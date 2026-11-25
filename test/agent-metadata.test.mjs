import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../runtime/agents.mjs';
import { ActivityStore } from '../runtime/activity.mjs';

class Client extends EventEmitter {
  calls = [];
  constructor(handler) { super(); this.handler = handler; }
  async request(method, params, options) { this.calls.push({ method, params, options }); return this.handler(method, params); }
  async reject() {}
  async respond() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, agents, handler) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-metadata-'));
  let store, controller;
  t.after(async () => {
    await store?.close();
    await controller?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const statePath = path.join(dir, 'state.json');
  await writeFile(statePath, JSON.stringify({ version: 1, pendingEvents: [], agents }));
  const client = new Client(handler);
  controller = new AgentController({ client, statePath });
  await controller.init();
  store = ActivityStore.attach(client, controller);
  return { client, controller, store, statePath };
}
const saved = (id, extra = {}) => ({ id, threadId: `thread-${id}`, status: 'completed', ...extra });

test('legacy metadata fills in background, persists, and polling does not change activity', async t => {
  const { store, controller, client, statePath } = await setup(t, [saved('a'), saved('b', { name: 'Claude name' })], (method, p) => {
    if (method === 'thread/read') return { thread: { id: p.threadId, name: 'Native name', createdAt: 100, updatedAt: 400 } };
    if (method === 'thread/turns/list') return { data: [{ startedAt: 300, completedAt: 350, items: [] }] };
    throw Error('Unexpected request');
  });
  assert.equal(store.list().agents[0].name, undefined);
  for (let i = 0; i < 20 && !controller.agents.get('b').lastActivityAtMs; i++) await tick();
  await controller.persist();
  assert.deepEqual(store.list().agents.map(a => [a.name, a.created_at_ms, a.last_activity_at_ms]), [['Native name', 100000, 300000], ['Claude name', 100000, 300000]]);
  for (let i = 0; i < 3; i++) store.list();
  await tick();
  assert.equal(client.calls.length, 4);
  assert.ok(client.calls.every(c => c.method === 'thread/read' ? c.params.includeTurns === false : c.params.limit === 1 && c.params.itemsView === 'notLoaded' && c.params.sortDirection === 'desc'));
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.agents[0].threadName, 'Native name');
  assert.equal(persisted.agents[0].lastActivityAtMs, 300000);
});

test('late metadata cannot overwrite activity or revive a removed agent', async t => {
  let resolveRead;
  const gate = new Promise(resolve => { resolveRead = resolve; });
  const { store, controller } = await setup(t, [saved('a')], (method) => method === 'thread/read' ? gate : { data: [{ startedAt: 200 }] });
  store.list();
  const a = controller.agents.get('a'); a.lastActivityAtMs = 900000;
  await controller.closeSelected({ target: a.id });
  resolveRead({ thread: { id: a.threadId, name: 'Late', createdAt: 100 } });
  await tick(); await tick();
  assert.equal(a.lastActivityAtMs, 900000); assert.equal(a.threadName, undefined);
  assert.equal(store.list().agents.length, 0);
});

test('metadata never overwrites a newer activity while its read is pending', async t => {
  let resolveRead;
  const gate = new Promise(resolve => { resolveRead = resolve; });
  const { store, controller } = await setup(t, [saved('a')], method => method === 'thread/read' ? gate : { data: [{ startedAt: 200 }] });
  store.list();
  const a = controller.agents.get('a'); a.lastActivityAtMs = 900000;
  resolveRead({ thread: { id: a.threadId, name: 'Title', createdAt: 100 } });
  await tick(); await tick();
  assert.equal(a.lastActivityAtMs, 900000); assert.equal(a.threadName, 'Title');
});

test('metadata requests use bounded concurrency', async t => {
  let active = 0, peak = 0;
  const resolvers = [];
  const { store, controller } = await setup(t, Array.from({ length: 10 }, (_, i) => saved(String(i))), (method, p) => {
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => resolvers.push(() => { active--; resolve(method === 'thread/read' ? { thread: { id: p.threadId, name: 'Title', createdAt: 100, updatedAt: 300 } } : { data: [{ startedAt: 200 }] }); }));
  });
  store.list(); assert.equal(peak, 8);
  while (resolvers.length || [...controller.agents.values()].some(a => a.lastActivityAtMs == null)) {
    for (const resolve of resolvers.splice(0)) resolve();
    await tick();
  }
  assert.equal(peak, 8);
});

test('failed metadata leaves list usable and retries are throttled', async t => {
  const { store, client } = await setup(t, [saved('a')], () => { throw Error('offline'); });
  assert.equal(store.list().agents.length, 1);
  await tick(); await tick();
  assert.equal(store.list().agents[0].last_activity_at_ms, null);
  await tick(); assert.equal(client.calls.length, 2);
});

test('failed turn lookup falls back to native thread update time and handles malformed names', async t => {
  const { store, controller } = await setup(t, [saved('a', { name: 42 })], (method, p) => {
    if (method === 'thread/read') return { thread: { id: p.threadId, name: 'Native', createdAt: 100, updatedAt: 400 } };
    throw Error('turns unavailable');
  });
  assert.equal(store.list().agents.length, 1);
  for (let i = 0; i < 20 && controller.agents.get('a').lastActivityAtMs == null; i++) await tick();
  const [agent] = store.list().agents;
  assert.equal(agent.name, 'Native'); assert.equal(agent.created_at_ms, 100000); assert.equal(agent.last_activity_at_ms, 400000);
});

test('adoption preserves native name and repeated followup uses one registration', async t => {
  const id = '01a1e21c-0000-7000-8000-000000000000'; let turns = 0;
  const { store, controller, client } = await setup(t, [], (method, p) => {
    if (method === 'thread/read') return { thread: { id, cwd: '/workspace', name: 'Original title', createdAt: 100, updatedAt: 200, status: { type: 'idle' } } };
    if (method === 'thread/resume') return { thread: { id, status: { type: 'idle' } } };
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } };
    if (method === 'turn/steer') return { turnId: p.expectedTurnId };
    throw Error(`Unexpected ${method}`);
  });
  const first = await controller.followup(`codex://threads/${id}`, 'first');
  await controller.followup(`codex://threads/${id}`, 'second');
  assert.equal(controller.agents.size, 1); assert.equal(store.list().agents[0].name, 'Original title');
  assert.equal(store.list().agents[0].created_at_ms, 100000);
  assert.equal(controller.agents.get(first.id).threadName, 'Original title');
  assert.equal(client.calls.filter(c => c.method === 'thread/read').length, 1);
});

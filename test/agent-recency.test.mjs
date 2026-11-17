import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../runtime/agents.mjs';
import { ActivityStore } from '../runtime/activity.mjs';

class Client extends EventEmitter {
  threads = 0; turns = 0;
  async request(method, params) {
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threads}` } };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turns}` } };
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    return {};
  }
  async respond() {}
  async reject() {}
  note(method, params) { this.emit('notification', { method, params }); }
}

test('recency reflects work and messages, survives restart, and ignores reads and acknowledgements', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-recency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const realNow = Date.now; let clock = 1000; Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  const client = new Client();
  const controller = new AgentController({ client, statePath, nativeRoleResolver: async () => undefined });
  await controller.init();
  const store = ActivityStore.attach(client, controller);
  const spawn = () => controller.dispatch('spawn_agent', { message: 'task', cwd: '/workspace', context_mode: 'none' });
  const a = await spawn(); clock = 2000; const b = await spawn();
  assert.deepEqual(store.list().agents.map(x => [x.created_at_ms, x.last_activity_at_ms]), [[1000, 1000], [2000, 2000]]);
  clock = 3000;
  client.note('item/started', { threadId: a.thread_id, turnId: a.turn_id, item: { id: 'tool', type: 'commandExecution' } });
  assert.equal(store.revision({ target: a.id }).agent.last_activity_at_ms, 3000);
  assert.deepEqual([...store.list().agents].sort((x, y) => y.last_activity_at_ms - x.last_activity_at_ms).map(x => x.id), [a.id, b.id]);
  clock = 4000;
  await controller.dispatch('send_message', { target: b.id, message: 'steer' });
  assert.equal(store.list().agents.find(x => x.id === b.id).last_activity_at_ms, 4000);
  clock = 5000;
  client.note('turn/completed', { threadId: a.thread_id, turn: { id: a.turn_id, status: 'completed' } });
  assert.equal(store.list().agents.find(x => x.id === a.id).last_activity_at_ms, 5000);
  clock = 6000;
  store.list(); store.revision({ target: a.id }); controller.eventsAfter();
  await controller.ackEvents(controller.nextSeq - 1);
  assert.equal(store.list().agents.find(x => x.id === a.id).last_activity_at_ms, 5000);
  clock = 7000;
  const followed = await controller.dispatch('followup_task', { target: a.id, message: 'continue' });
  assert.equal(store.list().agents.find(x => x.id === a.id).last_activity_at_ms, 7000);
  clock = 8000;
  await controller.serverRequest({ id: 42, method: 'item/tool/requestUserInput', params: { threadId: a.thread_id, turnId: followed.turn_id, questions: [{ id: 'q', question: 'Choose' }] } });
  assert.equal(store.list().agents.find(x => x.id === a.id).last_activity_at_ms, 8000);
  clock = 9000;
  await controller.dispatch('answer_agent', { target: a.id, request_id: '42', answer: { answers: { q: { answers: ['yes'] } } } });
  assert.equal(store.list().agents.find(x => x.id === a.id).last_activity_at_ms, 9000);
  client.note('turn/completed', { threadId: a.thread_id, turn: { id: followed.turn_id, status: 'completed' } });
  await controller.persist();
  // Avoid close(), which intentionally interrupts running work.
  store.close();
  const restored = new AgentController({ client: new Client(), statePath, nativeRoleResolver: async () => undefined });
  await restored.init();
  const restoredStore = ActivityStore.attach(restored.client, restored);
  assert.equal(restoredStore.list().agents.find(x => x.id === a.id).last_activity_at_ms, 9000);
  assert.equal(restoredStore.list().agents.find(x => x.id === b.id).last_activity_at_ms, 4000);
  await restoredStore.close(); await restored.close(); await controller.close();
});

test('legacy saved agents retain unknown timestamps through migration', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-recency-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  await writeFile(statePath, JSON.stringify({ version: 1, pendingEvents: [], agents: [{ id: 'legacy', threadId: 'old', status: 'completed' }] }));
  const client = new Client(), controller = new AgentController({ client, statePath });
  await controller.init(); const store = ActivityStore.attach(client, controller);
  assert.equal(store.list().agents[0].created_at_ms, null);
  assert.equal(store.revision({ target: 'legacy' }).agent.last_activity_at_ms, null);
  await store.close(); await controller.close();
  const restored = new AgentController({ client: new Client(), statePath }); await restored.init();
  const second = ActivityStore.attach(restored.client, restored);
  assert.equal(second.list().agents[0].last_activity_at_ms, null);
  await second.close(); await restored.close();
});

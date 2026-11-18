import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../runtime/agents.mjs';
import { externalClientTools, loadGuidance, resolveNativeDefault } from '../runtime/roles.mjs';
import { loadSettings } from '../runtime/settings.mjs';

const UUID = '12345678-1234-1234-1234-123456789abc';
test('unknown settings are rejected instead of silently applying defaults', () => {
  assert.throws(() => loadSettings({ permissionMode: 'ask' }), /Unknown settings: permissionMode/);
});
test('guidance validates collaboration and model selection notes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'guidance-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'guidance.json');
  await writeFile(file, JSON.stringify({ collaboration: 'Coordinate.', models: { example: { selection_note: 'Use for checks.' } } }));
  assert.equal(loadGuidance(file).models.example.selection_note, 'Use for checks.');
  await writeFile(file, JSON.stringify({ collaboration: ' ', models: {} }));
  assert.throws(() => loadGuidance(file), /collaboration/);
  await writeFile(file, JSON.stringify({ collaboration: 'Coordinate.', models: { example: { selection_note: 42 } } }));
  assert.throws(() => loadGuidance(file), /selection notes/);
});
class Client extends EventEmitter {
  calls = []; n = 0;
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (this.handler) { const response = this.handler(method, params); if (response !== undefined) return response; }
    if (method === 'thread/start') return { thread: { id: `thread-${++this.n}` } };
    if (method === 'turn/start') return { turn: { id: `turn-${this.n}`, status: 'inProgress' } };
    if (method === 'model/list') return { data: [{ model: 'gpt-6-luna' }], nextCursor: null };
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId, cwd: '/native', status: { type: 'idle' } }, model: params.model };
    return {};
  }
  async reject() {} async respond(id, result) { this.lastReply = { id, result }; }
  finish(agent) { this.emit('notification', { method: 'turn/completed', params: { threadId: agent.thread_id, turn: { id: agent.turn_id, status: 'completed' } } }); }
}
async function setup(t, settings = {}) {
  const client = new Client(), c = new AgentController({ client, settings, nativeRoleResolver: async () => undefined });
  t.after(() => c.close());
  return { client, c, spawn: (extra = {}) => c.dispatch('spawn_agent', { message: 'task', cwd: '/workspace', context_mode: 'none', ...extra }) };
}

test('capacity is reserved synchronously and released on terminal or rejected start', async t => {
  const { client, c, spawn } = await setup(t, { maxActiveAgents: 1 });
  let release; client.handler = method => method === 'thread/start' ? new Promise(resolve => { release = resolve; }) : undefined;
  const first = spawn(); await assert.rejects(spawn(), /limit/);
  release({ thread: { id: 'thread-x' } }); const agent = await first;
  await assert.rejects(c.dispatch('followup_task', { target: agent.id, message: 'steer' }).then(() => spawn()), /limit/);
  client.finish(agent); client.handler = undefined;
  const second = await spawn(); assert.equal(second.status, 'running');
  client.finish(second); client.handler = method => { if (method === 'thread/start') throw new Error('rejected'); };
  await assert.rejects(spawn(), /rejected/); client.handler = undefined;
  assert.equal((await spawn()).status, 'running');
});

test('adoption validates metadata, serializes first adoption, and retains native history', async t => {
  const { client, c } = await setup(t, { maxActiveAgents: 1 });
  let release; client.handler = method => method === 'thread/read' ? new Promise(resolve => { release = resolve; }) : undefined;
  const first = c.dispatch('followup_task', { target: `codex://threads/${UUID}`, message: 'continue' });
  await assert.rejects(c.dispatch('followup_task', { target: UUID, message: 'duplicate' }), /already being adopted/);
  release({ thread: { id: UUID, cwd: '/native', status: { type: 'idle' } } });
  const agent = await first; assert.equal(agent.cwd, '/native'); assert.equal(agent.thread_id, UUID);
  assert.match(agent.limitations[0], /dynamic tools/);
  client.emit('request', { id: 9, method: 'item/tool/call', params: { threadId: UUID, turnId: agent.turn_id, tool: 'desktop_tool', arguments: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.lastReply.result.success, false); assert.match(client.lastReply.result.contentItems[0].text, /original Codex client/);
  client.emit('request', { id: 10, method: 'item/tool/call', params: { threadId: UUID, turnId: agent.turn_id, tool: 'desktop_tool', arguments: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.eventsAfter(0).filter(event => event.code === 'client_tools_unavailable').length, 1);
  assert.equal(client.calls.filter(x => x.method === 'thread/inject_items').length, 0);
  assert.equal(client.calls.filter(x => x.method === 'turn/start').length, 1);
  client.finish(agent); await c.dispatch('close_agent', { target: agent.id });
  client.handler = method => method === 'thread/read' ? { thread: { id: UUID, cwd: '/native', status: { type: 'active' } } } : undefined;
  await assert.rejects(c.dispatch('followup_task', { target: UUID, message: 'continue' }), /active.*cannot be adopted/);
  assert.equal(client.calls.filter(x => x.method === 'turn/start').length, 1);
});

test('unmatched UUID read failures explain session scope without diagnosing a fork', async t => {
  for (const message of [
    'App-server thread/read failed (RPC -32600).',
    'App-server request timed out.',
    'App-server thread/read failed (RPC -32600). This thread is archived. Unarchive it in Codex before resuming.',
  ]) {
    const { client, c } = await setup(t);
    const cause = new Error(message);
    client.handler = method => { if (method === 'thread/read') throw cause; };
    await assert.rejects(c.dispatch('followup_task', { target: UUID, message: 'continue' }), error => {
      assert.equal(error.cause, cause);
      assert.ok(error.message.includes(message), 'the original failure must remain visible');
      assert.match(error.message, /No agent .* is registered in this Claude session/);
      assert.match(error.message, /current agent_id from list_agents/);
      assert.match(error.message, /original Codex thread_id\/link/);
      assert.doesNotMatch(error.message, /fork|branch|history.*lost/i);
      return true;
    });
    assert.equal(c.agents.size, 0);
    assert.deepEqual(client.calls.map(call => call.method), ['thread/read'], 'guidance must not start or resume work');
  }
});

test('explicit thread link lookup failure keeps the native cause without agent-ID advice', async t => {
  const { client, c } = await setup(t);
  const cause = new Error('App-server thread/read failed (RPC -32600). This thread already has an active native writer.');
  client.handler = method => { if (method === 'thread/read') throw cause; };
  await assert.rejects(c.dispatch('followup_task', { target: `codex://threads/${UUID}`, message: 'continue' }), error => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /Could not read Codex thread/);
    assert.match(error.message, /active native writer/);
    assert.doesNotMatch(error.message, /fork|branch|list_agents|another session/i);
    return true;
  });
  assert.equal(c.agents.size, 0);
  assert.deepEqual(client.calls.map(call => call.method), ['thread/read']);
});

test('post-registration send failure still identifies the registered agent', async t => {
  const { client, c } = await setup(t);
  client.handler = method => { if (method === 'turn/start') throw new Error('turn request rejected'); };
  await assert.rejects(c.dispatch('followup_task', { target: UUID, message: 'continue' }), error => {
    assert.match(error.message, /is registered as agent/);
    assert.match(error.message, /retry using this agent ID/);
    assert.doesNotMatch(error.message, /No agent .* is registered|another session|fork/i);
    return true;
  });
  assert.equal(c.agents.size, 1);
  assert.equal(client.calls.filter(call => call.method === 'thread/read').length, 1);
});

test('bulk close snapshots selectors and skips active agents', async t => {
  const { client, c, spawn } = await setup(t); const a = await spawn(), b = await spawn(), d = await spawn();
  client.finish(a); client.finish(d);
  await assert.rejects(c.dispatch('close_agent', { targets: [] }), /targets/);
  await assert.rejects(c.dispatch('close_agent', { targets: [a.id], except: [d.id] }), /only valid/);
  const result = await c.dispatch('close_agent', { targets: 'all', except: [d.id] });
  assert.deepEqual(result.closed_ids, [a.id]); assert.equal(result.closed_count, 1); assert.equal(result.skipped[0].agent_id, b.id);
  assert.equal((await c.dispatch('list_agents')).agents.length, 2);
});

test('native default fallback leaves all existing role configurations untouched', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'roles-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), cwd = path.join(dir, 'project', 'work'); await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true });
  const response = { config: { agents: null }, origins: {}, layers: [{ name: { type: 'user', file: path.join(home, 'config.toml') } }] };
  const args = { cwd, guidance: loadGuidance(), roleFile: path.join(dir, 'plugin.toml'), readConfig: async () => response };
  await writeFile(args.roleFile, 'model = "test"');
  assert.equal((await resolveNativeDefault(args))['agents.default.config_file'], args.roleFile);
  response.config.agents = { default: { description: 'user role' } };
  assert.equal(await resolveNativeDefault(args), undefined); response.config.agents = null;
  await mkdir(path.join(home, 'agents')); await writeFile(path.join(home, 'agents', 'other.toml'), 'name = "default"');
  assert.equal(await resolveNativeDefault(args), undefined); await rm(path.join(home, 'agents', 'other.toml'));
  await mkdir(path.join(home, 'agents', 'nested')); await writeFile(path.join(home, 'agents', 'nested', 'role.toml'), 'name = "default"');
  assert.equal(await resolveNativeDefault(args), undefined); await rm(path.join(home, 'agents', 'nested'), { recursive: true });
  await mkdir(path.join(dir, 'project', '.codex', 'agents'), { recursive: true });
  await writeFile(path.join(dir, 'project', '.codex', 'agents', 'other.toml'), 'name = "worker"');
  assert.equal(await resolveNativeDefault(args), undefined);
  assert.equal(await resolveNativeDefault({ ...args, readConfig: async () => { throw new Error('unavailable'); } }), undefined);
});

test('external tool inspection reads only matching first session metadata', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'external-tools-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'thread.jsonl');
  const meta = { type: 'session_meta', payload: { id: UUID, dynamic_tools: [{ type: 'function', name: 'one' }, { type: 'namespace', name: 'group', tools: [{ name: 'two' }] }] } };
  await writeFile(file, `${JSON.stringify(meta)}\nnot a history record\n`);
  assert.deepEqual(await externalClientTools({ id: UUID, path: file }), { status: 'known', tools: ['one', 'group.two'] });
  assert.deepEqual(await externalClientTools({ id: 'other', path: file }), { status: 'unknown', tools: [] });
});

test('an active descendant occupies its completed root slot until it finishes', async t => {
  const { client, c, spawn } = await setup(t, { maxActiveAgents: 1 }); const a = await spawn();
  client.emit('notification', { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: a.thread_id } } });
  client.emit('notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  client.finish(a); await assert.rejects(spawn(), /limit/);
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } });
  assert.equal((await spawn()).status, 'running');
});

test('root actions emit lifecycle events without descendant traces', async t => {
  const { client, c, spawn } = await setup(t); const events = []; c.on('agentAction', event => events.push(event));
  const a = await spawn({ name: 'same' }); await c.dispatch('send_message', { target: a.id, message: 'steer' }); client.finish(a);
  await c.dispatch('close_agent', { target: a.id });
  assert.deepEqual(events.map(event => event.kind), ['spawn', 'send', 'close']);
  assert.ok(events.every(event => event.agent_id === a.id && event.thread_id === a.thread_id));
});

test('start and resume expose valid native model metadata', async t => {
  const { client, c, spawn } = await setup(t);
  client.handler = (method, params) => {
    if (method === 'thread/start') return { thread: { id: 'metadata-thread' }, model: 'resolved-model', reasoningEffort: 'high' };
    if (method === 'model/list') return { data: [{ model: 'resolved-model' }], nextCursor: null };
    if (method === 'thread/resume') return { thread: { status: { type: 'idle' } }, model: params.model, reasoningEffort: null };
  };
  const a = await spawn(); assert.equal(a.model, 'resolved-model'); assert.equal(a.reasoning_effort, 'high');
  client.finish(a); c.find(a.id).loaded = false;
  const resumed = await c.dispatch('followup_task', { target: a.id, message: 'continue' });
  assert.equal(resumed.model, 'resolved-model'); assert.equal(resumed.reasoning_effort, 'high');
});

test('permission modes and default role use explicit protocol settings', async t => {
  for (const [mode, reviewer] of [['ask', 'user'], ['auto-review', 'auto_review']]) {
    const { client, c, spawn } = await setup(t, { permissionsMode: mode });
    const a = await spawn({ role: 'default' });
    const start = client.calls[0].params;
    assert.equal(start.approvalPolicy, 'on-request'); assert.equal(start.approvalsReviewer, reviewer); assert.equal(start.sandbox, 'workspace-write');
    assert.equal(start.model, 'gpt-6-luna'); assert.equal(client.calls.find(x => x.method === 'turn/start').params.effort, 'medium');
    assert.deepEqual(start.dynamicTools, []); assert.equal(start.config['features.multi_agent_v2'], false); assert.equal(start.config['features.image_generation'], false);
    await assert.rejects(spawn({ role: 'default', model: 'other' }), /role default/);
    client.finish(a); c.find(a.id).loaded = false;
    await c.dispatch('followup_task', { target: a.id, message: 'continue' });
    assert.equal(client.calls.find(x => x.method === 'thread/resume').params.approvalsReviewer, reviewer);
  }
});

test('permissions reply example preserves requested nested structures', async t => {
  const { client, c, spawn } = await setup(t); const a = await spawn();
  client.emit('request', { id: 5, method: 'item/permissions/requestApproval', params: { threadId: a.thread_id, turnId: a.turn_id, permissions: { network: { enabled: true }, fileSystem: { read: ['/x'], write: ['/y'] } } } });
  const example = c.view(c.find(a.id)).pending_requests[0].reply_format;
  assert.deepEqual(example, { permissions: { network: { enabled: true }, fileSystem: { read: ['/x'], write: ['/y'] } }, scope: 'turn' });
  await c.dispatch('answer_agent', { target: a.id, request_id: 5, answer: example });
});

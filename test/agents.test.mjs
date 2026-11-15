import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../runtime/agents.mjs';
import { prepareAttachments } from '../runtime/attachments.mjs';
import { ActivityStore } from '../runtime/activity.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
class MockClient extends EventEmitter {
  calls = []; replies = []; rejected = []; threadCount = 0; turnCount = 0;
  async request(method, params, options) {
    this.calls.push({ method, params: structuredClone(params) });
    if (this.handler) {
      const response = this.handler(method, params, options);
      if (response !== undefined) return response;
    }
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threadCount}` } };
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.turnCount}`, status: 'inProgress' };
      this.note('turn/started', { threadId: params.threadId, turn });
      return { turn };
    }
    return {};
  }
  async respond(id, result) { this.replies.push({ id, result: structuredClone(result) }); }
  async reject(id, code, message) { this.rejected.push({ id, code, message }); }
  note(method, params) { this.emit('notification', { method, params }); }
  ask(id, method, params) { this.emit('request', { id, method, params }); }
  complete(threadId = 'thread-1', turnId = 'turn-1', status = 'completed', error) {
    this.note('turn/completed', { threadId, turn: { id: turnId, status, error } });
  }
}
async function setup(t, options = {}) {
  const client = new MockClient();
  const controller = new AgentController({ client, nativeRoleResolver: async () => undefined, ...options });
  await controller.init();
  t.after(() => controller.close());
  return { client, controller, spawn: (args = {}) => controller.dispatch('spawn_agent', { message: 'Solve task', cwd: '/workspace', context_mode: 'none', ...args }) };
}
const pendingQuestion = (threadId = 'thread-1', turnId = 'turn-1') => ({ threadId, turnId, itemId: 'q-item', questions: [{ id: 'choice', header: 'Choose', question: 'Which?' }], isBlocking: true });
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const tinyGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

test('spawn task action uses its exact first turn even when native completion precedes the start reply', async t => {
  for (const lostReply of [false, true]) {
    const { client, controller, spawn } = await setup(t); const activity = ActivityStore.attach(client, controller); t.after(() => activity.close());
    const actions = []; controller.on('agentAction', action => actions.push(action));
    client.handler = (method, params) => {
      if (method !== 'turn/start') return;
      client.note('turn/started', { threadId: params.threadId, turn: { id: 'first-turn' } });
      client.note('item/completed', { threadId: params.threadId, turnId: 'first-turn', item: { id: 'native-user', type: 'userMessage', content: [{ text: params.input[0].text }] } });
      client.complete(params.threadId, 'first-turn');
      if (lostReply) throw new Error('Lost start reply');
      return { turn: { id: 'first-turn', status: 'completed' } };
    };
    if (lostReply) await assert.rejects(spawn({ message: 'Initial task' }), /Lost start reply/);
    else await spawn({ message: 'Initial task' });
    assert.equal(actions.filter(action => action.kind === 'spawn').length, 1);
    assert.equal(actions[0].turn_id, 'first-turn');
    const agent = controller.snapshot().agents[0]; assert.equal(agent.turn_id, null);
    const entries = activity.revision({ target: agent.id }).entries;
    const task = entries.find(entry => entry.type === 'parentMessage'), native = entries.find(entry => entry.id === 'native-user');
    assert.equal(task.turn_id, 'first-turn'); assert.equal(native.turn_id, task.turn_id);
    assert.equal(task.data.text, 'Initial task'); assert.equal(native.preview, task.data.text);
  }
});

test('spawn action retains one unbound task when native turn creation is rejected', async t => {
  const { client, controller, spawn } = await setup(t); const activity = ActivityStore.attach(client, controller); t.after(() => activity.close());
  const actions = []; controller.on('agentAction', action => actions.push(action));
  client.handler = method => { if (method === 'turn/start') throw Object.assign(new Error('Start rejected'), { code: -32602 }); };
  await assert.rejects(spawn({ message: 'Unstarted task' }), /Start rejected/);
  assert.equal(actions.length, 1); assert.equal(actions[0].kind, 'spawn'); assert.equal(actions[0].turn_id, null);
  const entries = activity.revision({ target: actions[0].agent_id }).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].data.text, 'Unstarted task'); assert.equal(entries[0].turn_id, '');
});

test('context source identifies new, Claude-inherited and native conversations across followups and restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-context-source-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json'); const nativeId = '12345678-1234-4234-8234-123456789abc';
  const { client, controller, spawn } = await setup(t, { statePath });
  const fresh = await spawn(); client.complete(fresh.thread_id, fresh.turn_id);
  const snapshot = { history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Claude context' }] }], digest: 'context-digest', stats: { messages: 1 } };
  const inherited = await spawn({ context_mode: 'available', snapshot }); client.complete(inherited.thread_id, inherited.turn_id);
  client.handler = (method, params) => method === 'thread/read' ? { thread: { id: params.threadId, cwd: '/workspace', status: { type: 'idle' } } }
    : method === 'thread/resume' ? { thread: { status: { type: 'idle' } } } : undefined;
  // Extra caller data cannot add a Claude snapshot to native-ID/deeplink followup.
  const native = await controller.dispatch('followup_task', { target: `codex://threads/${nativeId}`, message: 'Continue native work', context_mode: 'available', snapshot });
  client.complete(nativeId, native.turn_id);
  assert.deepEqual([fresh.context_source, inherited.context_source, native.context_source], ['new', 'claude', 'codex']);
  for (const [agent, source] of [[fresh, 'new'], [inherited, 'claude'], [native, 'codex']]) {
    const continued = await controller.dispatch('followup_task', { target: `codex://threads/${agent.thread_id}`, message: 'Continue again', context_mode: 'available', snapshot });
    assert.equal(continued.context_source, source); assert.equal(continued.thread_id, agent.thread_id);
    client.complete(agent.thread_id, continued.turn_id);
  }
  assert.equal(client.calls.filter(call => call.method === 'thread/start').length, 2);
  const injections = client.calls.filter(call => call.method === 'thread/inject_items');
  assert.equal(injections.length, 1); assert.equal(injections[0].params.threadId, inherited.thread_id);
  await controller.persist();
  const restored = new AgentController({ client: new MockClient(), statePath, nativeRoleResolver: async () => undefined });
  await restored.init(); t.after(() => restored.close());
  assert.deepEqual((await restored.dispatch('list_agents')).agents.map(agent => agent.context_source), ['new', 'claude', 'codex']);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).agents.map(agent => agent.contextSource), ['new', 'claude', 'codex']);
});

test('legacy context-source migration only infers origins with positive evidence', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-context-migration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const evidence = [
    { id: 'unproven', injected: false, snapshot: null },
    { id: 'injected', injected: true },
    { id: 'snapshot', snapshot: { digest: 'recorded-digest', stats: {} } },
    { id: 'external', externalThread: true },
    { id: 'adopted', externalAdopted: true },
    { id: 'invalid-snapshot', snapshot: {} },
    { id: 'explicit-new', contextSource: 'new' },
    { id: 'invalid-enum', contextSource: 'other', injected: true },
  ];
  await writeFile(statePath, JSON.stringify({ version: 1, pendingEvents: [], agents: evidence.map(agent => ({ status: 'completed', ...agent })) }));
  const restored = new AgentController({ client: new MockClient(), statePath, nativeRoleResolver: async () => undefined });
  await restored.init(); t.after(() => restored.close());
  const listed = (await restored.dispatch('list_agents')).agents;
  assert.deepEqual(listed.map(agent => agent.context_source), ['unknown', 'claude', 'claude', 'codex', 'codex', 'unknown', 'new', 'claude']);
  assert.equal(listed[0].context_source, 'unknown');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).agents.map(agent => agent.contextSource), listed.map(agent => agent.context_source));
});

test('private sidebar followup keeps native history and Claude can reuse the same agent afterward', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.complete(); await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'PRIVATE USER REQUEST' });
  assert.equal(controller.view(controller.find(agent.id)).turn_origin, 'user');
  assert.equal(controller.hasParentWork(), false); assert.equal(controller.hasActiveWork(), true);
  client.note('item/completed', { threadId: agent.thread_id, turnId: 'turn-2', item: { id: 'private-final', type: 'agentMessage', phase: 'final_answer', text: 'PRIVATE ANSWER' } });
  client.complete(agent.thread_id, 'turn-2');
  assert.deepEqual(controller.eventsAfter(), []);
  assert.equal(controller.snapshot().agents[0].result, 'PRIVATE ANSWER');
  await controller.dispatch('followup_task', { target: agent.id, message: 'Next parent task' });
  assert.equal(controller.view(controller.find(agent.id)).turn_origin, 'parent');
  client.note('item/completed', { threadId: agent.thread_id, turnId: 'turn-3', item: { id: 'parent-final', type: 'agentMessage', phase: 'final_answer', text: 'Parent answer' } });
  client.complete(agent.thread_id, 'turn-3');
  assert.equal(controller.eventsAfter()[0].result, 'Parent answer');
  assert.equal(client.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(client.calls.filter(c => c.method === 'thread/inject_items').length, 0);
  assert.deepEqual(client.calls.filter(c => c.method === 'turn/start').map(c => c.params.threadId), [agent.thread_id, agent.thread_id, agent.thread_id]);
  assert.doesNotMatch(JSON.stringify(controller.eventsAfter()), /PRIVATE/);
});

test('successful user steer suppresses even a result received before its RPC response', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  let accept; client.handler = method => method === 'turn/steer' ? new Promise(resolve => { accept = resolve; }) : undefined;
  const sending = controller.dispatch('ui_send', { target: agent.id, message: 'Private steer' });
  await tick();
  client.note('item/completed', { threadId: agent.thread_id, turnId: agent.turn_id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Private steered answer' } });
  client.complete();
  assert.deepEqual(controller.eventsAfter(), []);
  accept({ turnId: agent.turn_id }); await sending;
  assert.deepEqual(controller.eventsAfter(), []); assert.equal(controller.find(agent.id).turnOrigin, 'user');
});

test('parent followup waits for a separate turn boundary when a private turn is active', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'Private active task' });
  const count = client.calls.length;
  await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'New parent task' }), error => {
    assert.equal(error.code, 'private_turn_active'); assert.equal(error.agent_id, agent.id);
    assert.equal(error.thread_id, agent.thread_id); assert.match(error.recovery, /same agent/); return true;
  });
  assert.equal(client.calls.length, count); assert.equal(controller.find(agent.id).turnOrigin, 'user');
  assert.equal(controller.find(agent.id).status, 'running');
  await controller.dispatch('send_message', { target: agent.id, message: 'Coordination only' });
  assert.equal(client.calls.at(-1).method, 'turn/steer'); assert.equal(controller.find(agent.id).turnOrigin, 'user');
  client.note('item/completed', { threadId: agent.thread_id, turnId: 'turn-2', item: { id: 'private-final', type: 'agentMessage', phase: 'final_answer', text: 'PRIVATE ANSWER' } });
  client.complete(agent.thread_id, 'turn-2'); assert.deepEqual(controller.eventsAfter(), []);
  await controller.dispatch('followup_task', { target: agent.id, message: 'New parent task' });
  assert.equal(client.calls.at(-1).method, 'turn/start'); assert.equal(client.calls.at(-1).params.threadId, agent.thread_id);
  assert.equal(controller.find(agent.id).turnOrigin, 'parent');
  client.note('item/completed', { threadId: agent.thread_id, turnId: 'turn-3', item: { id: 'parent-final', type: 'agentMessage', phase: 'final_answer', text: 'Parent task answer' } });
  client.complete(agent.thread_id, 'turn-3');
  assert.equal(controller.eventsAfter()[0].result, 'Parent task answer');
  assert.equal(client.calls.filter(c => c.method === 'thread/start').length, 1);
});

test('private completion racing a parent followup starts its own parent turn and retains no private final', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'Private task' });
  const followup = controller.dispatch('followup_task', { target: agent.id, message: 'Parent task' });
  client.note('item/completed', { threadId: agent.thread_id, turnId: 'turn-2', item: { id: 'private-final', type: 'agentMessage', phase: 'final_answer', text: 'PRIVATE FINAL' } });
  client.complete(agent.thread_id, 'turn-2');
  const accepted = await followup; assert.equal(accepted.turn_origin, 'parent'); assert.equal(accepted.turn_id, 'turn-3');
  assert.equal(client.calls.filter(c => c.method === 'turn/steer').length, 0);
  client.complete(agent.thread_id, 'turn-3');
  assert.equal(controller.eventsAfter().length, 1); assert.equal(controller.eventsAfter()[0].turn_id, 'turn-3');
  assert.doesNotMatch(JSON.stringify(controller.eventsAfter()), /PRIVATE FINAL/);
});

test('failed ordinary parent steering never changes a private turn recipient', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'Private task' });
  client.handler = method => method === 'turn/steer' ? Promise.reject(new Error('Steer failed')) : undefined;
  await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'Coordination' }), /Steer failed/);
  assert.equal(controller.find(agent.id).turnOrigin, 'user');
  client.complete(agent.thread_id, 'turn-2'); assert.deepEqual(controller.eventsAfter(), []);
});

test('rejected or unconfirmed user steer preserves the original parent turn result', async t => {
  for (const error of [Object.assign(new Error('Rejected'), { code: -32602 }), new Error('Connection lost')]) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn();
    let reject; client.handler = method => method === 'turn/steer' ? new Promise((resolve, fail) => { reject = fail; }) : undefined;
    const sending = controller.dispatch('ui_send', { target: agent.id, message: 'PRIVATE FAILED STEER' });
    const rejected = assert.rejects(sending, new RegExp(error.message)); await tick();
    client.complete(); assert.deepEqual(controller.eventsAfter(), []);
    reject(error); await rejected;
    assert.equal(controller.find(agent.id).turnOrigin ?? 'parent', 'parent');
    assert.equal(controller.eventsAfter()[0].kind, 'completed');
    assert.doesNotMatch(JSON.stringify(controller.eventsAfter()), /PRIVATE FAILED/);
  }
});

test('private turns retain explicit notify_parent and blocking collaboration requests', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'Private work' });
  client.ask('notify-private', 'item/tool/call', { threadId: agent.thread_id, turnId: 'turn-2', tool: 'notify_parent', arguments: { message: 'Explicit coordination' } });
  client.ask('question-private', 'item/tool/requestUserInput', pendingQuestion(agent.thread_id, 'turn-2'));
  await tick();
  assert.equal(controller.hasParentWork(), true);
  assert.deepEqual(controller.eventsAfter().map(e => e.kind), ['message', 'question']);
  assert.equal(controller.eventsAfter()[0].message, 'Explicit coordination');
});

test('private native failure details stay in the local snapshot rather than parent status', async t => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'Private work' });
  client.complete(agent.thread_id, 'turn-2', 'failed', { message: 'PRIVATE NATIVE FAILURE' });
  assert.deepEqual(controller.eventsAfter(), []);
  const listed = await controller.dispatch('list_agents'); assert.equal(listed.agents[0].error, null);
  assert.equal(controller.snapshot().agents[0].error.message, 'PRIVATE NATIVE FAILURE');
});

test('restart restores deferred parent results when a user steer never received confirmation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-steer-restart-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); const agent = await spawn();
  client.handler = method => method === 'turn/steer' ? new Promise(() => {}) : undefined;
  const sending = controller.dispatch('ui_send', { target: agent.id, message: 'Private pending steer' }); sending.catch(() => {});
  await tick(); client.complete(); await controller.persist();
  assert.deepEqual(controller.eventsAfter(), []);
  const restored = new AgentController({ client: new MockClient(), statePath, nativeRoleResolver: async () => undefined });
  await restored.init(); t.after(() => restored.close());
  assert.equal(restored.find(agent.id).turnOrigin, 'parent');
  assert.equal(restored.eventsAfter()[0].kind, 'completed');
  assert.equal(restored.find(agent.id).pendingUserSteer, null);
  // End the mock transport so the intentionally unanswered RPC cannot outlive the test.
  client.emit('closed'); await assert.rejects(sending, /connection closed/i);
});

test('private turn scope survives restart and legacy pending sends migrate by exact turn identity', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-private-restart-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); const agent = await spawn(); client.complete();
  await controller.ackEvents(controller.nextSeq - 1);
  await controller.dispatch('ui_send', { target: agent.id, message: 'PRIVATE REQUEST' }); await controller.persist();
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  saved.pendingEvents = [
    { seq: 10, agent_id: agent.id, turn_id: 'turn-2', kind: 'completed', result: 'PRIVATE RESULT' },
    { seq: 11, agent_id: agent.id, turn_id: 'turn-2', kind: 'message', origin: 'user', action: 'send', phase: 'delivered', message: 'PRIVATE REQUEST' },
    { seq: 12, agent_id: agent.id, turn_id: 'turn-parent', kind: 'completed', result: 'Parent result' },
    { seq: 13, agent_id: agent.id, turn_id: 'turn-2', kind: 'message', message: 'Explicit coordination' },
    { seq: 14, agent_id: agent.id, turn_id: 'turn-parent', kind: 'message', origin: 'user', action: 'send', phase: 'failed', message: 'FAILED PRIVATE REQUEST' },
  ];
  delete saved.agents[0].turnOrigin; saved.nextSeq = 15;
  await writeFile(statePath, JSON.stringify(saved));
  const nextClient = new MockClient(); nextClient.handler = method => method === 'thread/read' ? { thread: { status: { type: 'active' } } }
    : method === 'thread/resume' ? { thread: { status: { type: 'active' } } }
    : method === 'thread/turns/list' ? { data: [{ id: 'turn-2', status: 'inProgress' }] } : undefined;
  const restored = new AgentController({ client: nextClient, statePath, nativeRoleResolver: async () => undefined });
  await restored.init(); t.after(() => restored.close());
  assert.equal(restored.find(agent.id).turnOrigin, 'user'); assert.equal(restored.hasParentWork(), false);
  nextClient.complete(agent.thread_id, 'turn-2');
  assert.deepEqual(restored.eventsAfter().map(e => e.seq), [12, 13]);
  assert.doesNotMatch(JSON.stringify(restored.eventsAfter()), /PRIVATE/);
  const durable = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durable.agents[0].turnOrigin, 'user');
});

test('direct user attachments steer as native images and file paths without forwarding file contents', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-user-attachments-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'photo.txt'), pdfPath = path.join(dir, 'document.png');
  const imageBytes = tinyPng;
  await writeFile(imagePath, imageBytes); await writeFile(pdfPath, '%PDF-1.7\nPRIVATE FILE CONTENT');
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  const actions = []; controller.on('agentAction', a => actions.push(a));
  const result = await controller.dispatch('ui_send', { target: agent.id, message: 'Please inspect', attachments: [{ path: imagePath }, { path: pdfPath }] });
  assert.equal(result.delivery, 'steered');
  const wire = client.calls.find(c => c.method === 'turn/steer').params.input;
  assert.equal(wire[0].type, 'text'); assert.deepEqual(wire[0].text_elements, []);
  assert.match(wire[0].text, /^\[Direct message from the user\]\n\nPlease inspect/);
  assert.deepEqual(wire[1], { type: 'localImage', path: await realpath(imagePath) });
  assert.equal(wire.length, 2); assert.ok(wire[0].text.includes(JSON.stringify(await realpath(pdfPath))));
  const action = actions.find(a => a.kind === 'send');
  assert.equal(action.origin, 'user'); assert.deepEqual(action.attachments.map(a => a.type), ['image', 'file']);
  assert.equal(controller.eventsAfter().some(e => e.action === 'send'), false);
  assert.doesNotMatch(JSON.stringify({ wire, action }), /PRIVATE FILE CONTENT/);
  assert.deepEqual(await readFile(imagePath), imageBytes);
});

test('attachment-only resume starts same thread and invalid paths preserve pause', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-user-attachments-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'data.bin'); await writeFile(filePath, 'hello');
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  await controller.dispatch('ui_interrupt', { target: agent.id }); client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  const count = client.calls.length;
  for (const invalid of [dir, path.join(dir, 'missing'), 'relative.txt', '\\\\server\\share\\file', '\\\\?\\C:\\device']) {
    await assert.rejects(controller.dispatch('ui_send', { target: agent.id, attachments: [{ path: invalid }] }));
    assert.equal(controller.find(agent.id).userPaused, true);
  }
  assert.equal(client.calls.length, count);
  await controller.dispatch('ui_send', { target: agent.id, attachments: [{ path: filePath }] });
  const start = client.calls.filter(c => c.method === 'turn/start').at(-1);
  assert.equal(start.params.threadId, agent.thread_id);
  assert.equal(start.params.input.length, 1); assert.ok(start.params.input[0].text.includes(JSON.stringify(await realpath(filePath))));
  assert.equal(client.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(client.calls.filter(c => c.method === 'thread/inject_items').length, 0);
});

test('image classification checks supported headers and bounds attachment count', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-image-headers-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const samples = [tinyPng, tinyGif, Buffer.from('%PDF-1.7')];
  const files = [];
  for (let i = 0; i < samples.length; i++) { const filePath = path.join(dir, String(i)); await writeFile(filePath, samples[i]); files.push({ path: filePath }); }
  assert.deepEqual((await prepareAttachments(files)).map(file => file.type), ['image', 'image', 'file']);
  await assert.rejects(prepareAttachments(Array.from({ length: 21 }, () => files[0])), /at most 20/);
  for (const bytes of [tinyPng.subarray(0, 8), Buffer.from([255, 216, 255, 224]), Buffer.from('GIF89a'), Buffer.from('RIFFxxxxWEBP')]) {
    await writeFile(files[0].path, bytes);
    await assert.rejects(prepareAttachments([files[0]]), /appears truncated or invalid/);
  }
});

test('a FIFO is rejected without waiting for a writer', { skip: process.platform !== 'linux' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-attachment-fifo-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  await assert.rejects(prepareAttachments([{ path: fifo }]), /not a regular file/);
});

test('stop during attachment validation prevents a later resume', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-attachment-stop-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'file.txt'); await writeFile(filePath, 'content');
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  const send = controller.dispatch('ui_send', { target: agent.id, message: 'inspect', attachments: [{ path: filePath }] });
  await controller.dispatch('ui_interrupt', { target: agent.id });
  await assert.rejects(send, /paused by the user/);
  assert.equal(client.calls.filter(c => c.method === 'turn/steer').length, 0);
  assert.equal(controller.find(agent.id).userPaused, true);
});

test('user stop isolates the tree, waits for descendants, and resumes with user attribution', async t => {
  const { client, controller, spawn } = await setup(t);
  const first = await spawn(), other = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: first.thread_id } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  const actions = []; controller.on('agentAction', action => actions.push(action));
  const result = await controller.dispatch('ui_interrupt', { target: first.id });
  assert.equal(result.status, 'stopping');
  assert.deepEqual(client.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params.threadId).sort(), ['child', first.thread_id].sort());
  await assert.rejects(controller.dispatch('followup_task', { target: first.id, message: 'continue' }), /paused by the user/);
  client.complete(first.thread_id, first.turn_id, 'interrupted');
  assert.equal(controller.view(controller.find(first.id)).user_control_status, 'stopping');
  await assert.rejects(controller.dispatch('ui_send', { target: first.id, message: 'resume' }), /not yet confirmed/);
  client.complete('child', 'child-turn', 'interrupted');
  assert.equal(controller.view(controller.find(first.id)).user_control_status, 'stopped');
  assert.equal(controller.find(other.id).status, 'running');
  await controller.dispatch('ui_send', { target: first.id, message: 'resume' });
  assert.equal(client.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text, '[Direct message from the user]\n\nresume');
  assert.ok(actions.some(a => a.kind === 'send' && a.origin === 'user' && a.message === 'resume'));
  assert.equal(controller.eventsAfter().some(e => e.origin === 'user' && e.action === 'send'), false);
});

test('stop all pauses every root before interrupting either tree and isolates failures', async t => {
  const { client, controller, spawn } = await setup(t);
  const first = await spawn(), second = await spawn();
  for (const [root, child] of [[first, 'child-a'], [second, 'child-b']]) {
    client.note('thread/started', { thread: { id: child, parentThreadId: root.thread_id } });
    client.note('turn/started', { threadId: child, turn: { id: child + '-turn' } });
  }
  client.note('turn/started', { threadId: 'external', turn: { id: 'external-turn' } });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const persist = controller.persist.bind(controller); controller.persist = () => gate;
  const stopping = controller.dispatch('ui_interrupt_all');
  assert.ok([first, second].every(a => controller.find(a.id).userPaused));
  assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 0);
  await assert.rejects(spawn(), /stop-all action is in progress/);
  await assert.rejects(controller.dispatch('ui_send', { target: first.id, message: 'resume' }), /stop-all action is in progress/);
  controller.persist = persist;
  client.handler = (method, params) => { if (method === 'turn/interrupt' && params.threadId === first.thread_id) throw new Error('offline'); };
  release();
  const result = await stopping;
  assert.deepEqual(result.results.map(a => a.status), ['unconfirmed', 'stopping']);
  assert.deepEqual(client.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params.threadId).sort(), [first.thread_id, second.thread_id, 'child-a', 'child-b'].sort());
  for (const a of [first, second]) await assert.rejects(controller.dispatch('send_message', { target: a.id, message: 'continue' }), /paused by the user/);
  for (const [thread, turn] of [[first.thread_id, first.turn_id], [second.thread_id, second.turn_id], ['child-a', 'child-a-turn'], ['child-b', 'child-b-turn']]) client.complete(thread, turn, 'interrupted');
  assert.ok(result.results.every(a => a.user_paused));
  assert.equal((await spawn()).status, 'running');
});

test('stop all persists registrations and pause across controller restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-stop-all-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath });
  const first = await spawn(), second = await spawn();
  await controller.dispatch('ui_interrupt_all');
  for (const a of [first, second]) client.complete(a.thread_id, a.turn_id, 'interrupted');
  await controller.persist(); await controller.close();
  const restartedClient = new MockClient();
  const restarted = new AgentController({ client: restartedClient, statePath, nativeRoleResolver: async () => undefined });
  await restarted.init(); t.after(() => restarted.close());
  assert.equal(restarted.agents.size, 2);
  for (const a of [first, second]) {
    assert.equal(restarted.find(a.id).userPaused, true);
    await assert.rejects(restarted.dispatch('followup_task', { target: a.id, message: 'continue' }), /paused by the user/);
  }
  assert.equal(restartedClient.calls.filter(c => c.method === 'turn/start').length, 0);
  await restarted.dispatch('ui_send', { target: first.id, message: 'resume' });
  assert.equal(restarted.find(first.id).userPaused, false);
  assert.equal(restarted.find(second.id).userPaused, true);
});

test('stop all prevents an in-flight external adoption from starting work', async t => {
  const { client, controller } = await setup(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  client.handler = method => { if (method === 'thread/read') return gate; };
  const nativeId = '12345678-1234-4234-8234-123456789abc';
  const adopting = controller.dispatch('followup_task', { target: nativeId, message: 'continue' });
  await tick(); await controller.dispatch('ui_interrupt_all');
  release({ thread: { id: nativeId, cwd: '/workspace', status: { type: 'idle' } } });
  await assert.rejects(adopting, /stop-all action interrupted adoption/);
  assert.equal(controller.agents.size, 0);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 0);
});

test('failed user stop remains unconfirmed, retries, and catches late descendants', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); let fail = true;
  client.handler = method => { if (method === 'turn/interrupt' && fail) throw new Error('offline'); };
  assert.equal((await controller.dispatch('ui_interrupt', { target: agent.id })).status, 'unconfirmed');
  fail = false;
  assert.equal((await controller.dispatch('ui_interrupt', { target: agent.id })).status, 'stopping');
  client.note('thread/started', { thread: { id: 'late-child', parentThreadId: agent.thread_id } });
  client.note('turn/started', { threadId: 'late-child', turn: { id: 'late-turn' } });
  await tick();
  assert.ok(client.calls.some(c => c.method === 'turn/interrupt' && c.params.threadId === 'late-child'));
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  client.complete('late-child', 'late-turn', 'interrupted');
  assert.equal(controller.view(controller.find(agent.id)).user_control_status, 'stopped');
  assert.equal(controller.eventsAfter().filter(e => e.action === 'interrupt' && e.phase === 'requested').length, 1);
  assert.equal(controller.eventsAfter().filter(e => e.action === 'interrupt' && e.phase === 'confirmed').length, 1);
});

test('user pause persists across restart and prevents Claude from resuming', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-pause-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath });
  const agent = await spawn();
  await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  await controller.persist();
  const second = new AgentController({ client: new MockClient(), statePath, nativeRoleResolver: async () => undefined });
  await second.init(); t.after(() => second.close());
  assert.equal(second.view(second.find(agent.id)).user_paused, true);
  await assert.rejects(second.dispatch('send_message', { target: agent.id, message: 'continue' }), /paused by the user/);
  await second.dispatch('ui_send', { target: agent.id, message: 'proceed' });
  assert.equal(second.view(second.find(agent.id)).user_paused, false);
});

test('user stop cancels an in-flight followup before it can start', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); client.complete(agent.thread_id, agent.turn_id); await tick();
  controller.find(agent.id).loaded = false;
  let release; const gate = new Promise(resolve => { release = resolve; });
  client.handler = method => { if (method === 'thread/resume') return gate; };
  const send = controller.dispatch('followup_task', { target: agent.id, message: 'continue' });
  await tick();
  await controller.dispatch('ui_interrupt', { target: agent.id });
  release({ thread: { status: { type: 'idle' } } });
  await assert.rejects(send, /paused by the user/);
  await tick();
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(controller.view(controller.find(agent.id)).user_control_status, 'stopped');
});

test('user message cannot bypass a pending question', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn();
  client.ask('question', 'item/tool/requestUserInput', pendingQuestion()); await tick();
  await assert.rejects(controller.dispatch('ui_send', { target: agent.id, message: 'answer?' }), /pending request/);
  assert.equal(client.calls.filter(c => c.method === 'turn/steer').length, 0);
  assert.equal(controller.find(agent.id).pending.length, 1);
});

test('connection loss cannot confirm a user interruption', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn();
  await controller.dispatch('ui_interrupt', { target: agent.id });
  client.emit('closed');
  const view = controller.view(controller.find(agent.id));
  assert.equal(view.status, 'unknown');
  assert.equal(view.user_control_status, 'unconfirmed');
  assert.equal(controller.hasActiveWork(), true);
});

test('unconfirmed native state stays unknown and occupies capacity after user stop', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn();
  const a = controller.find(agent.id); a.status = 'unknown'; a.turnId = null;
  client.handler = method => { if (method === 'thread/read') throw new Error('offline'); };
  const result = await controller.dispatch('ui_interrupt', { target: agent.id });
  assert.equal(result.status, 'unconfirmed'); assert.equal(a.status, 'unknown'); assert.equal(controller.occupies(a), true);
});

test('paused pending requests cannot be answered by Claude', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn();
  client.ask('question', 'item/tool/requestUserInput', pendingQuestion()); await tick();
  await controller.dispatch('ui_interrupt', { target: agent.id });
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 'question', answer: { answers: { choice: { answers: ['yes'] } } } }), /paused by the user/);
  assert.equal(client.replies.length, 0);
});

test('user resume holds an exclusive barrier while pause persistence is pending', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted'); await tick();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const persist = controller.persist.bind(controller); controller.persist = () => gate;
  const userSend = controller.dispatch('ui_send', { target: agent.id, message: 'resume' });
  await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'Claude followup' }), /direct user message/);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
  controller.persist = persist; release(); await userSend;
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('closed paused ownership remains paused on native thread adoption', async t => {
  const { client, controller, spawn } = await setup(t);
  const nativeId = '12345678-1234-4234-8234-123456789abc';
  client.handler = method => { if (method === 'thread/start') return { thread: { id: nativeId } }; };
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(nativeId, agent.turn_id, 'interrupted'); await tick();
  await controller.dispatch('close_agent', { target: agent.id });
  client.handler = (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/workspace', status: { type: 'idle' } } };
    if (method === 'thread/resume') return { thread: { status: { type: 'idle' } } };
  };
  await assert.rejects(controller.dispatch('followup_task', { target: nativeId, message: 'continue' }), /remains paused by the user/);
  const adopted = controller.find(nativeId);
  assert.equal(adopted.userPaused, true);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
  await controller.dispatch('ui_send', { target: adopted.id, message: 'resume' });
  assert.equal(adopted.userPaused, false);
});

test('closed paused thread tombstone survives controller restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-paused-close-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json'), nativeId = '12345678-1234-4234-8234-123456789abc';
  const { client, controller, spawn } = await setup(t, { statePath });
  client.handler = method => { if (method === 'thread/start') return { thread: { id: nativeId } }; };
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(nativeId, agent.turn_id, 'interrupted'); await controller.dispatch('close_agent', { target: agent.id });
  const otherClient = new MockClient();
  otherClient.handler = (method, params) => { if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/workspace', status: { type: 'idle' } } }; };
  const second = new AgentController({ client: otherClient, statePath, nativeRoleResolver: async () => undefined });
  await second.init(); t.after(() => second.close());
  await assert.rejects(second.dispatch('followup_task', { target: nativeId, message: 'continue' }), /remains paused by the user/);
  assert.equal(second.find(nativeId).userPaused, true);
});

test('late root turn changes a confirmed stop until that turn completes', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  client.note('turn/started', { threadId: agent.thread_id, turn: { id: 'late-root' } }); await tick();
  assert.equal(controller.view(controller.find(agent.id)).user_control_status, 'stopping');
  assert.ok(client.calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'late-root'));
  client.complete(agent.thread_id, 'late-root', 'interrupted');
  assert.equal(controller.view(controller.find(agent.id)).user_control_status, 'stopped');
});

test('paused descendants remain protected after root ownership closes', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(), child = '12345678-1234-4234-8234-123456789abc';
  client.note('thread/started', { thread: { id: child, parentThreadId: agent.thread_id } });
  await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  await controller.dispatch('close_agent', { target: agent.id });
  client.handler = (method, params) => { if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/workspace', status: { type: 'idle' } } }; };
  await assert.rejects(controller.dispatch('followup_task', { target: child, message: 'continue' }), /remains paused by the user/);
  assert.equal(controller.find(child).userPaused, true);
});

test('ambiguous user resume restores interception and interrupts an observed start', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  client.handler = (method, params) => {
    if (method === 'turn/start') {
      client.note('turn/started', { threadId: params.threadId, turn: { id: 'lost-reply-turn' } });
      throw new Error('transport lost');
    }
  };
  await assert.rejects(controller.dispatch('ui_send', { target: agent.id, message: 'resume' }), /transport lost/);
  assert.equal(controller.find(agent.id).userPaused, true);
  assert.ok(client.calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'lost-reply-turn'));
  assert.notEqual(controller.view(controller.find(agent.id)).user_control_status, 'stopped');
});

test('persisted terminal root with a late turn is reconciled on restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-late-root-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath });
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  client.note('turn/started', { threadId: agent.thread_id, turn: { id: 'late-root' } });
  await controller.persist();
  const nextClient = new MockClient();
  nextClient.handler = method => { if (method === 'thread/read') return { thread: { status: { type: 'idle' } } }; };
  const second = new AgentController({ client: nextClient, statePath, nativeRoleResolver: async () => undefined });
  await second.init(); t.after(() => second.close());
  assert.equal(second.find(agent.id).turnId, null);
  assert.equal(second.view(second.find(agent.id)).user_control_status, 'stopped');
});

test('late unlinked descendant turn is stopped only after ownership is established', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); await controller.dispatch('ui_interrupt', { target: agent.id });
  client.complete(agent.thread_id, agent.turn_id, 'interrupted');
  client.note('turn/started', { threadId: 'late', turn: { id: 'late-turn' } });
  assert.equal(client.calls.filter(c => c.method === 'turn/interrupt' && c.params.threadId === 'late').length, 0);
  client.note('thread/started', { thread: { id: 'late', parentThreadId: agent.thread_id } }); await tick();
  assert.equal(client.calls.filter(c => c.method === 'turn/interrupt' && c.params.threadId === 'late').length, 1);
  assert.equal(controller.view(controller.find(agent.id)).user_control_status, 'stopping');
  client.complete('late', 'late-turn', 'interrupted');
  assert.equal(controller.view(controller.find(agent.id)).user_control_status, 'stopped');
});

test('native interruption waits for the user pause to become durable', async t => {
  const { client, controller, spawn } = await setup(t);
  const agent = await spawn(); let release; const gate = new Promise(resolve => { release = resolve; });
  const persist = controller.persist.bind(controller); controller.persist = () => gate;
  const stop = controller.dispatch('ui_interrupt', { target: agent.id });
  client.note('thread/started', { thread: { id: 'child-gated', parentThreadId: agent.thread_id } });
  client.note('turn/started', { threadId: 'child-gated', turn: { id: 'child-turn' } });
  await tick(); assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 0);
  controller.persist = persist; release(); await stop; await tick();
  assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 2);
});

test('an asynchronous interruption rejection stays local to its agent', async t => {
  const { client, controller, spawn } = await setup(t);
  const first = await spawn(), second = await spawn();
  const errors = []; controller.on('controllerError', error => errors.push(error));
  controller.find(first.id).interrupted = true;
  client.handler = method => { if (method === 'turn/interrupt') throw Object.assign(new Error('interrupt rejected'), { code: -32000 }); };
  client.note('turn/started', { threadId: first.thread_id, turn: { id: first.turn_id } });
  await tick();
  assert.equal(errors.length, 0); assert.equal(controller.find(second.id).status, 'running');
  assert.ok(controller.eventsAfter(0).some(event => event.agent_id === first.id && event.code === 'interrupt_unconfirmed'));
});

test('default available context returns preview once without retaining private history or preview', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller } = await setup(t, { statePath });
  const args = { message: 'Work', cwd: '/workspace' };
  await assert.rejects(controller.dispatch('spawn_agent', args), /validated snapshot/);
  await assert.rejects(controller.dispatch('spawn_agent', { ...args, context_mode: 'all' }), /context_mode/);
  await assert.rejects(controller.dispatch('spawn_agent', { ...args, snapshot: { history: [] } }), /validated snapshot/);
  assert.equal(client.calls.length, 0);
  const snapshot = { history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE AVAILABLE HISTORY' }] }], digest: 'digest', stats: { messages: 1 }, preview: { text: 'PRIVATE PREVIEW' } };
  const agent = await controller.dispatch('spawn_agent', { ...args, snapshot });
  assert.equal(client.calls.filter((call) => call.method === 'thread/inject_items').length, 1);
  assert.deepEqual(agent.context_snapshot, { digest: 'digest', stats: { messages: 1 }, preview: snapshot.preview });
  assert.doesNotMatch(JSON.stringify(agent), /PRIVATE AVAILABLE HISTORY/);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE AVAILABLE HISTORY/);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE PREVIEW/);
  assert.doesNotMatch(JSON.stringify(await controller.dispatch('list_agents')), /PRIVATE PREVIEW/);
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /PRIVATE (?:PREVIEW|AVAILABLE HISTORY)/);
});

test('none context skips injection and cwd accepts absolute POSIX and Windows paths only', async (t) => {
  const { client, controller, spawn } = await setup(t);
  for (const cwd of ['relative/path', 'C:relative', './workspace']) await assert.rejects(spawn({ cwd }), /absolute path/);
  assert.equal(client.calls.length, 0);
  for (const cwd of ['/nonexistent/workspace', 'C:\\nonexistent\\workspace', '\\\\server\\share\\workspace']) {
    const agent = await spawn({ cwd });
    assert.equal(agent.context_snapshot, null);
  }
  assert.equal(client.calls.filter((call) => call.method === 'thread/inject_items').length, 0);
  assert.equal(controller.snapshot().agents[0].context_snapshot, null);
});

test('spawn uses user sandbox defaults, injects snapshot once, queues mailbox, and resumes same thread', async (t) => {
  const { client, controller, spawn } = await setup(t);
  const snapshot = { history: [{ type: 'message', role: 'user', content: [] }], digest: 'hash', stats: { count: 1 } };
  const agent = await spawn({ model: 'dynamic-model', reasoning_effort: 'high', context_mode: 'available', snapshot });
  assert.deepEqual(agent.context_snapshot, { digest: snapshot.digest, stats: snapshot.stats });
  assert.deepEqual(controller.snapshot().agents[0].context_snapshot, agent.context_snapshot);
  assert.equal(Object.hasOwn((await controller.dispatch('list_agents')).agents[0], 'context_snapshot'), false);
  const start = client.calls[0].params;
  assert.equal(start.serviceTier, 'default'); assert.equal(start.ephemeral, false);
  assert.equal(start.model, 'dynamic-model'); assert.equal(start.config['features.default_mode_request_user_input'], true);
  assert.equal(start.dynamicTools[0].type, 'function'); assert.equal(start.dynamicTools[0].name, 'notify_parent');
  assert.equal(start.sandbox, 'danger-full-access'); assert.equal(start.approvalPolicy, 'never');
  for (const key of ['baseInstructions', 'developerInstructions', 'multiAgentMode']) assert.equal(Object.hasOwn(start, key), false);
  assert.deepEqual(client.calls[1], { method: 'thread/inject_items', params: { threadId: 'thread-1', items: snapshot.history } });
  assert.equal(client.calls[2].params.effort, 'high'); assert.equal(client.calls[2].params.serviceTierForTurn, 'default');
  assert.match(client.calls[2].params.input[0].text, /Claude is your parent/);
  client.complete(); await tick();
  assert.deepEqual(await controller.dispatch('send_message', { target: agent.id, message: 'hello' }), { agent_id: agent.id, status: 'stored', model_turn_started: false });
  assert.deepEqual(client.calls.at(-1), { method: 'thread/inject_items', params: { threadId: 'thread-1',
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] } });
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  await controller.dispatch('followup_task', { target: agent.id, message: 'second task' });
  assert.equal(client.calls.filter((c) => c.method === 'thread/start').length, 1);
  assert.equal(client.calls.filter((c) => c.method === 'thread/inject_items').length, 2);
  assert.equal(client.calls.filter((c) => c.method === 'thread/resume').length, 0);
  assert.equal(client.calls.at(-1).params.input[0].text, 'second task');
});

test('a restored old agent resumes once and runs repeated tasks on its existing native thread', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-reuse-old-'));
  let restored;
  t.after(async () => { await restored?.close(); await rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath });
  const original = await spawn(); client.complete(original.thread_id, original.turn_id);
  await controller.persist(); await controller.close();
  const restoredClient = new MockClient();
  restoredClient.handler = (method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } } };
  };
  restored = new AgentController({ client: restoredClient, statePath });
  await restored.init();
  const resume = restoredClient.handler;
  restoredClient.handler = method => {
    if (method === 'thread/resume') throw Object.assign(new Error('This thread already has an active native writer.'), { code: -32600, reason: 'thread_writer_conflict' });
  };
  await assert.rejects(restored.dispatch('followup_task', { target: original.id, message: 'blocked task' }), { reason: 'thread_writer_conflict' });
  assert.equal(restored.find(original.id).loaded, false);
  assert.equal(restored.find(original.id).status, 'completed');
  assert.deepEqual(restoredClient.calls.map(call => call.method), ['thread/resume']);
  restoredClient.handler = resume;
  for (const operation of ['followup_task', 'ui_send', 'followup_task']) {
    const current = await restored.dispatch(operation, { target: original.id, message: 'next task' });
    assert.equal(current.thread_id, original.thread_id);
    restoredClient.complete(current.thread_id, current.turn_id);
  }
  assert.deepEqual(restoredClient.calls.map(call => call.method), ['thread/resume', 'thread/resume', 'turn/start', 'turn/start', 'turn/start']);
  assert.deepEqual(restoredClient.calls[0].params, { threadId: original.thread_id, excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
});

test('completed final messages and requests before RPC replies are not lost', async (t) => {
  const { client, controller, spawn } = await setup(t);
  client.handler = (method, params) => {
    if (method === 'thread/start') {
      client.ask('early-q', 'item/tool/requestUserInput', pendingQuestion());
      return { thread: { id: 'thread-1' } };
    }
    if (method === 'turn/start') {
      client.note('turn/started', { threadId: params.threadId, turn: { id: 'turn-1' } });
      client.note('item/completed', { threadId: params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Done early' } });
      client.complete();
      return { turn: { id: 'turn-1' } };
    }
  };
  const agent = await spawn(); await tick();
  assert.equal(agent.status, 'completed');
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'question').length, 0);
  assert.deepEqual(controller.eventsAfter(0).filter((e) => e.kind === 'completed').map((e) => e.result), ['Done early']);
  client.complete(); assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'completed').length, 1);
});

test('nested threads and normal tool output never become parent events', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('item/completed', { threadId: 'nested', turnId: 'nested-turn', item: { type: 'agentMessage', phase: 'finalAnswer', text: 'SECRET CHILD RESULT' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', aggregatedOutput: 'SECRET TOOL OUTPUT' } });
  client.note('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'collabAgentToolCall', prompt: 'SECRET NESTED PROMPT' } });
  client.ask('nested-request', 'item/tool/requestUserInput', pendingQuestion('nested', 'nested-turn'));
  await tick();
  assert.equal(controller.eventsAfter(0).length, 0);
  assert.equal(controller.snapshot().agents[0].activity, 'delegated to subagent');
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /SECRET/);
  assert.equal(client.rejected[0].id, 'nested-request');
});

test('native questions need exact IDs, answer once, and continue original turn', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.ask(7, 'item/tool/requestUserInput', pendingQuestion()); await tick();
  assert.equal(controller.snapshot().agents[0].status, 'waiting');
  assert.deepEqual(controller.eventsAfter(0)[0].reply_format, { answers: { choice: { answers: ['<text>'] } } });
  assert.deepEqual((await controller.dispatch('list_agents')).agents[0].pending_requests[0].reply_format, controller.eventsAfter(0)[0].reply_format);
  await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'bypass question' }), /answer_agent/);
  await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'bypass question' }), /answer_agent/);
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 7, answer: { answers: { wrong: { answers: ['x'] } } } }), (error) => {
    assert.equal(error.code, 'invalid_answer'); assert.equal(error.request_id, '7');
    assert.deepEqual(error.reply_format, { answers: { choice: { answers: ['<text>'] } } });
    return true;
  });
  assert.equal(controller.snapshot().agents[0].pending_requests.length, 1);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 7, answer: { answers: { choice: { answers: ['selected'] } } } });
  assert.deepEqual(client.replies[0], { id: 7, result: { answers: { choice: { answers: ['selected'] } } } });
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 7, answer: {} }));
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(controller.snapshot().agents[0].status, 'running');
});

test('all approval families require explicit valid protocol response', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  const cases = [
    ['item/commandExecution/requestApproval', { decision: 'accept' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp'], write: null } }, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'cancel', content: null, _meta: null }],
  ];
  const formats = [
    { decision: 'accept|acceptForSession|decline|cancel' },
    { decision: 'accept|acceptForSession|decline|cancel' },
    { permissions: {}, scope: 'turn' },
    { action: 'accept|decline|cancel', content: '<form data or null>', _meta: null },
  ];
  for (const [index, [method, answer]] of cases.entries()) {
    client.ask(index, method, { threadId: 'thread-1', turnId: 'turn-1', itemId: 'approval' }); await tick();
    assert.deepEqual(controller.eventsAfter(0).at(-1).reply_format, formats[index]);
    assert.deepEqual((await controller.dispatch('list_agents')).agents[0].pending_requests[0].reply_format, formats[index]);
    assert.equal(client.replies.length, index);
    await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: index, answer: { decision: 'allow' } }));
    await controller.dispatch('answer_agent', { target: agent.id, request_id: index, answer });
    assert.deepEqual(client.replies.at(-1).result, answer);
  }
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'approval').length, 0);
  client.ask('limited', 'item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', availableDecisions: ['decline', 'cancel'] });
  assert.deepEqual(controller.eventsAfter(0).at(-1).reply_format, { decision: '<one value from availableDecisions>' });
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 'limited', answer: { decision: 'accept' } }), /availableDecisions/);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 'limited', answer: { decision: 'decline' } });
});

test('answers are isolated to their owning agent', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn(); const other = await spawn();
  client.ask('private', 'item/tool/requestUserInput', pendingQuestion());
  await assert.rejects(controller.dispatch('answer_agent', { target: other.id, request_id: 'private', answer: { answers: { choice: { answers: ['x'] } } } }));
  assert.equal(client.replies.length, 0);
});

test('external request IDs are strings while replies preserve numeric wire IDs and collisions are rejected', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.ask(0, 'item/tool/requestUserInput', pendingQuestion());
  assert.equal(controller.eventsAfter(0)[0].request_id, '0');
  assert.equal(controller.snapshot().agents[0].pending_requests[0].request_id, '0');
  client.ask('0', 'item/tool/requestUserInput', pendingQuestion()); await tick();
  assert.deepEqual(client.rejected.map((r) => [r.id, r.code]), [['0', -32600]]);
  client.note('serverRequest/resolved', { threadId: 'thread-1', requestId: '0' });
  assert.equal(controller.snapshot().agents[0].pending_requests.length, 1);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: { answers: { choice: { answers: ['yes'] } } } });
  assert.equal(client.replies[0].id, 0);
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: {} }));
});

test('unclassified final fallback applies only on success and explicit final beats it', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  const message = (text, phase) => client.note('item/completed', { threadId: 'thread-1', turnId: `turn-${client.turnCount}`, item: { type: 'agentMessage', text, phase } });
  message('Legacy final response', null); message('Explicit commentary after legacy response', 'commentary');
  client.complete(); assert.equal(controller.eventsAfter(0).at(-1).result, 'Legacy final response');
  await controller.dispatch('followup_task', { target: 'thread-1', message: 'second' });
  message('Explicit final', 'final_answer'); message('Unclassified after explicit', null);
  client.complete('thread-1', 'turn-2'); assert.equal(controller.eventsAfter(0).at(-1).result, 'Explicit final');
  await controller.dispatch('followup_task', { target: 'thread-1', message: 'third' });
  message('Unclassified failed turn content', null);
  client.complete('thread-1', 'turn-3', 'failed', { message: 'Failure' });
  assert.equal(controller.eventsAfter(0).at(-1).kind, 'failed');
  assert.equal(controller.snapshot().agents[0].result, null);
});

test('verified descendants forward only questions and approvals to root and retain wire routing', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('thread/started', { thread: { id: 'grandchild', source: { subAgent: { thread_spawn: { parent_thread_id: 'child' } } } } });
  client.note('turn/started', { threadId: 'grandchild', turn: { id: 'grand-turn' } });
  client.note('item/completed', { threadId: 'grandchild', turnId: 'grand-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'SECRET CHILD FINAL' } });
  client.note('item/completed', { threadId: 'grandchild', turnId: 'grand-turn', item: { type: 'commandExecution', aggregatedOutput: 'SECRET TOOL OUTPUT' } });
  client.ask(10, 'item/tool/requestUserInput', pendingQuestion('grandchild', 'grand-turn'));
  client.ask(11, 'item/fileChange/requestApproval', { threadId: 'grandchild', turnId: 'grand-turn', itemId: 'file', reason: 'Need permission' });
  await tick();
  const events = controller.eventsAfter(0);
  assert.deepEqual(events.map((e) => [e.agent_id, e.kind, e.source_thread_id]), [[agent.id, 'question', 'grandchild'], [agent.id, 'approval', 'grandchild']]);
  assert.equal(events[0].request_id, '10'); assert.doesNotMatch(JSON.stringify(controller.snapshot()), /SECRET/);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '10', answer: { answers: { choice: { answers: ['yes'] } } } });
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '11', answer: { decision: 'decline' } });
  assert.deepEqual(client.replies.map((r) => r.id), [10, 11]);
  assert.equal(controller.snapshot().agents[0].status, 'running');
  assert.equal(client.rejected.length, 0);
});

test('descendant discovery and requests before root spawn reply are replayed safely', async (t) => {
  const { client, controller, spawn } = await setup(t);
  client.handler = (method) => {
    if (method !== 'thread/start') return;
    client.note('thread/started', { thread: { id: 'early-child', source: { subAgent: { thread_spawn: { parent_thread_id: 'thread-1' } } } } });
    client.note('turn/started', { threadId: 'early-child', turn: { id: 'child-turn' } });
    client.ask(0, 'item/tool/requestUserInput', pendingQuestion('early-child', 'child-turn'));
    return { thread: { id: 'thread-1' } };
  };
  const agent = await spawn(); await tick();
  assert.equal(agent.status, 'waiting');
  assert.equal(controller.eventsAfter(0)[0].source_thread_id, 'early-child');
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: { answers: { choice: { answers: ['resolved'] } } } });
  assert.equal(client.replies[0].id, 0); assert.equal(client.rejected.length, 0);
});

test('a still-running descendant can ask after root finishes without reviving root turn', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.complete();
  client.ask('child-q', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'bypass' }), /answer_agent/);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 'child-q', answer: { answers: { choice: { answers: ['done'] } } } });
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  assert.equal(controller.snapshot().agents[0].activity, 'completed');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(client.replies.at(-1).id, 'child-q');
});

test('descendant questions and approvals asked before root completion remain deliverable and answerable', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.ask(0, 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  client.ask(1, 'item/fileChange/requestApproval', { threadId: 'child', turnId: 'child-turn', itemId: 'file', reason: 'Need permission' });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Root result' } });
  client.complete(); await tick();
  const listed = (await controller.dispatch('list_agents')).agents[0];
  assert.equal(listed.status, 'completed');
  assert.deepEqual(listed.pending_requests.map((r) => [r.request_id, r.source_thread_id]), [['0', 'child'], ['1', 'child']]);
  assert.deepEqual(controller.eventsAfter(0, [agent.id]).map((event) => event.kind), ['question', 'approval', 'completed']);
  assert.equal(controller.eventsAfter(0).at(-1).result, 'Root result');
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: { answers: { choice: { answers: ['yes'] } } } });
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '1', answer: { decision: 'decline' } });
  assert.deepEqual(client.replies.map((r) => r.id), [0, 1]);
  client.complete();
  assert.equal(controller.eventsAfter(0).filter((event) => event.kind === 'completed').length, 1);
  assert.equal(controller.snapshot().agents[0].result, 'Root result');
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  assert.deepEqual(controller.snapshot().agents[0].pending_requests, []);
});

test('descendant pending requests clear only on their own lifecycle or controller shutdown', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  for (const id of ['a', 'b', 'c']) {
    client.note('thread/started', { thread: { id, parentThreadId: 'thread-1' } });
    client.note('turn/started', { threadId: id, turn: { id: `${id}-turn` } });
    client.ask(id, 'item/tool/requestUserInput', pendingQuestion(id, `${id}-turn`));
  }
  client.complete();
  client.complete('a', 'a-turn');
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 'a', answer: {} }), /No matching/);
  assert.deepEqual(controller.snapshot().agents[0].pending_requests.map((r) => r.request_id), ['b', 'c']);
  client.note('serverRequest/resolved', { threadId: 'b', requestId: 'b' });
  assert.deepEqual(controller.snapshot().agents[0].pending_requests.map((r) => r.request_id), ['c']);
  await controller.close();
  assert.deepEqual(controller.snapshot().agents[0].pending_requests, []);
  assert.equal(controller.snapshot().agents[0].status, 'completed');
});

test('notify_parent returns dynamic tool response and unknown requests are rejected', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.ask('notice', 'item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', tool: 'notify_parent', arguments: { message: 'Need a decision' } });
  client.ask('invalid', 'item/tool/call', { threadId: 'thread-1', tool: 'notify_parent', arguments: {} });
  client.ask('unknown', 'something/new', { threadId: 'thread-1' }); await tick();
  assert.deepEqual(client.replies[0].result, { contentItems: [{ type: 'inputText', text: 'Delivered to parent.' }], success: true });
  assert.equal(client.replies[1].result.success, false); assert.equal(client.rejected[0].code, -32601);
  assert.equal(controller.eventsAfter(0)[0].message, 'Need a decision');
});

test('send and followup steer running turn; interrupt never starts a new turn', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  assert.deepEqual(await controller.dispatch('send_message', { target: agent.id, message: 'steer one' }), { agent_id: agent.id, status: 'steered', turn_id: 'turn-1' });
  client.handler = (method) => { if (method === 'turn/steer') return { turnId: 'accepted-turn' }; };
  assert.deepEqual(await controller.dispatch('followup_task', { target: agent.id, message: 'steer two' }), { agent_id: agent.id, status: 'steered', turn_id: 'accepted-turn' });
  assert.equal(client.calls.filter((c) => c.method === 'turn/steer').length, 2);
  assert.equal(client.calls.at(-1).params.expectedTurnId, 'turn-1');
  await controller.dispatch('interrupt_agent', { target: agent.id });
  client.complete('thread-1', 'turn-1', 'interrupted'); await tick();
  assert.equal(controller.eventsAfter(0).at(-1).kind, 'interrupted');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('normal compaction completion clears activity without blocking other agents or descendant replies', async t => {
  for (const completion of ['item/completed', 'thread/compacted']) {
    const { client, controller, spawn } = await setup(t); const root = await spawn(), other = await spawn();
    client.note('thread/started', { thread: { id: 'compaction-child', parentThreadId: root.thread_id } });
    client.note('turn/started', { threadId: 'compaction-child', turn: { id: 'child-turn' } });
    client.note('item/started', { threadId: root.thread_id, turnId: root.turn_id, item: { type: 'contextCompaction', id: 'normal-compact' } });
    assert.equal(controller.find(root.id).activity, 'compacting context');
    const steered = await controller.dispatch('send_message', { target: other.id, message: 'Continue the independent task' });
    assert.equal(steered.status, 'steered'); assert.equal(client.calls.at(-1).params.threadId, other.thread_id);
    client.ask('child-during-compaction', 'item/tool/requestUserInput', pendingQuestion('compaction-child', 'child-turn')); await tick();
    assert.equal(controller.find(root.id).pending[0].params.threadId, 'compaction-child');
    await controller.dispatch('answer_agent', { target: root.id, request_id: 'child-during-compaction', answer: { answers: { choice: { answers: ['continue'] } } } });
    assert.equal(client.replies.at(-1).id, 'child-during-compaction');
    client.note(completion, { threadId: root.thread_id, turnId: root.turn_id, item: { type: 'contextCompaction', id: 'normal-compact' } });
    assert.equal(controller.find(root.id).activity, 'working');
    assert.equal(controller.find(other.id).status, 'running');
    assert.equal(controller.descendantTurns.get('compaction-child'), 'child-turn');
    client.complete(other.thread_id, other.turn_id); client.complete('compaction-child', 'child-turn');
    client.complete(root.thread_id, root.turn_id);
    assert.equal(controller.eventsAfter().filter(e => e.kind === 'completed').length, 2);
    assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 0);
  }
});

test('completed normal compaction returns to working before the model produces its answer', async t => {
  for (const completion of ['item/completed', 'thread/compacted']) {
    const { client, controller, spawn } = await setup(t); const root = await spawn();
    client.note('item/started', { threadId: root.thread_id, turnId: root.turn_id, item: { type: 'contextCompaction', id: 'normal-compact' } });
    client.note(completion, { threadId: root.thread_id, turnId: root.turn_id, item: { type: 'contextCompaction', id: 'normal-compact' } });
    assert.equal(controller.find(root.id).activity, 'working'); assert.equal(controller.find(root.id).status, 'running');
  }
});

test('true overflow compacts after failed turn, waits for compaction turn, and retries once', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('error', { threadId: 'thread-1', turnId: 'turn-1', error: { message: 'Too long', codexErrorInfo: 'contextWindowExceeded' } });
  assert.equal(client.calls.filter((c) => c.method === 'thread/compact/start').length, 0);
  client.complete('thread-1', 'turn-1', 'failed');
  assert.equal(client.calls.at(-1).method, 'thread/compact/start');
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'compact-1' } });
  client.note('item/started', { threadId: 'thread-1', turnId: 'compact-1', item: { type: 'contextCompaction', id: 'compact-item' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'compact-1', item: { type: 'contextCompaction', id: 'compact-item' } });
  assert.equal(controller.snapshot().agents[0].activity, 'working');
  assert.equal(controller.snapshot().agents[0].status, 'compacting');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  client.complete('thread-1', 'compact-1'); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 2);
  assert.match(client.calls.at(-1).params.input[0].text, /^Continue the existing task/);
  assert.doesNotMatch(client.calls.at(-1).params.input[0].text, /Solve task/);
  client.complete('thread-1', 'turn-2', 'failed', { message: 'Still too long', codexErrorInfo: 'contextWindowExceeded' }); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'thread/compact/start').length, 1);
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'compacting').length, 1);
  assert.equal(controller.eventsAfter(0).at(-1).kind, 'failed');
});

test('compaction failures terminate without retry loops', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.handler = (method) => { if (method === 'thread/compact/start') throw new Error('compact unavailable'); };
  client.complete('thread-1', 'turn-1', 'failed', { message: 'overflow', codexErrorInfo: 'contextWindowExceeded' }); await tick();
  assert.match(controller.eventsAfter(0).at(-1).message, /compaction failed/);
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('compaction turn failure and parent interrupt prevent continuation', async (t) => {
  for (const interrupt of [false, true]) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn();
    client.complete('thread-1', 'turn-1', 'failed', { codexErrorInfo: 'contextWindowExceeded' });
    client.note('turn/started', { threadId: 'thread-1', turn: { id: 'compact' } });
    if (interrupt) await controller.dispatch('interrupt_agent', { target: agent.id });
    client.complete('thread-1', 'compact', interrupt ? 'completed' : 'failed', { message: 'compaction failed' }); await tick();
    assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
    assert.equal(controller.eventsAfter(0).at(-1).kind, interrupt ? 'interrupted' : 'failed');
  }
});

test('interrupt between failed turn and compaction start wins and emits once', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.complete('thread-1', 'turn-1', 'failed', { codexErrorInfo: 'contextWindowExceeded' });
  await controller.dispatch('interrupt_agent', { target: agent.id });
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'late-compact' } });
  client.complete('thread-1', 'late-compact'); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(client.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'interrupted').length, 1);
  assert.equal(controller.snapshot().agents[0].status, 'interrupted');
});

test('interrupt while turn/start reply is pending interrupts the observed turn only once', async (t) => {
  const { client, controller, spawn } = await setup(t);
  let release;
  client.handler = (method) => {
    if (method === 'turn/start') return new Promise((resolve) => { release = resolve; });
  };
  const starting = spawn();
  await tick(); const agent = controller.snapshot().agents[0];
  await controller.dispatch('interrupt_agent', { target: agent.id });
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'late-start' } });
  release({ turn: { id: 'late-start' } }); await starting;
  client.complete('thread-1', 'late-start', 'interrupted'); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'interrupted').length, 1);
});

test('ack removes delivered event while retaining final result and actual cached usage', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', text: 'Routine progress' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Verified final result' } });
  client.note('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: { cachedInputTokens: 234 } } });
  client.complete(); await tick();
  const final = controller.eventsAfter(0)[0]; assert.equal(final.result, 'Verified final result');
  await controller.ackEvents(final.seq);
  assert.deepEqual(controller.eventsAfter(0), []);
  assert.equal(controller.snapshot().agents[0].result, 'Verified final result');
  assert.equal(controller.snapshot().agents[0].token_usage.total.cachedInputTokens, 234);
});

test('close_agent removes idle ownership and events durably while ignoring late events', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.complete('child', 'child-turn'); client.complete();
  const seq = controller.nextSeq;
  assert.deepEqual(await controller.dispatch('close_agent', { target: agent.id }), { agent_id: agent.id, thread_id: 'thread-1', status: 'closed' });
  assert.deepEqual(client.calls.at(-1), { method: 'thread/unsubscribe', params: { threadId: 'thread-1' } });
  assert.deepEqual(controller.snapshot().agents, []); assert.deepEqual(controller.eventsAfter(0), []);
  assert.equal(controller.nextSeq, seq); assert.equal(controller.threads.size, 0); assert.equal(controller.descendants.size, 0);
  const emitLate = (source) => {
    source.note('turn/started', { threadId: 'thread-1', turn: { id: 'late' } });
    source.note('thread/started', { thread: { id: 'late-child', parentThreadId: 'thread-1' } });
    source.ask('late-request', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  };
  emitLate(client); await tick();
  assert.equal(controller.unlinkedThreads.size, 0); assert.deepEqual(controller.eventsAfter(0), []);
  const restartedClient = new MockClient();
  const restarted = new AgentController({ client: restartedClient, statePath }); await restarted.init(); t.after(() => restarted.close());
  restarted.starting = 1; emitLate(restartedClient); await tick(); restarted.starting = 0;
  assert.deepEqual(restarted.snapshot().agents, []); assert.deepEqual(restarted.eventsAfter(0), []);
  assert.equal(restarted.unlinkedThreads.size, 0); assert.deepEqual(restarted.early, []);
  assert.equal(restartedClient.rejected[0].id, 'late-request');
});

test('close_agent cleans failed starts without thread IDs and unsubscribes only loaded threads', async (t) => {
  const { client, controller, spawn } = await setup(t);
  client.handler = (method) => { if (method === 'thread/start') throw new Error('start failed'); };
  await assert.rejects(spawn(), /start failed/);
  const failed = controller.snapshot().agents[0];
  await controller.dispatch('close_agent', { target: failed.id });
  assert.equal(client.calls.filter((call) => call.method === 'thread/unsubscribe').length, 0);
  client.handler = undefined;
  const agent = await spawn(); client.complete();
  controller.find(agent.id).loaded = false;
  await controller.dispatch('close_agent', { target: agent.id });
  assert.equal(client.calls.filter((call) => call.method === 'thread/unsubscribe').length, 0);
  assert.deepEqual(controller.snapshot().agents, []);
});

test('close_agent rejects active roots, descendants and pending requests', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /idle and terminal/);
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.complete();
  await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /active descendant/);
  client.ask('child-q', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /pending requests/);
  assert.equal(client.calls.filter((call) => call.method === 'thread/unsubscribe').length, 0);
  client.complete('child', 'child-turn');
  await controller.dispatch('close_agent', { target: agent.id });
});

test('close_agent accepts failed and interrupted turns without deleting their saved history', async (t) => {
  const { client, controller, spawn } = await setup(t);
  for (const status of ['failed', 'interrupted']) {
    const agent = await spawn();
    client.complete(agent.thread_id, agent.turn_id, status, status === 'failed' ? { message: 'Task failed' } : undefined);
    await controller.dispatch('close_agent', { target: agent.id });
  }
  assert.deepEqual(controller.snapshot().agents, []);
  assert.deepEqual(client.calls.filter((call) => call.method !== 'thread/start' && call.method !== 'turn/start').map((call) => call.method), ['thread/unsubscribe', 'thread/unsubscribe']);
});

test('close_agent excludes in-flight send, start and concurrent sends during unsubscribe', async (t) => {
  for (const mode of ['steer', 'store', 'followup', 'spawn']) {
    const { client, controller, spawn } = await setup(t);
    let agent, release;
    if (mode !== 'spawn') { agent = await spawn(); if (mode !== 'steer') client.complete(); }
    client.handler = (method) => {
      if (method === ({ steer: 'turn/steer', store: 'thread/inject_items', followup: 'turn/start', spawn: 'turn/start' })[mode]) {
        return new Promise((resolve) => { release = resolve; });
      }
    };
    const operation = mode === 'spawn' ? spawn() : controller.dispatch(mode === 'followup' ? 'followup_task' : 'send_message', { target: agent.id, message: 'pending' });
    await tick(); agent ??= controller.snapshot().agents[0];
    if (mode === 'steer') client.complete();
    if (mode === 'followup' || mode === 'spawn') client.complete('thread-1', 'pending-turn');
    await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /idle and terminal/);
    release({ turn: { id: 'pending-turn' } }); await operation;
    let finishUnsubscribe;
    client.handler = (method) => { if (method === 'thread/unsubscribe') return new Promise((resolve) => { finishUnsubscribe = resolve; }); };
    const closing = controller.dispatch('close_agent', { target: agent.id });
    await tick();
    await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'racing send' }), /closing/);
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'racing start' }), /closing/);
    await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /already closing/);
    finishUnsubscribe({}); await closing;
  }
});

test('close_agent preserves ownership if unsubscribe fails or a descendant starts during it', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  client.handler = (method) => { if (method === 'thread/unsubscribe') throw new Error('unsubscribe failed'); };
  await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /unsubscribe failed/);
  assert.equal(controller.find(agent.id).status, 'completed');
  client.handler = (method) => {
    if (method === 'thread/unsubscribe') {
      client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
      client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
      return {};
    }
    if (method === 'thread/resume') return { thread: { status: { type: 'idle' } } };
  };
  await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /active descendant/);
  assert.equal(controller.find(agent.id).status, 'completed');
  assert.equal(controller.find(agent.id).loaded, true);
  assert.equal(client.calls.filter((call) => call.method === 'thread/resume').length, 1);
  assert.equal(controller.descendantTurns.get('child'), 'child-turn');
});

test('failed subscription restoration remains unconfirmed and reports recovery', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  client.handler = method => {
    if (method === 'thread/unsubscribe') {
      client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
      client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } }); return {};
    }
    if (method === 'thread/resume') throw new Error('resume failed');
  };
  await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /active descendant/);
  assert.equal(controller.find(agent.id).loaded, false); assert.equal(controller.find(agent.id).status, 'unknown');
  assert.match(controller.eventsAfter(0).find(e => e.code === 'subscription_restore_failed').message, /resume failed/);
});

test('automatic compaction emits once per item without claiming an overflow', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  for (const method of ['item/started', 'item/completed']) client.note(method, { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'auto', type: 'contextCompaction' } });
  assert.equal(controller.eventsAfter(0).length, 1); assert.equal(controller.eventsAfter(0)[0].reason, undefined);
});

test('models use pagination and actual catalog effort IDs', async (t) => {
  const { client, controller } = await setup(t);
  client.handler = (method, params) => {
    if (method === 'model/list') return { data: [{ id: params.cursor ? 'b' : 'catalog-a', ...(params.cursor ? {} : { model: 'a' }), displayName: 'Actual catalog', isDefault: !params.cursor,
      supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra' }], nextCursor: params.cursor ? null : 'next' };
  };
  const { models } = await controller.dispatch('list_models');
  assert.deepEqual(models.map((m) => m.id), ['a', 'b']); assert.deepEqual(models[0].efforts, ['ultra']);
  assert.equal(client.calls[1].params.cursor, 'next');
});

test('durable journal preserves cached usage and result, ack retains sequence, restart clears requests', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); const agent = await spawn({ message: 'PRIVATE LONG INPUT' });
  client.note('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 }, last: { cachedInputTokens: 40 }, modelContextWindow: 1234 } });
  client.ask('q', 'item/tool/requestUserInput', pendingQuestion()); await controller.persist();
  const serialized = await readFile(statePath, 'utf8'); assert.doesNotMatch(serialized, /PRIVATE LONG INPUT/);
  const restarted = new AgentController({ client: new MockClient(), statePath }); await restarted.init(); t.after(() => restarted.close());
  assert.equal(restarted.snapshot().agents[0].status, 'unknown'); assert.deepEqual(restarted.snapshot().agents[0].pending_requests, []);
  assert.equal(restarted.snapshot().agents[0].token_usage.total.cachedInputTokens, 80);
  const seq = restarted.snapshot().nextSeq; await restarted.ackEvents(seq - 1);
  assert.equal(restarted.eventsAfter(0).length, 0); assert.equal(restarted.snapshot().nextSeq, seq);
  assert.equal((await restarted.dispatch('list_agents')).agents[0].token_usage, undefined);
  assert.equal((await restarted.dispatch('list_agents')).agents[0].result, undefined);
  await assert.rejects(restarted.dispatch('answer_agent', { target: agent.id, request_id: 'q', answer: {} }));
});

test('client close rejects outstanding calls and close marks active agents interrupted', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.handler = (method) => { if (method === 'turn/steer') return new Promise(() => {}); };
  const sending = controller.dispatch('send_message', { target: agent.id, message: 'pending' });
  client.emit('closed'); await assert.rejects(sending, /closed/); assert.equal(controller.snapshot().agents[0].status, 'failed');
  const second = await setup(t); await second.spawn(); await second.controller.close();
  assert.equal(second.controller.snapshot().agents[0].status, 'interrupted');
});

test('close interrupts known root and descendant turns once and prevents new work or overflow recovery', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  const interruptRequests = [], release = [];
  client.handler = (method, params, options) => {
    if (method !== 'turn/interrupt') return;
    interruptRequests.push({ params, options });
    return new Promise((resolve) => { release.push(resolve); });
  };
  const first = controller.close(); const second = controller.close();
  assert.equal(first, second);
  await tick();
  assert.deepEqual(interruptRequests.map((request) => request.params).sort((a, b) => a.threadId.localeCompare(b.threadId)), [
    { threadId: 'child', turnId: 'child-turn' }, { threadId: 'thread-1', turnId: 'turn-1' },
  ]);
  assert.ok(interruptRequests.every((request) => request.options.timeoutMs === 1500));
  assert.equal(controller.closed, false);
  await assert.rejects(controller.dispatch('list_agents'), /closing/);
  client.complete('thread-1', 'turn-1', 'failed', { message: 'overflow', codexErrorInfo: 'contextWindowExceeded' });
  assert.equal(client.calls.filter((call) => call.method === 'thread/compact/start').length, 0);
  for (const resolve of release) resolve({});
  await first; await controller.close();
  assert.equal(interruptRequests.length, 2);
  assert.equal(controller.closed, true);
  assert.equal(controller.snapshot().agents[0].status, 'interrupted');
  assert.equal(controller.eventsAfter(0).filter((event) => event.kind === 'interrupted').length, 1);
});

test('native interruption failures do not prevent shutdown and already closed transport is skipped', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.ask('pending', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  client.handler = (method) => { if (method === 'turn/interrupt') throw new Error('transport unavailable'); };
  await controller.close();
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 2);
  assert.equal(controller.closed, true);
  assert.equal(controller.snapshot().agents[0].status, 'interrupted');
  assert.deepEqual(controller.snapshot().agents[0].pending_requests, []);
  const other = await setup(t); await other.spawn(); other.client.emit('closed');
  await other.controller.close();
  assert.equal(other.client.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
});

test('followup start rejection is terminal while ambiguous starts require reconciliation', async (t) => {
  for (const rpcRejected of [true, false]) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
    client.handler = (method) => {
      if (method === 'turn/start') throw Object.assign(new Error(rpcRejected ? 'server rejected start' : 'reply timed out'), { code: rpcRejected ? -32602 : 'ETIMEDOUT' });
    };
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'next' }), /rejected|timed out/);
    const current = controller.snapshot().agents[0];
    assert.equal(current.status, rpcRejected ? 'failed' : 'unknown');
    assert.equal(current.turn_id, null);
    assert.equal(current.error.reason, rpcRejected ? 'turn_start_rejected' : 'turn_start_outcome_unknown');
    if (!rpcRejected) {
      assert.match(current.error.recovery, /native Codex thread thread-1/);
      const count = client.calls.filter((call) => call.method === 'turn/start').length;
      await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'duplicate' }), /outcome is unknown/);
      await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'duplicate' }), /outcome is unknown/);
      await assert.rejects(controller.dispatch('close_agent', { target: agent.id }), /outcome is unknown/);
      assert.equal(client.calls.filter((call) => call.method === 'turn/start').length, count);
      assert.equal(client.calls.filter((call) => call.method === 'thread/read').length, 3);
      client.note('turn/started', { threadId: 'thread-1', turn: { id: 'late-start' } });
      assert.equal(controller.snapshot().agents[0].status, 'running');
      client.complete('thread-1', 'late-start');
      assert.equal(controller.snapshot().agents[0].status, 'completed');
    }
  }
});

test('observed starts and completions remain authoritative if the turn/start reply fails', async (t) => {
  for (const complete of [false, true]) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
    client.handler = (method) => {
      if (method !== 'turn/start') return;
      client.note('turn/started', { threadId: 'thread-1', turn: { id: 'observed' } });
      if (complete) client.complete('thread-1', 'observed');
      throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' });
    };
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'next' }), /lost reply/);
    assert.equal(controller.snapshot().agents[0].status, complete ? 'completed' : 'running');
    assert.equal(controller.snapshot().agents[0].turn_id, complete ? null : 'observed');
    assert.equal(client.calls.filter((call) => call.method === 'turn/start').length, 2);
  }
});

test('exact acknowledgements are idempotent and retain omitted and other-agent events', async (t) => {
  const { client, controller, spawn } = await setup(t); const first = await spawn({ name: 'one' }); const second = await spawn({ name: 'two' });
  client.complete('thread-1', 'turn-1'); client.complete('thread-2', 'turn-2');
  const [one, two] = controller.eventsAfter(0);
  assert.equal(one.name, 'one'); assert.equal(one.turn_id, 'turn-1');
  assert.equal(two.name, 'two'); assert.equal(two.turn_id, 'turn-2');
  await controller.ackSequences([two.seq, two.seq]);
  assert.deepEqual(controller.eventsAfter(0).map((event) => event.agent_id), [first.id]);
  assert.deepEqual(await controller.ackSequences([two.seq]), { acknowledged: [two.seq] });
  for (const invalid of [[0], [-1], [controller.nextSeq], ['1'], null]) await assert.rejects(controller.ackSequences(invalid), /Invalid event/);
  controller.pendingEvents.push({ seq: 99, agent_id: 'missing', kind: 'completed' });
  assert.deepEqual(controller.eventsAfter(0).map((event) => event.agent_id), [first.id]);
  assert.notEqual(first.id, second.id);
});

test('answered, resolved and completed requests disappear without removing live descendants', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.ask('answer', 'item/tool/requestUserInput', pendingQuestion());
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 'answer', answer: { answers: { choice: { answers: ['yes'] } } } });
  assert.deepEqual(controller.eventsAfter(0), []);
  client.ask('resolve', 'item/tool/requestUserInput', pendingQuestion());
  client.note('serverRequest/resolved', { threadId: 'thread-1', requestId: 'resolve' });
  assert.deepEqual(controller.eventsAfter(0), []);
  client.ask('root', 'item/tool/requestUserInput', pendingQuestion());
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.ask('child', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  client.complete();
  assert.deepEqual(controller.eventsAfter(0).map((event) => event.request_id).filter(Boolean), ['child']);
  client.complete('child', 'child-turn');
  assert.equal(controller.eventsAfter(0).filter((event) => event.kind === 'question').length, 0);
  client.ask('late-child', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn')); await tick();
  assert.equal(controller.eventsAfter(0).filter((event) => event.kind === 'question').length, 0);
  assert.equal(client.rejected.at(-1).id, 'late-child');
});

test('restart discards nonrecoverable requests and orphan journal entries', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); await spawn();
  client.ask('q', 'item/tool/requestUserInput', pendingQuestion());
  client.ask('a', 'item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1' });
  controller.pendingEvents.push({ seq: controller.nextSeq++, agent_id: 'missing', kind: 'completed' });
  await controller.persist();
  const restarted = new AgentController({ client: new MockClient(), statePath }); await restarted.init(); t.after(() => restarted.close());
  assert.deepEqual(restarted.eventsAfter(0).map((event) => event.kind), ['unknown']);
});

test('turn-local deduplication remains bounded and rejects late prior-turn notifications', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  for (let i = 1; i <= 25; i++) {
    const turnId = `turn-${i}`;
    client.note('item/started', { threadId: 'thread-1', turnId, item: { id: `compact-${i}`, type: 'contextCompaction' } });
    client.complete('thread-1', turnId);
    if (i < 25) await controller.dispatch('followup_task', { target: agent.id, message: 'next' });
    client.note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'late stale result' } });
    client.complete('thread-1', 'turn-1');
    assert.ok(controller.find(agent.id).completedTurns.size <= 1);
    assert.ok(controller.find(agent.id).compactItems.size <= 1);
  }
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  assert.doesNotMatch(JSON.stringify(controller.eventsAfter(0)), /late stale result/);
});

test('same-batch persistence shares a write and event notification follows durable journal', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); await spawn();
  const first = controller.persist(); const second = controller.persist();
  assert.equal(first, second); await first;
  let observed;
  const emitted = new Promise((resolve) => controller.once('event', (event) => {
    observed = readFile(statePath, 'utf8').then((text) => JSON.parse(text).pendingEvents.some((saved) => saved.seq === event.seq));
    resolve();
  }));
  client.complete(); await emitted;
  assert.equal(await observed, true);
});

test('authoritative start reply filters arbitrarily old events while a new start is pending', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
  await controller.dispatch('followup_task', { target: agent.id, message: 'second' }); client.complete('thread-1', 'turn-2');
  let release;
  client.handler = (method) => {
    if (method === 'turn/start') return new Promise((resolve) => { release = resolve; });
  };
  const starting = controller.dispatch('followup_task', { target: agent.id, message: 'third' });
  await tick();
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'stale old final' } });
  client.ask('old-q', 'item/tool/requestUserInput', pendingQuestion());
  client.complete();
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-3' } });
  client.ask('new-q', 'item/tool/requestUserInput', pendingQuestion('thread-1', 'turn-3'));
  release({ turn: { id: 'turn-3' } }); await starting;
  assert.equal(controller.snapshot().agents[0].turn_id, 'turn-3');
  assert.equal(controller.snapshot().agents[0].status, 'waiting');
  assert.deepEqual(controller.snapshot().agents[0].pending_requests.map((request) => request.request_id), ['new-q']);
  assert.deepEqual(client.rejected.map((request) => request.id), ['old-q']);
  assert.doesNotMatch(JSON.stringify(controller.eventsAfter(0)), /stale old final/);
});

test('persistence errors reject callers and prevent premature event publication', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { client, controller, spawn } = await setup(t); await spawn();
  controller.statePath = dir;
  const errors = [], events = [];
  controller.on('controllerError', (error) => errors.push(error)); controller.on('event', (event) => events.push(event));
  client.complete();
  await assert.rejects(controller.persist());
  await tick();
  assert.ok(errors.length > 0); assert.deepEqual(events, []);
  controller.statePath = null;
});

test('active work includes unresolved starts and descendants after root completion', async (t) => {
  const { client, controller, spawn } = await setup(t);
  assert.equal(controller.hasActiveWork(), false);
  const agent = await spawn(); assert.equal(controller.hasActiveWork(), true);
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.complete(); assert.equal(controller.hasActiveWork(), true);
  client.ask('child-q', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  assert.equal(controller.hasActiveWork(), true);
  client.complete('child', 'child-turn'); assert.equal(controller.hasActiveWork(), false);
  controller.find(agent.id).status = 'unknown'; assert.equal(controller.hasActiveWork(), true);
});

test('approval allowlists compare structured decisions and reject unoffered amendments', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  const allowed = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } };
  client.ask('structured', 'item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', availableDecisions: [allowed] });
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 'structured', answer: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl'] } } } }), /availableDecisions/);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 'structured', answer: { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.com' } } } } });
  assert.deepEqual(client.replies.at(-1).result.decision, allowed);
});

test('persisted unknown starts reconcile idle metadata before an explicit new followup', async (t) => {
  for (const nativeStatus of ['idle', 'notLoaded']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const statePath = path.join(dir, 'state.json');
    const { client, controller, spawn } = await setup(t, { statePath }); const agent = await spawn(); client.complete();
    client.handler = (method) => { if (method === 'turn/start') throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' }); };
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'ORIGINAL DO NOT REPLAY' }));
    await controller.close();
    const restartedClient = new MockClient();
    restartedClient.turnCount = 10;
    restartedClient.handler = (method) => { if (method === 'thread/read') return { thread: { id: 'thread-1', status: { type: nativeStatus } } }; };
    const restarted = new AgentController({ client: restartedClient, statePath }); await restarted.init(); t.after(() => restarted.close());
    assert.equal(restarted.snapshot().agents[0].status, 'interrupted'); assert.equal(restarted.hasActiveWork(), false);
    const result = await restarted.dispatch('followup_task', { target: agent.id, message: 'EXPLICIT NEW TASK' });
    assert.equal(result.status, 'running'); assert.equal(result.turn_id, 'turn-11');
    assert.deepEqual(restartedClient.calls[0], { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } });
    assert.equal(restartedClient.calls.filter((call) => call.method === 'thread/turns/list').length, 0);
    const starts = restartedClient.calls.filter((call) => call.method === 'turn/start');
    assert.equal(starts.length, 1); assert.equal(starts[0].params.input[0].text, 'EXPLICIT NEW TASK');
    assert.equal(restarted.eventsAfter(0).filter((event) => event.reason === 'outcome_reconciled').length, 1);
  }
});

test('unknown active starts use one metadata turn and steer or interrupt without another start', async (t) => {
  for (const operation of ['send_message', 'followup_task', 'interrupt_agent']) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
    client.handler = (method) => { if (method === 'turn/start') throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' }); };
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'original' }));
    client.handler = (method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'active', activeFlags: [] } } };
      if (method === 'thread/turns/list') return { data: [{ id: 'native-running', status: 'inProgress', items: [], itemsView: 'notLoaded' }] };
    };
    await controller.dispatch(operation, { target: agent.id, message: 'steer current work' });
    assert.equal(controller.snapshot().agents[0].status, 'running');
    assert.equal(controller.snapshot().agents[0].turn_id, 'native-running');
    assert.deepEqual(client.calls.find((call) => call.method === 'thread/turns/list').params,
      { threadId: 'thread-1', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    assert.equal(client.calls.filter((call) => call.method === 'turn/start').length, 2);
    assert.equal(client.calls.at(-1).method, operation === 'interrupt_agent' ? 'turn/interrupt' : 'turn/steer');
  }
});

test('unknown close reconciles idle ownership while insufficient metadata never restarts work', async (t) => {
  for (const mode of ['idle', 'systemError', 'active-completed', 'read-error']) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
    client.handler = (method) => { if (method === 'turn/start') throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' }); };
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'original' }));
    client.handler = (method) => {
      if (method === 'thread/read') {
        if (mode === 'read-error') throw new Error('metadata unavailable');
        return { thread: { status: { type: mode === 'active-completed' ? 'active' : mode } } };
      }
      if (method === 'thread/turns/list') return { data: [{ id: 'already-finished', status: 'completed' }] };
    };
    if (mode === 'idle') {
      assert.equal((await controller.dispatch('close_agent', { target: agent.id })).status, 'closed');
      assert.deepEqual(controller.snapshot().agents, []);
    } else {
      await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'do not duplicate' }), /outcome is unknown/);
      assert.equal(controller.snapshot().agents[0].status, 'unknown');
      assert.equal(controller.hasActiveWork(), true);
    }
    assert.equal(client.calls.filter((call) => call.method === 'turn/start').length, 2);
  }
});

test('persisted unknown active work restores subscription and steers without starting a turn', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-'));
  let controller, restarted;
  t.after(async () => { await restarted?.close(); await controller?.close(); await rm(dir, { recursive: true, force: true }); });
  const statePath = path.join(dir, 'state.json');
  const setupResult = await setup(t, { statePath }); controller = setupResult.controller;
  const { client, spawn } = setupResult; const agent = await spawn(); client.complete();
  client.handler = (method) => { if (method === 'turn/start') throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'original' })); await controller.close();
  const restartedClient = new MockClient();
  restartedClient.handler = (method) => {
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'thread-1', status: { type: 'active', activeFlags: [] } } };
    if (method === 'thread/turns/list') return { data: [{ id: 'native-running', status: 'inProgress', items: [], itemsView: 'notLoaded' }] };
  };
  restarted = new AgentController({ client: restartedClient, statePath }); await restarted.init();
  await restarted.dispatch('followup_task', { target: agent.id, message: 'steer existing work' });
  assert.deepEqual(restartedClient.calls.map((call) => call.method), ['thread/read', 'thread/resume', 'thread/turns/list', 'turn/steer']);
  assert.deepEqual(restartedClient.calls[1].params, { threadId: 'thread-1', excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.equal(restarted.find(agent.id).loaded, true);
  restartedClient.complete('thread-1', 'native-running');
  assert.equal(restarted.snapshot().agents[0].status, 'completed');
});

test('resume-window idle metadata reconciles without binding stale active turns', async (t) => {
  for (const operation of ['followup_task', 'close_agent']) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn(); client.complete();
    client.handler = (method) => { if (method === 'turn/start') throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' }); };
    await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'original' }));
    controller.find(agent.id).loaded = false;
    const before = client.calls.length;
    client.handler = (method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'active', activeFlags: [] } } };
      if (method === 'thread/resume') return { thread: { status: { type: 'idle' } } };
    };
    const result = await controller.dispatch(operation, { target: agent.id, message: 'explicit new task' });
    const calls = client.calls.slice(before);
    assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 1);
    assert.equal(calls.filter((call) => call.method === 'thread/turns/list').length, 0);
    assert.equal(calls.filter((call) => call.method === 'turn/steer').length, 0);
    assert.equal(calls.filter((call) => call.method === 'turn/start').length, operation === 'followup_task' ? 1 : 0);
    assert.equal(result.status, operation === 'followup_task' ? 'running' : 'closed');
  }
});

test('rejected overflow continuation fails only its agent without a controller-wide error', async (t) => {
  const { client, controller, spawn } = await setup(t); const first = await spawn(); const second = await spawn();
  const errors = []; controller.on('controllerError', (error) => errors.push(error));
  client.complete('thread-1', 'turn-1', 'failed', { codexErrorInfo: 'contextWindowExceeded' });
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'compact-first' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'compact-first', item: { id: 'compact-item', type: 'contextCompaction' } });
  client.handler = (method, params) => {
    if (method === 'turn/start' && params.threadId === 'thread-1') throw Object.assign(new Error('continuation rejected'), { code: -32602 });
  };
  client.complete('thread-1', 'compact-first'); await tick();
  assert.equal(controller.find(first.id).status, 'failed');
  assert.equal(controller.find(second.id).status, 'running');
  assert.equal(controller.find(second.id).turnId, 'turn-2');
  assert.deepEqual(errors, []);
  assert.equal(controller.closed, false);
  assert.equal(controller.eventsAfter(0, [first.id]).at(-1).kind, 'failed');
  assert.equal(controller.eventsAfter(0, [first.id]).at(-1).reason, 'turn_start_rejected');
});

test('failed acknowledgement persistence emits one controller error and retains the disk journal', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); await spawn(); client.complete(); await controller.persist();
  const [event] = controller.eventsAfter(0);
  const before = await readFile(statePath, 'utf8');
  const errors = []; controller.on('controllerError', (error) => errors.push(error));
  await mkdir(`${statePath}.tmp`);
  try {
    await assert.rejects(controller.ackSequences([event.seq]));
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(await readFile(statePath, 'utf8'), before);
    assert.ok(JSON.parse(before).pendingEvents.some((saved) => saved.seq === event.seq));
  } finally { await rm(`${statePath}.tmp`, { recursive: true, force: true }); }
});

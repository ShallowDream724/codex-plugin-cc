import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import { createBroker } from '../runtime/broker.mjs';
import { AgentController } from '../runtime/agents.mjs';
import { DeliveryStore } from '../runtime/delivery.mjs';
import { postLoopbackJson } from '../runtime/loopback-http.mjs';

class FakeController extends EventEmitter {
  constructor() { super(); this.events = []; this.calls = []; this.acks = []; this.status = 'running'; this.nextSeq = 1; }
  async dispatch(op, args) { this.calls.push({ op, args }); return op === 'list_agents' ? { agents: [{ agent_id: 'a', status: this.status }] } : { agent_id: 'a', accepted: true }; }
  eventsAfter(cursor) { return this.events.filter(e => e.seq > cursor); }
  async ackEvents(cursor) { this.acks.push(cursor); this.events = this.events.filter(e => e.seq > cursor); }
  async ackSequences(sequences) { this.acks.push(sequences); this.events = this.events.filter(e => !sequences.includes(e.seq)); }
  publish(kind = 'completed') { const e = { seq: this.nextSeq++, kind, agent_id: 'a' }; this.events.push(e); this.emit('event', e); }
}

async function setup(t, options = {}) {
  const controller = new FakeController(), token = 'test-auth';
  const server = createBroker({ controller, token, waitTimeoutMs: 100, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const post = async (body, { signal } = {}) => {
    const { status, text } = await postLoopbackJson(port, body, { token, signal });
    return { status, body: JSON.parse(text) };
  };
  return { controller, post, url, server };
}

test('local transport requires a session secret', async t => {
  const { server, controller } = await setup(t);
  const response = await postLoopbackJson(server.address().port, {});
  assert.equal(response.status, 403); assert.equal(controller.calls.length, 0);
});

test('wait returns queryable private-agent status without awaiting its private work', async t => {
  const { post, controller } = await setup(t);
  controller.hasParentWork = () => false;
  controller.hasActiveWork = () => true;
  controller.dispatch = async operation => ({ agents: [{ agent_id: 'a', status: 'running', turn_origin: 'user' }] });
  const waited = await post({ operation: 'wait' });
  assert.equal(waited.body.idle, false); assert.equal(waited.body.parent_idle, true); assert.equal(waited.body.active, true); assert.deepEqual(waited.body.events, []);
  assert.equal(waited.body.agents[0].turn_origin, 'user');
  assert.equal((await post({ operation: 'idle_shutdown' })).body.reason, 'active');
});

test('UI reads never claim or confirm Claude events, even with extraneous restore evidence', async t => {
  const { post, controller } = await setup(t, { activity: { list: () => ({ agents: [{ agent_id: 'a' }] }) } });
  controller.publish();
  const view = await post({ operation: 'ui_list', restore: { legacy_events: controller.events } });
  assert.equal(view.status, 200); assert.equal(view.body.agents[0].agent_id, 'a');
  assert.equal(controller.events.length, 1); assert.deepEqual(controller.acks, []);
  const wait = await post({ operation: 'wait', args: { timeout_ms: 0 } });
  assert.equal(wait.body.events.length, 1);
});

test('action responses can carry a fresh UI-only catalog without caching it in the receipt', async t => {
  let agents = [{ agent_id: 'a', name: 'Native title', last_activity_at_ms: 1000 }];
  const { post, controller } = await setup(t, { activity: { list: () => ({ agents }) } });
  controller.publish();
  const body = { operation: 'followup_task', requestId: 'continue-once', args: { target: 'a', message: 'Continue' }, ui_summary: true };
  const first = (await post(body)).body;
  assert.deepEqual(first.ui_summary, { agents });
  agents = [...agents, { agent_id: 'b' }];
  assert.deepEqual((await post(body)).body.ui_summary, { agents });
  assert.equal(controller.calls.filter(call => call.op === 'followup_task').length, 1);
  assert.equal((await post({ ...body, ui_summary: false })).body.ui_summary, undefined);
  assert.equal(controller.events.length, 1); assert.deepEqual(controller.acks, []);
  const observed = await post({ operation: 'observe', args: { deliver: false } });
  assert.deepEqual(observed.body.agents, agents);
});

test('partial adoption failures still refresh the catalog, and a UI failure cannot lose an accepted action', async t => {
  let broken = false;
  const { post, controller } = await setup(t, { activity: { list: () => { if (broken) throw new Error('UI unavailable'); return { agents: [{ agent_id: 'adopted' }] }; } } });
  const dispatch = controller.dispatch.bind(controller);
  controller.dispatch = async (operation, args) => { if (args.target === 'partial') throw new Error('Thread registered; continuation failed'); return dispatch(operation, args); };
  const failed = await post({ operation: 'followup_task', requestId: 'partial', args: { target: 'partial', message: 'Continue' }, ui_summary: true });
  assert.equal(failed.status, 400);
  assert.deepEqual(failed.body.ui_summary.agents, [{ agent_id: 'adopted' }]);
  broken = true;
  const accepted = await post({ operation: 'followup_task', requestId: 'accepted', args: { target: 'a', message: 'Continue' }, ui_summary: true });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.accepted, true);
});

test('model recovery errors retain options and distinguish confirmed rejection from an uncertain action', async t => {
  const { post, controller } = await setup(t, { activity: { list: () => ({ agents: [{ agent_id: 'a', status: 'failed' }] }) } });
  let calls = 0;
  const choices = [{ model: 'new', target: 'codex-recovery:example/new' }];
  const afterAccessFix = [{ model: 'old', target: 'codex-recovery:example/old' }];
  controller.dispatch = async (_, args) => {
    calls++;
    if (args.target === 'catalog-offline') throw Object.assign(new Error('Could not verify the Codex model catalog. No turn was started.'), { code: 'model_catalog_unavailable', model_turn_started: false });
    if (args.target === 'consumed') throw Object.assign(new Error('This replacement was accepted earlier. No new turn was started.'), { code: 'model_recovery_consumed', model_turn_started: false, turn_id: 'recovered-turn' });
    const started = args.target !== 'certain';
    throw Object.assign(new Error('Model unavailable'), { code: 'agent_model_unavailable', agent_id: 'a', thread_id: 'thread-a', status: 'failed', reason: 'provider_model_unavailable', model: 'old', available_models: ['old', 'new'], recommended_model: 'new', recovery_choices: choices, retry_after_access_fix: afterAccessFix, model_turn_started: started, ...(started ? { turn_id: 'failed-turn' } : {}), recovery: 'Choose a replacement.' });
  };
  const request = target => ({ operation: 'followup_task', requestId: target, args: { target, message: 'Continue' }, ui_summary: true });
  const first = (await post(request('certain'))).body;
  assert.deepEqual(first.error, { code: 'agent_model_unavailable', message: 'Model unavailable', agent_id: 'a', thread_id: 'thread-a', status: 'failed', recovery: 'Choose a replacement.', reason: 'provider_model_unavailable', model: 'old', available_models: ['old', 'new'], recommended_model: 'new', recovery_choices: choices, retry_after_access_fix: afterAccessFix, model_turn_started: false });
  assert.equal(first.ui_summary.agents[0].status, 'failed');
  assert.deepEqual((await post(request('certain'))).body.error, first.error);
  assert.equal(calls, 1);
  const uncertain = (await post(request('uncertain'))).body.error;
  assert.equal(uncertain.model_turn_started, true);
  assert.equal(uncertain.turn_id, 'failed-turn');
  assert.equal((await post(request('uncertain'))).body.error.code, 'ambiguous_action');
  assert.equal(calls, 2);
  const offline = (await post(request('catalog-offline'))).body.error;
  assert.equal(offline.code, 'model_catalog_unavailable');
  assert.deepEqual((await post(request('catalog-offline'))).body.error, offline);
  assert.equal(calls, 3);
  const consumed = (await post(request('consumed'))).body.error;
  assert.equal(consumed.code, 'model_recovery_consumed');
  assert.equal(consumed.turn_id, 'recovered-turn');
  assert.equal(consumed.model_turn_started, false);
  assert.deepEqual((await post(request('consumed'))).body.error, consumed);
  assert.equal(calls, 4);
});

test('model diagnostics are read by explicit list_agents and failure delivery, with no background catalog polling', async t => {
  class Client extends EventEmitter {
    calls = [];
    successor = 'gpt-6.2-astra';
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'root', model: 'gpt-6.1-astra', modelProvider: 'fixture' } };
      if (method === 'turn/start') return { turn: { id: 'failed-turn', status: 'inProgress' } };
      if (method === 'model/list') return params.cursor
        ? { data: [{ model: 'gpt-6.2-sol' }], nextCursor: null }
        : { data: [{ model: 'gpt-6.1-astra' }, { model: this.successor }, { model: 'gpt-6.9-astra', hidden: true }], nextCursor: 'next' };
      return {};
    }
  }
  const client = new Client(), controller = new AgentController({ client, nativeRoleResolver: async () => undefined });
  await controller.init(); t.after(() => controller.close());
  const { post } = await setup(t, { controller });
  await controller.dispatch('spawn_agent', { message: 'Task', cwd: '/workspace', model: 'gpt-6.1-astra', context_mode: 'none' });
  client.calls.length = 0;
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'failed-turn', status: 'failed', error: { codexErrorInfo: 'modelNotFound', message: 'Provider rejected the model.' } } } });

  const background = (await post({ operation: 'observe', args: { deliver: false } })).body;
  assert.equal(background.agents[0].status, 'failed');
  assert.deepEqual(background.events, []);
  assert.deepEqual(client.calls, []);
  const delivered = (await post({ operation: 'wait', args: { timeout_ms: 0 } })).body;
  assert.equal(delivered.events[0].code, 'agent_model_unavailable');
  assert.deepEqual(delivered.events[0].available_models, ['gpt-6.1-astra', 'gpt-6.2-astra', 'gpt-6.2-sol']);
  assert.deepEqual(delivered.events[0].recovery_choices.map(choice => choice.model), ['gpt-6.2-astra', 'gpt-6.2-sol']);
  assert.deepEqual(delivered.events[0].retry_after_access_fix.map(choice => choice.model), ['gpt-6.1-astra']);
  assert.deepEqual(client.calls, [{ method: 'model/list', params: { includeHidden: false, modelProvider: 'fixture' } },
    { method: 'model/list', params: { includeHidden: false, modelProvider: 'fixture', cursor: 'next' } }]);

  const confirmation = (await post({ operation: 'confirm', args: { observations: [{ delivery_id: delivered.delivery_id, events: delivered.events }] } })).body;
  assert.deepEqual(confirmation, { confirmed: [delivered.delivery_id] });
  assert.deepEqual(controller.eventsAfter(0), []);
  assert.equal((await post({ operation: 'wait', args: { timeout_ms: 0 } })).body.idle, true);
  assert.equal(client.calls.length, 2);

  client.successor = 'gpt-6.3-astra';
  const listed = (await post({ operation: 'list_agents' })).body;
  assert.deepEqual(listed.agents[0].model_recovery.available_models, ['gpt-6.1-astra', 'gpt-6.3-astra', 'gpt-6.2-sol']);
  assert.equal(listed.agents[0].model_recovery.recommended_model, 'gpt-6.3-astra');
  assert.deepEqual(client.calls.map(call => call.method), ['model/list', 'model/list', 'model/list', 'model/list']);
});

test('direct user controls use durable receipts without acknowledging Claude events', async t => {
  const { post, controller } = await setup(t);
  controller.publish();
  const request = { operation: 'ui_send', requestId: 'human-message', args: { target: 'a', message: 'Keep the original data.' }, restore: { legacy_events: controller.events } };
  assert.equal((await post(request)).status, 200);
  assert.equal((await post(request)).status, 200);
  assert.equal(controller.calls.filter(call => call.op === 'ui_send').length, 1);
  assert.equal(controller.events.length, 1); assert.deepEqual(controller.acks, []);
  const conflict = await post({ ...request, args: { ...request.args, message: 'Changed text' } });
  assert.equal(conflict.body.error.code, 'request_id_conflict');
  assert.equal((await post({ operation: 'ui_interrupt', requestId: 'human-stop', args: { target: 'a' }, restore: request.restore })).status, 200);
  const stopAll = { operation: 'ui_interrupt_all', requestId: 'human-stop-all', args: {}, restore: request.restore };
  assert.equal((await post(stopAll)).status, 200);
  assert.equal((await post(stopAll)).status, 200);
  assert.equal(controller.calls.filter(call => call.op === 'ui_interrupt_all').length, 1);
  assert.deepEqual(controller.acks, []);
  const delivery = await post({ operation: 'wait', args: { timeout_ms: 0 } });
  assert.equal(delivery.body.events[0].seq, 1);
});

test('default preset is normalized before snapshot capture without weakening normal context validation', async t => {
  const { post, controller } = await setup(t);
  const result = await post({ operation: 'spawn_agent', requestId: 'scout', args: { role: 'default' } });
  assert.equal(result.status, 200); assert.equal(controller.calls[0].args.context_mode, 'none');
  assert.equal(controller.calls[0].args.snapshot, undefined);
  const conflict = await post({ operation: 'spawn_agent', requestId: 'conflict', args: { role: 'default', context_mode: 'available' } });
  assert.equal(conflict.status, 400); assert.equal(controller.calls.length, 1);
});

test('snapshot validation fails before a Codex mutation', async t => {
  const { post, controller } = await setup(t);
  const result = await post({ operation: 'spawn_agent', requestId: 'call1', args: { context_mode: 'available' }, context: { messages: [], source: 'unknown' } });
  assert.equal(result.status, 400); assert.equal(result.body.error.code, 'invalid_context'); assert.equal(controller.calls.length, 0);
});

test('same mutation receipt cannot create a duplicate worker', async t => {
  const receipts = {}, { post, controller } = await setup(t, { receipts });
  const request = { operation: 'spawn_agent', requestId: 'call1', args: { context_mode: 'none' } };
  assert.equal((await post(request)).body.accepted, true);
  assert.equal((await post(request)).body.accepted, true);
  assert.equal(controller.calls.length, 1);
});

test('a crash receipt fails explicitly rather than replaying work', async t => {
  const { post, controller } = await setup(t, { receipts: { call1: { operation: 'spawn_agent', status: 'inflight' } } });
  const result = await post({ operation: 'spawn_agent', requestId: 'call1', args: { context_mode: 'none' } });
  assert.equal(result.body.error.code, 'ambiguous_action'); assert.equal(controller.calls.length, 0);
});

test('private-turn followup rejection is a retryable-on-new-call preflight failure rather than ambiguous submission', async t => {
  const { post, controller } = await setup(t);
  controller.dispatch = async () => { throw Object.assign(new Error('Private turn remains active; task was not sent.'), { code: 'private_turn_active', agent_id: 'a', thread_id: 'thread-a', status: 'running', recovery: 'Retry this same agent after its user turn completes.' }); };
  const request = { operation: 'followup_task', requestId: 'private-active', args: { target: 'a', message: 'Parent task' } };
  const first = await post(request), repeated = await post(request);
  assert.equal(first.body.error.code, 'private_turn_active');
  assert.deepEqual(repeated.body, first.body);
  assert.equal(first.body.error.thread_id, 'thread-a'); assert.match(first.body.error.recovery, /same agent/);
});

test('simultaneous copies of one tool call never dispatch twice', async t => {
  const { post, controller } = await setup(t, { saveReceipts: () => new Promise(done => setTimeout(done, 15)) });
  const request = { operation: 'spawn_agent', requestId: 'same-call', args: { context_mode: 'none' } };
  const results = await Promise.all([post(request), post(request)]);
  assert.equal(controller.calls.filter(c => c.op === 'spawn_agent').length, 1);
  assert.equal(results.filter(r => r.body.accepted).length, 1);
  assert.equal(results.filter(r => r.body.error?.code === 'ambiguous_action').length, 1);
});

test('parallel distinct actions persist receipts in order without losing newer state', async t => {
  let saved, writing = 0, maxWriting = 0;
  const { post } = await setup(t, { saveReceipts: async value => {
    writing++; maxWriting = Math.max(maxWriting, writing);
    await new Promise(done => setTimeout(done, 10));
    saved = structuredClone(value); writing--;
  } });
  await Promise.all(['first', 'second'].map(requestId => post({ operation: 'spawn_agent', requestId, args: { context_mode: 'none' } })));
  assert.equal(maxWriting, 1);
  assert.equal(saved.first.status, 'done'); assert.equal(saved.second.status, 'done');
});

test('waiting wakes on an important event and observation cannot steal it', async t => {
  const { controller, post } = await setup(t, { waitTimeoutMs: 1000 });
  const waiting = post({ operation: 'wait', cursor: 0 });
  await new Promise(done => setTimeout(done, 30));
  assert.deepEqual((await post({ operation: 'observe' })).body.events, []);
  controller.publish('question');
  const result = await waiting;
  assert.equal(result.body.events[0].kind, 'question'); assert.ok(result.body.delivery_id);
  assert.deepEqual(controller.acks, []); // Returning a response is not proof that Claude retained it.
  await post({ operation: 'confirm', args: { observations: [{ delivery_id: result.body.delivery_id, sequences: [1], events: result.body.events }] } });
  assert.deepEqual(controller.acks, [[1]]);
});

test('compaction alone does not prompt Claude or finish its wait, but a question still does', async t => {
  const { controller, post } = await setup(t, { waitTimeoutMs: 1000 });
  controller.status = 'compacting';
  controller.publish('compacting');
  const observed = (await post({ operation: 'observe', args: { deliver: true } })).body;
  assert.deepEqual(observed.events, []); assert.equal(observed.delivery_id, undefined);
  assert.equal(observed.agents[0].status, 'compacting');
  let finished = false;
  const waiting = post({ operation: 'wait' }).then(value => { finished = true; return value; });
  while (!controller.listenerCount('state')) await new Promise(resolve => setImmediate(resolve));
  controller.publish('compacting');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finished, false);
  controller.publish('question');
  const result = (await waiting).body;
  assert.deepEqual(result.events.map(e => e.kind), ['question']);
  assert.ok(result.delivery_id);
});

test('wait continues to observe parent work after a private user message', async t => {
  class Client extends EventEmitter {
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'root' } };
      if (method === 'turn/start') return { turn: { id: 'root-turn', status: 'inProgress' } };
      return {};
    }
  }
  const client = new Client(), controller = new AgentController({ client, nativeRoleResolver: async () => undefined });
  await controller.init(); t.after(() => controller.close());
  const { post } = await setup(t, { controller, waitTimeoutMs: 1000 });
  const agent = await controller.dispatch('spawn_agent', { message: 'Task', cwd: '/workspace', context_mode: 'none' });
  await controller.dispatch('ui_send', { target: agent.id, message: 'PRIVATE USER BODY' });
  const waiting = post({ operation: 'wait', args: { timeout_ms: 500 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'root-turn', status: 'completed' } } });
  const result = (await waiting).body;
  assert.equal(result.events[0].kind, 'completed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE USER BODY/);
});

test('wait wakes when the last matching descendant turn completes', async t => {
  class Client extends EventEmitter {
    async request(method, params) {
      if (method === 'thread/start') return { thread: { id: 'root' } };
      if (method === 'turn/start') return { turn: { id: 'root-turn', status: 'inProgress' } };
      return {};
    }
    note(method, params) { this.emit('notification', { method, params }); }
  }
  const client = new Client();
  const controller = new AgentController({ client, nativeRoleResolver: async () => undefined });
  await controller.init();
  t.after(() => controller.close());
  const { post } = await setup(t, { controller, waitTimeoutMs: 1500 });
  await controller.dispatch('spawn_agent', { message: 'Task', cwd: '/workspace', context_mode: 'none' });
  for (const id of ['child-1', 'child-2']) {
    client.note('thread/started', { thread: { id, parentThreadId: 'root' } });
    client.note('turn/started', { threadId: id, turn: { id: `${id}-turn` } });
  }
  client.emit('request', { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'child-1', turnId: 'child-1-turn', itemId: 'question', questions: [{ id: 'q', header: 'Choice', question: 'Which?' }] } });
  await new Promise(resolve => setImmediate(resolve));
  client.note('turn/completed', { threadId: 'root', turn: { id: 'root-turn', status: 'completed' } });
  const completed = (await post({ operation: 'wait' })).body;
  assert.ok(completed.events.some(e => e.kind === 'completed'));
  assert.ok(completed.events.some(e => e.kind === 'question'));
  await post({ operation: 'confirm', args: { observations: [{ delivery_id: completed.delivery_id, sequences: completed.events.map(e => e.seq), events: completed.events }] } });
  assert.equal(controller.hasParentWork(), true);
  const waiting = post({ operation: 'wait' });
  while (!controller.listenerCount('state')) await new Promise(resolve => setImmediate(resolve));
  client.note('turn/completed', { threadId: 'child-1', turn: { id: 'wrong-turn', status: 'completed' } });
  assert.equal(controller.snapshot().agents[0].pending_requests.length, 1);
  assert.equal(controller.hasParentWork(), true);
  client.note('turn/completed', { threadId: 'child-1', turn: { id: 'child-1-turn', status: 'completed' } });
  assert.equal(controller.snapshot().agents[0].pending_requests.length, 0);
  assert.equal(controller.hasParentWork(), true);
  assert.equal((await Promise.race([waiting.then(() => 'returned'), new Promise(resolve => setTimeout(() => resolve('waiting'), 80))])), 'waiting');
  client.note('turn/completed', { threadId: 'child-2', turn: { id: 'child-2-turn', status: 'completed' } });
  const result = await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error('wait did not wake after descendant completion')), 400))]);
  assert.equal(result.body.idle, true);
  assert.deepEqual(result.body.events, []);
  await controller.dispatch('interrupt_agent', { target: controller.snapshot().agents[0].id });
  client.note('turn/started', { threadId: 'root', turn: { id: 'late-root-turn' } });
  const lateWaiting = post({ operation: 'wait' });
  while (!controller.listenerCount('state')) await new Promise(resolve => setImmediate(resolve));
  client.note('turn/completed', { threadId: 'root', turn: { id: 'late-root-turn', status: 'interrupted' } });
  const lateResult = await Promise.race([lateWaiting, new Promise((_, reject) => setTimeout(() => reject(new Error('wait did not wake after late root completion')), 400))]);
  assert.equal(lateResult.body.idle, true);
});

test('wait claims completion published while an empty claim is being saved', async t => {
  const controller = new FakeController();
  controller.hasParentWork = () => controller.status === 'running';
  const deliveryStore = new DeliveryStore({ controller });
  let injected = false;
  deliveryStore.saveLease = async () => {
    if (!injected && !deliveryStore.lease) {
      injected = true;
      controller.status = 'completed';
      controller.publish('completed');
    }
  };
  const { post } = await setup(t, { controller, deliveryStore });
  const result = (await post({ operation: 'wait' })).body;
  assert.equal(result.events[0]?.kind, 'completed');
  assert.ok(result.delivery_id);
});

test('parallel waits return a busy result instead of delivering the same question twice', async t => {
  const { controller, post } = await setup(t, { waitTimeoutMs: 1000 });
  const first = post({ operation: 'wait' });
  await new Promise(done => setTimeout(done, 20));
  assert.equal((await post({ operation: 'wait' })).body.waiting, true);
  controller.publish('question');
  const result = (await first).body;
  assert.equal(result.events[0].seq, 1);
  const another = (await post({ operation: 'wait', args: { timeout_ms: 0 } })).body;
  assert.equal(another.pending, true); assert.equal(another.events, undefined);
  await post({ operation: 'release', args: { delivery_id: result.delivery_id } });
  assert.equal((await post({ operation: 'wait' })).body.events[0].seq, 1);
});

test('queued prompt reserves delivery until confirmation and legacy cursor cannot erase events', async t => {
  const { controller, post } = await setup(t);
  controller.publish();
  const prompt = (await post({ operation: 'observe', args: { deliver: true } })).body;
  assert.ok(prompt.delivery_id);
  const waiting = (await post({ operation: 'wait', cursor: 9999, args: { timeout_ms: 0 } })).body;
  assert.equal(waiting.pending, true); assert.equal(controller.events.length, 1);
  await post({ operation: 'confirm', args: { delivery_ids: [prompt.delivery_id] } });
  assert.equal(controller.events.length, 0);
});

test('restored history is confirmed before a first wait and metadata health reflects the transport', async t => {
  const { controller, post } = await setup(t, { getHealth: () => ({ ready: false, protocol: 2 }), requiredProtocol: 2 });
  assert.equal((await post({ operation: 'health' })).body.ready, false);
  assert.equal((await post({ operation: 'list_agents' })).body.error.code, 'bridge_version_mismatch');
  controller.publish(); controller.publish();
  const result = await post({ operation: 'wait', protocolVersion: 2, restore: { legacy_events: [{ seq: 1, agent_id: 'a', kind: 'completed' }] } });
  assert.deepEqual(result.body.events.map(e => e.seq), [2]);
});

test('tool-call IDs cannot be reused with different mutation inputs', async t => {
  const { controller, post } = await setup(t);
  await post({ operation: 'send_message', requestId: 'same', args: { target: 'a', message: 'first' } });
  const result = await post({ operation: 'send_message', requestId: 'same', args: { target: 'a', message: 'changed' } });
  assert.equal(result.body.error.code, 'request_id_conflict'); assert.equal(controller.calls.length, 1);
});

test('wait timeout is local pending state, not an agent interruption', async t => {
  const { post, controller } = await setup(t, { waitTimeoutMs: 10 });
  assert.equal((await post({ operation: 'wait' })).body.pending, true);
  assert.equal(controller.calls.filter(c => c.op === 'interrupt_agent').length, 0);
});

test('a caller can shorten one wait and invalid limits never interrupt the worker', async t => {
  const { post, controller } = await setup(t, { waitTimeoutMs: 10000 });
  assert.equal((await post({ operation: 'wait', args: { timeout_ms: 0 } })).body.pending, true);
  for (const timeout_ms of [-1, 1.5, 25001]) assert.equal((await post({ operation: 'wait', args: { timeout_ms } })).status, 400);
  assert.equal(controller.status, 'running');
  assert.equal(controller.calls.filter(c => c.op === 'interrupt_agent').length, 0);
});

test('invalid answers return the response format without auto-answering', async t => {
  const { post, controller } = await setup(t);
  const reply_format = { answers: { choice: { answers: ['<text>'] } } };
  controller.dispatch = async () => { throw Object.assign(new Error('Answer choice.'), { code: 'invalid_answer', request_id: 'q', reply_format }); };
  const response = await post({ operation: 'answer_agent', requestId: 'bad-answer', args: {} });
  assert.deepEqual(response.body.error, { code: 'invalid_answer', message: 'Answer choice.', request_id: 'q', reply_format });
});

test('disconnecting a waiter leaves the Codex task running', async t => {
  const { post, controller } = await setup(t, { waitTimeoutMs: 1000 });
  const abort = new AbortController();
  const pending = post({ operation: 'wait' }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending);
  assert.equal(controller.status, 'running');
  assert.equal(controller.calls.filter(c => c.op === 'interrupt_agent').length, 0);
});

test('broker shutdown releases a prompt claim while model diagnostics are pending', async t => {
  const controller = new FakeController(), deliveryStore = new DeliveryStore({ controller });
  const reading = Promise.withResolvers(), finishCatalog = Promise.withResolvers();
  controller.events.push({ seq: controller.nextSeq++, agent_id: 'a', kind: 'failed', code: 'agent_model_unavailable' });
  controller.enrichModelFailureEvent = async event => {
    reading.resolve();
    return { ...event, available_models: await finishCatalog.promise };
  };
  const { post, server } = await setup(t, { controller, deliveryStore });
  const prompt = post({ operation: 'observe', args: { deliver: true } });
  await reading.promise;
  server.close();
  finishCatalog.resolve(['replacement']);
  assert.deepEqual((await prompt).body, { cancelled: true });
  assert.equal(deliveryStore.remaining(), 0);
  assert.deepEqual((await deliveryStore.claim()).events[0].available_models, ['replacement']);
  assert.deepEqual(controller.acks, []);
});

test('shutdown releases local waiters but drains accepted disconnected mutations before releasing ownership', async t => {
  const { post, controller, server } = await setup(t, { waitTimeoutMs: 10000 });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waitRegistered = Promise.withResolvers();
  controller.dispatch = async op => {
    if (op === 'list_agents') {
      waitRegistered.resolve();
      return { agents: [{ agent_id: 'a', status: 'running' }] };
    }
    entered(); await new Promise(resolve => { release = resolve; }); return { accepted: true };
  };
  const abort = new AbortController();
  const action = post({ operation: 'send_message', requestId: 'slow', args: {} }, { signal: abort.signal }).catch(() => {});
  await started;
  const waiting = post({ operation: 'wait' });
  await waitRegistered.promise;
  abort.abort(); server.close();
  assert.equal((await waiting).body.cancelled, true);
  let drained = false;
  const drain = server.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); await action; await drain; assert.equal(drained, true);
});

test('idle upgrade refuses an in-flight mutation and rechecks active work after it completes', async t => {
  let stopped = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { post, controller } = await setup(t, { onShutdown: () => { stopped++; } });
  let active = false;
  controller.hasActiveWork = () => active;
  controller.dispatch = async () => { entered(); await new Promise(resolve => { release = resolve; }); active = true; return { accepted: true }; };
  const mutation = post({ operation: 'spawn_agent', requestId: 'racing-upgrade', args: { context_mode: 'none' } });
  await started;
  assert.deepEqual((await post({ operation: 'idle_shutdown' })).body, { stopped: false, reason: 'busy' });
  assert.equal(stopped, 0);
  release(); await mutation;
  assert.deepEqual((await post({ operation: 'idle_shutdown' })).body, { stopped: false, reason: 'active' });
  assert.equal(stopped, 0);
  active = false;
  assert.deepEqual((await post({ operation: 'idle_shutdown' })).body, { stopped: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
});

test('an accepted idle upgrade seals mutation admission and parallel upgrades schedule shutdown once', async t => {
  let stopped = 0;
  const { post, controller } = await setup(t, { onShutdown: () => { stopped++; } });
  controller.hasActiveWork = () => false;
  const first = await post({ operation: 'idle_shutdown' });
  assert.deepEqual(first.body, { stopped: true });
  const results = await Promise.all([
    post({ operation: 'idle_shutdown' }),
    post({ operation: 'send_message', requestId: 'too-late', args: {} }),
  ]);
  assert.deepEqual(results[0].body, { stopped: true });
  assert.equal(results[1].body.error.code, 'helper_restarting');
  assert.equal(controller.calls.length, 0);
  assert.equal(stopped, 1);
  assert.equal((await post({ operation: 'health' })).body.ready, false);
});

test('idle upgrade requires the negotiated protocol before making shutdown decisions', async t => {
  let stopped = false;
  const { post } = await setup(t, { requiredProtocol: 2, onShutdown: () => { stopped = true; } });
  const result = await post({ operation: 'idle_shutdown', protocolVersion: 1 });
  assert.equal(result.body.error.code, 'bridge_version_mismatch');
  assert.equal(stopped, false);
});

test('idle upgrade treats a partially received request as in flight before mutation dispatch', async t => {
  let stopped = 0;
  const { post, controller, server, url } = await setup(t, { onShutdown: () => { stopped++; } });
  controller.hasActiveWork = () => false;
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const admitted = once(server, 'request');
  const incoming = request(url, { method: 'POST', headers: { authorization: 'Bearer test-auth' } }, res => {
    res.resume(); res.on('end', finish);
  });
  t.after(() => incoming.destroy());
  incoming.write('{"operation":"send_message",');
  await admitted;
  assert.equal(controller.calls.length, 0);
  assert.deepEqual((await post({ operation: 'idle_shutdown' })).body, { stopped: false, reason: 'busy' });
  assert.equal(stopped, 0);
  incoming.end('"requestId":"incoming","args":{}}');
  await response;
  assert.equal(controller.calls.length, 1);
});

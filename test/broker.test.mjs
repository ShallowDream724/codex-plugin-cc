import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import { createBroker } from '../runtime/broker.mjs';

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
  const url = `http://127.0.0.1:${server.address().port}/`;
  const post = async (body, extra = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body), ...extra });
    return { status: response.status, body: await response.json() };
  };
  return { controller, post, url, server };
}

test('local transport requires a session secret', async t => {
  const { url, controller } = await setup(t);
  const response = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(response.status, 403); assert.equal(controller.calls.length, 0);
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

test('shutdown releases local waiters but drains accepted disconnected mutations before releasing ownership', async t => {
  const { post, controller, server } = await setup(t, { waitTimeoutMs: 10000 });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  controller.dispatch = async op => {
    if (op === 'list_agents') return { agents: [{ agent_id: 'a', status: 'running' }] };
    entered(); await new Promise(resolve => { release = resolve; }); return { accepted: true };
  };
  const abort = new AbortController();
  const action = post({ operation: 'send_message', requestId: 'slow', args: {} }, { signal: abort.signal }).catch(() => {});
  await started;
  const waiting = post({ operation: 'wait' });
  await new Promise(resolve => setTimeout(resolve, 20));
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

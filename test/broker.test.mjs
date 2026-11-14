import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBroker } from '../runtime/broker.mjs';

class FakeController extends EventEmitter {
  constructor() { super(); this.events = []; this.calls = []; this.acks = []; this.status = 'running'; }
  async dispatch(op, args) { this.calls.push({ op, args }); return op === 'list_agents' ? { agents: [{ agent_id: 'a', status: this.status }] } : { agent_id: 'a', accepted: true }; }
  eventsAfter(cursor) { return this.events.filter(e => e.seq > cursor); }
  async ackEvents(cursor) { this.acks.push(cursor); this.events = this.events.filter(e => e.seq > cursor); }
  publish(kind = 'completed') { const e = { seq: 1, kind, agent_id: 'a' }; this.events.push(e); this.emit('event', e); }
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
  return { controller, post, url };
}

test('local transport requires a session secret', async t => {
  const { url, controller } = await setup(t);
  const response = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(response.status, 403); assert.equal(controller.calls.length, 0);
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
  assert.equal(result.body.events[0].kind, 'question'); assert.equal(result.body.cursor, 1);
  assert.deepEqual(controller.acks, [0]); // Delivery is acked by a later host action, not speculatively.
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

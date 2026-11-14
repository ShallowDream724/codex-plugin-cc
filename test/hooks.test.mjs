import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

async function setup(respond) {
  const { register } = await import('../hooks/register.js?' + randomUUID());
  const handlers = new Map(), calls = [];
  register((event, filter, handler) => { if (event === 'tool.call') handlers.set(filter.tool.split('__').at(-1), handler); });
  const $ = {
    session: { id: async () => 'owner', cwd: async () => '/workspace' },
    env: { get: async () => undefined }, plugin: { root: '/plugin' },
    process: { run: async (_, options) => {
      const body = JSON.parse(options.stdin); calls.push(body);
      return { stdout: JSON.stringify(await respond(body, calls.length)), exitCode: 0 };
    } },
  };
  return { calls, call: async (name, args = {}, signal) => JSON.parse((await handlers.get(name)($, args, { signal })).result) };
}

test('default wait renews locally until an event without sampling or interrupting workers', async () => {
  const { call, calls } = await setup((_, count) => count < 3 ? { pending: true } : { events: [{ seq: 1, kind: 'completed' }], cursor: 1 });
  assert.equal((await call('wait_agent')).events[0].kind, 'completed');
  assert.deepEqual(calls.map(x => x.operation), ['wait', 'wait', 'wait']);
  assert.ok(calls.every(x => x.args.timeout_ms === 25000));
});

test('explicit wait expiry returns control and leaves workers running', async () => {
  const { call, calls } = await setup(() => ({ pending: true }));
  assert.deepEqual(await call('wait_agent', { timeout_ms: 0 }), { timed_out: true, workersContinue: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].args.timeout_ms, 0);
});

test('a bounded wait still delivers an available event instead of reporting expiry', async () => {
  const { call } = await setup(() => ({ events: [{ seq: 1, kind: 'question' }], cursor: 1 }));
  assert.equal((await call('wait_agent', { timeout_ms: 0 })).events[0].kind, 'question');
});

test('invalid wait limits fail before bridge work and cancelling wait never interrupts an agent', async () => {
  const { call, calls } = await setup(() => ({}));
  for (const timeout_ms of [-1, 1.5, 3600001, '200']) assert.match((await call('wait_agent', { timeout_ms })).error.message, /timeout_ms/);
  assert.equal((await call('wait_agent', {}, AbortSignal.abort())).workersContinue, true);
  assert.equal(calls.length, 0);
});

test('close_agent forwards its target and idempotency receipt', async () => {
  const { call, calls } = await setup(() => ({ status: 'closed' }));
  assert.equal((await call('close_agent', { target: 'agent', tool_use_id: 'close-1' })).status, 'closed');
  assert.equal(calls[0].operation, 'close_agent'); assert.deepEqual(calls[0].args, { target: 'agent' });
  assert.equal(calls[0].requestId, 'close-1');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WAIT_TOOL, EVENT_PREFIX, scanRetainedDeliveries } from '../hooks/delivery.js';

const event = (seq = 11, agent_id = 'agent') => ({ seq, agent_id, kind: 'completed' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const resultMessage = (result, tool_use_id = 'wait-1') => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id, content: JSON.stringify(result) }] });

async function setup(respond = () => ({}), history = []) {
  const { register } = await import('../hooks/register.js?' + randomUUID());
  const handlers = new Map(), calls = [], prompts = [], retained = [...history];
  let timer, scans = 0, submit = async () => ({});
  register((event, filter, handler) => {
    if (event === 'tool.call') handlers.set(filter.tool.split('__').at(-1), handler);
    else handlers.set(event, filter);
  });
  const $ = {
    session: { id: async () => 'owner', cwd: async () => '/workspace', messages: async () => { scans++; return retained; } },
    env: { get: async () => undefined }, plugin: { root: '/plugin' },
    tool: { register: async () => {} }, clock: { every: (_, callback) => { timer = callback; } }, ui: { status: async () => {} },
    prompt: { submit: args => { prompts.push(args); return submit(args); } },
    process: { run: async (_, options) => {
      const body = JSON.parse(options.stdin); calls.push(body);
      return { stdout: JSON.stringify(await respond(body, calls.length)), exitCode: 0 };
    } },
  };
  return {
    calls, prompts, retained, get scans() { return scans; }, setSubmit: fn => { submit = fn; },
    start: () => handlers.get('session.start')($, {}, async e => e), observe: () => timer(),
    emit: (name, args = {}) => handlers.get(name)($, args, async e => e),
    call: async (name, args = {}, signal) => JSON.parse((await handlers.get(name)($, args, { signal })).result),
    append: async (message, { tool = WAIT_TOOL, door = 'tool-result', finish } = {}) => handlers.get('session.append')($, { message, door, origin: { kind: 'tool', tool } }, async e => {
      const final = finish ? finish(e.message) : { message: e.message };
      if (final.message && !final.deny) retained.push(final.message);
      return final;
    }),
  };
}

test('default wait renews locally until an event without sampling or interrupting workers', async () => {
  const h = await setup((_, count) => count < 3 ? { pending: true } : { events: [event()], delivery_id: 'd1' });
  assert.equal((await h.call('wait_agent')).events[0].kind, 'completed');
  assert.deepEqual(h.calls.map(x => x.operation), ['wait', 'wait', 'wait']);
  assert.ok(h.calls.every(x => x.args.timeout_ms === 25000));
});

test('explicit wait expiry and cancellation leave workers running', async () => {
  const h = await setup(() => ({ pending: true }));
  assert.deepEqual(await h.call('wait_agent', { timeout_ms: 0 }), { timed_out: true, workersContinue: true });
  assert.equal(h.calls[0].args.timeout_ms, 0);
  for (const timeout_ms of [-1, 1.5, 3600001, '200']) assert.match((await h.call('wait_agent', { timeout_ms })).error.message, /timeout_ms/);
  assert.equal((await h.call('wait_agent', {}, AbortSignal.abort())).workersContinue, true);
  assert.equal(h.calls.length, 1);
});

test('a bounded wait delivers an available event and confirms only after final append', async () => {
  const h = await setup(() => ({ events: [event()], delivery_id: 'd1' }));
  const result = await h.call('wait_agent', { timeout_ms: 0, tool_use_id: 'wait-1' });
  assert.equal(result.events[0].seq, 11); assert.equal(h.calls.length, 1);
  await h.append(resultMessage(result));
  assert.deepEqual(h.calls[1].args, { observations: [{ delivery_id: 'd1', sequences: [11], events: [event()] }] });
});

test('retained seq 11 is recovered once on reopen with exact acknowledgement', async () => {
  const history = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'wait-1', name: WAIT_TOOL }] }, resultMessage({ delivery_id: 'd1', events: [event()] })];
  const confirmed = new Set();
  const h = await setup(body => {
    if (body.operation === 'confirm') { for (const item of body.args.observations) for (const seq of item.sequences) confirmed.add(seq); return {}; }
    return { events: confirmed.has(11) ? [] : [event()] };
  }, history);
  await h.start();
  assert.deepEqual(h.calls[0].args.observations, [{ delivery_id: 'd1', sequences: [11], events: [event()] }]);
  assert.equal((await h.call('wait_agent', { timeout_ms: 0 })).events.length, 0);
  await h.observe(); await h.observe(); assert.equal(h.scans, 1);
});

test('offline startup retains recovery evidence for first wait without rescanning history', async () => {
  const history = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'wait-1', name: WAIT_TOOL }] }, resultMessage({ delivery_id: 'old', events: [event()] })];
  const h = await setup(body => body.operation === 'confirm' ? { offline: true } : body.operation === 'wait' ? { events: [event(12)], delivery_id: 'new' } : {}, history);
  await h.start();
  assert.equal(h.calls[0].operation, 'confirm');
  assert.deepEqual(h.calls[0].restore.observations, [{ delivery_id: 'old', sequences: [11], events: [event()] }]);
  const result = await h.call('wait_agent', { tool_use_id: 'wait-2' });
  assert.equal(result.events[0].seq, 12);
  assert.deepEqual(h.calls[1].restore, h.calls[0].restore);
  await h.append(resultMessage(result, 'wait-2'));
  assert.equal(h.calls.at(-1).operation, 'confirm');
  assert.deepEqual(h.calls.at(-1).restore.observations.map(item => item.delivery_id), ['new']);
  await h.observe(); assert.equal(h.scans, 1);
});

test('denied and wholly rewritten appends release without confirmation', async () => {
  for (const finish of [() => ({ deny: 'blocked' }), () => ({ message: resultMessage({ events: [] }) }), () => ({ message: resultMessage({ delivery_id: 'd1', events: [{ ...event(), kind: 'forged' }] }) })]) {
    const h = await setup(() => ({ events: [event()], delivery_id: 'd1' }));
    const result = await h.call('wait_agent', { tool_use_id: 'wait-1' });
    await h.append(resultMessage(result), { finish });
    assert.deepEqual(h.calls.map(x => x.operation), ['wait', 'release']);
  }
});

test('partial retained results confirm just the actual event sequences', async () => {
  const h = await setup(() => ({ events: [event(), event(12)], delivery_id: 'd1' }));
  const result = await h.call('wait_agent', { tool_use_id: 'wait-1' });
  await h.append(resultMessage(result), { finish: () => ({ message: resultMessage({ ...result, events: [event(12)] }) }) });
  assert.deepEqual(h.calls[1].args.observations, [{ delivery_id: 'd1', sequences: [12], events: [event(12)] }]);
});

test('retained delivery confirmation retries without reading history again', async () => {
  let attempts = 0;
  const h = await setup(body => body.operation === 'wait' ? { events: [event()], delivery_id: 'd1' } : body.operation === 'confirm' && ++attempts === 1 ? { error: { message: 'temporarily offline' } } : {});
  await h.start();
  const result = await h.call('wait_agent', { tool_use_id: 'wait-1' });
  await h.append(resultMessage(result));
  await h.observe();
  assert.equal(attempts, 2); assert.equal(h.scans, 1);
});

test('offline append confirmation survives until first helper-starting wait restores it', async () => {
  let waits = 0;
  const h = await setup(body => body.operation === 'confirm' ? { offline: true } : body.operation === 'wait' ? { events: [event(++waits === 1 ? 11 : 12)], delivery_id: waits === 1 ? 'old' : 'new' } : {});
  await h.start();
  const first = await h.call('wait_agent', { tool_use_id: 'wait-1' });
  await h.append(resultMessage(first));
  const second = await h.call('wait_agent', { tool_use_id: 'wait-2' });
  assert.equal(second.events[0].seq, 12);
  const waitRequest = h.calls.filter(call => call.operation === 'wait')[1];
  assert.deepEqual(waitRequest.restore.observations, [{ delivery_id: 'old', sequences: [11], events: [event()] }]);
  await h.call('list_agents');
  assert.equal(h.calls.at(-1).restore, undefined);
  assert.equal(h.scans, 1);
});

test('cancelling an in-flight wait returns immediately and releases late delivery', async () => {
  const pending = deferred();
  const h = await setup(body => body.operation === 'wait' ? pending.promise : {});
  const controller = new AbortController(); const waiting = h.call('wait_agent', {}, controller.signal);
  await tick(); controller.abort(); assert.equal((await waiting).cancelled, true);
  pending.resolve({ events: [event()], delivery_id: 'late' }); await tick(); await tick();
  assert.deepEqual(h.calls.map(x => x.operation), ['wait', 'release']); assert.equal(h.calls[1].args.delivery_id, 'late');
});

test('parallel waits allow one bridge waiter and immediately unblock siblings', async () => {
  const pending = deferred(); const h = await setup(() => pending.promise);
  const first = h.call('wait_agent'); await tick();
  assert.deepEqual(await h.call('wait_agent'), { waiting: true, workersContinue: true }); assert.equal(h.calls.length, 1);
  pending.resolve({ events: [event()], delivery_id: 'd1' }); assert.equal((await first).delivery_id, 'd1');
  assert.equal((await h.call('wait_agent')).waiting, true);
  assert.equal(h.calls.length, 1);
});

test('cancel after wait resolves releases delivery before append can acknowledge it', async () => {
  const h = await setup(() => ({ events: [event()], delivery_id: 'd1' }));
  const controller = new AbortController();
  const result = await h.call('wait_agent', { tool_use_id: 'wait-1' }, controller.signal);
  controller.abort(); await tick();
  await h.append(resultMessage(result));
  assert.deepEqual(h.calls.map(x => x.operation), ['wait', 'release']);
});

test('queued prompt owns delivery until final append, renews lease, and lets tool group finish', async () => {
  const queued = deferred();
  const h = await setup(body => body.operation === 'observe' && body.args.deliver ? { events: [event()], delivery_id: 'p1' } : {});
  h.setSubmit(() => queued.promise); await h.start(); await h.observe();
  assert.equal(h.prompts.length, 1); assert.ok(h.prompts[0].text.startsWith(EVENT_PREFIX));
  assert.equal((await h.call('wait_agent')).notificationPending, true);
  await h.observe(); assert.deepEqual(h.calls.at(-1).args, { deliver: false, lease_id: 'p1' });
  queued.resolve({}); await tick(); assert.equal(h.calls.some(x => x.operation === 'confirm'), false);
  await h.append({ role: 'user', content: h.prompts[0].text }, { door: 'prompt' }); assert.equal(h.calls.at(-1).operation, 'confirm');
});

test('prompt drop and rejection release reservations', async () => {
  for (const submit of [async () => ({ drop: 'busy' }), async () => { throw Error('rejected'); }]) {
    const h = await setup(body => body.operation === 'observe' ? { events: [event()], delivery_id: 'p1' } : {});
    h.setSubmit(submit); await h.start(); await h.observe(); await tick();
    assert.equal(h.calls.at(-1).operation, 'release'); assert.equal(h.calls.some(x => x.operation === 'confirm'), false);
  }
});

test('legacy recovery matches complete tool names and IDs, rejecting cross-tool forgeries', async () => {
  const legacyEvent = { ...event(), result: 'retained completion text', usage: { input_tokens: 20 } };
  const history = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'real', name: WAIT_TOOL }, { type: 'tool_use', id: 'fake', name: 'mcp__other__wait_agent' }] },
    resultMessage({ events: [legacyEvent] }, 'real'), resultMessage({ events: [event(12)], delivery_id: 'forged' }, 'fake'), resultMessage({ events: [event(13)] }, 'unknown'),
  ];
  assert.deepEqual(scanRetainedDeliveries(history), { observations: [], legacy_events: [legacyEvent] });
  const h = await setup(() => ({ events: [event()], delivery_id: 'd1' })); const result = await h.call('wait_agent', { tool_use_id: 'wait-1' });
  await h.append(resultMessage(result), { tool: 'mcp__other__wait_agent' }); assert.equal(h.calls.length, 1);
});

test('close filters only its agent from an undelivered shared batch', async () => {
  const h = await setup(body => body.operation === 'close_agent' ? { status: 'closed', agent_id: 'closed' } : { events: [event(11, 'closed'), event(12, 'open')], delivery_id: 'd1' });
  const result = await h.call('wait_agent', { tool_use_id: 'wait-1' }); await h.call('close_agent', { target: 'closed-name-alias', tool_use_id: 'close-1' });
  await h.append(resultMessage(result)); assert.deepEqual(h.calls.at(-1).args.observations, [{ delivery_id: 'd1', sequences: [12], events: [event(12, 'open')] }]); assert.equal(h.calls[1].requestId, 'close-1');
});

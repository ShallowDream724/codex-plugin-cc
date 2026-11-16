import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WAIT_TOOL, EVENT_PREFIX, messageDeliveries, scanRetainedDeliveries, filterClosed } from '../hooks/delivery.js';
import { DeliveryStore, formatDeliveryEvent } from '../runtime/delivery.mjs';

const event = (seq = 11, agent_id = 'agent') => ({ seq, agent_id, kind: 'completed' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const resultMessage = (result, tool_use_id = 'wait-1') => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id, content: JSON.stringify(result) }] });

async function setup(respond = () => ({}), history = [], userConfig = {}) {
  const { register } = await import('../hooks/register.js?' + randomUUID());
  const handlers = new Map(), appendHandlers = [], calls = [], envs = [], prompts = [], retained = [...history];
  let timer, scans = 0, submit = async () => ({}), appendNote = async args => ({ message: args.message, uuid: 'note' });
  register((event, filter, handler) => {
    if (event === 'session.append') appendHandlers.push({ filter, handler });
    else if (event === 'tool.call') handlers.set(filter.tool.split('__').at(-1), handler);
    else handlers.set(event, filter);
  }, userConfig);
  const $ = {
    session: { id: async () => 'owner', cwd: async () => '/workspace', messages: async () => { scans++; return retained; }, append: args => appendNote(args) },
    env: { get: async () => undefined }, plugin: { root: '/plugin' },
    tool: { register: async () => {} }, clock: { every: (_, callback) => { timer = callback; } }, ui: { status: async () => {}, invalidate: () => {} },
    prompt: { submit: args => { prompts.push(args); return submit(args); } },
    process: { run: async (_, options) => {
      const body = JSON.parse(options.stdin); calls.push(body); envs.push(options.env);
      return { stdout: JSON.stringify(await respond(body, calls.length)), exitCode: 0 };
    } },
  };
  return {
    calls, envs, prompts, retained, appendHandlers, get scans() { return scans; }, setSubmit: fn => { submit = fn; }, setAppendNote: fn => { appendNote = fn; },
    start: () => handlers.get('session.start')($, {}, async e => e), observe: () => timer(),
    emit: (name, args = {}) => handlers.get(name)($, args, async e => e),
    step: async args => { for await (const _ of handlers.get('turn.step')($, args, async function* () {})) {} },
    call: async (name, args = {}, signal) => JSON.parse((await handlers.get(name)($, args, { signal })).result),
    append: async (message, { tool = WAIT_TOOL, door = 'tool-result', origin = { kind: 'tool', tool }, finish } = {}) => {
      const e = { message, door, origin };
      const matches = (filter, value) => Object.entries(filter).every(([key, expected]) => expected && typeof expected === 'object'
        ? value?.[key] && matches(expected, value[key]) : value?.[key] === expected);
      const handler = appendHandlers.find(({ filter }) => matches(filter, e))?.handler;
      const next = async current => {
        const final = finish ? finish(current.message) : { message: current.message };
        if (final.message && !final.deny) retained.push(final.message);
        return final;
      };
      return handler ? handler($, e, next) : next(e);
    },
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

test('append subscriptions exclude protected doors and unrelated tool results', async () => {
  const h = await setup(() => ({ events: [event()], delivery_id: 'd1' }));
  assert.deepEqual(h.appendHandlers.map(({ filter }) => filter), [
    { door: 'tool-result', origin: { kind: 'tool', tool: WAIT_TOOL } },
    { door: 'prompt' },
  ]);
  const result = await h.call('wait_agent', { tool_use_id: 'wait-1' });
  for (const options of [
    { door: 'attachment' }, { door: 'hook-context' }, { door: 'compaction' },
    { door: 'tool-message' }, { door: 'note' },
    { tool: 'mcp__other__wait_agent' }, { origin: { kind: 'other', tool: WAIT_TOOL } },
  ]) await h.append(resultMessage(result), options);
  assert.deepEqual(h.calls.map(call => call.operation), ['wait']);
  await h.append(resultMessage(result));
  assert.equal(h.calls.at(-1).operation, 'confirm');
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

test('a late batch note wakes only when no subsequent model step ran', async () => {
  const pending = deferred(), notes = [];
  const h = await setup(body => body.operation === 'observe' && body.args.deliver ? { events: [event()], delivery_id: 'busy' } : {});
  h.setAppendNote(args => { notes.push(args); return pending.promise; });
  await h.start(); await h.emit('turn.start', { turnId: 'turn' });
  const observation = h.emit('classic.PostToolBatch'); await tick();
  assert.equal(notes.length, 1); assert.equal(h.prompts.length, 0);
  assert.equal((await h.call('wait_agent')).notificationPending, true);
  await h.emit('turn.complete', { turnId: 'turn', reason: 'answer' });
  pending.resolve({ message: notes[0].message, uuid: 'kept' }); await observation; await tick();
  assert.deepEqual(h.calls.find(call => call.operation === 'confirm').args.observations, [{ delivery_id: 'busy', sequences: [11], events: [event()] }]);
  assert.equal(h.prompts.length, 1); assert.doesNotMatch(h.prompts[0].text, /"events"|"seq"/);
  assert.deepEqual(scanRetainedDeliveries([notes[0].message]).observations[0].sequences, [11]);
});

test('busy note refusal, rewrite or exception releases the lease without acknowledging it', async () => {
  for (const outcome of [{ deny: 'blocked' }, { message: { type: 'user', content: [{ type: 'text', text: 'rewritten' }] } }, new Error('append failed')]) {
    const h = await setup(body => body.operation === 'observe' ? { events: [event()], delivery_id: 'busy' } : {});
    h.setAppendNote(async () => { if (outcome instanceof Error) throw outcome; return outcome; }); await h.start(); await h.emit('turn.start', { turnId: 'turn' }); await h.emit('classic.PostToolBatch');
    assert.equal(h.calls.at(-1).operation, 'release'); assert.equal(h.calls.some(call => call.operation === 'confirm'), false);
    assert.equal(h.prompts.length, 0);
  }
});

test('busy note confirms only exact retained events and recovers that note on restart', async () => {
  let note;
  const h = await setup(body => body.operation === 'observe' ? { events: [event(), event(12)], delivery_id: 'busy' } : {});
  h.setAppendNote(async args => {
    const original = JSON.parse(args.message.content[0].text.slice(EVENT_PREFIX.length));
    note = { type: 'user', content: [{ type: 'text', text: EVENT_PREFIX + JSON.stringify({ ...original, events: [event(12)] }) }] };
    return { message: note, uuid: 'kept' };
  });
  await h.start(); await h.emit('turn.start', { turnId: 'turn' }); await h.emit('classic.PostToolBatch');
  const observation = { delivery_id: 'busy', sequences: [12], events: [event(12)] };
  assert.deepEqual(h.calls.at(-1).args.observations, [observation]);
  const reopened = await setup(() => ({}), [note]); await reopened.start();
  assert.deepEqual(reopened.calls[0].args.observations, [observation]);
});

test('a wait starting during observation wins over a late busy note', async () => {
  const observed = deferred(), waiting = deferred();
  const h = await setup(body => body.operation === 'observe' ? observed.promise : body.operation === 'wait' ? waiting.promise : {});
  let notes = 0; h.setAppendNote(async () => { notes++; });
  await h.start(); await h.emit('turn.start', { turnId: 'turn' });
  const observation = h.emit('classic.PostToolBatch'); await tick(); const wait = h.call('wait_agent'); await tick();
  observed.resolve({ events: [event()], delivery_id: 'late' }); await observation;
  assert.equal(notes, 0); assert.equal(h.calls.at(-1).operation, 'release');
  waiting.resolve({ events: [], delivery_id: undefined }); await wait;
});

test('batch delivery consumed by the next step does not start another turn', async () => {
  let issued = false;
  const h = await setup(body => body.operation === 'observe' && body.args.deliver && !issued ? (issued = true, { events: [event()], delivery_id: 'busy' }) : {});
  await h.start(); await h.emit('turn.start', { turnId: 'turn' });
  await h.observe(); assert.equal(issued, false);
  await h.emit('classic.PostToolBatch');
  assert.equal(h.calls.some(call => call.operation === 'confirm'), true);
  await h.step({ turnId: 'turn' }); await h.emit('turn.complete', { turnId: 'turn', reason: 'answer' }); await tick();
  assert.deepEqual(h.prompts, []);
});

test('user interruption never wakes a retained batch note or polls new prompts', async () => {
  const h = await setup(body => body.operation === 'observe' && body.args.deliver ? { events: [event()], delivery_id: 'busy' } : {});
  await h.start(); await h.emit('turn.start', { turnId: 'turn' }); await h.emit('classic.PostToolBatch');
  await h.emit('turn.complete', { turnId: 'turn', reason: 'aborted', isAborted: true }); await h.observe(); await tick();
  assert.deepEqual(h.prompts, []); assert.equal(h.calls.at(-1).args.deliver, false);
});

test('a note retained after user interruption does not wake the session', async () => {
  const pending = deferred(); let note;
  const h = await setup(body => body.operation === 'observe' && body.args.deliver ? { events: [event()], delivery_id: 'busy' } : {});
  h.setAppendNote(args => { note = args.message; return pending.promise; });
  await h.start(); await h.emit('turn.start', { turnId: 'turn' });
  const batch = h.emit('classic.PostToolBatch'); await tick();
  await h.emit('turn.complete', { turnId: 'turn', reason: 'aborted', isAborted: true });
  pending.resolve({ message: note, uuid: 'kept' }); await batch; await h.observe();
  assert.equal(h.calls.some(call => call.operation === 'confirm'), true); assert.deepEqual(h.prompts, []);
});

test('direct user sends never submit a parent prompt', async () => {
  const send = { seq: 3, agent_id: 'a', turn_id: 'private', name: 'worker', kind: 'message', origin: 'user', action: 'send', phase: 'delivered', message: 'PRIVATE_USER_ACTION' };
  const controller = { events: [send], eventsAfter() { return structuredClone(this.events); },
    async ackSequences(sequences) { this.events = this.events.filter(event => !sequences.includes(event.seq)); } };
  const delivery = new DeliveryStore({ controller });
  const h = await setup(body => body.operation === 'observe' ? delivery.claim({ channel: 'prompt' }) : {});
  await h.start(); await h.observe();
  assert.equal(formatDeliveryEvent(send), null); assert.deepEqual(controller.events, []);
  assert.deepEqual(h.prompts, []); assert.equal(h.calls.some(call => call.operation === 'confirm'), false);
});

test('user stop facts still prompt and confirm exact framed receipts on append and recovery', async () => {
  const receipt = formatDeliveryEvent({ seq: 3, agent_id: 'a', name: 'worker', kind: 'message', origin: 'user', action: 'interrupt', phase: 'confirmed', message: 'User stop detail' });
  for (const [head, tail] of [
    ['The codex-subagents plugin sent a message:\n', "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above."],
    ['The codex-subagents plugin sent a message while you were working:\n', '\n\nThis is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn.'],
  ]) {
    const h = await setup(body => body.operation === 'observe' ? { events: [receipt], delivery_id: 'receipt' } : {});
    await h.start(); await h.observe();
    const content = h.prompts[0].text, value = JSON.parse(content.slice(EVENT_PREFIX.length));
    assert.deepEqual(value.events, [receipt]); assert.equal(value.events[0].message, undefined);
    assert.equal(value.events[0].quoted_user_message, undefined); assert.equal(value.events[0].kind, 'user_action_receipt');
    assert.match(value.events[0].summary, /已按用户要求停止/);
    const retained = { role: 'user', content: [{ type: 'text', text: head + content + tail }] };
    const observation = { delivery_id: 'receipt', sequences: [3], events: [receipt] };
    await h.append(retained, { door: 'prompt' });
    assert.deepEqual(h.calls.at(-1).args.observations, [observation]);
    assert.deepEqual(scanRetainedDeliveries([retained]).observations, [observation]);
    const reopened = await setup(() => ({}), [retained]); await reopened.start();
    assert.equal(reopened.calls[0].operation, 'confirm');
    assert.deepEqual(reopened.calls[0].args.observations, [observation]);
  }
});

test('exact native plugin prompt frames acknowledge final retained events and recover on reopen', async () => {
  for (const [head, tail] of [
    ['The codex-subagents plugin sent a message:\n', "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above."],
    ['The codex-subagents plugin sent a message while you were working:\n', '\n\nThis is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn.'],
  ]) {
    const h = await setup(body => body.operation === 'observe' ? { events: [event()], delivery_id: 'framed' } : {});
    await h.start(); await h.observe();
    const message = { role: 'user', content: [{ type: 'text', text: head + h.prompts[0].text + tail }] };
    await h.append(message, { door: 'prompt' });
    const observation = { delivery_id: 'framed', sequences: [11], events: [event()] };
    assert.deepEqual(h.calls.at(-1).args.observations, [observation]);
    assert.deepEqual(scanRetainedDeliveries([message]).observations, [observation]);
    for (const content of [head.replace('codex-subagents', 'other-plugin') + h.prompts[0].text + tail, 'Quoted notification: ' + head + h.prompts[0].text + tail, head + h.prompts[0].text + tail + ' extra']) {
      assert.deepEqual(messageDeliveries({ content }, { prompt: true }), []);
    }
    const filtered = filterClosed(message, { prompt: true }, new Set(['agent']));
    const encoded = filtered.content[0].text;
    assert.ok(encoded.startsWith(head + EVENT_PREFIX)); assert.ok(encoded.endsWith(tail));
    assert.deepEqual(messageDeliveries(filtered, { prompt: true })[0].events, []);
  }
});

test('a rewritten event inside the exact host frame is released without confirmation', async () => {
  const head = 'The codex-subagents plugin sent a message:\n';
  const tail = "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
  const h = await setup(body => body.operation === 'observe' ? { events: [event()], delivery_id: 'framed' } : {});
  await h.start(); await h.observe();
  const message = { role: 'user', content: head + h.prompts[0].text + tail };
  await h.append(message, { door: 'prompt', finish: () => ({ message: { ...message, content: head + EVENT_PREFIX + JSON.stringify({ delivery_id: 'framed', events: [{ ...event(), kind: 'changed' }] }) + tail } }) });
  assert.equal(h.calls.at(-1).operation, 'release'); assert.equal(h.calls.some(call => call.operation === 'confirm'), false);
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

test('default role skips the host context read and user permissions stay outside model arguments', async () => {
  const h = await setup(() => ({ agent_id: 'a' }), [], { maxActiveAgents: '7', permissionsMode: 'auto-review' });
  await h.call('spawn_agent', { role: 'default', message: 'Locate the symbol', tool_use_id: 'scout' });
  assert.equal(h.scans, 0);
  assert.equal(h.calls[0].args.context_mode, 'none');
  assert.equal(h.calls[0].args.role, 'default');
  assert.equal(h.calls[0].context, undefined);
  assert.deepEqual(JSON.parse(h.envs[0].CODEX_SUBAGENTS_SETTINGS), { maxActiveAgents: 7, permissionsMode: 'auto-review' });
  assert.equal(h.calls[0].args.permissionsMode, undefined);
  const refused = await h.call('spawn_agent', { role: 'default', context_mode: 'available', message: 'task' });
  assert.match(refused.error.message, /task-only context/);
  assert.equal(h.scans, 0); assert.equal(h.calls.length, 1);
});

test('bulk close hides long ID receipts from Claude while filtering every closed agent', async () => {
  const events = [event(11, 'a'), event(12, 'b'), event(13, 'keep')];
  const h = await setup(body => body.operation === 'close_agent' ? { closed_count: 2, closed_ids: ['a', 'b'], skipped: [] } : { events, delivery_id: 'batch' });
  const result = await h.call('wait_agent', { tool_use_id: 'wait-1' });
  assert.deepEqual(await h.call('close_agent', { targets: 'all', except: ['keep'], tool_use_id: 'close' }), { closed_count: 2, skipped: [] });
  await h.append(resultMessage(result));
  assert.deepEqual(h.calls.at(-1).args.observations[0].sequences, [13]);
});

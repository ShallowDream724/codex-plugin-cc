import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeliveryStore, formatDeliveryEvent } from '../runtime/delivery.mjs';
import { DiskReceipts, MemoryReceipts, requestFingerprint } from '../runtime/receipts.mjs';
import { writeJson } from '../runtime/storage.mjs';

function controller(count = 3) {
  return { events: Array.from({ length: count }, (_, i) => ({ seq: i + 1, agent_id: 'agent-' + i, kind: 'completed', result: 'result-' + i })),
    eventsAfter() { return structuredClone(this.events); },
    async ackSequences(sequences) { this.events = this.events.filter(event => !sequences.includes(event.seq)); } };
}
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'codex-delivery-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('direct user sends have no parent delivery representation', () => {
  const original = { seq: 3, agent_id: 'a', name: 'terra-nested-test', kind: 'message', origin: 'user', action: 'send', phase: 'delivered', delivery_status: 'started', message: 'Add another line; do not delegate.' };
  assert.equal(formatDeliveryEvent(original), null);
  assert.equal(original.kind, 'message'); assert.equal(original.message, 'Add another line; do not delegate.');
  for (const event of [{ ...original, origin: 'codex' }, { seq: 4, agent_id: 'a', kind: 'message', message: 'Agent update' }, { ...original, action: 'answer' }]) {
    assert.equal(formatDeliveryEvent(event), event);
  }
  assert.equal(formatDeliveryEvent({ ...original, phase: 'failed', delivery_status: 'unconfirmed' }), null);
  assert.equal(formatDeliveryEvent({ ...original, kind: 'user_action_receipt', quoted_user_message: original.message }), null);
});

test('compaction status stays out of parent deliveries, including legacy queued events', async () => {
  for (const channel of ['prompt', 'wait']) {
    const c = controller(0);
    c.events = [
      { seq: 1, agent_id: 'agent', kind: 'compacting' },
      { seq: 2, agent_id: 'agent', kind: 'compacted' },
      ...['question', 'approval', 'failed', 'completed', 'message', 'future_event'].map((kind, i) => ({ seq: i + 3, agent_id: 'agent', kind })),
    ];
    assert.equal(formatDeliveryEvent(c.events[0]), null);
    assert.equal(formatDeliveryEvent(c.events[1]), null);
    const store = new DeliveryStore({ controller: c });
    const batch = await store.claim({ channel });
    assert.deepEqual(batch.events.map(e => e.kind), ['question', 'approval', 'failed', 'completed', 'message', 'future_event']);
    assert.deepEqual(c.events.map(e => e.seq), [3, 4, 5, 6, 7, 8]);
  }
});

test('an old lease containing only compaction does not block the next useful notification', async () => {
  const c = controller(0);
  c.events = [{ seq: 1, agent_id: 'agent', kind: 'compacting' }];
  const records = new MemoryReceipts({ old: { status: 'issued', sequences: [1], acknowledged: [] } });
  const store = new DeliveryStore({ controller: c, records, now: () => 10 });
  store.lease = { id: 'old', expiresAt: 1000 };
  assert.deepEqual(await store.claim({ channel: 'prompt' }), { events: [] });
  assert.equal(store.lease, null); assert.deepEqual(c.events, []);
  c.events.push({ seq: 2, agent_id: 'agent', kind: 'completed', result: 'done' });
  assert.deepEqual((await store.claim()).events, c.events);
});

test('stop receipts distinguish requested, stopped, and unconfirmed without a new task message', () => {
  const base = { seq: 1, agent_id: 'a', name: 'worker', kind: 'message', origin: 'user', action: 'interrupt', message: 'Stop status detail' };
  for (const [phase, expected] of [['requested', '用户已请求停止 Codex 子代理 worker 及其子代理。'], ['stopping', 'Codex 子代理 worker 及其子代理 正在按用户要求停止。'], ['confirmed', 'Codex 子代理 worker 及其子代理 已按用户要求停止。'], ['unconfirmed', '用户请求停止 Codex 子代理 worker 及其子代理，停止状态未确认。']]) {
    const receipt = formatDeliveryEvent({ ...base, phase });
    assert.equal(receipt.summary, expected); assert.equal(receipt.kind, 'user_action_receipt');
    assert.equal(receipt.message, undefined); assert.equal(receipt.status_detail, undefined);
    assert.equal(receipt.quoted_user_message, undefined);
    assert.doesNotMatch(receipt.summary, /followup|resume|重启|恢复/);
  }
});

test('parent wire omits native routing IDs while preserving names, business fields and original journal', async () => {
  const c = controller(0);
  const raw = { seq: 1, agent_id: 'agent', name: 'worker', kind: 'question', turn_id: 'turn', turnId: 'native-turn',
    thread_id: 'thread', threadId: 'native-thread', source_thread_id: 'child-thread', item_id: 'item', itemId: 'native-item',
    request_id: 'question-1', method: 'item/tool/requestUserInput',
    questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'Continue', description: 'Continue work.' }] }],
    reply_format: { answers: { choice: { answers: ['<answer>'] } } },
    future_business_field: { threadId: 'business value', content: 'Keep this whole value' }, status: null };
  c.events = [raw];
  const store = new DeliveryStore({ controller: c }); const batch = await store.claim();
  const { turn_id, turnId, thread_id, threadId, source_thread_id, item_id, itemId, ...expected } = raw;
  assert.deepEqual(batch.events, [expected]); assert.deepEqual(c.events, [raw]);
  assert.equal(batch.events[0].name, 'worker'); assert.equal(batch.events[0].request_id, 'question-1');
  const record = await store.records.get(batch.delivery_id);
  assert.equal(record.hashes[1], requestFingerprint('event', expected));
  assert.notEqual(record.hashes[1], requestFingerprint('event', raw));
});

test('projected wire confirms only exact retained business content and supports partial acknowledgements', async () => {
  const c = controller(0);
  c.events = [
    { seq: 1, agent_id: 'agent', name: 'worker', turn_id: 'turn-1', kind: 'message', message: 'Coordination message' },
    { seq: 2, agent_id: 'agent', name: 'worker', turn_id: 'turn-2', kind: 'completed', result: 'Complete business result' },
  ];
  const store = new DeliveryStore({ controller: c }); const batch = await store.claim();
  const changed = { ...batch.events[0], message: 'Rewritten message' };
  const first = await store.confirm({ observations: [{ delivery_id: batch.delivery_id, sequences: [1, 2], events: [changed, batch.events[1]] }] });
  assert.deepEqual(first.rejected, [{ delivery_id: batch.delivery_id, sequences: [1] }]);
  assert.deepEqual(c.events.map(event => event.seq), [1]); assert.equal(c.events[0].turn_id, 'turn-1');
  await store.confirm({ observations: [{ delivery_id: batch.delivery_id, sequences: [1], events: [batch.events[0]] }] });
  assert.deepEqual(c.events, []);
});

test('old full-event receipt hashes still require and confirm the exact old wire without migration', async () => {
  const c = controller(0);
  const old = { seq: 1, agent_id: 'agent', name: 'worker', turn_id: 'old-turn', kind: 'message', message: 'Old retained message' };
  c.events = [old];
  const records = new MemoryReceipts({ old: { status: 'issued', sequences: [1], hashes: { 1: requestFingerprint('event', old) }, acknowledged: [] } });
  const store = new DeliveryStore({ controller: c, records });
  const { turn_id, ...projected } = old;
  const rejected = await store.confirm({ observations: [{ delivery_id: 'old', sequences: [1], events: [projected] }] });
  assert.deepEqual(rejected.rejected, [{ delivery_id: 'old', sequences: [1] }]); assert.deepEqual(c.events, [old]);
  await store.confirm({ observations: [{ delivery_id: 'old', sequences: [1], events: [old] }] });
  assert.deepEqual(c.events, []);
});

test('legacy send receipts and their exact-turn automatic results are retired before delivery', async () => {
  const c = controller(0);
  const raw = { seq: 3, agent_id: 'a', turn_id: 'private', name: 'worker', kind: 'message', origin: 'user', action: 'send', phase: 'delivered', message: 'Add another line.' };
  const safe = { seq: 4, agent_id: 'a', turn_id: 'public', kind: 'completed', result: 'parent result' };
  c.events = [{ seq: 1, agent_id: 'a', turn_id: 'private', kind: 'completed', result: 'private result' }, raw,
    { ...raw, seq: 2, kind: 'user_action_receipt', quoted_user_message: raw.message }, safe,
    { seq: 5, agent_id: 'a', turn_id: 'private', kind: 'message', message: 'explicit notify_parent' }];
  const store = new DeliveryStore({ controller: c });
  const first = await store.claim({ channel: 'prompt' });
  assert.deepEqual(first.events.map(e => e.seq), [4, 5]);
  assert.deepEqual(c.events.map(e => e.seq), [4, 5]);
  await store.confirm({ delivery_ids: [first.delivery_id] });
  assert.deepEqual(c.events, []);
});

test('delivery survives restart, confirms exact retained results and never trusts another owner', async t => {
  const dir = await temp(t), c = controller();
  const first = await DeliveryStore.open({ directory: dir, controller: c });
  const batch = await first.claim({ channel: 'wait', toolUseId: 'call-1' });
  assert.equal((await first.claim()).busy, true);
  const restarted = await DeliveryStore.open({ directory: dir, controller: c });
  const foreign = new DeliveryStore({ controller: c });
  assert.deepEqual((await foreign.confirm({ delivery_ids: [batch.delivery_id] })).unknown, [batch.delivery_id]);
  assert.equal(c.events.length, 3);
  await restarted.confirm({ observations: [{ delivery_id: batch.delivery_id, sequences: [1, 2, 3], events: batch.events }] });
  assert.equal(c.events.length, 0);
  assert.deepEqual((await restarted.claim()).events, []);
  assert.deepEqual((await restarted.confirm({ delivery_ids: [batch.delivery_id] })).confirmed, [batch.delivery_id]);
});

test('event delivery waits for durable publication and excludes arrivals beyond its barrier', async () => {
  const c = controller(1); let release, stored = false;
  c.persist = () => new Promise(resolve => { release = () => { stored = true; resolve(); }; });
  const store = new DeliveryStore({ controller: c }); let settled = false;
  const claimed = store.claim().then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(stored, false);
  c.events.push({ seq: 2, agent_id: 'later', kind: 'completed', result: 'later' });
  release();
  assert.deepEqual((await claimed).events.map(event => event.seq), [1]);
});

test('partial or rewritten host results cannot erase unrelated events', async () => {
  const c = controller(), store = new DeliveryStore({ controller: c });
  const batch = await store.claim();
  const changed = { ...batch.events[1], result: 'changed' };
  const result = await store.confirm({ observations: [{ delivery_id: batch.delivery_id, sequences: [1, 2], events: [batch.events[0], changed] }] });
  assert.deepEqual(result.rejected[0].sequences, [2]);
  assert.deepEqual(c.events.map(e => e.seq), [2, 3]);
  assert.deepEqual((await store.claim()).events.map(e => e.seq), [2, 3]);
});

test('cancel/release and expired lease replay unconfirmed events, with whole-event paging', async () => {
  const c = controller(70); let now = 0;
  const store = new DeliveryStore({ controller: c, now: () => now, leaseMs: 10 });
  const first = await store.claim(); assert.equal(first.events.length, 32); assert.equal(first.more, true);
  await store.release(first.delivery_id);
  const second = await store.claim(); assert.deepEqual(second.events, first.events);
  now = 9; await store.renew(second.delivery_id); now = 11;
  assert.equal((await store.claim()).busy, true);
  now = 20;
  const third = await store.claim(); assert.deepEqual(third.events, first.events);
  await store.confirm({ delivery_ids: [first.delivery_id] }); // Late acknowledgement still has exact scope.
  assert.deepEqual((await store.claim()).events.map(e => e.seq), Array.from({ length: 32 }, (_, i) => i + 33));
});

test('legacy recovery requires exact event identity, not just a sequence number', async () => {
  const c = controller(), store = new DeliveryStore({ controller: c });
  await store.confirm({ legacy_events: [{ seq: 1, agent_id: 'other', kind: 'completed' }, { seq: 2, agent_id: 'agent-1', kind: 'failed' }] });
  assert.equal(c.events.length, 3);
  await store.confirm({ legacy_events: [{ ...c.events[1], result: 'rewritten' }] });
  assert.equal(c.events.length, 3);
  await store.confirm({ legacy_events: [c.events[1]] });
  assert.deepEqual(c.events.map(e => e.seq), [1, 3]);
});

test('disk receipts migrate once and survive hundreds of independent actions without a full-state rewrite', async t => {
  const dir = await temp(t), legacyPath = join(dir, 'receipts.json'), directory = join(dir, 'records');
  await writeJson(legacyPath, { old: { status: 'done', result: { agent_id: 'old-agent' } } });
  const store = await DiskReceipts.open(directory, { legacyPath });
  const firstPath = store.path('old');
  const fs = await import('node:fs/promises');
  const before = await fs.stat(firstPath);
  for (let i = 0; i < 300; i++) await store.put('call-' + i, { status: 'done', result: { agent_id: 'agent-' + i } });
  assert.equal((await fs.stat(firstPath)).mtimeMs, before.mtimeMs);
  await writeFile(legacyPath, 'not read again');
  const restarted = await DiskReceipts.open(directory, { legacyPath });
  assert.equal((await restarted.get('old')).result.agent_id, 'old-agent');
  assert.equal((await restarted.get('call-299')).result.agent_id, 'agent-299');
  assert.equal(await restarted.get('never-issued'), null);
  assert.equal((await readdir(directory)).filter(x => x.endsWith('.json')).length, 302);
  await writeFile(restarted.path('call-299'), 'corrupt');
  await assert.rejects(restarted.get('call-299'), SyntaxError); // Corruption never becomes permission to replay.
  await writeFile(restarted.path('call-299'), 'null');
  await assert.rejects(restarted.get('call-299'), /Invalid receipt/);
  await writeFile(join(dir, 'invalid-legacy.json'), '[]');
  await assert.rejects(DiskReceipts.open(join(dir, 'invalid-records'), { legacyPath: join(dir, 'invalid-legacy.json') }), /Invalid legacy/);
});

test('failed atomic replacement keeps the original target and cleans its temporary file', async t => {
  const dir = await temp(t), target = join(dir, 'target'); await mkdir(target);
  await assert.rejects(writeJson(target, { secret: 'only a fixture' }));
  assert.deepEqual(await readdir(dir), ['target']);
});

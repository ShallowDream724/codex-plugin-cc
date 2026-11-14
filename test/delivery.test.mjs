import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeliveryStore } from '../runtime/delivery.mjs';
import { DiskReceipts } from '../runtime/receipts.mjs';
import { writeJson } from '../runtime/storage.mjs';

function controller(count = 3) {
  return { events: Array.from({ length: count }, (_, i) => ({ seq: i + 1, agent_id: 'agent-' + i, kind: 'completed', result: 'result-' + i })),
    eventsAfter() { return structuredClone(this.events); },
    async ackSequences(sequences) { this.events = this.events.filter(event => !sequences.includes(event.seq)); } };
}
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'codex-delivery-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

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

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DiskReceipts, MemoryReceipts, requestFingerprint } from './receipts.mjs';
import { readJson, writeJson } from './storage.mjs';
import { isCompactionStatus, isUserSend, restoreParentEvents } from './event-routing.mjs';

const INTERNAL_EVENT_FIELDS = new Set(['turn_id', 'turnId', 'thread_id', 'threadId', 'source_thread_id', 'item_id', 'itemId']);
const BATCH_BYTES = 128 * 1024;

// Keep the first item whole even if a single result exceeds the batch budget.
function wholeEventBatch(events) {
  let bytes = 2, count = 0;
  for (const event of events) {
    const wire = projectDeliveryEvent(formatDeliveryEvent(event));
    const size = Buffer.byteLength(JSON.stringify(wire)) + (count ? 1 : 0);
    if (count && bytes + size > BATCH_BYTES) break;
    bytes += size;
    count++;
  }
  return events.slice(0, count);
}

// Keep names, actionable IDs and all business content. Only remove top-level
// native routing IDs: answer_agent routes through request_id, never these IDs.
// Nested request payloads and future business fields retain their exact values.
function projectDeliveryEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => !INTERNAL_EVENT_FIELDS.has(key)));
}

function needsModelDiagnostics(event) {
  // Legacy failures represented an unverified catalog as [] with no choices.
  return event.kind === 'failed' && event.code === 'agent_model_unavailable'
    && (event.available_models === undefined || event.available_models?.length === 0 && event.recovery_choices === undefined);
}

// An explicit note can repeat the final answer verbatim. Supersede it only
// when both original entries are in this unclaimed batch for the same turn.
function repeatedFinalNotes(page) {
  const finals = new Map(), notes = [];
  for (let i = page.length - 1; i >= 0; i--) {
    const e = page[i];
    if (!e.agent_id || !e.turn_id) continue;
    const turn = JSON.stringify([e.agent_id, e.turn_id]);
    if (e.kind === 'completed' && e.result) finals.set(turn, e.result);
    else if (e.kind === 'message' && e.message && e.message === finals.get(turn)
      && Object.keys(e).every(key => ['seq', 'agent_id', 'turn_id', 'name', 'kind', 'message'].includes(key))) notes.push(e.seq);
  }
  return notes;
}

// Only user stop facts are parent receipts. Activity and private chats stay in Codex.
export function formatDeliveryEvent(event) {
  if (isCompactionStatus(event) || isUserSend(event)) return null;
  return event;
}

export class DeliveryStore extends EventEmitter {
  constructor({ controller, records = new MemoryReceipts(), statePath, leaseMs = 60000, actionFailureHoldMs = 5000, now = Date.now } = {}) {
    super();
    this.controller = controller; this.records = records; this.statePath = statePath;
    this.leaseMs = leaseMs; this.now = now; this.lease = null; this.tail = Promise.resolve();
    this.actionFailureHoldMs = actionFailureHoldMs; this.actionFailureHolds = new Map();
  }
  static async open({ directory, controller, ...options }) {
    const records = await DiskReceipts.open(join(directory, 'batches'));
    const store = new DeliveryStore({ ...options, controller, records, statePath: join(directory, 'lease.json') });
    store.lease = await readJson(store.statePath, null);
    return store;
  }
  serial(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async saveLease() { if (this.statePath) await writeJson(this.statePath, this.lease); }
  remaining() { return this.lease ? Math.max(0, this.lease.expiresAt - this.now()) : 0; }
  expireActionFailureHolds() {
    const now = this.now();
    for (const [seq, deadline] of this.actionFailureHolds) if (deadline <= now) this.actionFailureHolds.delete(seq);
  }
  holdActionFailure(seq) {
    // The host can retain the direct tool result separately from this queue.
    // A lost or denied result leaves the failure eligible after the hold.
    this.expireActionFailureHolds();
    this.actionFailureHolds.set(seq, this.now() + this.actionFailureHoldMs);
  }
  claim({ channel = 'wait', toolUseId } = {}) {
    return this.serial(async () => {
      const captured = this.controller.eventsAfter(0);
      // Publication can precede its queued disk write. Do not deliver an event
      // until the journal containing it is durable, nor include newer arrivals
      // that were not part of that barrier.
      if (captured.length && this.controller.persist) await this.controller.persist();
      const live = new Set(this.controller.eventsAfter(0).map(event => event.seq));
      const eligible = restoreParentEvents(captured);
      const allowed = new Set(eligible.map(event => event.seq));
      const excluded = captured.filter(event => !allowed.has(event.seq) && live.has(event.seq)).map(event => event.seq);
      if (excluded.length) await this.controller.ackSequences(excluded);
      this.expireActionFailureHolds();
      const actionResponsePending = eligible.some(event => live.has(event.seq) && this.actionFailureHolds.has(event.seq));
      let events = eligible.filter(event => live.has(event.seq) && !this.actionFailureHolds.has(event.seq));
      if (this.lease && this.remaining()) {
        const record = await this.records.get(this.lease.id);
        const leased = new Set(record?.sequences);
        if (events.some(event => leased.has(event.seq))) return { busy: true };
      }
      // Page whole events, never truncate their content or drop an unconfirmed result.
      let page = wholeEventBatch(events);
      if (this.controller.enrichModelFailureEvent && page.some(needsModelDiagnostics)) {
        page = await Promise.all(page.map(event => needsModelDiagnostics(event) ? this.controller.enrichModelFailureEvent(event) : event));
        // Agent close and request resolution can retire events during the catalog read.
        const retained = new Set(this.controller.eventsAfter(0).map(event => event.seq));
        page = wholeEventBatch(page.filter(event => retained.has(event.seq)));
        events = events.filter(event => retained.has(event.seq));
      }
      const repeated = repeatedFinalNotes(page);
      if (repeated.length) {
        await this.controller.ackSequences(repeated);
        const pending = new Set(this.controller.eventsAfter(0).map(e => e.seq));
        page = page.filter(e => pending.has(e.seq));
        events = events.filter(e => pending.has(e.seq));
      }
      if (!page.length) {
        this.lease = null; await this.saveLease();
        return actionResponsePending ? { busy: true, actionResponsePending } : { events: [] };
      }
      const selected = page.map(event => projectDeliveryEvent(formatDeliveryEvent(event))), id = randomUUID();
      await this.records.put(id, { status: 'issued', channel, toolUseId, sequences: selected.map(event => event.seq),
        hashes: Object.fromEntries(selected.map(event => [event.seq, requestFingerprint('event', event)])), acknowledged: [] });
      this.lease = { id, expiresAt: this.now() + this.leaseMs };
      await this.saveLease();
      return { events: selected, delivery_id: id, more: events.length > selected.length };
    });
  }
  renew(id) {
    return this.serial(async () => {
      if (this.lease?.id !== id) return;
      this.lease.expiresAt = this.now() + this.leaseMs;
      await this.saveLease();
    });
  }
  release(id) {
    return this.serial(async () => {
      if (this.lease?.id !== id) return { released: false };
      this.lease = null; await this.saveLease(); this.emit('change');
      return { released: true };
    });
  }
  confirm({ delivery_ids = [], observations = [], legacy_events = [] } = {}, reportedFailures = []) {
    return this.serial(async () => {
      if (!Array.isArray(delivery_ids) || !Array.isArray(observations) || !Array.isArray(legacy_events)) throw new Error('Invalid delivery confirmation.');
      const confirmed = [], unknown = [], rejected = [];
      for (const item of [...delivery_ids.map(delivery_id => ({ delivery_id })), ...observations]) {
        const id = item?.delivery_id;
        if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid delivery ID.');
        const record = await this.records.get(id);
        if (!record) { unknown.push(id); continue; } // A different session cannot acknowledge this session.
        if (record.status === 'acknowledged') { confirmed.push(id); continue; }
        let sequences = item.sequences ?? record.sequences;
        const issued = new Set(record.sequences);
        if (!Array.isArray(sequences) || sequences.some(seq => !issued.has(seq))) throw new Error('Confirmation contains an event outside its delivery.');
        if (item.events !== undefined) {
          if (!Array.isArray(item.events)) throw new Error('Invalid retained events.');
          const matched = new Set(item.events.filter(event => issued.has(event?.seq) && requestFingerprint('event', event) === record.hashes?.[event.seq]).map(event => event.seq));
          const mismatches = sequences.filter(seq => !matched.has(seq));
          if (mismatches.length) rejected.push({ delivery_id: id, sequences: mismatches });
          sequences = sequences.filter(seq => matched.has(seq));
        }
        await this.controller.ackSequences(sequences);
        const acknowledged = [...new Set([...(record.acknowledged ?? []), ...sequences])];
        await this.records.put(id, acknowledged.length === record.sequences.length ? { status: 'acknowledged' } : { ...record, acknowledged });
        if (this.lease?.id === id) { this.lease = null; await this.saveLease(); }
        confirmed.push(id);
      }
      // Migration from 0.1.1: only exact events still in the journal can match a
      // result restored by the host. A number alone is never enough to erase work.
      const pending = this.controller.eventsAfter(0);
      const legacy = pending.filter(event => legacy_events.some(old => old?.seq === event.seq && requestFingerprint('event', old) === requestFingerprint('event', event))).map(event => event.seq);
      const actionFailures = new Map(reportedFailures.map(failure => [failure.seq, failure.eventFingerprint]));
      const reported = pending.filter(event => actionFailures.has(event.seq) && actionFailures.get(event.seq) === requestFingerprint('event', event)).map(event => event.seq);
      if (legacy.length || reported.length) await this.controller.ackSequences([...legacy, ...reported]);
      for (const seq of reported) this.actionFailureHolds.delete(seq);
      this.emit('change');
      return { confirmed, ...(unknown.length ? { unknown } : {}), ...(rejected.length ? { rejected } : {}), ...(legacy.length ? { legacy_confirmed: legacy } : {}) };
    });
  }
}

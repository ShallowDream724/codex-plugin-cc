import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DiskReceipts, MemoryReceipts, requestFingerprint } from './receipts.mjs';
import { readJson, writeJson } from './storage.mjs';
import { isUserSend, parentDeliveryEvents } from './event-routing.mjs';

const INTERNAL_EVENT_FIELDS = new Set(['turn_id', 'turnId', 'thread_id', 'threadId', 'source_thread_id', 'item_id', 'itemId']);

// Keep names, actionable IDs and all business content. Only remove top-level
// native routing IDs: answer_agent routes through request_id, never these IDs.
// Nested request payloads and future business fields retain their exact values.
function projectDeliveryEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => !INTERNAL_EVENT_FIELDS.has(key)));
}

// Only user stop facts are parent receipts. Direct conversations stay in Codex.
export function formatDeliveryEvent(event) {
  if (isUserSend(event)) return null;
  if (event?.kind !== 'message' || event.origin !== 'user' || event.action !== 'interrupt') return event;
  const { message, ...receipt } = event;
  const target = `Codex 子代理 ${event.name || event.agent_id}`;
  const tree = `${target} 及其子代理`;
  const summary = ({ requested: `用户已请求停止 ${tree}。`, stopping: `${tree} 正在按用户要求停止。`,
      confirmed: `${tree} 已按用户要求停止。`, unconfirmed: `用户请求停止 ${tree}，停止状态未确认。` })[event.phase] || `${tree} 的用户停止请求状态已更新。`;
  return { ...receipt, kind: 'user_action_receipt', summary };
}

export class DeliveryStore extends EventEmitter {
  constructor({ controller, records = new MemoryReceipts(), statePath, leaseMs = 60000, now = Date.now } = {}) {
    super();
    this.controller = controller; this.records = records; this.statePath = statePath;
    this.leaseMs = leaseMs; this.now = now; this.lease = null; this.tail = Promise.resolve();
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
  claim({ channel = 'wait', toolUseId } = {}) {
    return this.serial(async () => {
      const captured = this.controller.eventsAfter(0);
      // Publication can precede its queued disk write. Do not deliver an event
      // until the journal containing it is durable, nor include newer arrivals
      // that were not part of that barrier.
      if (captured.length && this.controller.persist) await this.controller.persist();
      const live = new Set(this.controller.eventsAfter(0).map(event => event.seq));
      const eligible = parentDeliveryEvents(captured);
      const allowed = new Set(eligible.map(event => event.seq));
      const excluded = captured.filter(event => !allowed.has(event.seq) && live.has(event.seq)).map(event => event.seq);
      if (excluded.length) await this.controller.ackSequences(excluded);
      const events = eligible.filter(event => live.has(event.seq));
      if (this.lease && this.remaining()) {
        const record = await this.records.get(this.lease.id);
        const retained = events.filter(event => record?.sequences?.includes(event.seq));
        if (retained.length) return { busy: true };
      }
      if (!events.length) { this.lease = null; await this.saveLease(); return { events: [] }; }
      // Page whole events, never truncate their content or drop an unconfirmed result.
      const selected = events.slice(0, 32).map(event => projectDeliveryEvent(formatDeliveryEvent(event))), id = randomUUID();
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
  confirm({ delivery_ids = [], observations = [], legacy_events = [] } = {}) {
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
        if (!Array.isArray(sequences) || sequences.some(seq => !record.sequences.includes(seq))) throw new Error('Confirmation contains an event outside its delivery.');
        if (item.events !== undefined) {
          if (!Array.isArray(item.events)) throw new Error('Invalid retained events.');
          const matched = sequences.filter(seq => item.events.some(event => event?.seq === seq && requestFingerprint('event', event) === record.hashes?.[seq]));
          if (matched.length !== sequences.length) rejected.push({ delivery_id: id, sequences: sequences.filter(seq => !matched.includes(seq)) });
          sequences = matched;
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
      if (legacy.length) await this.controller.ackSequences(legacy);
      this.emit('change');
      return { confirmed, ...(unknown.length ? { unknown } : {}), ...(rejected.length ? { rejected } : {}), ...(legacy.length ? { legacy_confirmed: legacy } : {}) };
    });
  }
}

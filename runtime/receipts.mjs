import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDirectory, readJson, writeJson } from './storage.mjs';

export const ACTION_PREFLIGHT_FAILURE = Symbol('actionPreflightFailure');

function recordValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['inflight', 'done', 'failed', 'issued', 'acknowledged'].includes(value.status)) {
    throw new Error('Invalid receipt record; refusing to replay an uncertain action.');
  }
  return value;
}

export class MemoryReceipts {
  constructor(initial = {}, save = async () => {}) { this.records = initial; this.save = save; this.tail = Promise.resolve(); }
  async get(id) { return structuredClone(this.records[id] ?? null); }
  async put(id, record) {
    this.records[id] = structuredClone(record);
    const snapshot = structuredClone(this.records);
    const write = this.tail.then(() => this.save(snapshot));
    this.tail = write.catch(() => {});
    await write;
  }
}

// One atomic record per action: a long session never rewrites or reloads all old
// action results. Retaining the IDs prevents replay after an ambiguous failure.
export class DiskReceipts {
  constructor(directory) { this.directory = directory; }
  static async open(directory, { legacyPath } = {}) {
    await ensureDirectory(directory);
    const store = new DiskReceipts(directory);
    const marker = join(directory, 'migration-v1.json');
    if (legacyPath && !(await readJson(marker, null))) {
      const old = await readJson(legacyPath, {});
      if (!old || typeof old !== 'object' || Array.isArray(old)) throw new Error('Invalid legacy receipt store.');
      for (const [id, record] of Object.entries(old)) if (!(await store.get(id))) await store.put(id, record);
      await writeJson(marker, { complete: true }); // Keep the old file as a migration backup.
    }
    return store;
  }
  path(id) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid receipt ID.');
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json');
  }
  async get(id) {
    const value = await readJson(this.path(id), undefined);
    return value === undefined ? null : recordValue(value);
  }
  async put(id, record) {
    await writeJson(this.path(id), recordValue(record));
    this.messageIndex?.add(record);
  }
  // Pre-marker releases kept the exact request fingerprint, but not the input
  // text. Read this session's receipts once, lazily, for historical display.
  messageInputs() {
    if (!this.loadingMessages) {
      if (Date.now() < this.retryMessagesAt) return Promise.resolve(null);
      this.messageIndex = new MessageReceiptIndex();
      this.loadingMessages = this.readMessageInputs().catch(() => {
        this.loadingMessages = null;
        this.retryMessagesAt = Date.now() + 5000;
        return null;
      });
    }
    return this.loadingMessages;
  }
  async readMessageInputs() {
    const names = (await readdir(this.directory)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
    for (let i = 0; i < names.length; i += 12) {
      await Promise.all(names.slice(i, i + 12).map(async name => {
        try { this.messageIndex.add(await readJson(join(this.directory, name), null)); }
        catch { /* A missing or damaged receipt supplies no authorship evidence. */ }
      }));
    }
    return this.messageIndex;
  }
}

export function requestFingerprint(operation, args, contextDigest) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ operation, args, contextDigest }))).digest('hex');
}

class MessageReceiptIndex {
  constructor() { this.turns = new Map(); }
  add(record) {
    const result = record?.result;
    if (record?.status !== 'done' || !['followup_task', 'send_message', 'ui_send'].includes(record.operation) ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint) || typeof result?.turn_id !== 'string' || !result.turn_id ||
        typeof result.agent_id !== 'string' || !result.agent_id) return;
    const steer = result.status === 'steered';
    if (!steer && (record.operation === 'send_message' || !result.thread_id || !['running', 'waiting', 'compacting', 'completed'].includes(result.status))) return;
    const key = JSON.stringify([result.agent_id, result.turn_id]);
    let records = this.turns.get(key);
    if (!records) this.turns.set(key, records = new Map());
    records.set(record.fingerprint, { operation: record.operation, thread: result.thread_id, turnInput: steer ? 'steer' : 'start' });
  }
  match(agent, turnId, message) {
    const records = this.turns.get(JSON.stringify([agent.id, turnId]));
    if (!records) return;
    const targets = new Set([agent.id, agent.threadId, `codex://threads/${agent.threadId}`, agent.name].filter(Boolean));
    const operations = new Set([...records.values()].filter(r => !r.thread || r.thread === agent.threadId).map(r => r.operation));
    const origins = new Set(), positions = new Set();
    for (const operation of operations) {
      const routes = operation === 'ui_send' ? [{}, { private_task: true }, { report_to_parent: true }] : [{}];
      for (const target of targets) for (const route of routes) {
        const record = records.get(requestFingerprint(operation, { target, message, ...route }));
        if (!record || record.thread && record.thread !== agent.threadId) continue;
        origins.add(operation === 'ui_send' ? 'user' : 'parent');
        positions.add(record.turnInput);
      }
    }
    if (origins.size === 1) return { message_origin: [...origins][0], ...(positions.size === 1 ? { turn_input: [...positions][0] } : {}) };
  }
}

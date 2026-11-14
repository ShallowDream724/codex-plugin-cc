import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, readJson, writeJson } from './storage.mjs';

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
  async put(id, record) { await writeJson(this.path(id), recordValue(record)); }
}

export function requestFingerprint(operation, args, contextDigest) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ operation, args, contextDigest }))).digest('hex');
}

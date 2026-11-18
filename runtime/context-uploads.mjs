import { randomBytes } from 'node:crypto';

export const MAX_CONTEXT_BYTES = 64 * 1024 * 1024;
const error = message => Object.assign(new Error(message), { code: 'context_export_failed' });

// The host posts a single ordered JSON stream to a write-only ticket. The broker's
// control token stays in the Node bridge and is never returned to a hook.
export class ContextUploads {
  #entries = new Map();

  reserve(requestId, count, chars) {
    if (typeof requestId !== 'string' || !requestId.length || requestId.length > 256 ||
        !Number.isSafeInteger(count) || count < 0 || count > 4096 ||
        !Number.isSafeInteger(chars) || chars < 2) throw error('Invalid Claude context upload request.');
    if (chars > MAX_CONTEXT_BYTES) throw error('The Claude context exceeds the 64 MiB transport limit.');
    if (this.#entries.size >= 7) throw error('Seven Claude context uploads are in progress. Retry when one finishes.');
    const ticket = randomBytes(32).toString('hex');
    const timer = setTimeout(() => this.discard(ticket), 120000);
    timer.unref();
    this.#entries.set(ticket, { requestId, count, chars, chunks: [], bytes: 0, received: 0, timer });
    return ticket;
  }

  get pending() { return this.#entries.size; }
  accepts(ticket) { return this.#entries.has(ticket); }

  append(ticket, offset, chunk, bytes) {
    const entry = this.#entries.get(ticket);
    if (!entry) throw error('The Claude context upload expired.');
    if (offset !== String(entry.received) || !chunk.length || chunk.length > entry.chars - entry.received) {
      throw error('Incomplete or out-of-order Claude context upload.');
    }
    if (entry.bytes + bytes > MAX_CONTEXT_BYTES) throw error('The Claude context exceeds the 64 MiB transport limit.');
    entry.chunks.push(chunk);
    entry.bytes += bytes;
    entry.received += chunk.length;
    entry.timer.refresh();
    return { received: entry.received };
  }

  take(ticket, requestId) {
    const entry = this.#entries.get(ticket);
    if (!entry || entry.requestId !== requestId || entry.received !== entry.chars) {
      throw error('The full Claude context was not received for this tool call.');
    }
    this.discard(ticket);
    let messages;
    try { messages = JSON.parse(entry.chunks.join('')); } catch { throw error('Claude exported invalid conversation JSON.'); }
    if (!Array.isArray(messages) || messages.length !== entry.count) throw error('Claude exported an unexpected number of messages.');
    return { messages, source: 'claude_api_available', hostMessageLimit: 4096 };
  }

  discard(ticket) {
    const entry = this.#entries.get(ticket);
    if (entry) clearTimeout(entry.timer);
    this.#entries.delete(ticket);
  }
}

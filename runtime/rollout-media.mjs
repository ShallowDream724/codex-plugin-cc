// Recovery is restricted to a registered thread's native rollout and exact call.
// Store byte offsets, never media payloads; a growing rollout is indexed incrementally.
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const LINE_LIMIT = 32 * 1024 * 1024, SCAN_LIMIT = 256 * 1024 * 1024;
export class RolloutMedia {
  constructor(client) { this.client = client; this.states = new Map(); }
  async lookup(threadId, turnId, callId) {
    const response = await this.client.request('thread/read', { threadId, includeTurns: false });
    const thread = response?.thread, path = thread?.path;
    if (thread?.id !== threadId || typeof path !== 'string' || !isAbsolute(path)) return null;
    let state = this.states.get(threadId);
    if (!state || state.path !== path) { state = { path, offset: 0, index: new Map(), queue: Promise.resolve() }; this.states.set(threadId, state); }
    const task = state.queue.then(() => this.scan(state, threadId, turnId, callId));
    state.queue = task.catch(() => {});
    return task;
  }
  async scan(state, threadId, turnId, callId) {
    const key = JSON.stringify([turnId, callId]);
    let file;
    try {
      file = await open(state.path, 'r');
      const info = await file.stat();
      const identity = `${info.dev}:${info.ino}`;
      if (!info.isFile() || info.size < state.offset || (state.identity && state.identity !== identity)) { state.offset = 0; state.index.clear(); }
      state.identity = identity;
      if (!info.isFile()) return null;
      // Verify the first record each time, including after a file replacement.
      const header = Buffer.alloc(Math.min(info.size, 1024 * 1024));
      const first = await file.read(header, 0, header.length, 0), newline = header.indexOf(10, 0);
      if (newline < 0 || newline >= first.bytesRead) return null;
      const meta = JSON.parse(header.subarray(0, newline).toString('utf8'));
      if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) return null;
      if (!state.offset) state.offset = newline + 1;
      if (!state.index.has(key)) {
        let pos = state.offset, start = pos, chunks = [], size = 0, skipping = false;
        const end = Math.min(info.size, pos + SCAN_LIMIT), buffer = Buffer.alloc(256 * 1024);
        while (pos < end) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - pos), pos);
          if (!bytesRead) break;
          let from = 0;
          while (from < bytesRead) {
            const nl = buffer.indexOf(10, from), to = nl < 0 || nl >= bytesRead ? bytesRead : nl;
            const length = to - from;
            if (!skipping && size + length <= LINE_LIMIT) { chunks.push(Buffer.from(buffer.subarray(from, to))); size += length; }
            else { chunks = []; skipping = true; }
            if (to < bytesRead) {
              if (!skipping && size) {
                const line = Buffer.concat(chunks, size).toString('utf8');
                if (line.includes('function_call_output')) {
                  try {
                    const record = JSON.parse(line), payload = record.payload;
                    const turn = payload?.internal_chat_message_metadata_passthrough?.turn_id;
                    if (record.type === 'response_item' && payload?.type === 'function_call_output' && typeof payload.call_id === 'string' && typeof turn === 'string') state.index.set(JSON.stringify([turn, payload.call_id]), { start, length: size });
                  } catch { /* Ignore malformed unrelated records. */ }
                }
              }
              start = pos + to + 1; state.offset = start; chunks = []; size = 0; skipping = false;
            }
            from = to + (to < bytesRead ? 1 : 0);
          }
          pos += bytesRead;
        }
      }
      const entry = state.index.get(key);
      if (!entry) return null;
      const bytes = Buffer.alloc(entry.length), read = await file.read(bytes, 0, bytes.length, entry.start);
      if (read.bytesRead !== bytes.length) return null;
      const record = JSON.parse(bytes.toString('utf8')), payload = record.payload;
      if (record.type !== 'response_item' || payload?.type !== 'function_call_output' || payload.call_id !== callId || payload.internal_chat_message_metadata_passthrough?.turn_id !== turnId || !Array.isArray(payload.output)) return null;
      return payload.output;
    } catch { return null; }
    finally { await file?.close().catch(() => {}); }
  }
}

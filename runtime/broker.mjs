import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { prepareContextSnapshot } from './context.mjs';

const MUTATIONS = new Set(['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'answer_agent']);
const OPERATIONS = new Set([...MUTATIONS, 'list_agents', 'list_models']);
const MAX_BODY = 64 * 1024 * 1024; // Transport bytes, never a token estimate or a truncation policy.

function authorized(value, token) {
  const a = Buffer.from(value || ''), b = Buffer.from('Bearer ' + token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBroker({ controller, token, receipts = {}, saveReceipts = async () => {}, onActivity = () => {}, onShutdown = () => {}, waitTimeoutMs = 25000 }) {
  let waiting = 0;
  let receiptTail = Promise.resolve();
  const persistReceipts = () => {
    const snapshot = structuredClone(receipts);
    const write = receiptTail.then(() => saveReceipts(snapshot));
    receiptTail = write.catch(() => {});
    return write;
  };
  const dispatch = async (body, signal) => {
    const { operation, args = {}, cursor = 0, requestId } = body;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid event cursor.');
    if (operation === 'health') return { ready: true };
    if (operation === 'shutdown') { setImmediate(onShutdown); return { stopped: true }; }
    if (operation === 'ack') { await controller.ackEvents(cursor); return { acknowledged: cursor }; }
    if (operation === 'observe') {
      const listed = await controller.dispatch('list_agents', {});
      return { ...listed, events: waiting ? [] : controller.eventsAfter(cursor), waiting: waiting > 0 };
    }
    if (operation === 'wait') {
      await controller.ackEvents(cursor);
      const existing = controller.eventsAfter(cursor);
      if (existing.length) return { events: existing, cursor: existing.at(-1).seq };
      const listed = await controller.dispatch('list_agents', {});
      if (!listed.agents?.some(a => ['starting', 'running', 'waiting', 'compacting', 'recovering'].includes(a.status))) {
        return { idle: true, events: [], agents: listed.agents || [], cursor };
      }
      waiting++;
      try {
        return await new Promise((resolve) => {
          let settled = false;
          const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            controller.off('event', wake);
            signal.removeEventListener('abort', abort);
            resolve(result);
          };
          const wake = () => {
            const events = controller.eventsAfter(cursor);
            if (events.length) finish({ events, cursor: events.at(-1).seq });
          };
          const abort = () => finish({ cancelled: true, cursor });
          const timer = setTimeout(() => finish({ pending: true, cursor }), waitTimeoutMs);
          controller.on('event', wake);
          signal.addEventListener('abort', abort, { once: true });
          wake();
          if (signal.aborted) abort();
        });
      } finally { waiting--; }
    }
    if (!OPERATIONS.has(operation)) throw new Error('Unknown bridge operation.');
    if (MUTATIONS.has(operation)) {
      if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new Error('Mutation requires a tool-call requestId.');
      const previous = receipts[requestId];
      if (previous) {
        if (previous.operation !== operation) throw new Error('Request id was already used by another operation.');
        if (previous.status === 'done') return previous.result;
        const error = new Error('This action may already have been submitted. Inspect list_agents before issuing a new action.');
        error.code = 'ambiguous_action';
        throw error;
      }
      // Context validation is local and must happen before a thread or a receipt is created.
      if (operation === 'spawn_agent' && (args.context_mode || 'available') === 'available') {
        args.snapshot = prepareContextSnapshot(body.context || {});
      }
      receipts[requestId] = { operation, status: 'inflight' };
      await persistReceipts();
      // No automatic retry of a mutation, including after a transport failure.
      const result = await controller.dispatch(operation, args);
      receipts[requestId] = { operation, status: 'done', result };
      await persistReceipts();
      return result;
    }
    return controller.dispatch(operation, args);
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/' || !authorized(req.headers.authorization, token)) {
      res.writeHead(403); res.end(); return;
    }
    onActivity();
    const aborter = new AbortController();
    res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) {
          res.writeHead(413); res.end(JSON.stringify({ error: { code: 'transport_limit', message: 'Snapshot exceeds the 64 MiB transport limit; nothing was truncated or dispatched.' } }));
          return;
        }
        chunks.push(chunk);
      }
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')), aborter.signal);
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: error.code || 'bridge_error', message: error.message } }));
      }
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  return server;
}

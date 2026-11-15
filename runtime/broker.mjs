import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { prepareContextSnapshot } from './context.mjs';
import { DeliveryStore } from './delivery.mjs';
import { MemoryReceipts, requestFingerprint } from './receipts.mjs';

const UI_MUTATIONS = new Set(['ui_interrupt', 'ui_interrupt_all', 'ui_send']);
const MUTATIONS = new Set(['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'close_agent', 'answer_agent', ...UI_MUTATIONS]);
const OPERATIONS = new Set([...MUTATIONS, 'list_agents', 'list_models']);
const MAX_BODY = 64 * 1024 * 1024;
const activeStatuses = new Set(['starting', 'running', 'waiting', 'compacting', 'recovering', 'unknown']);
const errorBody = error => ({ code: error.code || 'bridge_error', message: error.message,
  ...Object.fromEntries(['agent_id', 'thread_id', 'status', 'recovery', 'limit', 'active_agents'].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
  ...(error.code === 'invalid_answer' ? { request_id: error.request_id, reply_format: error.reply_format } : {}) });

function authorized(value, token) {
  const a = Buffer.from(value || ''), b = Buffer.from('Bearer ' + token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBroker({ controller, token, receipts = {}, saveReceipts = async () => {}, receiptStore,
  deliveryStore, activity, onActivity = () => {}, onShutdown = () => {}, getHealth, requiredProtocol,
  waitTimeoutMs = 25000 } = {}) {
  const journal = receiptStore ?? new MemoryReceipts(receipts, saveReceipts);
  const delivery = deliveryStore ?? new DeliveryStore({ controller });
  const actions = new Set();
  const requests = new Set(), aborters = new Set();
  let waiting = false, stopping = false;

  const stopIfIdle = () => {
    if (stopping) return { stopped: true };
    const active = controller.hasActiveWork ? controller.hasActiveWork()
      : [...(controller.agents?.values() || [])].some(agent => activeStatuses.has(agent.status) || agent.pending_requests?.length);
    if (active) return { stopped: false, reason: 'active' };
    if (actions.size || requests.size > 1) return { stopped: false, reason: 'busy' };
    // No await separates the idle check from sealing admission. Mutation
    // dispatch and this check therefore share one atomic admission boundary.
    stopping = true;
    setImmediate(onShutdown);
    return { stopped: true };
  };

  const waitForChange = (signal, timeout) => new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      controller.off('event', finish); controller.off('state', finish); delivery.off('change', finish);
      signal.removeEventListener('abort', finish); resolve();
    };
    const timer = setTimeout(finish, timeout);
    controller.on('event', finish); controller.on('state', finish); delivery.on('change', finish);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });

  const dispatch = async (body, signal) => {
    const { operation, args = {}, requestId } = body;
    if (operation === 'health') return { ...(getHealth ? await getHealth() : { ready: !controller.closed && !controller.closing }),
      ...(stopping ? { ready: false } : {}), capabilities: ['idle_shutdown'] };
    if (operation === 'shutdown') { setImmediate(onShutdown); return { stopped: true }; }
    if (requiredProtocol !== undefined && body.protocolVersion !== requiredProtocol) {
      throw Object.assign(new Error('Restart Claude Code to load the current Codex plugin bridge.'), { code: 'bridge_version_mismatch' });
    }
    if (operation === 'idle_shutdown') return stopIfIdle();
    if (stopping) throw Object.assign(new Error('The idle session helper is restarting. Retry the request.'), { code: 'helper_restarting' });
    if (['ui_list', 'ui_history', 'ui_detail', 'ui_revision'].includes(operation)) {
      if (!activity) throw new Error('Activity view is unavailable.');
      const method = { ui_list: 'list', ui_history: 'history', ui_detail: 'detail', ui_revision: 'revision' }[operation];
      return activity[method](args);
    }
    // A user's UI action can publish a new event, but never acknowledges events
    // addressed to Claude. Only the model delivery path may confirm those.
    if (body.restore && !UI_MUTATIONS.has(operation)) await delivery.confirm(body.restore);
    if (operation === 'confirm') return delivery.confirm(args);
    if (operation === 'release') return delivery.release(args.delivery_id);
    if (operation === 'observe') {
      if (args.lease_id) await delivery.renew(args.lease_id);
      const listed = await controller.dispatch('list_agents', {});
      const batch = args.deliver && !waiting ? await delivery.claim({ channel: 'prompt' }) : { events: [] };
      return { ...listed, ...(batch.busy ? { events: [], delivery_pending: true } : batch), waiting };
    }
    if (operation === 'wait') {
      if (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 0 || args.timeout_ms > 25000)) throw new Error('Wait timeout_ms must be an integer from 0 to 25000.');
      // A parallel tool group must not await itself before Claude can answer.
      if (waiting) return { waiting: true, workersContinue: true };
      waiting = true;
      const deadline = Date.now() + Math.min(args.timeout_ms ?? waitTimeoutMs, waitTimeoutMs);
      try {
        while (!signal.aborted) {
          // Subscribe before disk I/O so a newly published event cannot fall
          // between reading the journal and installing a wake listener.
          const wakeAbort = new AbortController();
          const abortWake = () => wakeAbort.abort();
          signal.addEventListener('abort', abortWake, { once: true });
          const remaining = Math.max(0, deadline - Date.now());
          const wake = waitForChange(wakeAbort.signal, Math.min(remaining, delivery.remaining() || remaining));
          try {
            const batch = await delivery.claim({ channel: 'wait', toolUseId: requestId });
            if (signal.aborted) { if (batch.delivery_id) await delivery.release(batch.delivery_id); break; }
            if (batch.events?.length) return batch;
            const listed = await controller.dispatch('list_agents', {});
            const active = controller.hasActiveWork ? controller.hasActiveWork()
              : listed.agents?.some(agent => activeStatuses.has(agent.status) || agent.pending_requests?.length);
            if (!batch.busy && !active) return { idle: true, events: [], agents: listed.agents || [] };
            if (Date.now() >= deadline) return { pending: true };
            await wake;
          } finally { wakeAbort.abort(); signal.removeEventListener('abort', abortWake); }
        }
        return { cancelled: true, workersContinue: true };
      } finally { waiting = false; }
    }
    if (!OPERATIONS.has(operation)) throw new Error('Unknown bridge operation.');
    if (!MUTATIONS.has(operation)) return controller.dispatch(operation, args);

    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new Error('Mutation requires an action requestId.');
    if (actions.has(requestId)) throw Object.assign(new Error('This action is already in progress. Use its existing result.'), { code: 'ambiguous_action' });
    actions.add(requestId);
    try {
      const requestArgs = { ...args }; delete requestArgs.snapshot;
      if (operation === 'spawn_agent' && args.role === 'default') {
        if (args.context_mode !== undefined && args.context_mode !== 'none') throw new Error('The default role requires context_mode none.');
        args.context_mode = 'none';
      }
      if (operation === 'spawn_agent' && (args.context_mode || 'available') === 'available') args.snapshot = prepareContextSnapshot(body.context || {});
      const fingerprint = requestFingerprint(operation, requestArgs, args.snapshot?.digest);
      const previous = await journal.get(requestId);
      if (previous) {
        if (previous.operation !== operation || (previous.fingerprint && previous.fingerprint !== fingerprint)) {
          throw Object.assign(new Error('This tool-call ID was already used with different input.'), { code: 'request_id_conflict' });
        }
        if (previous.status === 'done') return previous.result;
        if (previous.status === 'failed') throw Object.assign(new Error(previous.error.message), previous.error);
        throw Object.assign(new Error('This action may already have been submitted. Inspect list_agents before issuing a new action.'), { code: 'ambiguous_action' });
      }
      await journal.put(requestId, { operation, fingerprint, status: 'inflight' });
      let result;
      try { result = await controller.dispatch(operation, args); }
      catch (error) {
        // This validation fails before any wire response. Other errors may have
        // ambiguous side effects, so retain their inflight receipt and never retry.
        if (error.code === 'invalid_answer') await journal.put(requestId, { operation, fingerprint, status: 'failed', error: errorBody(error) });
        throw error;
      }
      await journal.put(requestId, { operation, fingerprint, status: 'done', result });
      return result;
    } finally { actions.delete(requestId); }
  };

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/' || !authorized(req.headers.authorization, token)) {
      res.writeHead(403); res.end(); return;
    }
    onActivity();
    const aborter = new AbortController();
    aborters.add(aborter);
    let finished;
    const done = new Promise(resolve => { finished = resolve; });
    requests.add(done);
    res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) {
          res.writeHead(413); res.end(JSON.stringify({ error: { code: 'transport_limit', message: 'Snapshot exceeds the 64 MiB transport limit; nothing was truncated or dispatched.' } })); return;
        }
        chunks.push(chunk);
      }
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')), aborter.signal);
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
    } catch (error) {
      if (!res.destroyed) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: errorBody(error) })); }
    } finally {
      aborters.delete(aborter); requests.delete(done); finished();
    }
  });
  const close = server.close;
  server.close = function (...args) {
    for (const aborter of aborters) aborter.abort();
    return close.apply(this, args);
  };
  // A disconnected client may leave an accepted action saving its receipt.
  // Service ownership must outlive these handlers, not merely their sockets.
  server.drain = async () => { while (requests.size) await Promise.allSettled([...requests]); };
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  return server;
}

// A Claude Code mod. No model requests or per-task tool definitions.
import { WAIT_TOOL, EVENT_PREFIX, messageDeliveries, scanRetainedDeliveries, retainedSequences, filterClosed, retainedActionFailures } from './delivery.js';
import { registerUI, observeUI, closeUI } from './ui.js';
import { registerRows, showNoteFeedback } from './rows.js';
import { configureBridge, requestBridge } from './bridge.js';
const OBJECT = { type: 'object' };
const STR = { type: 'string' };
const TARGET = { type: 'string', description: 'Agent ID from list_agents or spawn_agent.' };
const TOOLS = [
  { name: 'spawn_agent', description: 'Delegate to Codex. The default role provides quick lookup, extraction and factual checks.', inputSchema: { ...OBJECT, properties: { message: STR, cwd: { ...STR, description: 'Absolute working directory; default: this session.' }, name: STR, role: { ...STR, enum: ['default'], description: 'One-shot read-only scout; preset model/effort and task-only context. Omit for a regular agent.' }, context_mode: { type: 'string', enum: ['available', 'none'], description: 'available: current host context, up to 4096 API messages; older content may be summarized or omitted. none: task only. Default: available; default role: none.' }, model: { ...STR, description: 'Choose an ID from list_models for a regular agent. Omit for the default role.' }, reasoning_effort: { ...STR, description: 'Choose a supported effort for the selected model. Omit for the default role.' } }, required: ['message'], additionalProperties: false } },
  { name: 'send_message', description: 'Steer a running agent; append to an idle agent’s history without starting it.', inputSchema: { ...OBJECT, properties: { target: TARGET, message: STR }, required: ['target', 'message'], additionalProperties: false } },
  { name: 'followup_task', description: 'Continue a Codex conversation with its history. Steer an owned running agent; adopt an idle external thread.', inputSchema: { ...OBJECT, properties: { target: { ...STR, description: 'Agent ID, native thread ID, or codex://threads/<id>.' }, message: STR }, required: ['target', 'message'], additionalProperties: false } },
  { name: 'wait_agent', description: 'Wait for queued or new events from any agent.', inputSchema: { ...OBJECT, properties: { timeout_ms: { type: 'integer', minimum: 0, maximum: 3600000, description: 'Limit this wait only; agents keep running. Omit to wait for an event.' } }, additionalProperties: false } },
  { name: 'list_agents', description: 'List this session’s agents with their IDs, models and status.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
  { name: 'interrupt_agent', description: 'Stop current work on this agent and its descendants. History and file changes are kept. Resume with followup_task.', inputSchema: { ...OBJECT, properties: { target: TARGET }, required: ['target'], additionalProperties: false } },
  { name: 'close_agent', description: 'Close inactive agents; keep Codex history. Use all with except to retain selected agents. Active agents are skipped.', inputSchema: { ...OBJECT, properties: { targets: { anyOf: [{ type: 'array', items: TARGET, minItems: 1 }, { type: 'string', enum: ['all'] }] }, except: { type: 'array', items: TARGET, description: 'IDs to keep; only with targets: all.' } }, required: ['targets'], additionalProperties: false } },
  { name: 'answer_agent', description: 'Answer a pending request using its request_id and reply_format.', inputSchema: { ...OBJECT, properties: { target: TARGET, request_id: STR, answer: { ...OBJECT, description: 'Object matching the event’s reply_format.' } }, required: ['target', 'request_id', 'answer'], additionalProperties: false } },
  { name: 'list_models', description: 'Read available model IDs, descriptions, selection notes and supported reasoning efforts.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
];

let active = false;
let activityEpoch = 0;
let waiters = 0;
let observing = false;
let notificationPending;
let recoveryEvidence;
let wakePending;
let waking = false;
let pausedAfterStop = false;
const wakeTurns = new Map();
const endedTurns = new Map();
const busyTurns = new Map();
const deliveries = new Map();
const closedAgents = new Set();

async function bridge($, operation, args = {}, extras = {}) {
  const restore = operation !== 'shutdown' ? recoveryEvidence : undefined;
  const value = await requestBridge($, operation, args, { ...(restore ? { restore } : {}), ...extras });
  if (restore && recoveryEvidence === restore && value && !value.offline && !value.error) {
    recoveryEvidence = undefined;
    for (const observation of restore.observations) {
      if (deliveries.get(observation.delivery_id)?.confirmedEvents) forgetDelivery(observation.delivery_id);
    }
  }
  return value;
}

function forgetDelivery(delivery_id) {
  const expected = deliveries.get(delivery_id);
  if (expected?.onAbort) expected.signal.removeEventListener('abort', expected.onAbort);
  deliveries.delete(delivery_id);
  if (notificationPending === delivery_id) notificationPending = undefined;
}

async function release($, delivery_id) {
  if (!delivery_id) return;
  forgetDelivery(delivery_id);
  await bridge($, 'release', { delivery_id }).catch(() => {});
}

async function confirm($, delivery_id, events) {
  const expected = deliveries.get(delivery_id);
  if (!expected) return;
  // Keep evidence for a lightweight retry if the helper is temporarily unavailable.
  expected.confirmedEvents = events;
  const previous = recoveryEvidence || { observations: [], legacy_events: [] };
  const existing = previous.observations.find(item => item.delivery_id === delivery_id);
  const retained = [...new Map([...(existing?.events || []), ...events].map(event => [event.seq, event])).values()];
  recoveryEvidence = { ...previous, observations: [...previous.observations.filter(item => item.delivery_id !== delivery_id), { delivery_id, sequences: retained.map(event => event.seq), events: retained }] };
  const result = await bridge($, 'confirm', { observations: [{ delivery_id, sequences: events.map(event => event.seq), events }] });
  if (result.offline || result.error) throw new Error(result.error?.message || 'Delivery confirmation is offline.');
  forgetDelivery(delivery_id);
}

function remember($, result, channel, tool_use_id, signal) {
  if (result.delivery_id && result.events?.length) {
    const onAbort = signal ? () => { void release($, result.delivery_id); } : undefined;
    deliveries.set(result.delivery_id, { events: result.events, channel, tool_use_id, signal, onAbort });
    if (onAbort) signal.addEventListener('abort', onAbort, { once: true });
  }
  return result.events ? { ...result, events: result.events.filter(event => !closedAgents.has(event.agent_id)) } : result;
}

function acceptedEvents(retained, delivery_id, expected) {
  if (!expected || expected.signal?.aborted) return [];
  const sequences = new Set(retained.filter(item => item.delivery_id === delivery_id).flatMap(item => retainedSequences(item, expected)));
  return expected.events.filter(event => sequences.has(event.seq));
}

async function cancellableWait($, args, signal) {
  if (signal?.aborted) return undefined;
  const pending = bridge($, 'wait', args);
  if (!signal) return pending;
  let cancel;
  const cancelled = new Promise(resolve => { cancel = () => resolve(undefined); signal.addEventListener('abort', cancel, { once: true }); });
  try {
    const result = await Promise.race([pending, cancelled]);
    if (result === undefined || signal.aborted) {
      pending.then(value => release($, value.delivery_id), () => {});
      return undefined;
    }
    return result;
  } finally { signal.removeEventListener('abort', cancel); }
}

async function capture($, e) {
  const messages = await $.session.messages({ as: 'api', ...(e.agentId ? { agentId: e.agentId } : {}) });
  if (!Array.isArray(messages)) throw new Error('Claude did not return its available conversation. No Codex task was started.');
  return { messages, source: 'claude_api_available', hostMessageLimit: 4096 };
}

function toolArgs(e, operation) {
  if (operation === 'spawn_agent') {
    if (e.role === 'default' && e.context_mode !== undefined && e.context_mode !== 'none') throw new Error('The default role uses task-only context; omit context_mode or use none.');
    return { message: e.message, cwd: e.cwd, name: e.name, role: e.role, model: e.model, reasoning_effort: e.reasoning_effort, context_mode: e.context_mode ?? (e.role === 'default' ? 'none' : 'available') };
  }
  if (operation === 'send_message' || operation === 'followup_task') {
    if (operation === 'followup_task' && e.replacement_model !== undefined) throw new Error('This call only accepts target and message. Use the target returned for your selected model if Codex reported a model failure.');
    return { target: e.target, message: e.message };
  }
  if (operation === 'interrupt_agent') return { target: e.target };
  if (operation === 'close_agent') return e.targets === undefined ? { target: e.target } : { targets: e.targets, ...(e.except === undefined ? {} : { except: e.except }) };
  if (operation === 'answer_agent') return { target: e.target, request_id: e.request_id, answer: e.answer };
  return {};
}

async function handle($, e, next, operation) {
  try {
    active = true; activityEpoch++;
    if (operation === 'wait_agent') {
      if (e.timeout_ms !== undefined && (!Number.isSafeInteger(e.timeout_ms) || e.timeout_ms < 0 || e.timeout_ms > 3600000)) throw new Error('timeout_ms must be an integer from 0 to 3600000.');
      const deadline = e.timeout_ms === undefined ? Infinity : Date.now() + e.timeout_ms;
      const queuedPrompt = notificationPending && !deliveries.get(notificationPending)?.confirmedEvents;
      if (waiters || queuedPrompt || [...deliveries.values()].some(delivery => delivery.channel === 'tool' && !delivery.confirmedEvents)) return { result: JSON.stringify({ waiting: true, ...(queuedPrompt ? { notificationPending: true, message: 'A Codex notification is queued for delivery.' } : {}), workersContinue: true }) };
      waiters++;
      try {
        while (!next.signal?.aborted) {
          const result = await cancellableWait($, { timeout_ms: Math.min(25000, Math.max(0, deadline - Date.now())) }, next.signal);
          if (!result) break;
          if (next.signal?.aborted) { void release($, result.delivery_id); break; }
          if (result.pending) {
            if (Date.now() >= deadline) return { result: JSON.stringify({ timed_out: true, workersContinue: true }) };
            continue; // Local long polling; Claude is not sampled here.
          }
          return { result: JSON.stringify(remember($, result, 'tool', e.tool_use_id, next.signal)) };
        }
        return { result: JSON.stringify({ cancelled: true, workersContinue: true }) };
      } finally { waiters--; }
    }
    const args = toolArgs(e, operation);
    const context = operation === 'spawn_agent' && args.context_mode === 'available' ? await capture($, e) : undefined;
    if (operation === 'spawn_agent' && !args.cwd) args.cwd = await $.session.cwd();
    const response = await bridge($, operation, args, { requestId: e.tool_use_id, ui_summary: true, ...(context ? { context } : {}) });
    const { ui_summary, ...result } = response;
    // The summary travels with the action response, without another bridge or
    // coupling UI freshness to notification delivery. Never send it to Claude.
    if (ui_summary) await observeUI($, ui_summary).catch(() => {});
    else if (operation === 'list_agents') await observeUI($, result).catch(() => {});
    if (operation === 'close_agent' && !result.error) {
      if (typeof result.agent_id === 'string') closedAgents.add(result.agent_id);
      for (const id of result.closed_ids || []) closedAgents.add(id);
      const { closed_ids, ...visible } = result;
      return { result: JSON.stringify(visible) };
    }
    return { result: JSON.stringify(result) };
  } catch (error) { return { result: JSON.stringify({ error: { code: 'plugin_error', message: String(error.message || error) } }) }; }
}

async function observe($, atBoundary = false, signal) {
  if (!active || observing) return;
  const epoch = activityEpoch;
  observing = true;
  let reobserve = false;
  try {
    for (const [delivery_id, expected] of deliveries) {
      if (expected.confirmedEvents) await confirm($, delivery_id, expected.confirmedEvents);
    }
    const pendingDelivery = notificationPending || deliveries.keys().next().value;
    const deliver = !signal?.aborted && !pausedAfterStop && !waking && !waiters && !pendingDelivery && (!busyTurns.size || matchesBoundary(atBoundary));
    const requests = deliver && !busyTurns.size ? wakePending : undefined;
    const result = await bridge($, 'observe', { deliver, ...(pendingDelivery ? { lease_id: pendingDelivery } : {}), ...(requests ? { include_pending_requests: true } : {}) });
    if (result.offline) { if (epoch === activityEpoch) active = false; return; }
    if (result.error) return;
    if (epoch === activityEpoch) await observeUI($, result);
    if (result.events?.length && result.delivery_id) {
      // Recheck after the async bridge: a tool wait may have started meanwhile.
      if (signal?.aborted || pausedAfterStop || waking || waiters || notificationPending || deliveries.size || (busyTurns.size && !matchesBoundary(atBoundary))) { await release($, result.delivery_id); return; }
      const delivery = remember($, result, 'prompt');
      if (!delivery.events.length) { await release($, delivery.delivery_id); return; }
      notificationPending = result.delivery_id;
      const text = EVENT_PREFIX + JSON.stringify({ delivery_id: delivery.delivery_id, events: delivery.events });
      if (busyTurns.size) {
        const turns = [...busyTurns];
        try {
          const receipt = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } });
          const retained = receipt?.deny ? [] : messageDeliveries(receipt?.message, { prompt: true });
          const accepted = acceptedEvents(retained, delivery.delivery_id, deliveries.get(delivery.delivery_id));
          if (accepted.length) {
            showNoteFeedback($, accepted);
            // A tool can still end the turn. Only an unread request that blocks
            // a worker justifies starting another turn after the note is retained.
            const requests = accepted.filter(event => ['question', 'approval'].includes(event.kind) && typeof event.request_id === 'string')
              .map(({ agent_id, request_id }) => ({ agent_id, request_id }));
            if (requests.length) {
              for (const [turn, step] of turns) {
                if (busyTurns.get(turn) === step) wakeTurns.set(turn, [...(wakeTurns.get(turn) || []), ...requests]);
                else if (endedTurns.get(turn)) {
                  wakePending = [...(wakePending || []), ...requests];
                  reobserve = true;
                }
              }
            }
            try { await confirm($, delivery.delivery_id, accepted); }
            catch { /* Retained history and recoveryEvidence preserve the receipt. */ }
          } else await release($, delivery.delivery_id);
        } catch { await release($, delivery.delivery_id); }
        return;
      }
      // Do not await a queued prompt inside a running turn. Host interruption holds it.
      $.prompt.submit({ text })
        .then(async receipt => {
          if (receipt?.drop) await release($, delivery.delivery_id);
        }).catch(() => release($, delivery.delivery_id));
    } else if (requests && !result.delivery_pending && !result.waiting) {
      // A newly queued batch already starts a model step that can see the prior note.
      void wake($, requests, result.pending_requests);
    }
  } finally {
    observing = false;
    if (reobserve) void observe($).catch(() => {});
  }
}

function matchesBoundary(steps) {
  return Boolean(steps) && [...busyTurns].every(([turn, step]) => step && steps.get(turn) === step);
}

async function observeBoundary($, steps, signal) {
  if (signal?.aborted || !busyTurns.size || !matchesBoundary(steps)) return;
  await observe($, steps, signal).catch(() => {});
}

async function wake($, requests, pendingRequests) {
  if (wakePending !== requests || !active || pausedAfterStop || wakeTurns.size || busyTurns.size || waiters || waking) return;
  const pending = new Set(pendingRequests?.map(request => JSON.stringify([request.agent_id, request.request_id])));
  if (!requests.some(request => !closedAgents.has(request.agent_id) && pending.has(JSON.stringify([request.agent_id, request.request_id])))) {
    wakePending = undefined;
    return;
  }
  waking = true;
  try {
    const receipt = await $.prompt.submit({ text: 'A Codex subagent is waiting for a reply. Review the preceding Codex subagent notification for the question or approval request.' });
    if (!receipt?.drop && wakePending === requests) wakePending = undefined;
  } catch { /* Retry at the next observation. */ }
  finally { waking = false; }
}

async function handleAppend($, e, next) {
  const options = { tool: e.door === 'tool-result' && e.origin?.kind === 'tool' && e.origin.tool === WAIT_TOOL, prompt: e.door === 'prompt' };
  const candidates = messageDeliveries(e.message, options).filter(delivery => deliveries.has(delivery.delivery_id));
  const message = filterClosed(e.message, options, closedAgents);
  const result = await next(message === e.message ? e : { ...e, message });
  if (!result?.deny && !next.signal?.aborted && e.door === 'tool-result' && e.origin?.kind === 'tool') {
    const action_results = retainedActionFailures(result?.message, id => !e.origin.tool_use_id || e.origin.tool_use_id === id ? e.origin.tool : undefined);
    if (action_results.length) {
      const previous = recoveryEvidence ?? { observations: [], legacy_events: [] };
      recoveryEvidence = { ...previous, action_results: [...(previous.action_results ?? []), ...action_results] };
      await bridge($, 'confirm').catch(() => {});
    }
  }
  if (!candidates.length) return result;
  const retained = result?.deny ? [] : messageDeliveries(result?.message, options);
  for (const candidate of candidates) {
    const accepted = acceptedEvents(retained, candidate.delivery_id, deliveries.get(candidate.delivery_id));
    if (accepted.length) {
      try {
        await confirm($, candidate.delivery_id, accepted);
      } catch { /* The retained transcript recovers this delivery on restart. */ }
    } else await release($, candidate.delivery_id);
  }
  return result;
}

export function register(on, options = {}) {
  configureBridge(options);
  registerUI(on);
  registerRows(on);
  on('session.start', async ($, e, next) => {
    active = true; activityEpoch++; // Observe existing helpers; never start one.
    for (const tool of TOOLS) await $.tool.register(tool); // ToolSearch controls deferral.
    // Recover only retained deliveries in the current API window, once per startup.
    const retained = scanRetainedDeliveries(await $.session.messages({ as: 'api' }));
    if (retained.observations.length || retained.legacy_events.length || retained.action_results?.length) {
      recoveryEvidence = retained;
      await bridge($, 'confirm', retained).catch(() => {});
    }
    $.clock.every(10000, () => observe($).catch(() => {}));
    try { await $.command.register({ name: 'codex-agents', description: 'Browse Codex agents', immediate: true }); }
    catch { /* A conflicting command does not prevent tool and clickable-row use. */ }
    try { await $.command.register({ name: 'codex-stop', description: 'Stop all Codex agents in this conversation', immediate: true }); }
    catch { /* Keep an existing command with the same name intact. */ }
    return next(e);
  });
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const steps = e.agentId ? new Map() : new Map(busyTurns);
    // Confirm our own wait result before asking for another delivery. For all
    // other tools handleAppend keeps their row and receipt unchanged.
    const result = await handleAppend($, e, next);
    // A long-running tool may finish after the response that requested it.
    // Observe its retained result without intercepting tool execution itself.
    const wait = e.origin?.kind === 'tool' && e.origin.tool === WAIT_TOOL;
    for (const [turn, step] of steps) {
      if (wait && step) step.waitRetained = true;
      if (!step?.hasTools || (step.waitPlanned && !step.waitRetained)) steps.delete(turn);
    }
    await observeBoundary($, steps, next.signal);
    return result;
  });
  on('session.append', { door: 'prompt' }, handleAppend);
  on('turn.start', ($, e, next) => {
    if (!e.agentId) { pausedAfterStop = false; wakePending = undefined; busyTurns.set(e.turnId, undefined); }
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || !busyTurns.has(e.turnId)) return yield* next(e);
    wakeTurns.delete(e.turnId);
    const step = {};
    busyTurns.set(e.turnId, step);
    const result = yield* next(e);
    // At entry the host already selected this request's messages. Append only
    // when the response has tool calls. Final answers leave the batch for the
    // idle prompt, which carries the events into a new turn in one message.
    if (result?.toolUses?.length) {
      step.hasTools = true;
      step.waitPlanned = result.toolUses.some(tool => tool.name === WAIT_TOOL);
      // A planned wait owns the next event even if its handler has not started.
      if (!step.waitPlanned || step.waitRetained) await observeBoundary($, new Map([[e.turnId, step]]), next.signal);
    }
    return result;
  });
  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      busyTurns.delete(e.turnId);
      endedTurns.set(e.turnId, !e.isAborted && e.reason === 'answer');
      if (endedTurns.size > 64) endedTurns.delete(endedTurns.keys().next().value);
      if (e.isAborted || e.reason === 'aborted') {
        pausedAfterStop = true;
        wakePending = undefined;
        wakeTurns.delete(e.turnId);
      } else if (e.reason === 'answer') {
        const requests = wakeTurns.get(e.turnId);
        wakeTurns.delete(e.turnId);
        if (requests) wakePending = [...(wakePending || []), ...requests];
        void observe($).catch(() => {});
      } else wakeTurns.delete(e.turnId);
    }
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    closeUI();
    if (active) await bridge($, 'shutdown').catch(() => {});
    active = false; activityEpoch++;
    return next(e);
  });
  on('tool.call', { tool: 'mcp__codex-subagents__spawn_agent' }, ($, e, next) => handle($, e, next, 'spawn_agent'));
  on('tool.call', { tool: 'mcp__codex-subagents__send_message' }, ($, e, next) => handle($, e, next, 'send_message'));
  on('tool.call', { tool: 'mcp__codex-subagents__followup_task' }, ($, e, next) => handle($, e, next, 'followup_task'));
  on('tool.call', { tool: 'mcp__codex-subagents__wait_agent' }, ($, e, next) => handle($, e, next, 'wait_agent'));
  on('tool.call', { tool: 'mcp__codex-subagents__list_agents' }, ($, e, next) => handle($, e, next, 'list_agents'));
  on('tool.call', { tool: 'mcp__codex-subagents__interrupt_agent' }, ($, e, next) => handle($, e, next, 'interrupt_agent'));
  on('tool.call', { tool: 'mcp__codex-subagents__close_agent' }, ($, e, next) => handle($, e, next, 'close_agent'));
  on('tool.call', { tool: 'mcp__codex-subagents__answer_agent' }, ($, e, next) => handle($, e, next, 'answer_agent'));
  on('tool.call', { tool: 'mcp__codex-subagents__list_models' }, ($, e, next) => handle($, e, next, 'list_models'));
}

// A Claude Code mod. No model requests or per-task tool definitions.
import { WAIT_TOOL, EVENT_PREFIX, messageDeliveries, scanRetainedDeliveries, retainedSequences, filterClosed } from './delivery.js';
const OBJECT = { type: 'object' };
const STR = { type: 'string' };
const TARGET = { type: 'string', description: 'Agent ID from spawn_agent.' };
const TOOLS = [
  { name: 'spawn_agent', description: 'Start a persistent Codex agent for a task.', inputSchema: { ...OBJECT, properties: { message: STR, cwd: { ...STR, description: 'Absolute working directory; default: this session.' }, name: STR, context_mode: { type: 'string', enum: ['available', 'none'], default: 'available', description: 'available: inherit host-exported current context, up to 4096 API messages; older content may be summarized or omitted. none: task only.' }, model: { ...STR, description: 'ID from list_models; default: configured Codex model.' }, reasoning_effort: { ...STR, description: 'Optional effort from list_models.' } }, required: ['message'], additionalProperties: false } },
  { name: 'send_message', description: 'Steer a running agent; append to an idle agent’s history without starting it.', inputSchema: { ...OBJECT, properties: { target: TARGET, message: STR }, required: ['target', 'message'], additionalProperties: false } },
  { name: 'followup_task', description: 'Send a task and run the same agent with its history. Steer if already running.', inputSchema: { ...OBJECT, properties: { target: TARGET, message: STR }, required: ['target', 'message'], additionalProperties: false } },
  { name: 'wait_agent', description: 'Wait for queued or new events from any agent.', inputSchema: { ...OBJECT, properties: { timeout_ms: { type: 'integer', minimum: 0, maximum: 3600000, description: 'Limit this wait only; agents keep running. Omit to wait for an event.' } }, additionalProperties: false } },
  { name: 'list_agents', description: 'List this session’s agent IDs and brief status.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
  { name: 'interrupt_agent', description: 'Stop the current turn; keep history and file changes. Resume with followup_task.', inputSchema: { ...OBJECT, properties: { target: TARGET }, required: ['target'], additionalProperties: false } },
  { name: 'close_agent', description: 'Remove an inactive agent from this session; preserve its Codex history.', inputSchema: { ...OBJECT, properties: { target: TARGET }, required: ['target'], additionalProperties: false } },
  { name: 'answer_agent', description: 'Answer a pending request using its request_id and reply_format.', inputSchema: { ...OBJECT, properties: { target: TARGET, request_id: STR, answer: { ...OBJECT, description: 'Object matching the event’s reply_format.' } }, required: ['target', 'request_id', 'answer'], additionalProperties: false } },
  { name: 'list_models', description: 'Read Codex’s configured model catalog: IDs, defaults and reasoning efforts.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
];

let active = false;
let waiters = 0;
let observing = false;
let notificationPending;
let recoveryEvidence;
let lastStatus = '';
const busyTurns = new Set();
const deliveries = new Map();
const closedAgents = new Set();

async function bridge($, operation, args = {}, extras = {}) {
  const owner = await $.session.id();
  const cwd = await $.session.cwd();
  const node = await $.env.get('CODEX_SUBAGENTS_NODE_COMMAND') || 'node';
  const stateDir = await $.env.get('CODEX_SUBAGENTS_STATE_DIR');
  const codex = await $.env.get('CODEX_SUBAGENTS_CODEX_COMMAND');
  const env = {};
  if (stateDir) env.CODEX_SUBAGENTS_STATE_DIR = stateDir;
  if (codex) env.CODEX_SUBAGENTS_CODEX_COMMAND = codex;
  const restore = operation !== 'shutdown' ? recoveryEvidence : undefined;
  const result = await $.process.run([node, `${$.plugin.root}/runtime/bridge.mjs`], {
    cwd, env, timeoutMs: operation === 'wait' ? 45000 : 240000,
    stdin: JSON.stringify({ owner, cwd, operation, args, ...(restore ? { restore } : {}), ...extras }),
  });
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`Codex bridge returned no valid response (exit ${result.exitCode}).`); }
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
  if (operation === 'spawn_agent') return { message: e.message, cwd: e.cwd, name: e.name, model: e.model, reasoning_effort: e.reasoning_effort, context_mode: e.context_mode || 'available' };
  if (operation === 'send_message' || operation === 'followup_task') return { target: e.target, message: e.message };
  if (operation === 'interrupt_agent' || operation === 'close_agent') return { target: e.target };
  if (operation === 'answer_agent') return { target: e.target, request_id: e.request_id, answer: e.answer };
  return {};
}

async function handle($, e, next, operation) {
  try {
    active = true;
    if (operation === 'wait_agent') {
      if (e.timeout_ms !== undefined && (!Number.isSafeInteger(e.timeout_ms) || e.timeout_ms < 0 || e.timeout_ms > 3600000)) throw new Error('timeout_ms must be an integer from 0 to 3600000.');
      const deadline = e.timeout_ms === undefined ? Infinity : Date.now() + e.timeout_ms;
      const queuedPrompt = notificationPending && !deliveries.get(notificationPending)?.confirmedEvents;
      if (waiters || queuedPrompt || [...deliveries.values()].some(delivery => delivery.channel === 'tool' && !delivery.confirmedEvents)) return { result: JSON.stringify({ waiting: true, ...(queuedPrompt ? { notificationPending: true, message: 'A notification is queued; finish this turn to receive it.' } : {}), workersContinue: true }) };
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
    const result = await bridge($, operation, args, { requestId: e.tool_use_id, ...(context ? { context } : {}) });
    if (operation === 'close_agent' && !result.error && typeof result.agent_id === 'string') closedAgents.add(result.agent_id);
    return { result: JSON.stringify(result) };
  } catch (error) { return { result: JSON.stringify({ error: { code: 'plugin_error', message: String(error.message || error) } }) }; }
}

async function observe($) {
  if (!active || observing) return;
  observing = true;
  try {
    for (const [delivery_id, expected] of deliveries) {
      if (expected.confirmedEvents) await confirm($, delivery_id, expected.confirmedEvents);
    }
    const pendingDelivery = notificationPending || deliveries.keys().next().value;
    const deliver = !waiters && !busyTurns.size && !pendingDelivery;
    const result = await bridge($, 'observe', { deliver, ...(pendingDelivery ? { lease_id: pendingDelivery } : {}) });
    if (result.offline) { active = false; return; }
    if (result.error) return;
    const text = (result.agents || []).map(a => `${a.name || a.agent_id}: ${a.status}${a.activity ? ' · ' + a.activity : ''}`).join(' | ');
    if (text !== lastStatus) { lastStatus = text; await $.ui.status(text || 'Codex: idle'); }
    if (result.events?.length && result.delivery_id) {
      // Recheck after the async bridge: a tool wait may have started meanwhile.
      if (waiters || busyTurns.size || notificationPending) { await release($, result.delivery_id); return; }
      const delivery = remember($, result, 'prompt');
      notificationPending = result.delivery_id;
      // Do not await a queued prompt inside a running turn. Host interruption holds it.
      $.prompt.submit({ text: EVENT_PREFIX + JSON.stringify({ delivery_id: delivery.delivery_id, events: delivery.events }) })
        .then(async receipt => {
          if (receipt?.drop) await release($, delivery.delivery_id);
        }).catch(() => release($, delivery.delivery_id));
    }
  } finally { observing = false; }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    active = true; // Observe an existing session helper once; observation never starts one.
    for (const tool of TOOLS) await $.tool.register(tool); // ToolSearch controls deferral.
    // Recover only retained deliveries in the current API window, once per startup.
    const retained = scanRetainedDeliveries(await $.session.messages({ as: 'api' }));
    if (retained.observations.length || retained.legacy_events.length) {
      recoveryEvidence = retained;
      await bridge($, 'confirm', retained).catch(() => {});
    }
    $.clock.every(10000, () => observe($).catch(() => {}));
    return next(e);
  });
  on('session.append', async ($, e, next) => {
    const options = { tool: e.door === 'tool-result' && e.origin?.kind === 'tool' && e.origin.tool === WAIT_TOOL, prompt: e.door === 'prompt' };
    const candidates = messageDeliveries(e.message, options).filter(delivery => deliveries.has(delivery.delivery_id));
    const message = filterClosed(e.message, options, closedAgents);
    const result = await next(message === e.message ? e : { ...e, message });
    if (!candidates.length) return result;
    const retained = result?.deny ? [] : messageDeliveries(result?.message, options);
    for (const candidate of candidates) {
      const expected = deliveries.get(candidate.delivery_id);
      const sequences = expected?.signal?.aborted ? [] : retained.filter(delivery => delivery.delivery_id === candidate.delivery_id).flatMap(delivery => retainedSequences(delivery, expected));
      if (sequences.length) {
        try {
          await confirm($, candidate.delivery_id, expected.events.filter(event => sequences.includes(event.seq)));
        } catch { /* The retained transcript recovers this delivery on restart. */ }
      } else await release($, candidate.delivery_id);
    }
    return result;
  });
  on('turn.start', ($, e, next) => {
    if (!e.agentId) busyTurns.add(e.turnId);
    return next(e);
  });
  on('turn.complete', ($, e, next) => {
    if (!e.agentId) busyTurns.delete(e.turnId);
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    if (active) await bridge($, 'shutdown').catch(() => {});
    active = false;
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

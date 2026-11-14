// A Claude Code mod. No model requests, transcript rewrites, or per-task tool definitions.
const OBJECT = { type: 'object' };
const STR = { type: 'string' };
const TARGET = { type: 'string', description: 'Agent ID from spawn_agent.' };
const TOOLS = [
  { name: 'spawn_agent', description: 'Start a persistent Codex agent for a task.', inputSchema: { ...OBJECT, properties: { message: STR, cwd: { ...STR, description: 'Absolute working directory; default: this session.' }, name: STR, context_mode: { type: 'string', enum: ['available', 'none'], default: 'available', description: 'available: inherit host-exported current context, up to 4096 API messages; older content may be summarized or omitted. none: task only.' }, model: { ...STR, description: 'ID from list_models; default: configured Codex model.' }, reasoning_effort: { ...STR, description: 'Optional effort from list_models.' } }, required: ['message'], additionalProperties: false } },
  { name: 'send_message', description: 'Steer a running agent; append to an idle agent’s history without starting it.', inputSchema: { ...OBJECT, properties: { target: TARGET, message: STR }, required: ['target', 'message'], additionalProperties: false } },
  { name: 'followup_task', description: 'Send a task and run the same agent with its history. Steer if already running.', inputSchema: { ...OBJECT, properties: { target: TARGET, message: STR }, required: ['target', 'message'], additionalProperties: false } },
  { name: 'wait_agent', description: 'Wait for questions, important messages, compaction or completion. No model polling.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
  { name: 'list_agents', description: 'List this session’s agent IDs and brief status.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
  { name: 'interrupt_agent', description: 'Stop the current turn; keep history and file changes. Resume with followup_task.', inputSchema: { ...OBJECT, properties: { target: TARGET }, required: ['target'], additionalProperties: false } },
  { name: 'answer_agent', description: 'Answer a pending request using its request_id and reply_format.', inputSchema: { ...OBJECT, properties: { target: TARGET, request_id: STR, answer: { ...OBJECT, description: 'Object matching the event’s reply_format.' } }, required: ['target', 'request_id', 'answer'], additionalProperties: false } },
  { name: 'list_models', description: 'List available Codex model IDs, defaults and supported reasoning efforts.', inputSchema: { ...OBJECT, properties: {}, additionalProperties: false } },
];

let cursor = 0;
let active = false;
let waiters = 0;
let observing = false;
let notificationPending = false;
let lastStatus = '';
const busyTurns = new Set();

async function bridge($, operation, args = {}, extras = {}) {
  const owner = await $.session.id();
  const cwd = await $.session.cwd();
  const node = await $.env.get('CODEX_SUBAGENTS_NODE_COMMAND') || 'node';
  const stateDir = await $.env.get('CODEX_SUBAGENTS_STATE_DIR');
  const codex = await $.env.get('CODEX_SUBAGENTS_CODEX_COMMAND');
  const env = {};
  if (stateDir) env.CODEX_SUBAGENTS_STATE_DIR = stateDir;
  if (codex) env.CODEX_SUBAGENTS_CODEX_COMMAND = codex;
  const result = await $.process.run([node, `${$.plugin.root}/runtime/bridge.mjs`], {
    cwd, env, timeoutMs: operation === 'wait' ? 45000 : 240000,
    stdin: JSON.stringify({ owner, cwd, operation, args, cursor, ...extras }),
  });
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`Codex bridge returned no valid response (exit ${result.exitCode}).`); }
  return value;
}

async function capture($, e) {
  const messages = await $.session.messages({ as: 'api', ...(e.agentId ? { agentId: e.agentId } : {}) });
  if (!Array.isArray(messages)) throw new Error('Claude did not return its available conversation. No Codex task was started.');
  return { messages, source: 'claude_api_available', hostMessageLimit: 4096 };
}

function toolArgs(e, operation) {
  if (operation === 'spawn_agent') return { message: e.message, cwd: e.cwd, name: e.name, model: e.model, reasoning_effort: e.reasoning_effort, context_mode: e.context_mode || 'available' };
  if (operation === 'send_message' || operation === 'followup_task') return { target: e.target, message: e.message };
  if (operation === 'interrupt_agent') return { target: e.target };
  if (operation === 'answer_agent') return { target: e.target, request_id: e.request_id, answer: e.answer };
  return {};
}

async function handle($, e, next, operation) {
  try {
    active = true;
    if (operation === 'wait_agent') {
      waiters++;
      try {
        while (!next.signal?.aborted) {
          const result = await bridge($, 'wait');
          if (result.pending) continue; // Local long polling; Claude is not sampled here.
          if (result.cursor !== undefined) cursor = Math.max(cursor, result.cursor);
          return { result: JSON.stringify(result) };
        }
        return { result: JSON.stringify({ cancelled: true, workersContinue: true }) };
      } finally { waiters--; }
    }
    const args = toolArgs(e, operation);
    const context = operation === 'spawn_agent' && args.context_mode === 'available' ? await capture($, e) : undefined;
    if (operation === 'spawn_agent' && !args.cwd) args.cwd = await $.session.cwd();
    const result = await bridge($, operation, args, { requestId: e.tool_use_id, ...(context ? { context } : {}) });
    return { result: JSON.stringify(result) };
  } catch (error) { return { result: JSON.stringify({ error: { code: 'plugin_error', message: String(error.message || error) } }) }; }
}

async function observe($) {
  if (!active || observing) return;
  observing = true;
  try {
    const result = await bridge($, 'observe');
    if (result.offline) { active = false; return; }
    if (result.error) return;
    const text = (result.agents || []).map(a => `${a.name || a.agent_id}: ${a.status}${a.activity ? ' · ' + a.activity : ''}`).join(' | ');
    if (text !== lastStatus) { lastStatus = text; await $.ui.status(text || 'Codex: idle'); }
    if (!waiters && !busyTurns.size && !notificationPending && result.events?.length) {
      notificationPending = true;
      const nextCursor = result.events.at(-1).seq;
      // Do not await a queued prompt inside a running turn. Host interruption holds it.
      $.prompt.submit({ text: 'Codex agent events (respond only where needed; otherwise wait):\n' + JSON.stringify(result.events) })
        .then(async receipt => {
          if (!receipt?.drop) { cursor = Math.max(cursor, nextCursor); await bridge($, 'ack'); }
        }).catch(() => {}).finally(() => { notificationPending = false; });
    }
  } finally { observing = false; }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    active = true; // Observe an existing session helper once; observation never starts one.
    for (const tool of TOOLS) await $.tool.register(tool); // ToolSearch controls deferral.
    $.clock.every(10000, () => observe($).catch(() => {}));
    return next(e);
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
  on('tool.call', { tool: 'mcp__codex-subagents__answer_agent' }, ($, e, next) => handle($, e, next, 'answer_agent'));
  on('tool.call', { tool: 'mcp__codex-subagents__list_models' }, ($, e, next) => handle($, e, next, 'list_models'));
}

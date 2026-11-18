let settingsJson;

// The public HTTP API limits each body to 4 Mi UTF-16 code units. Transfer
// ordinary UTF-8 JSON text, preserving Unicode pairs across requests.
async function postContext($, endpoint, json) {
  const limit = 4 * 1024 * 1024;
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(json.length, offset + limit);
    const last = json.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    const response = await $.http.fetch(`http://127.0.0.1:${endpoint.port}/context`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8', authorization: 'Bearer ' + endpoint.ticket, 'x-context-offset': String(offset) },
      body: json.slice(offset, end),
    });
    let receipt;
    try { receipt = JSON.parse(response.text); } catch { /* A refused request can have an empty response. */ }
    if (!response.ok) {
      if (['context_export_failed', 'transport_limit'].includes(receipt?.error?.code) && typeof receipt.error.message === 'string') throw new Error(receipt.error.message);
      throw new Error(`Local context export returned HTTP ${response.status}.`);
    }
    if (receipt?.received !== end) throw new Error('The local helper did not acknowledge the full context upload.');
    offset = end;
  }
}

export function configureBridge(options = {}) {
  const maxActiveAgents = options.maxActiveAgents === undefined ? 5 : Number(options.maxActiveAgents);
  const permissionsMode = options.permissionsMode ?? 'full-access';
  if (!Number.isInteger(maxActiveAgents) || maxActiveAgents < 1 || maxActiveAgents > 7) throw new Error('maxActiveAgents must be an integer from 1 to 7.');
  if (!['full-access', 'auto-review', 'ask'].includes(permissionsMode)) throw new Error('permissionsMode must be full-access, auto-review, or ask.');
  settingsJson = JSON.stringify({ maxActiveAgents, permissionsMode });
}

// Transport only: UI reads do not participate in model-event acknowledgements.
export async function requestBridge($, operation, args = {}, extras = {}) {
  const [owner, cwd, nodeCommand, stateDir, codex, settingsOverride] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.env.get('CODEX_SUBAGENTS_NODE_COMMAND'),
    $.env.get('CODEX_SUBAGENTS_STATE_DIR'),
    $.env.get('CODEX_SUBAGENTS_CODEX_COMMAND'),
    $.env.get('CODEX_SUBAGENTS_SETTINGS'),
  ]);
  const node = nodeCommand || 'node';
  const env = {};
  if (stateDir) env.CODEX_SUBAGENTS_STATE_DIR = stateDir;
  if (codex) env.CODEX_SUBAGENTS_CODEX_COMMAND = codex;
  if (settingsOverride || settingsJson) env.CODEX_SUBAGENTS_SETTINGS = settingsOverride || settingsJson;
  const run = async body => {
    const result = await $.process.run([node, `${$.plugin.root}/runtime/bridge.mjs`], {
      cwd, env, timeoutMs: operation === 'wait' ? 45000 : 240000,
      stdin: JSON.stringify({ owner, cwd, ...body }),
    });
    try { return JSON.parse(result.stdout); }
    catch { throw new Error(`Codex bridge returned no valid response (exit ${result.exitCode}).`); }
  };
  const { context, ...control } = extras;
  if (!context) return run({ operation, args, ...control });
  let ticket;
  try {
    const json = JSON.stringify(context.messages);
    const endpoint = await run({ operation: 'reserve_context', args: { count: context.messages.length, chars: json.length }, requestId: control.requestId });
    if (endpoint.error) return endpoint;
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.ticket)) {
      throw new Error('The local helper returned an invalid context upload endpoint.');
    }
    ticket = endpoint.ticket;
    await postContext($, endpoint, json);
  } catch (cause) {
    if (ticket) await run({ operation: 'discard_context', args: { ticket } }).catch(() => {});
    return { error: { code: 'context_export_failed', message: `Claude context export failed before task dispatch: ${String(cause.message || cause)} Use context_mode none with a task summary to delegate without history.` } };
  }
  try {
    const result = await run({ operation, args, ...control, context_ticket: ticket });
    if (result.error) await run({ operation: 'discard_context', args: { ticket } }).catch(() => {});
    return result;
  } catch (error) {
    await run({ operation: 'discard_context', args: { ticket } }).catch(() => {});
    throw error;
  }
}

export async function pickFiles($) {
  const node = await $.env.get('CODEX_SUBAGENTS_NODE_COMMAND') || 'node';
  const result = await $.process.run([node, `${$.plugin.root}/runtime/picker.mjs`], { cwd: await $.session.cwd(), timeoutMs: 210000 });
  try { return JSON.parse(result.stdout); }
  catch { return { paths: [], unsupported: true }; }
}

export async function pasteAttachments($) {
  try {
    const node = await $.env.get('CODEX_SUBAGENTS_NODE_COMMAND') || 'node';
    const result = await $.process.run([node, `${$.plugin.root}/runtime/picker.mjs`, '--clipboard'], { cwd: await $.session.cwd(), timeoutMs: 20000 });
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.paths) || parsed.paths.some(path => typeof path !== 'string')) throw new Error('Invalid clipboard response');
    return parsed;
  } catch { return { paths: [], error: '无法读取剪贴板附件，请重试。' }; }
}

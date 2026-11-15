let settingsJson;

export function configureBridge(options = {}) {
  const maxActiveAgents = options.maxActiveAgents === undefined ? 5 : Number(options.maxActiveAgents);
  const permissionsMode = options.permissionsMode ?? 'full-access';
  if (!Number.isInteger(maxActiveAgents) || maxActiveAgents < 1 || maxActiveAgents > 7) throw new Error('maxActiveAgents must be an integer from 1 to 7.');
  if (!['full-access', 'auto-review', 'ask'].includes(permissionsMode)) throw new Error('permissionsMode must be full-access, auto-review, or ask.');
  settingsJson = JSON.stringify({ maxActiveAgents, permissionsMode });
}

// Transport only: UI reads do not participate in model-event acknowledgements.
export async function requestBridge($, operation, args = {}, extras = {}) {
  const owner = await $.session.id();
  const cwd = await $.session.cwd();
  const node = await $.env.get('CODEX_SUBAGENTS_NODE_COMMAND') || 'node';
  const stateDir = await $.env.get('CODEX_SUBAGENTS_STATE_DIR');
  const codex = await $.env.get('CODEX_SUBAGENTS_CODEX_COMMAND');
  const settingsOverride = await $.env.get('CODEX_SUBAGENTS_SETTINGS');
  const env = {};
  if (stateDir) env.CODEX_SUBAGENTS_STATE_DIR = stateDir;
  if (codex) env.CODEX_SUBAGENTS_CODEX_COMMAND = codex;
  if (settingsOverride || settingsJson) env.CODEX_SUBAGENTS_SETTINGS = settingsOverride || settingsJson;
  const result = await $.process.run([node, `${$.plugin.root}/runtime/bridge.mjs`], {
    cwd, env, timeoutMs: operation === 'wait' ? 45000 : 240000,
    stdin: JSON.stringify({ owner, cwd, operation, args, ...extras }),
  });
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Codex bridge returned no valid response (exit ${result.exitCode}).`); }
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

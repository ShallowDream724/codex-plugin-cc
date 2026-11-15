export function loadSettings(value = process.env.CODEX_SUBAGENTS_SETTINGS) {
  let settings = value ?? {};
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch { throw new TypeError('CODEX_SUBAGENTS_SETTINGS must be valid JSON.'); }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Settings must be an object.');
  const unknown = Object.keys(settings).filter((key) => !['maxActiveAgents', 'permissionsMode'].includes(key));
  if (unknown.length) throw new TypeError(`Unknown settings: ${unknown.join(', ')}.`);
  const { maxActiveAgents = 5, permissionsMode = 'full-access' } = settings;
  if (!Number.isInteger(maxActiveAgents) || maxActiveAgents < 1 || maxActiveAgents > 7) throw new TypeError('maxActiveAgents must be an integer from 1 to 7.');
  if (!['full-access', 'auto-review', 'ask'].includes(permissionsMode)) throw new TypeError('permissionsMode must be full-access, auto-review, or ask.');
  return { maxActiveAgents, permissionsMode };
}

export function permissionParams(settings) {
  if (settings.permissionsMode === 'full-access') return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  return { approvalPolicy: 'on-request', approvalsReviewer: settings.permissionsMode === 'ask' ? 'user' : 'auto_review', sandbox: 'workspace-write' };
}

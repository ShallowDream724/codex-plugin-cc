import { requestBridge as bridge, pickFiles, pasteAttachments } from './bridge.js';
import { agentIcon, agentVisual, retainIcons, clearIcons, displayLabel } from './presentation.js';
import { toolSections } from './tool-presentation.js';
import { activityIcon, contextIndicator, disclosureIcon, copyIcon, jumpIcon } from './tool-icons.js';
import { normalizeDisplayMath } from './math-markdown.js';
import { orderWaits } from '../shared/activity-order.mjs';
import { renderDiff } from './diff-view.js';
import { nativeRenderBudget } from './render-budget.js';

const PANE = 'codex_subagent_activity';
const PANE_REVISION = { plugin: 'codex-subagents', key: 'paneRevision' };
let paneRevision = 0;
const MAX_DETAILS = 16;
const VISIBLE_ENTRIES = 500;
const safe = (value) => String(value).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
const idOf = (agent) => agent.agent_id || agent.id;
const summaries = (agents) => agents.map((agent) => ({ agent_id: idOf(agent), ...Object.fromEntries(['name', 'model', 'reasoning_effort', 'permissions_mode', 'context_used_tokens', 'context_limit_tokens', 'status', 'user_paused', 'user_control_status'].filter((key) => Object.hasOwn(agent, key)).map((key) => [key, agent[key]])) }));
const entryKey = (entry) => `${entry.turn_id || ''}:${entry.id}`;
const detailKey = (entry, filePath) => JSON.stringify([entryKey(entry), filePath ?? null]);
const detailFor = (page, entry, filePath) => page.details.get(detailKey(entry, filePath));
function cacheDetail(page, key, value) {
  page.details.delete(key); page.details.set(key, value);
  while (page.details.size > MAX_DETAILS) page.details.delete(page.details.keys().next().value);
}
const groupable = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
const outputTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput']);
function attachmentName(path, index) {
  const name = path.split(/[\\/]/).at(-1) || path, ext = /\.[^.]{1,10}$/.exec(name)?.[0] || '';
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(ext) && /(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[\da-f]{24,})/i.test(name)) return `图片 ${index + 1}${ext}`;
  const width = (text) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
  if (width(name) <= 26) return name;
  let prefix = '', used = 0;
  for (const char of name.slice(0, ext ? -ext.length : undefined)) { const cells = char.charCodeAt(0) > 255 ? 2 : 1; if (used + cells > 24 - width(ext)) break; prefix += char; used += cells; }
  return `${prefix}…${ext}`;
}
const integrationOf = (entry) => {
  if (!['mcpToolCall', 'dynamicToolCall'].includes(entry.type)) return '';
  const d = entry.data || {}, source = d.server || d.namespace || (/^mcp__([^_]+)__/.exec(d.tool || '')?.[1]) || '';
  return /fastctx/i.test(`${source} ${d.tool || ''}`) ? 'FastCtx' : source;
};
const fastctxTitles = { inspect_local_file: '读取本地文件', grep: '搜索文件内容', glob: '匹配文件路径', run: '运行命令', run_background: '启动后台任务', job_output: '读取任务输出', job_list: '查看后台任务', job_kill: '停止后台任务', replace: '替换文件内容' };
function toolTitle(data) {
  if (typeof data.display_title === 'string' && data.display_title.trim()) return data.display_title;
  if (typeof data.appContext?.actionName === 'string' && data.appContext.actionName.trim()) return data.appContext.actionName;
  const tool = typeof data.tool === 'string' ? data.tool : '', server = typeof data.server === 'string' ? data.server : '';
  const name = tool.split('__').at(-1);
  if ((/fastctx/i.test(server) || /fastctx/i.test(tool)) && fastctxTitles[name]) return fastctxTitles[name];
  return tool ? `使用 ${server ? `${server} / ` : ''}${tool}` : '使用工具';
}
function searchDescription(data) {
  const action = data.action && typeof data.action === 'object' ? data.action : {};
  const query = data.query || action.query || data.title || action.title || data.url || action.url || (Array.isArray(action.queries) ? action.queries.join('、') : '');
  const verb = ['open_page', 'openPage'].includes(action.type) ? '打开网页' : ['find_in_page', 'findInPage'].includes(action.type) ? '查找页面内容' : '搜索';
  return `${verb}${typeof query === 'string' && query ? `：${query}` : ''}`;
}
function planText(data) {
  if (typeof data.text === 'string') return data.text;
  const steps = data.steps ?? data.plan;
  if (typeof steps === 'string') return steps;
  if (Array.isArray(steps)) return steps.map((step) => `- ${typeof step === 'string' ? step : step?.step ?? step?.description ?? ''}${step?.status ? `（${step.status}）` : ''}`).join('\n');
  return '';
}
function delegationDescription(data) {
  const name = [data.name, ...(Array.isArray(data.names) ? data.names : [])].filter(Boolean).join('、') || '子代理';
  const statuses = Array.isArray(data.agents) ? data.agents.map((agent) => agent?.status) : Array.isArray(data.agent_statuses) ? data.agent_statuses : typeof data.agent_status === 'string' ? [data.agent_status] : [];
  if (statuses.length && statuses.every((status) => status === 'completed')) return `${name}已完成`;
  if (data.tool === 'spawnAgent' || data.tool === 'followupTask' || data.tool === 'resumeAgent') return `${name}${data.stage === 'started' ? '正在启动' : '开始工作'}`;
  const action = { wait: '等待子代理', sendInput: '发送消息', sendMessage: '发送消息', interruptAgent: '请求停止', closeAgent: '关闭子代理', listAgents: '查看子代理' }[data.tool];
  return action ? `${action}${name === '子代理' ? '' : `：${name}`}` : `${name}已更新`;
}
function changeLabel(change) {
  const diff = typeof change.diff === 'string' && change.diff.length < 4096 && !change.diff.includes('[truncated]') ? change.diff : null;
  const lines = diff === null ? [] : diff.split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const hasCounts = Number.isInteger(change.added) && Number.isInteger(change.removed);
  return `已编辑 ${safe(typeof change.path === 'string' ? change.path.split(/[\\/]/).at(-1) : '文件')}${hasCounts ? ` +${change.added} -${change.removed}` : lines.length ? ` +${added} -${removed}` : ''}`;
}
// Only complete unified hunks are passed as diffs; bounded previews and output
// pages may end mid-hunk and are still readable as ordinary code.
function isUnifiedDiff(text) {
  if (typeof text !== 'string' || !text) return false;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let oldLeft = 0, newLeft = 0, hunks = 0, inHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      if (inHunk && (oldLeft !== 0 || newLeft !== 0)) return false;
      oldLeft = Number(header[2] ?? 1); newLeft = Number(header[4] ?? 1); inHunk = true; hunks++; continue;
    }
    if (!inHunk) {
      if (/^(?:diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary files )/.test(line) || line === '') continue;
      return false;
    }
    if (line === '' && i === lines.length - 1) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith(' ')) { oldLeft--; newLeft--; }
    else if (line.startsWith('-')) oldLeft--;
    else if (line.startsWith('+')) newLeft--;
    else return false;
    if (oldLeft < 0 || newLeft < 0) return false;
  }
  return hunks > 0 && oldLeft === 0 && newLeft === 0;
}
const description = (entry) => {
  const d = entry.data || {};
  if (entry.type === 'parentMessage') return 'Claude';
  if (entry.type === 'directUserMessage') return '你';
  if (entry.type === 'userMessage') return 'Claude';
  if (entry.type === 'agentMessage') return 'Codex';
  if (entry.type === 'commandExecution') return `运行命令 ${d.command || ''}`;
  if (entry.type === 'mcpToolCall' || entry.type === 'dynamicToolCall') return toolTitle(d);
  if (entry.type === 'fileChange') return `修改文件 ${Array.isArray(d.changes) ? d.changes.map((change) => change.path).filter(Boolean).join('、') : ''}`;
  if (entry.type === 'collabAgentToolCall' || entry.type === 'collabToolCall') return delegationDescription(d);
  if (entry.type === 'imageView' || entry.type === 'imageGeneration') return `图片 ${[d.path || d.savedPath || d.saved_path, d.contentType || d.content_type].filter((value) => typeof value === 'string').join(' · ')}`;
  if (entry.type === 'webSearch') return searchDescription(d);
  if (entry.type === 'contextCompaction') return d.stage === 'started' ? '正在压缩上下文 · 可能需要几分钟' : d.stage === 'completed' ? '上下文已压缩' : '上下文压缩记录';
  if (entry.type === 'subAgentActivity') {
    const rawName = d.display_name || d.name || d.agentPath || '子代理';
    const pathName = typeof d.agentPath === 'string' ? d.agentPath.split('/').at(-1) : null;
    const name = rawName.startsWith('/root/') || rawName === pathName ? rawName.split('/').at(-1).replace(/_/g, ' ') : rawName;
    return `${name} ${({ started: '开始工作', interacted: '已互动', interrupted: '已停止', completed: '已完成' })[d.kind] || '已更新'}`;
  }
  if (entry.type === 'plan') return '计划';
  if (entry.type === 'functionCallOutput') return `工具返回${d.name ? `：${d.name}` : ''}`;
  if (entry.type === 'hookPrompt') return '补充指令';
  if (entry.type === 'sleep') return '等待';
  if (entry.type === 'enteredReviewMode') return '开始审查';
  if (entry.type === 'exitedReviewMode') return '审查结束';
  return typeof d.display_title === 'string' && d.display_title.trim() ? d.display_title : '活动';
};
const body = (entry) => {
  const d = entry.data || {};
  if (entry.type === 'webSearch') {
    const action = d.action && typeof d.action === 'object' ? d.action : {};
    const results = Array.isArray(d.results) ? d.results.flatMap((result) => result && typeof result === 'object' ? [result.title, result.url] : []) : [];
    return [d.query, action.query, ...(Array.isArray(action.queries) ? action.queries : []), action.pattern, d.title, action.title, d.url, action.url, ...results].filter((v) => typeof v === 'string' && v).join('\n') || entry.preview || '';
  }
  if (entry.type === 'plan') return planText(d) || entry.preview || '';
  if (typeof d.text === 'string') return d.text;
  if (entry.type === 'userMessage' && Array.isArray(d.content)) return d.content.map((part) => part.text || '').filter(Boolean).join('\n\n');
  if (typeof entry.preview === 'string') return entry.preview;
  return JSON.stringify(d, null, 2);
};

// Groups preserve the original items and only join adjacent calls in one turn.
export function groupEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    const sameTool = !['mcpToolCall', 'dynamicToolCall'].includes(entry.type) || (integrationOf(entry) ? integrationOf(last?.items[0] || {}) === integrationOf(entry) : last?.items[0]?.data?.tool === entry.data?.tool);
    if (groupable.has(entry.type) && last && last.type === entry.type && last.turn_id === entry.turn_id && sameTool) last.items.push(entry);
    else groups.push({ type: entry.type, turn_id: entry.turn_id, integration: integrationOf(entry), items: [entry] });
  }
  return groups;
}

// The caller feeds its existing low-frequency observe result to observeUI.
// There are no session hooks, model calls, or delivery acknowledgements here.
const state = { agents: [], selected: null, requested: null, error: '', opened: false, timer: null, pages: new Map(), controls: new Map(), folds: new Set(), scroll: new Map(), restore: false, generation: 0 };
const mergeSummaries = (agents) => summaries(agents).map((agent) => ({ ...state.agents.find((previous) => idOf(previous) === idOf(agent)), ...agent }));
const failureText = (error) => safe(error?.message || error?.error?.message || error?.error || (typeof error === 'string' ? error : JSON.stringify(error)) || '连接未返回有效响应').slice(0, 400);
function mergeLive(page, entries, prepend = false) {
  const positions = new Map(page.live.map((entry, index) => [entryKey(entry), index]));
  if (prepend) {
    // Loaded history extends the same transcript. It cannot replace newer live
    // versions or evict messages the person already has on screen.
    const older = [];
    for (const entry of entries) if (!positions.has(entryKey(entry))) {
      positions.set(entryKey(entry), -1); older.push(entry);
    }
    if (older.length) { page.live = [...older, ...page.live]; page.timeline = null; }
    return older.length > 0;
  }
  let changed = false;
  for (const entry of entries) {
    const index = positions.get(entryKey(entry));
    if (index === undefined) { positions.set(entryKey(entry), page.live.length); page.live.push(entry); changed = true; }
    else {
      const value = !Number.isFinite(entry.started_at_ms) && Number.isFinite(page.live[index].started_at_ms) ? { ...entry, started_at_ms: page.live[index].started_at_ms } : entry;
      if (JSON.stringify(page.live[index]) !== JSON.stringify(value)) { page.live[index] = value; changed = true; }
    }
  }
  if (changed) page.timeline = null;
  return changed;
}
function conversationEntries(all) {
  const messageKey = (entry) => {
    if (!entry.turn_id || !['userMessage', 'parentMessage', 'directUserMessage'].includes(entry.type)) return null;
    const attachments = entry.data?.attachments ?? entry.data?.content?.filter(part => ['localImage', 'mention'].includes(part.type)) ?? [];
    return JSON.stringify([entry.turn_id, entry.type === 'directUserMessage' ? 'user' : 'parent', body(entry), attachments.map(part => part.path)]);
  };
  const nativeCopies = new Map();
  for (const entry of all) {
    const key = messageKey(entry);
    if (key && !String(entry.id).startsWith('action:')) nativeCopies.set(key, (nativeCopies.get(key) ?? 0) + 1);
  }
  return orderWaits(all.filter((entry) => {
    if (!String(entry.id).startsWith('action:')) return true;
    const key = messageKey(entry), count = nativeCopies.get(key) ?? 0;
    if (!count) return true;
    nativeCopies.set(key, count - 1); return false;
  }));
}
function timelineWindow(page, count = page.windowSize ?? VISIBLE_ENTRIES, from) {
  const all = page.timeline ??= conversationEntries(page.live), lastStart = Math.max(0, all.length - count);
  const start = page.followTail ? lastStart : Math.max(0, Math.min(from ?? (page.windowEnd != null ? page.windowEnd - count : page.windowStart), Math.max(0, all.length - 1)));
  return { entries: all.slice(start, page.windowEnd != null && !page.followTail ? page.windowEnd : start + count), start, total: all.length };
}
function holdWindow(page) { page.windowStart = timelineWindow(page).start; page.followTail = false; }
function anchorAfterRender($, id, page, gen, scrollGen, entry, block) {
  if (!entry) return;
  $.clock.after(0, async () => {
    if (state.opened && state.selected === id && state.generation === gen && page.scrollGeneration === scrollGen) await $.ui.scroll({ in: PANE, to: { key: `activity_group_${id}:${entryKey(entry)}` }, block }).catch(() => {});
  });
}
let actionSequence = 0;
let stoppingAll;
const actionId = () => `ui-${Date.now().toString(36)}-${++actionSequence}-${Math.random().toString(36).slice(2)}`;
const controlFor = (id) => {
  if (!state.controls.has(id)) state.controls.set(id, { draft: '', attachments: [], attachmentVersion: 0, picking: false, pathEntry: false, attachmentNotice: '', inputVersion: 0, sending: false, stopping: false, stopEpoch: 0, mutationEpoch: 0, sendResult: '' });
  return state.controls.get(id);
};
const active = (agent) => ['running', 'waiting', 'starting', 'compacting'].includes(agent?.status);
const interruptible = (agent) => (!agent?.user_paused && active(agent)) || agent?.status === 'unknown' || ['stopping', 'unconfirmed'].includes(agent?.user_control_status);
function updateAgent(id, fields) {
  const agent = state.agents.find((a) => idOf(a) === id);
  if (!agent) return false;
  let changed = false;
  for (const key of ['name', 'model', 'reasoning_effort', 'permissions_mode', 'context_used_tokens', 'context_limit_tokens', 'status', 'user_paused', 'user_control_status']) {
    if (Object.hasOwn(fields, key) && agent[key] !== fields[key]) { agent[key] = fields[key]; changed = true; }
  }
  return changed;
}
async function stopAgent($, id) {
  const control = controlFor(id);
  if (control.stopping) return;
  control.stopping = true; control.stopEpoch++; control.mutationEpoch++; updateAgent(id, { user_control_status: 'stopping' }); await invalidate($);
  try {
    const result = await bridge($, 'ui_interrupt', { target: id }, { requestId: actionId() });
    const status = result.user_control_status ?? result.status;
    const known = ['stopping', 'stopped', 'unconfirmed'].includes(status);
    if (state.controls.get(id) === control) updateAgent(id, { ...(typeof result.user_paused === 'boolean' ? { user_paused: result.user_paused } : known ? { user_paused: true } : {}), user_control_status: known ? status : 'unconfirmed' });
  } catch { if (state.controls.get(id) === control) updateAgent(id, { user_control_status: 'unconfirmed' }); }
  finally { control.stopping = false; if (state.opened && state.selected === id) await invalidate($); }
}
async function stopAllAgents($) {
  if (stoppingAll) return stoppingAll;
  stoppingAll = (async () => {
    try {
      const result = await bridge($, 'ui_interrupt_all', {}, { requestId: actionId() });
      if (result.offline) return { text: '当前会话的 Codex 助手未运行，已有记录保留。' };
      if (result.error || !Array.isArray(result.results)) return { text: `停止结果未确认：${failureText(result)}` };
      const listed = await bridge($, 'ui_list', {}).catch(() => null);
      if (Array.isArray(listed?.agents)) await observeUI($, listed);
      if (!result.results.length) return { text: '当前会话没有 Codex 代理。' };
      const stopped = result.results.filter(item => (item.user_control_status ?? item.status) === 'stopped').length;
      const stopping = result.results.filter(item => (item.user_control_status ?? item.status) === 'stopping').length;
      const unconfirmed = result.results.length - stopped - stopping;
      return { text: [stopped && `已停止 ${stopped} 个`, stopping && `正在停止 ${stopping} 个`, unconfirmed && `停止未确认 ${unconfirmed} 个`].filter(Boolean).join('；') + ' Codex 代理（含所属子代理）。' };
    } catch (error) { return { text: `停止结果未确认：${failureText(error)}` }; }
  })();
  try { return await stoppingAll; } finally { stoppingAll = null; }
}
async function sendAgent($, id) {
  const control = controlFor(id), message = control.draft, attachments = [...control.attachments], attachmentVersion = control.attachmentVersion, stopEpoch = control.stopEpoch;
  let accepted = false;
  const selected = state.agents.find((agent) => idOf(agent) === id);
  if (!selected || control.sending || control.stopping || selected.user_control_status === 'stopping' || (!message.trim() && !attachments.length)) return;
  control.sending = true; control.mutationEpoch++; control.sendResult = '发送中…'; await invalidate($);
  try {
    const result = await bridge($, 'ui_send', { target: id, message, ...(attachments.length ? { attachments: attachments.map((path) => ({ path })) } : {}) }, { requestId: actionId() });
    if (result.error || result.offline) {
      control.sendResult = result.offline || result.error?.code === 'action_status_unknown' ? '发送状态未知，请查看活动后再试。' : `发送失败：${safe(result.error?.message || result.error).slice(0, 600)}。草稿已保留。`;
    } else if (result.agent_id === id && typeof result.status === 'string') {
      accepted = true; control.sendResult = '';
      if (control.draft === message) { control.draft = ''; control.inputVersion++; }
      if (control.attachmentVersion === attachmentVersion) { control.attachments = []; control.attachmentVersion++; }
      if (state.controls.get(id) === control && control.stopEpoch === stopEpoch) updateAgent(id, { ...(Object.hasOwn(result, 'user_paused') ? { user_paused: result.user_paused } : {}), ...(Object.hasOwn(result, 'user_control_status') ? { user_control_status: result.user_control_status } : {}), ...(result.status !== 'steered' ? { status: result.status } : {}) });
    } else control.sendResult = '发送状态未知，请查看活动后再试。';
  } catch (error) { control.sendResult = `发送状态未知：${safe(error?.message || error).slice(0, 600)}。请查看活动后再试，草稿已保留。`; }
  finally {
    control.sending = false;
    if (state.opened && state.selected === id && state.controls.get(id) === control) {
      if (accepted) await poll($, true);
      if (state.opened && state.selected === id && state.controls.get(id) === control) await invalidate($);
    }
  }
}
function addAttachments(control, paths) {
  const additions = paths.filter((path) => typeof path === 'string' && path.trim());
  if (!additions.length) return;
  const selected = [...new Set([...control.attachments, ...additions])];
  if (selected.length > 20) { control.attachmentNotice = '每条消息最多添加 20 个附件，请分次发送。'; return; }
  control.attachments = selected;
  control.attachmentVersion++; control.attachmentNotice = '';
}
async function chooseAttachments($, id, source = 'file') {
  const control = controlFor(id);
  if (control.picking) return;
  control.picking = true; control.attachmentNotice = ''; await invalidate($);
  try {
    const result = await (source === 'clipboard' ? pasteAttachments($) : pickFiles($));
    if (state.controls.get(id) !== control) return;
    if (source === 'clipboard' && result.unsupported) control.attachmentNotice = '当前平台不支持粘贴附件，请添加文件。';
    else if (source === 'clipboard' && result.error) control.attachmentNotice = `无法读取剪贴板：${safe(result.error?.message || result.error).slice(0, 300)}`;
    else if (source === 'clipboard' && !result.paths?.length) control.attachmentNotice = '剪贴板中没有可添加的截图或文件。';
    else if (result.unsupported) { control.pathEntry = true; control.attachmentNotice = '请输入文件的绝对路径。'; }
    else if (result.error) control.attachmentNotice = '无法选择文件，请输入文件路径。', control.pathEntry = true;
    else if (Array.isArray(result.paths)) addAttachments(control, result.paths);
  } catch { if (state.controls.get(id) === control) { control.pathEntry = source !== 'clipboard'; control.attachmentNotice = source === 'clipboard' ? '无法读取剪贴板，请添加文件。' : '无法选择文件，请输入文件路径。'; } }
  finally { control.picking = false; if (state.opened && state.selected === id) await invalidate($); }
}
  const pageFor = (id) => {
    if (!state.pages.has(id)) state.pages.set(id, { live: [], windowStart: 0, followTail: true, revision: undefined, historyChecked: false, cursor: null, liveError: '', historyError: '', busy: false, historyLoading: false, historyGeneration: 0, scrollGeneration: 0, detailSequence: 0, details: new Map(), detailRequests: new Map() });
    const page = state.pages.get(id); state.pages.delete(id); state.pages.set(id, page);
    while (state.pages.size > 16) {
      const old = state.pages.keys().next().value; state.pages.delete(old); state.scroll.delete(old);
      for (const key of state.folds) if (key.startsWith(`${old}:`)) state.folds.delete(key);
    }
    return page;
  };
  const toggle = (key) => { if (!state.folds.delete(key)) { state.folds.add(key); if (state.folds.size > 512) state.folds.delete(state.folds.values().next().value); } };
  function invalidate($) {
    // Reading this key in the pane renderer subscribes only that render site.
    // Event-wide invalidation also rebuilds the host conversation's tool rows.
    return $.state.set(PANE_REVISION, ++paneRevision).catch(() => {});
  }
  async function latestHistory($, id) {
    const page = pageFor(id), gen = state.generation, historyGen = page.historyGeneration;
    if (page.historyChecked) return;
    page.historyChecked = true;
    try {
      const result = await bridge($, 'ui_history', { target: id });
      if (!state.opened || state.selected !== id || state.generation !== gen || page.historyGeneration !== historyGen) return;
      if (result.error || result.offline || !Array.isArray(result.entries)) throw new Error(failureText(result));
      const changed = mergeLive(page, result.entries, true), cursorChanged = JSON.stringify(page.cursor) !== JSON.stringify(result.next_cursor ?? null);
      const hadError = page.historyError;
      page.cursor = result.next_cursor ?? null; page.historyError = '';
      if (changed || cursorChanged || hadError) await invalidate($);
      queueHistoryPrefetch($, id);
    } catch (error) {
      if (state.opened && state.selected === id && state.generation === gen) {
        page.historyError = `无法读取已保存的对话：${failureText(error)}。请重试。`; await invalidate($);
      }
    }
  }
  async function poll($, afterSend = false) {
    const id = state.selected, gen = state.generation;
    if (!state.opened || !id) return;
    const page = pageFor(id), control = controlFor(id), mutationEpoch = control.mutationEpoch;
    if (afterSend) { page.afterSendGeneration = gen; page.followTail = true; page.scrollGeneration++; }
    if (page.busy) { if (afterSend) page.refreshAfterPoll = true; return; }
    page.busy = true;
    try {
      const result = await bridge($, 'ui_revision', { target: id, revision: page.revision });
      if (!state.opened || state.selected !== id || state.generation !== gen) return;
      if (result.error || result.offline) throw new Error(failureText(result));
      const changed = result.agent && control.mutationEpoch === mutationEpoch && !control.stopping && !control.sending && updateAgent(id, result.agent);
      let dirty = changed || Boolean(page.liveError);
      page.liveError = '';
      if (result.entries && result.revision !== page.revision) {
        const entriesChanged = mergeLive(page, result.entries);
        page.revision = result.revision;
        dirty ||= entriesChanged;
      }
      if (dirty) await invalidate($);
      const selected = state.agents.find((agent) => idOf(agent) === id);
      if (selected && selected.status !== 'starting' && !page.historyChecked) await latestHistory($, id);
    } catch (error) {
      if (state.opened && state.selected === id && state.generation === gen) {
        const message = `无法更新对话：${failureText(error)}。请重试。`;
        if (page.liveError !== message) { page.liveError = message; await invalidate($); }
      }
    } finally {
      page.busy = false;
      if (page.refreshAfterPoll) {
        page.refreshAfterPoll = false;
        if (state.opened && state.selected === id && state.generation === gen) await poll($);
        else delete page.afterSendGeneration;
      } else if (page.afterSendGeneration !== undefined) {
        const sentGeneration = page.afterSendGeneration;
        delete page.afterSendGeneration;
        if (sentGeneration === gen && state.opened && state.selected === id && state.generation === gen) await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {});
      }
    }
  }
  function prefetchHistory($, id) {
    const page = pageFor(id), cursor = page.cursor, cursorKey = JSON.stringify(cursor);
    if (!cursor || !state.opened || state.selected !== id) return;
    if (page.historyPrefetch?.cursorKey === cursorKey) return page.historyPrefetch.promise;
    const promise = bridge($, 'ui_history', { target: id, cursor }).catch(error => ({ error: { message: failureText(error) } }));
    page.historyPrefetch = { cursorKey, promise };
    return promise;
  }
  function queueHistoryPrefetch($, id) {
    if (!pageFor(id).cursor) return;
    const gen = state.generation;
    $.clock.after(0, () => { if (state.opened && state.selected === id && state.generation === gen) prefetchHistory($, id); });
  }
  async function history($, id) {
    const page = pageFor(id), gen = state.generation, cursor = page.cursor;
    if (!cursor || page.historyLoading) return;
    const scrollGen = page.scrollGeneration, anchor = timelineWindow(page).entries[0];
    page.historyLoading = true;
    try {
      const result = await prefetchHistory($, id);
      if (!state.opened || state.selected !== id || state.generation !== gen) return;
      page.historyPrefetch = null;
      if (result.error || result.offline || !Array.isArray(result.entries)) throw new Error(failureText(result));
      if (result.next_cursor && JSON.stringify(result.next_cursor) === JSON.stringify(cursor)) throw new Error('历史读取位置未推进');
      const previous = timelineWindow(page), oldLength = page.live.length;
      const changed = mergeLive(page, result.entries, true);
      if (!page.followTail) page.windowStart = page.scrollGeneration === scrollGen ? 0 : previous.start + page.live.length - oldLength;
      page.cursor = result.next_cursor ?? null; page.historyError = '';
      await invalidate($);
      // Run after this wheel dispatch returns. Revealing the previous first row
      // preserves its position without recursively dispatching a scroll hook.
      if (changed) anchorAfterRender($, id, page, gen, scrollGen, anchor, 'start');
      queueHistoryPrefetch($, id);
    } catch (error) { if (state.opened && state.selected === id && state.generation === gen) { page.historyError = `无法读取对话记录：${failureText(error)}。请重试。`; await invalidate($); } }
    finally { page.historyLoading = false; }
  }
  async function select($, id) {
    state.selected = id; state.generation++;
    const page = pageFor(id);
    state.restore = state.scroll.has(id) && !page.followTail;
    page.detailRequests.clear();
    await poll($);
    await invalidate($);
  }
  export async function openAgent($, id) {
    state.opened = true; state.requested = id || null; state.error = ''; const gen = ++state.generation;
    try {
      const list = await bridge($, 'ui_list', {});
      if (!state.opened || state.generation !== gen) return;
      if (list.error || list.offline || !Array.isArray(list.agents)) throw new Error(failureText(list));
      state.agents = mergeSummaries(list.agents);
    } catch (error) { state.error = `无法读取代理列表：${failureText(error)}。请重试。`; }
    if (!state.opened || state.generation !== gen) return;
    const selected = id ? state.agents.find((agent) => idOf(agent) === id) : [...state.agents].reverse().find(active) || state.agents.at(-1);
    if (selected) await select($, idOf(selected));
    else { state.selected = null; if (!state.error) state.error = id ? '未找到此代理。请重新读取代理列表。' : '当前会话没有可打开的 Codex 代理。'; await invalidate($); }
    const selectedGen = state.generation;
    const result = await $.ui.open({ id: PANE, title: 'Codex', focus: true, closeOnEscape: true, rows: 24 });
    if (!state.opened || state.generation !== selectedGen) return;
    if (result.isPlaced === false) { state.opened = false; state.generation++; return; }
    await $.ui.scroll({ in: PANE, to: state.restore ? 'start' : 'end' }).catch(() => {});
    if (!state.timer) state.timer = $.clock.every(1000, () => poll($).catch(() => {}));
  }
  async function detail($, id, entry, offset = 0, foldKey = `${id}:${entryKey(entry)}`, filePath, background = false) {
    const page = pageFor(id), key = detailKey(entry, filePath), gen = state.generation, historyGen = page.historyGeneration, request = ++page.detailSequence;
    page.detailRequests.set(key, request);
    while (page.detailRequests.size > MAX_DETAILS) page.detailRequests.delete(page.detailRequests.keys().next().value);
    const fetch = async () => {
      if (request !== page.detailRequests.get(key) || state.selected !== id || !state.opened || state.generation !== gen || !state.folds.has(foldKey)) return;
      const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, offset, ...(filePath !== undefined ? { file_path: filePath } : outputTypes.has(entry.type) ? { view: 'output' } : {}) }).catch((error) => ({ error: { message: failureText(error) } }));
      if (request !== page.detailRequests.get(key)) return;
      page.detailRequests.delete(key);
      if (state.selected !== id || !state.opened || state.generation !== gen || page.historyGeneration !== historyGen || !state.folds.has(foldKey)) return;
      if (result.error || result.offline) cacheDetail(page, key, { text: `无法读取内容：${failureText(result)}`, error: true, next_offset: null, offset });
      else cacheDetail(page, key, { text: result.text || '', next_offset: result.next_offset, offset, format: result.format, startLine: result.start_line });
      await invalidate($);
    };
    if (background) $.clock.after(0, fetch);
    await invalidate($);
    if (!background) await fetch();
  }
export function registerUI(on) {
  on('command.run', { command: 'codex-stop' }, async ($) => stopAllAgents($));
  on('command.run', { command: 'codex-agents' }, async ($) => {
    try {
      const result = await bridge($, 'ui_list', {});
      if (result.error || result.offline) { $.ui.toast('无法获取 Codex 代理。'); return {}; }
      const agents = Array.isArray(result.agents) ? result.agents : [];
      if (!agents.length) { $.ui.toast('当前会话没有 Codex 代理。'); return {}; }
      state.agents = mergeSummaries(agents);
      const selected = agents.find((agent) => idOf(agent) === state.selected)
        || [...agents].reverse().find((agent) => ['running', 'waiting', 'starting', 'compacting'].includes(agent.status))
        || agents.at(-1);
      await openAgent($, idOf(selected));
    } catch { $.ui.toast('无法获取 Codex 代理。'); }
    return {};
  });
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { state.opened = false; state.generation++; state.timer?.cancel(); state.timer = null; }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const id = state.selected;
    const page = id && pageFor(id), view = page && timelineWindow(page), gen = state.generation;
    const atBottom = Number.isFinite(e.contentRows) && Number.isFinite(e.bodyRows) && e.offset >= e.contentRows - e.bodyRows - 1;
    const wasAway = page?.awayFromBottom;
    if (e.origin.kind === 'person' && id) {
      state.scroll.set(id, e.offset); page.scrollGeneration++;
      page.windowAnchor = null;
      holdWindow(page);
      page.followTail = atBottom && view.start + view.entries.length >= view.total;
      page.awayFromBottom = !page.followTail;
    }
    if (e.origin.kind === 'plugin' && state.restore) { state.restore = false; return next({ ...e, offset: state.scroll.get(state.selected) || 0 }); }
    if (e.origin.kind === 'plugin' && state.selected) state.scroll.set(state.selected, e.offset);
    const result = await next(e);
    if (e.origin.kind === 'person' && id && state.opened && state.selected === id && state.generation === gen) {
      if (Boolean(wasAway) !== page.awayFromBottom) await invalidate($);
      if (e.by < 0 && view.start === 0 && e.offset <= Math.max(2, (e.bodyRows || 12) * 2)) prefetchHistory($, id);
      if (e.by < 0 && e.offset <= 1) {
        if (view.start > 0) {
          page.windowEnd = view.start + (view.entries.length > 1 ? 1 : 0);
          page.windowSize = Math.min(VISIBLE_ENTRIES, Math.max(2, view.entries.length * 2)); page.followTail = false; page.windowAnchor = null;
          await invalidate($);
          anchorAfterRender($, id, page, gen, page.scrollGeneration, view.entries[0], 'start');
        } else $.clock.after(0, async () => { if (state.opened && state.selected === id && state.generation === gen) await history($, id); });
      } else if (e.by > 0 && atBottom && view.start + view.entries.length < view.total) {
        page.windowEnd = null; page.windowStart = view.start + Math.max(1, view.entries.length - 1);
        page.windowSize = Math.min(VISIBLE_ENTRIES, Math.max(2, view.entries.length * 2)); page.windowAnchor = null;
        await invalidate($);
        anchorAfterRender($, id, page, gen, page.scrollGeneration, view.entries.at(-1), 'end');
      } else if (e.by > 0 && atBottom && page.followTail) {
        const scrollGen = page.scrollGeneration;
        $.clock.after(0, async () => {
          if (state.opened && state.selected === id && state.generation === gen && page.scrollGeneration === scrollGen) await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {});
        });
      }
    }
    return result;
  });
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (!state.opened || !state.selected) return next(e);
    const disclosure = controlFor(state.selected).iconActions?.get(e.element);
    if (disclosure && e.data?.action === disclosure.action) {
      if (disclosure.expanded === e.data.expanded) await disclosure.onPress(e);
      return {};
    }
    if (e.element !== `codex_action_${state.selected}` || e.data?.action !== 'activate') return next(e);
    await controlFor(state.selected).actions?.activate();
    return {};
  });
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    await $.state.get(PANE_REVISION);
    return renderPane($, e, next);
  });
}
function renderPane($, e, next, attempt = {}) {
    if (e.requestId !== PANE) return next(e);
    const budget = nativeRenderBudget($.ui.resolve(e), { copy: text => $.ui.copy({ text, surface: e.surface }) });
    const { Box, Text, Button, Input, Markdown, Image, Code, Svg, Client } = budget.ui, id = state.selected;
    const selected = state.agents.find((agent) => idOf(agent) === id);
    if (!selected) return Box({ key: 'codex_recovery', flexDirection: 'column', gap: 'sm', children: [Text({ size: 'caption', dimColor: true, children: [state.error || '重新读取代理列表以恢复对话。'] }), Button({ key: 'codex_retry', variant: 'secondary', label: '重新读取', onPress: () => openAgent($, state.requested) })] });
    const page = pageFor(id), control = controlFor(id);
    control.iconActions = new Map();
    const view = timelineWindow(page, attempt.count, attempt.start), entries = view.entries;
    const rows = [], navigation = [], composer = [];
    const caption = (key, value) => Text({ key, size: 'caption', dimColor: true, children: [safe(value)] });
    const hint = (key, child, label, width = 18, left = 0) => Box({ key, position: 'relative', alignSelf: 'center', children: [child, Box({ position: 'absolute', bottom: 1, left, width, display: 'none', hover: { display: 'flex' }, children: [Text({ size: 'caption', inverse: true, children: [label] })] })] });
    const iconFor = (key, icon) => e.surface === 'desktop' && typeof Svg === 'function' ? Svg({ key, source: icon.source, alt: icon.alt, width: 14, height: 14, ...(icon.animated ? { isInteractive: true } : {}) }) : caption(key, icon.glyph);
    const agentMark = (key, agentId) => {
      const visual = agentVisual(agentId);
      return e.surface === 'desktop' && typeof Svg === 'function' ? Svg({ key, source: visual.source, alt: visual.alt, width: 16, height: 16 }) : caption(key, agentIcon(agentId));
    };
    const iconButton = (key, { source, label, onPress, action = 'activate', expanded = false, width = 2, height = 1, size = 12 }) => {
      control.iconActions.set(key, { action, expanded, onPress });
      return Box({ key: `icon_region_${key}`, position: 'relative', width, height, flexShrink: 0, children: [
        Box({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', children: [Svg({ key: `icon_${key}`, source, alt: label, width: size, height: size })] }),
        Box({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, children: [Client({ key, module: './icon-control.js', width, height, props: { expanded, action, rows: height } })] }),
      ] });
    };
    const disclosure = (key, label, onPress, entry, integration = false, expanded) => {
      const activate = entry ? (...args) => {
        page.scrollGeneration++; holdWindow(page); page.windowAnchor = entryKey(entry);
        // Request the reading anchor without blocking the visible disclosure.
        $.ui.scroll({ in: PANE, to: { key: `row_${key}` }, block: 'nearest' }).catch(() => {});
        return onPress(...args);
      } : onPress;
      const vector = typeof expanded === 'boolean' && e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function';
      const button = Button({ key, plain: true, dimColor: true, label: `${label}${typeof expanded === 'boolean' && !vector ? ` ${expanded ? '⌄' : '›'}` : ''}`, onPress: activate });
      const children = [button];
      if (vector) {
        const hitKey = `chevron_${key}`;
        children.push(iconButton(hitKey, { source: disclosureIcon(expanded), label: expanded ? '收起' : '展开', onPress: activate, action: 'toggle', expanded }));
      }
      return entry ? Box({ key: `row_${key}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [iconFor(`icon_${key}`, activityIcon(entry, integration)), ...children] }) : button;
    };
    const sourceCode = (key, source) => {
      const value = safe(source);
      let language = 'text';
      if (/^\s*[\[{]/.test(value)) { try { JSON.parse(value); language = 'json'; } catch { /* Opaque tool text stays plain text. */ } }
      return typeof Code === 'function' ? Code({ key, source: value, language, format: 'source', wrap: 'wrap' }) : Text({ key, mono: true, size: 'caption', children: [value] });
    };
    const stopStatus = selected?.user_control_status;
    // Keep handler identity stable across activity updates. Typing updates the
    // draft without invalidating the pane or the host conversation.
    control.actions ??= {
      stop: () => stopAgent($, id), attach: () => chooseAttachments($, id), paste: () => chooseAttachments($, id, 'clipboard'),
      input: (value) => { const wasEmpty = !control.draft.trim(); control.draft = value; if (wasEmpty !== !value.trim()) return invalidate($); },
      submit: (value) => {
        control.draft = value;
        return sendAgent($, id);
      },
      activate: () => {
        const agent = state.agents.find((item) => idOf(item) === id);
        if (control.stopping || agent?.user_control_status === 'stopping') return;
        if (!control.draft.trim() && !control.attachments.length && interruptible(agent)) return stopAgent($, id);
        return sendAgent($, id);
      },
    };
    const canStop = interruptible(selected);
    const friendlyModel = displayLabel(selected?.model, 256).replace(/^gpt-([\d.]+)-(.+)$/, (_all, version, name) => `GPT-${version} ${name.split('-').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')}`);
    const rawEffort = displayLabel(selected?.reasoning_effort, 64);
    const effort = rawEffort ? rawEffort[0].toUpperCase() + rawEffort.slice(1) : '';
    const model = [friendlyModel, effort].filter(Boolean).join(' · ');
    navigation.push(Box({ key: `codex_title_row_${id}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [agentMark(`codex_title_icon_${id}`, id), Text({ key: `codex_title_${id}`, size: 'body', weight: 'semibold', children: [safe(displayLabel(selected.name || 'Codex'))] })] }));
    if (state.error) navigation.push(caption('codex_open_error', state.error));
    if (state.error || page.liveError || page.historyError) {
      if (page.liveError) navigation.push(caption('codex_update_error', page.liveError));
      if (page.historyError) navigation.push(caption('codex_history_error', page.historyError));
      navigation.push(disclosure('codex_retry_conversation', '重新读取', async () => { if (state.error) return openAgent($, id); if (page.cursor && page.historyError) return history($, id); page.historyChecked = false; await poll($); }));
    }
    for (const group of groupEntries(entries)) {
      const first = group.items[0], groupKey = `${id}:${entryKey(first)}:group`, folded = !state.folds.has(groupKey);
      const groupRows = [], rowGap = e.surface === 'desktop' ? 0.7 : 'sm';
      const groupBox = (children) => Box({ key: `activity_group_${id}:${entryKey(first)}`, flexDirection: 'column', rowGap, minWidth: 0, children });
      if (group.items.length > 1 || group.integration) {
        const groupLabel = group.integration ? `已使用 ${safe(group.integration)} 集成` : group.type === 'webSearch' ? '搜索' : safe(description(first)).slice(0, 120);
        groupRows.push(disclosure(`group_${groupKey}`, `${groupLabel}${!group.integration ? ` (${group.items.length})` : ''}`, () => { toggle(groupKey); return invalidate($); }, first, Boolean(group.integration), !folded));
        if (folded) { rows.push(groupBox(groupRows)); continue; }
      }
      const itemRows = [];
      for (const entry of group.items) {
        if (['collabAgentToolCall', 'collabToolCall', 'subAgentActivity'].includes(entry.type)) {
          const d = entry.data || {}, target = d.agentThreadId || d.agent_id || d.agentId || d.agents?.[0]?.id || d.receiverThreadIds?.[0] || d.name || d.names?.[0] || entry.id;
          const waiting = d.tool === 'wait';
          itemRows.push(Box({ key: `activity_${id}:${entryKey(entry)}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [waiting ? iconFor(`wait_icon_${id}:${entryKey(entry)}`, activityIcon(entry)) : agentMark(`agent_icon_${id}:${entryKey(entry)}`, target), caption(`activity_label_${id}:${entryKey(entry)}`, description(entry))] }));
          continue;
        }
        if (entry.type === 'contextCompaction') { itemRows.push(Box({ key: `activity_${id}:${entryKey(entry)}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [iconFor(`icon_${id}:${entryKey(entry)}`, activityIcon(entry)), caption(`activity_label_${id}:${entryKey(entry)}`, description(entry))] })); continue; }
        const key = `${id}:${entryKey(entry)}`, expanded = state.folds.has(key);
        if (['agentMessage', 'userMessage', 'parentMessage', 'directUserMessage', 'plan'].includes(entry.type)) {
          const loaded = detailFor(page, entry);
          const message = [];
          if (['userMessage', 'parentMessage'].includes(entry.type)) message.push(caption(`author_${key}`, 'Claude'));
          const incoming = ['userMessage', 'parentMessage', 'directUserMessage'].includes(entry.type);
          const text = safe(loaded?.text ?? body(entry));
          message.push(incoming ? Text({ key: `message_${key}`, size: 'body', children: [text] }) : Markdown({ key: `message_${key}`, text: e.surface === 'desktop' ? normalizeDisplayMath(text) : text }));
          const attachments = Array.isArray(entry.data?.attachments) ? entry.data.attachments : Array.isArray(entry.data?.content) ? entry.data.content.filter((part) => ['localImage', 'mention'].includes(part?.type)) : [];
          if (attachments.length) message.push(caption(`attachments_${key}`, attachments.map((part) => `附件：${part?.name || (typeof part?.path === 'string' ? part.path.split(/[\\/]/).at(-1) : '') || '文件'}`).join('  ')));
          if (loaded?.offset > 0) message.push(disclosure(`message_prev_${key}`, '上一页正文', () => detail($, id, entry, Math.max(0, loaded.offset - 16000))));
          if (!String(entry.id).startsWith('action:') && ((!loaded && (entry.deferred || (entry.preview?.length ?? 0) >= 4096)) || loaded?.next_offset != null)) message.push(disclosure(`item_${key}`, loaded ? '下一页正文' : '展开全文', () => { state.folds.add(key); return detail($, id, entry, loaded?.next_offset ?? 0); }));
          const content = Box({ key: `message_content_${key}`, flexDirection: 'column', gap: 'sm', ...(incoming ? { alignSelf: 'flex-end', minWidth: 0, borderStyle: 'round', borderDimColor: true, padding: 1, ...(e.surface === 'desktop' ? { backgroundColor: 'rgba(128,128,128,0.08)' } : {}) } : { width: '100%', paddingY: e.surface === 'desktop' ? 0.8 : 1 }), children: message });
          const bounded = incoming ? Box({ key: `message_limit_${key}`, width: '85%', flexDirection: 'column', alignItems: 'flex-end', children: [content] }) : content;
          itemRows.push(Box({ key: `message_container_${key}`, flexDirection: 'row', justifyContent: incoming ? 'flex-end' : 'flex-start', children: [bounded] }));
          continue;
        }
        const fileList = entry.data?.fileSummary?.length ? entry.data.fileSummary : entry.data?.changes;
        if (entry.type === 'fileChange' && Array.isArray(fileList) && fileList.length) {
          fileList.forEach((change, index) => {
            const fileKey = `${key}:file:${index}`, open = state.folds.has(fileKey);
            const diff = entry.data?.changes?.find((item) => item.path === change.path)?.diff ?? change.diff;
            const filePath = typeof change.path === 'string' ? change.path : '';
            const deferred = entry.deferred || typeof diff !== 'string' || diff.length >= 4096 || diff.includes('[truncated]');
            itemRows.push(disclosure(`file_${fileKey}`, changeLabel(change), () => {
              toggle(fileKey);
              if (open) page.detailRequests.delete(detailKey(entry, filePath));
              else if (deferred && !detailFor(page, entry, filePath)) return detail($, id, entry, 0, fileKey, filePath, true);
              return invalidate($);
            }, entry, false, open));
            if (open) {
              const loaded = detailFor(page, entry, filePath);
              const source = safe((loaded && !loaded.error ? loaded.text : diff) ?? '请查看完整内容');
              const complete = !loaded ? !deferred : !loaded.error && loaded.offset === 0 && loaded.next_offset == null && loaded.format !== 'source';
              const copy = (press = {}) => $.ui.copy({ text: source, surface: press.surface ?? e.surface });
              const copyControl = e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function'
                ? hint(`diff_copy_hint_${fileKey}`, iconButton(`diff_copy_${fileKey}`, { source: copyIcon, label: '复制差异', size: 14, onPress: copy }), '复制差异', 12, -10)
                : Button({ key: `diff_copy_${fileKey}`, plain: true, label: '⧉', onPress: copy });
              const diffView = e.surface === 'desktop' && complete ? renderDiff({ Box, Text, Button }, { key: `file_diff_${fileKey}`, source, path: filePath, page: page.diffPages?.get(fileKey) ?? 0, copyControl, onPage: (value) => {
                page.diffPages ??= new Map(); page.diffPages.set(fileKey, value);
                if (page.diffPages.size > 64) page.diffPages.delete(page.diffPages.keys().next().value);
                return invalidate($);
              } }) : null;
              itemRows.push(diffView ?? (typeof Code === 'function' ? Code({ key: `file_code_${fileKey}`, source, ...(filePath ? { path: filePath.split(/[\\/]/).at(-1) } : {}), ...(Number.isSafeInteger(loaded?.startLine) && loaded.startLine > 0 ? { startLine: loaded.startLine } : {}), format: complete && isUnifiedDiff(source) ? 'diff' : 'source', wrap: 'wrap' }) : Text({ key: `file_code_${fileKey}`, mono: true, size: 'caption', children: [source] })));
              if (loaded?.error) itemRows.push(caption(`file_error_${fileKey}`, loaded.text));
              if (loaded?.offset > 0) itemRows.push(disclosure(`file_prev_${fileKey}`, '上一页输出', () => detail($, id, entry, Math.max(0, loaded.offset - 16000), fileKey, filePath)));
              if (!page.detailRequests.has(detailKey(entry, filePath)) && !String(entry.id).startsWith('action:') && ((!loaded && deferred) || loaded?.error || loaded?.next_offset != null)) itemRows.push(disclosure(`file_detail_${fileKey}`, loaded?.error ? '重试获取内容' : loaded ? '下一页输出' : '获取更多', () => detail($, id, entry, loaded?.error ? loaded.offset : loaded?.next_offset ?? 0, fileKey, filePath)));
            }
          });
          continue;
        }
        const toolStart = itemRows.length;
        itemRows.push(disclosure(`item_${key}`, safe(description(entry)).slice(0, 120), async () => {
          toggle(key); if (expanded) page.detailRequests.delete(detailKey(entry));
          if (!expanded && entry.deferred && outputTypes.has(entry.type) && !detailFor(page, entry)) return detail($, id, entry, 0, key, undefined, true);
          await invalidate($);
        }, entry));
        if (expanded) {
          const loaded = detailFor(page, entry), loading = page.detailRequests.has(detailKey(entry));
          const sections = toolSections(entry);
          const output = loaded && !loaded.error ? [{ label: '输出', source: loaded.text }] : sections.filter((section) => ['输出', '错误'].includes(section.label));
          const raw = sections.filter((section) => !['输出', '错误'].includes(section.label));
          const contents = loaded?.error ? [caption(`tool_error_${key}`, loaded.text)] : output.filter((section) => section.source).map((section, index) => sourceCode(`tool_source_${key}:${index}`, section.source));
          if (!contents.length && !loading) contents.push(sections.length || loaded ? caption(`tool_empty_${key}`, '暂无输出') : sourceCode(`tool_source_${key}`, body(entry)));
          if (raw.length) {
            const rawKey = `${key}:raw`;
            const rawToggle = Box({ key: `tool_raw_row_${key}`, flexDirection: 'row', children: [hint(`tool_raw_hover_${key}`, disclosure(`tool_raw_${key}`, '‹/›', () => { toggle(rawKey); return invalidate($); }), state.folds.has(rawKey) ? '收起原始调用' : '显示原始调用', 16)] });
            contents.splice(0, contents.length, Box({ key: `tool_output_${key}`, flexDirection: 'column', gap: 0, children: [...contents, rawToggle] }));
            if (state.folds.has(rawKey)) raw.forEach((section, index) => contents.push(...(section.compact ? [caption(`tool_status_${key}:${index}`, section.source)] : [caption(`tool_label_${key}:${index}`, section.label), sourceCode(`tool_raw_source_${key}:${index}`, section.source)])));
          }
          itemRows.push(Box({ key: `tool_content_${key}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 0.7 : 'sm', paddingX: 1, children: contents }));
          const imagePath = entry.data?.path || entry.data?.savedPath || entry.data?.saved_path;
          const localImage = typeof imagePath === 'string' && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(imagePath);
          if (['imageView', 'imageGeneration'].includes(entry.type) && localImage) {
            if (typeof Image === 'function' && /\.png$/i.test(imagePath)) itemRows.push(Image({ key: `image_${key}`, source: { file: imagePath, format: 'png' }, columns: 48, rows: 18, alt: `图片：${safe(imagePath)}` }));
            itemRows.push(disclosure(`copy_${key}`, '复制图片路径', press => $.ui.copy({ text: imagePath, surface: press.surface })));
          }
          if (loaded?.offset > 0) itemRows.push(disclosure(`detail_prev_${key}`, '上一页输出', () => detail($, id, entry, Math.max(0, loaded.offset - 16000))));
          const truncated = entry.deferred || (entry.preview?.length ?? 0) >= 4096 || entry.preview?.includes('[truncated]') || JSON.stringify(entry.data || {}).includes('[truncated]');
          if (!String(entry.id).startsWith('action:') && !loading && ((!loaded && truncated) || loaded?.error || loaded?.next_offset != null)) itemRows.push(disclosure(`detail_${key}`, loaded?.error ? '重试' : loaded ? '更多输出' : '获取更多', () => detail($, id, entry, loaded?.error ? loaded.offset : loaded?.next_offset ?? 0)));
        }
        itemRows.push(Box({ key: `tool_entry_${key}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 0.5 : 'sm', children: itemRows.splice(toolStart) }));
      }
      if (group.integration) {
        // Native Box dimensions use cells or percentages, not CSS unit strings.
        const line = e.surface === 'desktop' ? Box({ key: `integration_line_${groupKey}`, position: 'absolute', top: 0, bottom: 0, left: 0, width: 0.125, backgroundColor: 'rgba(128,128,128,0.18)', children: [] }) : null;
        groupRows.push(Box({ key: `integration_${groupKey}`, position: 'relative', flexDirection: 'column', rowGap, paddingLeft: 1, children: [...(line ? [line] : []), ...itemRows] }));
      } else groupRows.push(...itemRows);
      rows.push(groupBox(groupRows));
    }
    if (control.attachments.length) composer.push(Box({ key: `codex_attachments_${id}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', children: control.attachments.map((path, index) => Box({ key: `attachment_hover_${id}_${index}`, position: 'relative', children: [disclosure(`attachment_${id}_${index}`, `${safe(attachmentName(path, index))} ×`, () => { control.attachments = control.attachments.filter((_, i) => i !== index); control.attachmentVersion++; return invalidate($); }), Box({ position: 'absolute', top: -2, left: 0, width: 40, display: 'none', hover: { display: 'flex' }, children: [Text({ size: 'caption', inverse: true, children: [safe(displayLabel(path.split(/[\\/]/).at(-1) || path))] })] })] })) }));
    if (control.pathEntry) composer.push(Input({ key: `attachment_path_${id}_${control.attachmentVersion}`, label: '文件路径', placeholder: '输入文件的绝对路径', submitLabel: '添加', onSubmit: (path) => { addAttachments(control, [path]); control.pathEntry = false; return invalidate($); } }));
    if (control.attachmentNotice) composer.push(caption(`codex_attachment_notice_${id}`, control.attachmentNotice));
    composer.push(Box({ key: `codex_input_${id}`, flexDirection: 'column', width: '100%', alignItems: 'stretch', children: [Input({ key: `codex_message_${id}_${control.inputVersion}`, placeholder: '给代理发送消息', value: control.draft, rows: 3, ...(e.surface === 'desktop' ? {} : { submitLabel: '发送' }), onInput: control.actions.input, onSubmit: control.actions.submit })] }));
    const permission = ({ 'full-access': '完全访问', 'auto-review': '自动审查', ask: '需要批准' })[selected?.permissions_mode];
    const used = selected?.context_used_tokens, limit = selected?.context_limit_tokens;
    const context = contextIndicator(used, limit);
    const paste = hint(`codex_paste_hover_${id}`, Button({ key: `codex_paste_${id}`, plain: true, dimColor: true, label: '📎︎', onPress: control.actions.paste }), '粘贴图片或文件');
    const attach = hint(`codex_attach_hover_${id}`, Button({ key: `codex_attach_${id}`, plain: true, dimColor: true, label: control.picking ? '…' : '+', onPress: control.actions.attach }), '添加文件', 12);
    const left = [Box({ key: `codex_attachment_actions_${id}`, flexDirection: 'row', alignItems: 'center', gap: 0, children: [attach, paste] }), ...(permission ? [caption(`codex_permissions_${id}`, permission)] : [])];
    const stopping = canStop && !control.draft.trim() && !control.attachments.length;
    const disabled = control.stopping || stopStatus === 'stopping' || (!stopping && (control.sending || (!control.draft.trim() && !control.attachments.length)));
    const action = e.surface === 'desktop' && typeof Client === 'function' ? Client({ key: `codex_action_${id}`, module: './action-control.js', width: 3, height: 2, props: { mode: stopping ? 'stop' : 'send', disabled, label: stopStatus === 'stopping' ? '正在停止' : stopping ? '停止' : '发送' } }) : Button({ key: `codex_action_${id}`, plain: true, label: control.sending || control.stopping || stopStatus === 'stopping' ? '…' : stopping ? '■' : '↑', onPress: control.actions.activate });
    const metadata = [...(context ? [e.surface === 'desktop' && typeof Svg === 'function' ? hint(`codex_context_hover_${id}`, Svg({ key: `codex_context_${id}`, source: context.source, alt: context.alt, width: 16, height: 16 }), context.alt, 24, -11) : caption(`codex_context_${id}`, context.glyph)] : []), ...(model ? [caption(`codex_model_${id}`, model)] : [])];
    const right = [Box({ key: `codex_composer_metadata_${id}`, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 'xs', children: metadata }), action];
    composer.push(Box({ key: `codex_composer_footer_${id}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', ...(e.surface === 'desktop' ? { marginTop: 'xs' } : {}), justifyContent: 'space-between', alignItems: 'center', children: [Box({ key: `codex_composer_left_${id}`, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 'xs', children: left }), Box({ key: `codex_composer_right_${id}`, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 'xs', children: right })] }));
    if (control.stopping || stopStatus === 'stopping' || stopStatus === 'stopped') composer.push(caption(`codex_stop_status_${id}`, control.stopping || stopStatus === 'stopping' ? '正在停止…' : '已停止'));
    if (stopStatus === 'unconfirmed') composer.push(caption(`codex_stop_notice_${id}`, '停止状态未确认，工作可能仍在进行。'));
    if (control.sendResult) composer.push(caption(`codex_send_result_${id}`, control.sendResult));
    const bodyRows = e.surface === 'desktop' ? e.props?.scroll?.bodyRows : undefined;
    const fillPane = Number.isFinite(bodyRows) && bodyRows > 0;
    const jump = async () => {
      const gen = state.generation; page.followTail = true; page.awayFromBottom = false; page.scrollGeneration++; page.windowAnchor = null; page.windowEnd = null; page.windowSize = VISIBLE_ENTRIES;
      await invalidate($);
      $.clock.after(0, async () => { if (state.opened && state.selected === id && state.generation === gen) await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {}); });
    };
    const overlay = [];
    const offset = e.props?.scroll?.offset;
    if (page.awayFromBottom && fillPane && Number.isFinite(offset) && typeof Svg === 'function' && typeof Client === 'function') {
      // Pane re-queries on scroll; use its viewport coordinates, no scroll timer.
      overlay.push(Box({ key: `codex_jump_position_${id}`, position: 'absolute', top: Math.max(0, Math.floor(offset + bodyRows - 3)), left: 0, width: '100%', flexDirection: 'row', justifyContent: 'center', children: [iconButton(`codex_jump_${id}`, { source: jumpIcon, label: '回到最新消息', size: 32, width: 4, height: 2, onPress: jump })] }));
    } else if (page.awayFromBottom && e.surface !== 'desktop') composer.push(Button({ key: `codex_jump_${id}`, plain: true, label: '↓ 最新消息', onPress: jump }));
    const timeline = Box({ key: `codex_timeline_${id}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 1 : 'md', minWidth: 0, ...(fillPane ? { flexGrow: 1 } : {}), children: rows });
    const root = content => Box({ key: 'codex_conversation', position: 'relative', flexDirection: 'column', gap: 'lg', ...(fillPane ? { minHeight: bodyRows } : {}), children: [Box({ key: 'codex_navigation', flexDirection: 'column', gap: 'sm', children: navigation }), ...content, Box({ key: `codex_composer_${id}`, flexDirection: 'column', flexShrink: 0, ...(e.surface === 'desktop' ? { gap: 0 } : { gap: 'sm', borderStyle: 'round', borderDimColor: true, padding: 1 }), children: composer }), ...overlay] });
    let tree = root([timeline]);
    if (!budget.fits(tree) && entries.length > 1) {
      const count = Math.max(1, Math.floor(entries.length / 2));
      const anchor = page.windowAnchor && page.timeline.findIndex(entry => entryKey(entry) === page.windowAnchor);
      const start = page.windowEnd != null ? Math.max(0, page.windowEnd - count) : Number.isInteger(anchor) && anchor >= view.start && anchor < view.start + entries.length
        ? Math.max(view.start, Math.min(anchor - Math.floor(count / 2), view.start + entries.length - count)) : view.start;
      return renderPane($, e, next, { count, start });
    }
    // An expanded entry can contain several individually paged files. Page the
    // displayed tree as well so their combined size cannot exhaust the host.
    if (!budget.fits(tree) && entries.length === 1) {
      const parts = budget.pages(timeline), key = entryKey(entries[0]);
      page.contentPages ??= new Map();
      const current = Math.max(0, Math.min(page.contentPages.get(key) ?? 0, parts.length - 1));
      const turn = value => { page.contentPages.set(key, value); return invalidate($); };
      const pager = Box({ key: `content_pages_${id}:${key}`, flexDirection: 'row', gap: 'sm', children: [
        ...(current > 0 ? [Button({ key: `content_prev_${id}:${key}`, plain: true, label: '上一页内容', onPress: () => turn(current - 1) })] : []),
        caption(`content_page_${id}:${key}`, `内容 ${current + 1} / ${parts.length}`),
        ...(current + 1 < parts.length ? [Button({ key: `content_next_${id}:${key}`, plain: true, label: '下一页内容', onPress: () => turn(current + 1) })] : []),
      ] });
      tree = root([parts[current], pager]);
    }
    page.windowStart = view.start; page.windowSize = attempt.count ?? page.windowSize ?? VISIBLE_ENTRIES; page.windowEnd = null;
    return tree;
}
export function closeUI() { state.opened = false; state.generation++; state.timer?.cancel(); state.timer = null; state.pages.clear(); state.controls.clear(); state.folds.clear(); state.scroll.clear(); state.agents = []; state.selected = null; state.requested = null; state.error = ''; clearIcons(); }
export async function observeUI($, result) {
    if (!Array.isArray(result?.agents)) return;
    const before = JSON.stringify(state.agents);
    state.agents = mergeSummaries(result.agents);
    const ids = new Set(state.agents.map(idOf));
    retainIcons([...ids], state.agents.filter((agent) => active(agent) || agent.status === 'unknown').map(idOf));
    for (const id of state.controls.keys()) if (!ids.has(id)) state.controls.delete(id);
    for (const id of state.pages.keys()) if (!ids.has(id)) {
      state.pages.delete(id); state.scroll.delete(id);
      for (const key of state.folds) if (key.startsWith(`${id}:`)) state.folds.delete(key);
    }
    if (state.opened && before !== JSON.stringify(state.agents)) await invalidate($);
}

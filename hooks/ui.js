import { requestBridge as bridge, pickFiles, pasteAttachments } from './bridge.js';
import { agentIcon, retainIcons, clearIcons } from './presentation.js';
import { toolSections } from './tool-presentation.js';

const PANE = 'codex_subagent_activity';
const PANE_REVISION = { plugin: 'codex-subagents', key: 'paneRevision' };
let paneRevision = 0;
const MAX_PAGES = 50;
const safe = (value) => String(value).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
const idOf = (agent) => agent.agent_id || agent.id;
const summaries = (agents) => agents.map((agent) => ({ agent_id: idOf(agent), name: agent.name, model: agent.model, reasoning_effort: agent.reasoning_effort, permissions_mode: agent.permissions_mode, context_used_tokens: agent.context_used_tokens, context_limit_tokens: agent.context_limit_tokens, status: agent.status, user_paused: agent.user_paused, user_control_status: agent.user_control_status }));
const entryKey = (entry) => `${entry.turn_id || ''}:${entry.id}`;
const groupable = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
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
  return action ? `${action}：${name}` : `${name}已更新`;
}
function changeLabel(change) {
  const diff = typeof change.diff === 'string' && change.diff.length < 4096 && !change.diff.includes('[truncated]') ? change.diff : null;
  const lines = diff === null ? [] : diff.split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const hasCounts = Number.isInteger(change.added) && Number.isInteger(change.removed);
  return `✎ 已编辑 ${safe(change.path || '文件')}${hasCounts ? ` +${change.added} -${change.removed}` : lines.length ? ` +${added} -${removed}` : ''}`;
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
  if (entry.type === 'contextCompaction') return d.stage === 'started' ? '上下文正在压缩' : d.stage === 'completed' ? '上下文已压缩' : '上下文压缩记录';
  if (entry.type === 'subAgentActivity') return `${d.name || d.agentPath || '子代理'}${({ started: '开始工作', interacted: '已互动', interrupted: '已停止', completed: '已完成' })[d.kind] || '已更新'}`;
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
const state = { agents: [], selected: null, opened: false, timer: null, pages: new Map(), controls: new Map(), folds: new Set(), scroll: new Map(), restore: false, generation: 0 };
let actionSequence = 0;
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
  control.stopping = true; control.stopEpoch++; control.mutationEpoch++; updateAgent(id, { user_control_status: 'stopping' }); invalidate($);
  try {
    const result = await bridge($, 'ui_interrupt', { target: id }, { requestId: actionId() });
    const status = result.user_control_status ?? result.status;
    const known = ['stopping', 'stopped', 'unconfirmed'].includes(status);
    if (state.controls.get(id) === control) updateAgent(id, { ...(typeof result.user_paused === 'boolean' ? { user_paused: result.user_paused } : known ? { user_paused: true } : {}), user_control_status: known ? status : 'unconfirmed' });
  } catch { if (state.controls.get(id) === control) updateAgent(id, { user_control_status: 'unconfirmed' }); }
  finally { control.stopping = false; if (state.opened && state.selected === id) invalidate($); }
}
async function sendAgent($, id) {
  const control = controlFor(id), message = control.draft, attachments = [...control.attachments], attachmentVersion = control.attachmentVersion, stopEpoch = control.stopEpoch;
  const selected = state.agents.find((agent) => idOf(agent) === id);
  if (control.sending || control.stopping || selected?.user_control_status === 'stopping' || (!message.trim() && !attachments.length)) return;
  control.sending = true; control.mutationEpoch++; control.sendResult = '发送中…'; invalidate($);
  try {
    const result = await bridge($, 'ui_send', { target: id, message, ...(attachments.length ? { attachments: attachments.map((path) => ({ path })) } : {}) }, { requestId: actionId() });
    if (result.error || result.offline) {
      control.sendResult = result.offline || result.error?.code === 'action_status_unknown' ? '发送状态未知，请查看活动后再试。' : `发送失败：${safe(result.error?.message || result.error).slice(0, 600)}。草稿已保留。`;
    } else if (result.agent_id === id && typeof result.status === 'string') {
      control.sendResult = result.status === 'steered' || result.user_paused || control.stopEpoch !== stopEpoch ? '消息已发送。' : '消息已发送，代理继续工作。';
      if (control.draft === message) { control.draft = ''; control.inputVersion++; }
      if (control.attachmentVersion === attachmentVersion) { control.attachments = []; control.attachmentVersion++; }
      if (state.controls.get(id) === control && control.stopEpoch === stopEpoch) updateAgent(id, { ...(Object.hasOwn(result, 'user_paused') ? { user_paused: result.user_paused } : {}), ...(Object.hasOwn(result, 'user_control_status') ? { user_control_status: result.user_control_status } : {}), ...(result.status !== 'steered' ? { status: result.status } : {}) });
    } else control.sendResult = '发送状态未知，请查看活动后再试。';
  } catch (error) { control.sendResult = `发送状态未知：${safe(error?.message || error).slice(0, 600)}。请查看活动后再试，草稿已保留。`; }
  finally { control.sending = false; if (state.opened && state.selected === id) invalidate($); }
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
  control.picking = true; control.attachmentNotice = ''; invalidate($);
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
  finally { control.picking = false; if (state.opened && state.selected === id) invalidate($); }
}
  const pageFor = (id) => {
    if (!state.pages.has(id)) state.pages.set(id, { mode: 'live', entries: [], live: [], revision: undefined, cursor: null, cursorStack: [], stackTruncated: false, loaded: false, busy: false, historyGeneration: 0, detailGeneration: 0, detail: null });
    const page = state.pages.get(id); state.pages.delete(id); state.pages.set(id, page);
    while (state.pages.size > 16) {
      const old = state.pages.keys().next().value; state.pages.delete(old); state.scroll.delete(old);
      for (const key of state.folds) if (key.startsWith(`${old}:`)) state.folds.delete(key);
    }
    return page;
  };
  const toggle = (key) => { if (!state.folds.delete(key)) { state.folds.add(key); if (state.folds.size > 512) state.folds.delete(state.folds.values().next().value); } };
  const reading = (id, page) => page.live.some((entry) => {
    const key = `${id}:${entryKey(entry)}`;
    return state.folds.has(key) || state.folds.has(`${key}:group`) || [...state.folds].some((fold) => fold.startsWith(`${key}:file:`));
  });
  function invalidate($) {
    // Reading this key in the pane renderer subscribes only that render site.
    // Event-wide invalidation also rebuilds the host conversation's tool rows.
    void $.state.set(PANE_REVISION, ++paneRevision).catch(() => {});
  }
  async function poll($) {
    const id = state.selected, gen = state.generation;
    if (!state.opened || !id) return;
    const page = pageFor(id), control = controlFor(id), mutationEpoch = control.mutationEpoch;
    if (page.busy) return;
    page.busy = true;
    try {
      const result = await bridge($, 'ui_revision', { target: id, revision: page.revision });
      if (!state.opened || state.selected !== id || state.generation !== gen || result.error || result.offline) return;
      const changed = result.agent && control.mutationEpoch === mutationEpoch && !control.stopping && !control.sending && updateAgent(id, result.agent);
      if (result.entries && result.revision !== page.revision && (page.mode !== 'live' || !reading(id, page))) {
        if (page.mode !== 'live') page.hasNew = true;
        page.revision = result.revision; page.live = result.entries;
        invalidate($);
      } else if (changed) invalidate($);
    } finally { page.busy = false; }
  }
  async function history($, id, direction = 'latest') {
    const page = pageFor(id), gen = state.generation, request = ++page.historyGeneration;
    if (page.mode === 'live') { page.mode = 'history'; page.entries = []; page.cursor = null; page.cursorStack = []; page.stackTruncated = false; page.loaded = false; invalidate($); }
    let stack = direction === 'older' ? [...page.cursorStack, page.cursor] : direction === 'newer' ? page.cursorStack.slice(0, -1) : [];
    let truncated = direction === 'latest' ? false : page.stackTruncated;
    if (direction === 'older' && !page.cursor) return;
    if (stack.length > MAX_PAGES) { stack = stack.slice(-MAX_PAGES); truncated = true; }
    const cursor = stack.at(-1);
    try {
      const result = await bridge($, 'ui_history', { target: id, ...(cursor ? { cursor } : {}) });
      if (!state.opened || state.selected !== id || state.generation !== gen || request !== page.historyGeneration) return;
      if (result.error || result.offline) throw new Error('无法获取历史记录');
      page.mode = 'history'; page.entries = result.entries || []; page.cursorStack = stack; page.stackTruncated = truncated; page.detail = null;
      page.cursor = result.next_cursor; page.loaded = true; page.error = null; invalidate($);
    } catch (error) { if (state.opened && state.selected === id && state.generation === gen && request === page.historyGeneration) { page.error = String(error.message || error); invalidate($); } }
  }
  async function select($, id) {
    state.selected = id; state.generation++; state.restore = true;
    const page = pageFor(id);
    if (page.mode === 'live') void poll($).catch(() => {});
    else if (!page.loaded) void history($, id);
    invalidate($);
  }
  export async function openAgent($, id) {
    state.opened = true; const gen = ++state.generation;
    try {
      const list = await bridge($, 'ui_list', {});
      if (!state.opened || state.generation !== gen) return;
      if (Array.isArray(list.agents)) state.agents = summaries(list.agents);
    } catch { /* The selected agent's history can still be opened. */ }
    if (!state.opened || state.generation !== gen) return;
    await select($, id);
    const selectedGen = state.generation;
    const result = await $.ui.open({ id: PANE, title: 'Codex 代理', focus: true, closeOnEscape: true, rows: 24 });
    if (!state.opened || state.generation !== selectedGen) return;
    if (result.isPlaced === false) { state.opened = false; state.generation++; return; }
    if (state.restore) void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {});
    if (!state.timer) state.timer = $.clock.every(1000, () => { void poll($).catch(() => {}); });
  }
  async function detail($, id, entry, offset = 0, foldKey = `${id}:${entryKey(entry)}`, filePath) {
    const page = pageFor(id), key = entryKey(entry), gen = state.generation, historyGen = page.historyGeneration, request = ++page.detailGeneration;
    const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, offset, ...(filePath !== undefined ? { file_path: filePath } : {}) });
    if (state.selected !== id || !state.opened || state.generation !== gen || page.historyGeneration !== historyGen || request !== page.detailGeneration || !state.folds.has(foldKey)) return;
    if (result.error || result.offline) page.detail = { key, filePath, text: '无法获取完整内容', error: true, next_offset: null, offset };
    else page.detail = { key, filePath, text: result.text || '', next_offset: result.next_offset, offset, format: result.format, startLine: result.start_line };
    invalidate($);
  }
export function registerUI(on) {
  on('command.run', { command: 'codex-agents' }, async ($) => {
    try {
      const result = await bridge($, 'ui_list', {});
      if (result.error || result.offline) { $.ui.toast('无法获取 Codex 代理。'); return {}; }
      const agents = Array.isArray(result.agents) ? result.agents : [];
      if (!agents.length) { $.ui.toast('当前会话没有 Codex 代理。'); return {}; }
      state.agents = summaries(agents);
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
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person' && state.selected) state.scroll.set(state.selected, e.offset);
    if (e.origin.kind === 'plugin' && state.restore) { state.restore = false; return next({ ...e, offset: state.scroll.get(state.selected) || 0 }); }
    return next(e);
  });
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    await $.state.get(PANE_REVISION);
    return renderPane($, e, next);
  });
}
function renderPane($, e, next) {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Button, Input, Markdown, Image, Code } = $.ui.resolve(e), id = state.selected, page = pageFor(id), control = controlFor(id);
    const all = page.mode === 'history' ? page.entries : page.live;
    // The action gives immediate feedback while native history catches up. Once
    // the same message is persisted, retain the native copy for pagination.
    const nativeMessages = (type) => all.filter((entry) => entry.type === type && !String(entry.id).startsWith('action:')).map(body);
    const nativeParent = nativeMessages('userMessage'), nativeUser = nativeMessages('directUserMessage');
    const entries = all.filter((entry) => !String(entry.id).startsWith('action:') || !['parentMessage', 'directUserMessage'].includes(entry.type) || !(entry.type === 'parentMessage' ? nativeParent : nativeUser).some((text) => entry.data?.text && text.includes(entry.data.text)));
    const rows = [], navigation = [], composer = [];
    const caption = (key, value) => Text({ key, size: 'caption', dimColor: true, children: [safe(value)] });
    const disclosure = (key, label, onPress) => Button({ key, plain: true, label, children: [caption(`${key}:label`, label)], onPress });
    const sourceCode = (key, source) => typeof Code === 'function' ? Code({ key, source: safe(source), format: 'source', wrap: 'wrap' }) : Text({ key, mono: true, size: 'caption', children: [safe(source)] });
    const selected = state.agents.find((a) => idOf(a) === id);
    const stopStatus = selected?.user_control_status;
    // Keep handler identity stable across activity updates. Typing updates the
    // draft without invalidating the pane or the host conversation.
    control.actions ??= {
      stop: () => stopAgent($, id), attach: () => chooseAttachments($, id), paste: () => chooseAttachments($, id, 'clipboard'),
      input: (value) => { const wasEmpty = !control.draft.trim(); control.draft = value; if (wasEmpty !== !value.trim()) invalidate($); },
      submit: (value) => {
        control.draft = value;
        const agent = state.agents.find((item) => idOf(item) === id);
        if (!value.trim() && !control.attachments.length && interruptible(agent)) return stopAgent($, id);
        return sendAgent($, id);
      },
    };
    const canStop = interruptible(selected);
    const model = [selected?.model, selected?.reasoning_effort].filter(Boolean).join(' · ');
    navigation.push(Text({ key: `codex_title_${id}`, size: 'body', weight: 'semibold', children: [`${agentIcon(id)} ${safe(selected?.name || id || 'Codex')}`] }));
    if (page.mode === 'live' || page.cursor) navigation.push(disclosure('codex_older', '更早消息', () => history($, id, page.mode === 'live' ? 'latest' : 'older')));
    if (page.error) navigation.push(caption('codex_history_error', page.error));
    for (const group of groupEntries(entries)) {
      const first = group.items[0], groupKey = `${id}:${entryKey(first)}:group`, folded = !state.folds.has(groupKey);
      if (group.items.length > 1 || group.integration) {
        const groupLabel = group.integration ? `已使用 ${safe(group.integration)} 集成` : group.type === 'webSearch' ? '搜索' : safe(description(first)).slice(0, 120);
        rows.push(disclosure(`group_${groupKey}`, `${groupLabel}${!group.integration ? ` (${group.items.length})` : ''} ${folded ? '▸' : '▾'}`, () => { toggle(groupKey); invalidate($); }));
        if (folded) continue;
      }
      const itemRows = [];
      for (const entry of group.items) {
        if (['collabAgentToolCall', 'collabToolCall', 'subAgentActivity'].includes(entry.type)) {
          const d = entry.data || {}, target = d.agentThreadId || d.agent_id || d.agentId || d.agents?.[0]?.id || d.receiverThreadIds?.[0] || d.name || d.names?.[0] || entry.id;
          itemRows.push(caption(`activity_${id}:${entryKey(entry)}`, `${agentIcon(target)} ${description(entry)}`));
          continue;
        }
        if (entry.type === 'contextCompaction') { itemRows.push(caption(`activity_${id}:${entryKey(entry)}`, description(entry))); continue; }
        const key = `${id}:${entryKey(entry)}`, expanded = state.folds.has(key);
        if (['agentMessage', 'userMessage', 'parentMessage', 'directUserMessage', 'plan'].includes(entry.type)) {
          const loaded = page.detail?.key === entryKey(entry) ? page.detail : null;
          const message = [];
          if (['userMessage', 'parentMessage'].includes(entry.type)) message.push(caption(`author_${key}`, 'Claude'));
          const incoming = ['userMessage', 'parentMessage', 'directUserMessage'].includes(entry.type);
          const text = safe(loaded?.text ?? body(entry));
          message.push(incoming ? Text({ key: `message_${key}`, size: 'body', children: [text] }) : Markdown({ key: `message_${key}`, text }));
          const attachments = Array.isArray(entry.data?.attachments) ? entry.data.attachments : Array.isArray(entry.data?.content) ? entry.data.content.filter((part) => ['localImage', 'mention'].includes(part?.type)) : [];
          if (attachments.length) message.push(caption(`attachments_${key}`, attachments.map((part) => `附件：${part?.name || (typeof part?.path === 'string' ? part.path.split(/[\\/]/).at(-1) : '') || '文件'}`).join('  ')));
          if (loaded?.offset > 0) message.push(disclosure(`message_prev_${key}`, '上一页正文', () => detail($, id, entry, Math.max(0, loaded.offset - 16000))));
          if (!String(entry.id).startsWith('action:') && ((!loaded && (entry.deferred || (entry.preview?.length ?? 0) >= 4096)) || loaded?.next_offset != null)) message.push(disclosure(`item_${key}`, loaded ? '下一页正文' : '展开全文', () => { state.folds.add(key); return detail($, id, entry, loaded?.next_offset ?? 0); }));
          const content = Box({ key: `message_content_${key}`, flexDirection: 'column', gap: 'sm', ...(incoming ? { width: '85%', borderStyle: 'round', borderDimColor: true, padding: 1 } : { width: '100%', paddingY: 1 }), children: message });
          itemRows.push(Box({ key: `message_container_${key}`, flexDirection: 'row', justifyContent: incoming ? 'flex-end' : 'flex-start', children: [content] }));
          continue;
        }
        const fileList = entry.data?.fileSummary?.length ? entry.data.fileSummary : entry.data?.changes;
        if (entry.type === 'fileChange' && Array.isArray(fileList) && fileList.length) {
          fileList.forEach((change, index) => {
            const fileKey = `${key}:file:${index}`, open = state.folds.has(fileKey);
            itemRows.push(disclosure(`file_${fileKey}`, `${changeLabel(change)} ${open ? '▾' : '▸'}`, () => { toggle(fileKey); invalidate($); }));
            const diff = entry.data?.changes?.find((item) => item.path === change.path)?.diff ?? change.diff;
            if (open) {
              const filePath = typeof change.path === 'string' ? change.path : '';
              const loaded = page.detail?.key === entryKey(entry) && page.detail.filePath === filePath ? page.detail : null;
              const source = safe((loaded && !loaded.error ? loaded.text : diff) ?? '请查看完整内容');
              const complete = !loaded || loaded.error || (loaded.offset === 0 && loaded.next_offset == null && loaded.format !== 'source');
              itemRows.push(typeof Code === 'function' ? Code({ key: `file_code_${fileKey}`, source, ...(filePath ? { path: filePath } : {}), ...(Number.isSafeInteger(loaded?.startLine) && loaded.startLine > 0 ? { startLine: loaded.startLine } : {}), format: complete && isUnifiedDiff(source) ? 'diff' : 'source', wrap: 'wrap' }) : Text({ key: `file_code_${fileKey}`, mono: true, size: 'caption', children: [source] }));
              if (loaded?.error) itemRows.push(caption(`file_error_${fileKey}`, loaded.text));
              if (filePath) itemRows.push(disclosure(`file_copy_path_${fileKey}`, '复制文件路径', press => $.ui.copy({ text: filePath, surface: press.surface })));
              if ((loaded && !loaded.error && loaded.text) || diff) itemRows.push(disclosure(`file_copy_diff_${fileKey}`, '复制当前差异', press => $.ui.copy({ text: loaded && !loaded.error ? loaded.text : diff, surface: press.surface })));
              if (loaded?.offset > 0) itemRows.push(disclosure(`file_prev_${fileKey}`, '上一页输出', () => detail($, id, entry, Math.max(0, loaded.offset - 16000), fileKey, filePath)));
              const deferred = entry.deferred || !diff || diff.length >= 4096 || diff.includes('[truncated]');
              if (!String(entry.id).startsWith('action:') && ((!loaded && deferred) || loaded?.error || loaded?.next_offset != null)) itemRows.push(disclosure(`file_detail_${fileKey}`, loaded?.error ? '重试获取内容' : loaded ? '下一页输出' : '获取更多', () => detail($, id, entry, loaded?.error ? loaded.offset : loaded?.next_offset ?? 0, fileKey, filePath)));
            }
          });
          continue;
        }
        itemRows.push(disclosure(`item_${key}`, `${safe(description(entry)).slice(0, 120)} ${expanded ? '▾' : '▸'}`, () => { toggle(key); if (expanded) page.detailGeneration++; invalidate($); }));
        if (expanded) {
          const loaded = page.detail?.key === entryKey(entry) ? page.detail : null;
          const sections = loaded ? [{ label: '输出', source: loaded.text }] : toolSections(entry);
          const output = sections.filter((section) => ['输出', '错误'].includes(section.label));
          const raw = sections.filter((section) => !['输出', '错误'].includes(section.label));
          const contents = output.map((section, index) => sourceCode(`tool_source_${key}:${index}`, section.source));
          if (!contents.length) contents.push(sections.length ? caption(`tool_empty_${key}`, '暂无输出') : sourceCode(`tool_source_${key}`, body(entry)));
          if (raw.length) {
            const rawKey = `${key}:raw`;
            contents.push(disclosure(`tool_raw_${key}`, `‹/› 原始调用 ${state.folds.has(rawKey) ? '▾' : '▸'}`, () => { toggle(rawKey); invalidate($); }));
            if (state.folds.has(rawKey)) raw.forEach((section, index) => contents.push(...(section.compact ? [caption(`tool_status_${key}:${index}`, section.source)] : [caption(`tool_label_${key}:${index}`, section.label), sourceCode(`tool_raw_source_${key}:${index}`, section.source)])));
          }
          itemRows.push(Box({ key: `tool_content_${key}`, flexDirection: 'column', gap: 'sm', paddingX: 1, children: contents }));
          const imagePath = entry.data?.path || entry.data?.savedPath || entry.data?.saved_path;
          const localImage = typeof imagePath === 'string' && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(imagePath);
          if (['imageView', 'imageGeneration'].includes(entry.type) && localImage) {
            if (typeof Image === 'function' && /\.png$/i.test(imagePath)) itemRows.push(Image({ key: `image_${key}`, source: { file: imagePath, format: 'png' }, columns: 48, rows: 18, alt: `图片：${safe(imagePath)}` }));
            itemRows.push(disclosure(`copy_${key}`, '复制图片路径', press => $.ui.copy({ text: imagePath, surface: press.surface })));
          }
          if (loaded?.offset > 0) itemRows.push(disclosure(`detail_prev_${key}`, '上一页输出', () => detail($, id, entry, Math.max(0, loaded.offset - 16000))));
          const truncated = entry.deferred || (entry.preview?.length ?? 0) >= 4096 || JSON.stringify(entry.data || {}).includes('[truncated]');
          if (!String(entry.id).startsWith('action:') && ((!loaded && truncated) || loaded?.next_offset != null)) itemRows.push(disclosure(`detail_${key}`, loaded ? '下一页输出' : '获取更多', () => detail($, id, entry, loaded?.next_offset ?? 0)));
        }
      }
      if (group.integration) rows.push(Box({ key: `integration_${groupKey}`, flexDirection: 'column', gap: 'sm', paddingX: 1, children: itemRows }));
      else rows.push(...itemRows);
    }
    if (page.mode !== 'live') rows.push(Button({ key: 'codex_latest', variant: 'secondary', label: '↓', onPress: () => { page.mode = 'live'; page.hasNew = false; page.historyGeneration++; page.detail = null; void poll($).catch(() => {}); invalidate($); void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {}); } }));
    if (control.attachments.length) composer.push(Box({ key: `codex_attachments_${id}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', children: control.attachments.map((path, index) => disclosure(`attachment_${id}_${index}`, `${safe(path.split(/[\\/]/).at(-1) || path)} ×`, () => { control.attachments = control.attachments.filter((_, i) => i !== index); control.attachmentVersion++; invalidate($); })) }));
    if (control.pathEntry) composer.push(Input({ key: `attachment_path_${id}_${control.attachmentVersion}`, label: '文件路径', placeholder: '输入文件的绝对路径', submitLabel: '添加', onSubmit: (path) => { addAttachments(control, [path]); control.pathEntry = false; invalidate($); } }));
    if (control.attachmentNotice) composer.push(caption(`codex_attachment_notice_${id}`, control.attachmentNotice));
    composer.push(Input({ key: `codex_message_${id}_${control.inputVersion}`, placeholder: '给代理发送消息', value: control.draft, rows: 3, submitLabel: control.sending ? '…' : control.stopping || stopStatus === 'stopping' ? '…' : canStop && !control.draft.trim() && !control.attachments.length ? '■' : '↑', onInput: control.actions.input, onSubmit: control.actions.submit }));
    const permission = ({ 'full-access': '完全访问', 'auto-review': '自动审查', ask: '需要批准' })[selected?.permissions_mode];
    const used = selected?.context_used_tokens, limit = selected?.context_limit_tokens;
    const context = Number.isFinite(used) && used >= 0 && Number.isFinite(limit) && limit > 0 ? `上下文 ${Math.round(used / limit * 100)}%` : '';
    const paste = Box({ key: `codex_paste_hover_${id}`, position: 'relative', children: [Button({ key: `codex_paste_${id}`, plain: true, label: '粘贴图片或文件', children: [caption(`codex_paste_icon_${id}`, '📋')], onPress: control.actions.paste }), Box({ position: 'absolute', top: -2, left: 0, width: 20, display: 'none', hover: { display: 'flex' }, children: [Text({ size: 'caption', inverse: true, children: ['粘贴图片或文件'] })] })] });
    const footer = [Button({ key: `codex_attach_${id}`, plain: true, label: '添加文件', children: [caption(`codex_attach_icon_${id}`, control.picking ? '…' : '+')], onPress: control.actions.attach }), paste, ...(permission ? [caption(`codex_permissions_${id}`, permission)] : []), ...(context ? [caption(`codex_context_${id}`, context)] : []), ...(model ? [caption(`codex_model_${id}`, model)] : [])];
    composer.push(Box({ key: `codex_composer_footer_${id}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', alignItems: 'center', children: footer }));
    if (control.stopping || stopStatus === 'stopping' || stopStatus === 'stopped') composer.push(caption(`codex_stop_status_${id}`, control.stopping || stopStatus === 'stopping' ? '正在停止…' : '已停止'));
    if (stopStatus === 'unconfirmed') composer.push(caption(`codex_stop_notice_${id}`, '停止状态未确认，工作可能仍在进行。'));
    if (control.sendResult) composer.push(caption(`codex_send_result_${id}`, control.sendResult));
    return Box({ key: 'codex_conversation', flexDirection: 'column', gap: 'lg', children: [Box({ key: 'codex_navigation', flexDirection: 'column', gap: 'sm', children: navigation }), Box({ key: `codex_timeline_${id}`, flexDirection: 'column', gap: 'md', minWidth: 0, children: rows }), Box({ key: `codex_composer_${id}`, flexDirection: 'column', gap: 'sm', borderStyle: 'round', borderDimColor: true, padding: 1, children: composer })] });
}
export function closeUI() { state.opened = false; state.generation++; state.timer?.cancel(); state.timer = null; state.pages.clear(); state.controls.clear(); state.folds.clear(); state.scroll.clear(); state.agents = []; state.selected = null; clearIcons(); }
export function observeUI($, result) {
    if (!Array.isArray(result?.agents)) return;
    const before = JSON.stringify(state.agents);
    state.agents = summaries(result.agents);
    const ids = new Set(state.agents.map(idOf));
    retainIcons([...ids], state.agents.filter((agent) => active(agent) || agent.status === 'unknown').map(idOf));
    for (const id of state.controls.keys()) if (!ids.has(id)) state.controls.delete(id);
    for (const id of state.pages.keys()) if (!ids.has(id)) {
      state.pages.delete(id); state.scroll.delete(id);
      for (const key of state.folds) if (key.startsWith(`${id}:`)) state.folds.delete(key);
    }
    if (state.opened && before !== JSON.stringify(state.agents)) invalidate($);
}

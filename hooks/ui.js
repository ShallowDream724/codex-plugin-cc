import { requestBridge as bridge, pickFiles, pasteAttachments } from './bridge.js';
import { agentIcon, agentVisual, retainIcons, clearIcons, displayLabel, agentDisplayName } from './presentation.js';
import { toolSections, communicationFailure } from './tool-presentation.js';
import { activityIcon, contextIndicator, disclosureIcon, copyIcon, copiedIcon, copyFailedIcon, jumpIcon } from './tool-icons.js';
import { normalizeMessageMarkdown } from './message-markdown.js';
import { orderWaits } from '../shared/activity-order.mjs';
import { renderDiff } from './diff-view.js';
import { fileChangeSummary, fileChangeSource } from '../shared/file-changes.mjs';
import { nativeRenderBudget } from './render-budget.js';
import { paneScroll } from './pane-scroll.js';
import { planHistoryWindow } from './history-window.js';

const PANE = 'codex_subagent_activity';
const PANE_REVISION = { plugin: 'codex-subagents', key: 'paneRevision' };
let paneRevision = 0;
const MAX_DETAILS = 16;
// Candidate safety cap only; actual visible content is chosen by render cost.
const VISIBLE_ENTRIES = 400;
const RAW_WINDOW_LIMIT = 400;
const MAX_COPY_LENGTH = 16 * 1024 * 1024;
const MAX_COPY_PAGES = 1100;
let copyIntent = 0;
const copyLabels = { pending: '正在复制…', copied: '已复制', failed: '复制失败，请重试' };
const safe = (value) => String(value).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
const idOf = (agent) => agent.agent_id || agent.id;
const summaries = (agents) => agents.map((agent) => ({ agent_id: idOf(agent), ...Object.fromEntries(['name', 'model', 'reasoning_effort', 'context_source', 'permissions_mode', 'context_used_tokens', 'context_limit_tokens', 'status', 'user_paused', 'user_control_status'].filter((key) => Object.hasOwn(agent, key)).map((key) => [key, agent[key]])) }));
const entryKey = (entry) => `${entry.turn_id || ''}:${entry.id}`;
const detailKey = (entry, filePath, view) => JSON.stringify([entryKey(entry), filePath ?? null, ...(view ? [view] : [])]);
const detailFor = (page, entry, filePath, view) => page.details.get(detailKey(entry, filePath, view));
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
function imageSize(image, bodyColumns, maxColumns = 24, maxRows = 10) {
  const available = Number.isFinite(bodyColumns) && bodyColumns > 0 ? Math.max(1, Math.floor(bodyColumns) - 4) : maxColumns;
  const limit = Math.max(1, Math.min(255, maxColumns, available));
  const aspect = Number.isFinite(image.width) && image.width > 0 && Number.isFinite(image.height) && image.height > 0 ? image.height / image.width : 0.75;
  const columns = Math.max(1, Math.min(limit, Math.floor(maxRows * 2 / aspect)));
  return { columns, rows: Math.max(1, Math.min(255, maxRows, Math.round(columns * aspect / 2))) };
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
  const name = [data.name, ...(Array.isArray(data.names) ? data.names : [])].filter(Boolean).map(agentDisplayName).join('、') || '子代理';
  const statuses = Array.isArray(data.agents) ? data.agents.map((agent) => agent?.status) : Array.isArray(data.agent_statuses) ? data.agent_statuses : typeof data.agent_status === 'string' ? [data.agent_status] : [];
  if (statuses.length && statuses.every((status) => status === 'completed')) return `${name}已完成`;
  if (data.tool === 'spawnAgent' || data.tool === 'followupTask' || data.tool === 'resumeAgent') return `${name}${data.stage === 'started' ? '正在启动' : '开始工作'}`;
  const action = { wait: '等待子代理', sendInput: '发送消息', sendMessage: '发送消息', interruptAgent: '请求停止', closeAgent: '关闭子代理', listAgents: '查看子代理' }[data.tool];
  return action ? `${action}${name === '子代理' ? '' : `：${name}`}` : `${name}已更新`;
}
function changeLabel(change) {
  const hasCounts = Number.isInteger(change.added) && Number.isInteger(change.removed);
  const filename = path => safe(typeof path === 'string' ? path.split(/[\\/]/).at(-1) : '文件');
  const name = filename(change.path), move = typeof change.move_path === 'string' ? ` → ${filename(change.move_path)}` : '';
  const verb = { add: '已创建', delete: '已删除', update: '已编辑' }[change.kind] || '已更改';
  return `${verb} ${name}${move}${hasCounts ? ` +${change.added} -${change.removed}` : ''}`;
}
const description = (entry) => {
  const d = entry.data || {};
  if (typeof entry.communication?.title === 'string' && entry.communication.title.trim()) return entry.communication.title;
  if (entry.type === 'parentMessage') return 'Claude';
  if (entry.type === 'directUserMessage') return 'User';
  if (entry.type === 'userMessage') return d.message_origin === 'parent' ? 'Claude' : '消息';
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
    return `${agentDisplayName(name)} ${({ started: '开始工作', interacted: '已互动', interrupted: '已停止', completed: '已完成' })[d.kind] || '已更新'}`;
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
  const all = page.navigationTimeline ?? (page.timeline ??= conversationEntries(page.live)), lastStart = Math.max(0, all.length - count);
  const anchor = page.windowAnchor ? all.findIndex(entry => entryKey(entry) === page.windowAnchor) : -1;
  // Budget retries shrink the count and pass the previous start. In tail mode
  // recalculate from the end for each retry, unless an expanded item is held.
  const preferred = page.followTail && anchor < 0 ? lastStart : (from ?? (page.followTail ? Math.max(0, Math.min(anchor - Math.floor(count / 2), lastStart)) : page.windowStart));
  const start = Math.max(0, Math.min(preferred, Math.max(0, all.length - 1)));
  return { entries: all.slice(start, page.windowEnd != null && !page.followTail ? Math.min(page.windowEnd, start + count) : start + count), start, total: all.length };
}
function drawnWindow(page) { return page.renderedWindow && page.renderedWindow.timeline === (page.navigationTimeline ?? page.timeline) ? page.renderedWindow : timelineWindow(page); }
function holdWindow(page) {
  const view = drawnWindow(page);
  page.windowStart = view.start; page.windowEnd = view.start + view.entries.length;
  page.windowSize = Math.max(1, view.entries.length); page.followTail = false;
}
const historyKey = (id, page) => `codex_history_${id}_${page.layoutRevision ?? 0}`;
const tailKey = (id, token) => `codex_tail_${id}_${token || 0}`;
let navigationSequence = 0;
let geometryPulse = false;
async function refreshPaneGeometry($, page) {
  if (page.surface !== 'desktop') return;
  // Desktop caches contentRows/keyed outside the props hash. A new tree with
  // unchanged scroll/size otherwise leaves the backend on the previous layout.
  // Retitle the same pane without changing its visible text or keyboard focus;
  // this public props update refreshes geometry without nudging the viewport.
  geometryPulse = !geometryPulse;
  await $.ui.open({ id: PANE, title: geometryPulse ? 'Codex ' : 'Codex', closeOnEscape: true, rows: 24 });
  await new Promise(resolve => $.clock.after(16, resolve));
}
function scrollPane($, args, valid = () => true, controller = null, observe = null) {
  const id = state.selected, generation = state.generation;
  const request = { controller, observe, restore: state.restore, valid: () => state.opened && state.selected === id && state.generation === generation && valid() };
  const run = async () => {
    if (!request.valid()) return { deny: 'obsolete navigation' };
    state.programmaticScroll = request;
    try {
      const result = await $.ui.scroll({ in: PANE, ...args });
      if (!result?.deny && request.restore && request.valid()) state.restore = false;
      return result;
    }
    finally { if (state.programmaticScroll === request) state.programmaticScroll = null; }
  };
  const operation = (state.scrollQueue || Promise.resolve()).catch(() => {}).then(run);
  state.scrollQueue = operation.catch(() => {});
  return operation;
}
function cancelNavigation(page) {
  page.navigationOwner = null; page.navigationRequest = null;
  page.navigationTimeline = null; page.adding = null; page.navigating = false;
  page.layoutFloor = null;
  page.scroller?.cancel(); page.scroller = null; page.browseTimer?.cancel();
}
function requestTail($, id, placement = false) {
  const page = pageFor(id);
  page.tailRequest = { token: ++navigationSequence, generation: state.generation, scrollGeneration: page.scrollGeneration, placement };
  page.tailMarkerToken = page.tailRequest.token;
  return invalidate($);
}
async function requestHistoryNavigation($, id, direction) {
  const page = pageFor(id), generation = state.generation;
  if (page.navigating || state.imagePreview) return;
  if (page.boundaryBlocked === direction) return;
  if (page.navigationRequest?.direction === direction && page.navigationRequest.generation === generation) return;
  page.boundaryBlocked = direction;
  const request = { token: ++navigationSequence, direction, generation, scrollGeneration: page.scrollGeneration };
  page.navigationRequest = request; holdWindow(page);
  const current = () => state.opened && state.selected === id && state.generation === generation
    && page.navigationRequest === request && !state.imagePreview && !page.followTail;
  // Fetch outside the render/scroll dispatch. A slow history read must not
  // exhaust the host's hook deadline or hold the wheel event open.
  for (let scanned = 0; direction < 0 && drawnWindow(page).start === 0 && page.cursor && scanned < 16; scanned++) {
    await history($, id);
    if (!current()) return;
    if (page.historyError) break;
  }
  if (!current()) return;
  const view = drawnWindow(page);
  if (direction < 0 ? view.start === 0 : view.start + view.entries.length >= view.total) {
    page.navigationRequest = null;
    await invalidate($); return;
  }
  request.ready = true;
  await invalidate($);
}
function scrollController($, id, page) {
  if (page.scroller) return page.scroller;
  const controller = paneScroll({
    scroll: args => scrollPane($, args, () => !controller.disposed, controller), later: (ms, fn) => $.clock.after(ms, fn),
    valid: () => state.opened && state.selected === id && state.pages.get(id) === page,
    position: offset => state.scroll.set(id, offset),
    refresh: () => refreshPaneGeometry($, page),
  });
  return page.scroller = controller;
}
async function resizeWindow($, id, page, start, end, above, owner) {
  // Height differences must describe this navigation only. Polls may keep
  // merging into the data cache, but cannot append/resize a different record
  // in the middle of our two measured frames.
  page.navigationTimeline ??= page.timeline ??= conversationEntries(page.live);
  const scroller = scrollController($, id, page), gen = state.generation;
  const oldView = drawnWindow(page);
  const anchorGroup = above && start < oldView.start ? page.renderedGroups?.find(group => group.start === oldView.start) : null;
  const anchored = !!anchorGroup;
  if (anchored && page.measureAnchor !== anchorGroup.key) {
    page.measureAnchor = anchorGroup.key;
    await invalidate($);
  }
  const measurementKey = () => anchored ? `codex_read_anchor_${id}_${anchorGroup.key}` : historyKey(id, page);
  const before = await scroller.measure(measurementKey(), null, false, anchored);
  if (!before || !state.opened || state.selected !== id || gen !== state.generation || page.navigationOwner !== owner) return false;
  const expanded = new Set(groupEntries(drawnWindow(page).entries).flatMap(group => state.folds.has(`${id}:${entryKey(group.items[0])}:group`) ? group.items.map(entryKey) : []));
  for (const group of groupEntries(page.navigationTimeline.slice(start, end))) {
    if (group.items.some(entry => expanded.has(entryKey(entry)))) state.folds.add(`${id}:${entryKey(group.items[0])}:group`);
  }
  page.followTail = false; page.windowAnchor = null;
  page.windowStart = start; page.windowEnd = end; page.windowSize = Math.max(1, end - start);
  page.layoutRevision = (page.layoutRevision ?? 0) + 1;
  if (anchored || end > oldView.start + oldView.entries.length) page.layoutFloor = before.contentRows;
  scroller.stage(before, above, anchored);
  await invalidate($);
  const after = await scroller.measure(measurementKey(), before, above, anchored);
  if (page.navigationOwner === owner) page.layoutFloor = null;
  return !!after && state.opened && state.selected === id && gen === state.generation && page.navigationOwner === owner;
}
async function browseHistory($, id, direction) {
  const page = pageFor(id), gen = state.generation;
  if (page.navigating || state.imagePreview) return;
  const owner = {}; page.navigationOwner = owner;
  page.navigating = true; holdWindow(page);
  try {
    let view = drawnWindow(page);
    if (direction < 0 && view.start === 0 && page.cursor) {
      await history($, id);
      if (gen !== state.generation || state.selected !== id || page.navigationOwner !== owner) return;
      view = drawnWindow(page);
    }
    const available = () => direction < 0 ? view.start > 0 : view.start + view.entries.length < view.total;
    if (!available()) return;
    // Trim only the opposite, off-screen side, then measure that frame before
    // adding anything. Mixing a prepend and a tail eviction in one redraw
    // makes total-height compensation incorrect.
    if (view.entries.length > 1 && (view.entries.length >= 300 || page.renderCost?.chars > 48000 || page.renderCost?.nodes > 5500)) {
      const groups = (page.renderedGroups || []).filter(group => group.start >= view.start && group.end <= view.start + view.entries.length);
      const near = direction < 0 ? groups : [...groups].reverse();
      let chars = 0, nodes = 0, keep = 0;
      for (const group of near) {
        const count = group.end - group.start;
        if (keep && (chars + group.cost.chars > 36000 || nodes + group.cost.nodes > 3500 || keep + count > 200)) break;
        chars += group.cost.chars; nodes += group.cost.nodes; keep += count;
      }
      keep = Math.max(1, Math.min(200, keep || Math.ceil(view.entries.length / 2)));
      if (keep < view.entries.length) {
        const start = direction < 0 ? view.start : view.start + view.entries.length - keep;
        if (!await resizeWindow($, id, page, start, start + keep, direction > 0, owner)) return;
        view = drawnWindow(page);
      }
    }
    const end = view.start + view.entries.length;
    page.adding = { direction, start: view.start, end };
    await resizeWindow($, id, page, direction < 0 ? Math.max(0, end - RAW_WINDOW_LIMIT) : view.start, direction > 0 ? Math.min(view.total, view.start + RAW_WINDOW_LIMIT) : end, direction < 0, owner);
  } finally {
    if (page.navigationOwner !== owner) return;
    const previous = drawnWindow(page), first = previous.entries[0], last = previous.entries.at(-1);
    page.navigationTimeline = null; page.adding = null; page.navigating = false; page.navigationOwner = null;
    page.layoutFloor = null;
    page.edgeCooldownUntil = Date.now() + 150;
    if (!page.followTail && first && last) {
      const all = page.timeline ??= conversationEntries(page.live), start = all.findIndex(entry => entryKey(entry) === entryKey(first)), end = all.findIndex(entry => entryKey(entry) === entryKey(last));
      if (start >= 0 && end >= start) { page.windowStart = start; page.windowEnd = end + 1; page.windowSize = end - start + 1; }
    }
    if (state.opened && state.selected === id && gen === state.generation) void invalidate($);
  }
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
  for (const key of ['name', 'model', 'reasoning_effort', 'context_source', 'permissions_mode', 'context_used_tokens', 'context_limit_tokens', 'status', 'user_paused', 'user_control_status']) {
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
  const page = pageFor(id); cancelNavigation(page); page.scrollGeneration++;
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
      const result = await bridge($, 'ui_history', { target: id, limit: RAW_WINDOW_LIMIT, character_budget: 64000 });
      if (!state.opened || state.selected !== id || state.generation !== gen || page.historyGeneration !== historyGen) return;
      if (result.error || result.offline || !Array.isArray(result.entries)) throw new Error(failureText(result));
      const before = drawnWindow(page), first = before.entries[0] && entryKey(before.entries[0]);
      const changed = mergeLive(page, result.entries, true), cursorChanged = JSON.stringify(page.cursor) !== JSON.stringify(result.next_cursor ?? null);
      if (changed && !page.followTail && first) {
        const index = timelineWindow(page).total && page.timeline.findIndex(entry => entryKey(entry) === first);
        if (index >= 0) { const delta = index - before.start; page.windowStart += delta; if (page.windowEnd != null) page.windowEnd += delta; }
      }
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
    if (afterSend) { page.afterSendGeneration = gen; page.followTail = true; page.awayFromBottom = false; page.windowAnchor = null; page.windowEnd = null; page.windowSize = VISIBLE_ENTRIES; page.scrollGeneration++; page.afterSendScrollGeneration = page.scrollGeneration; }
    if (page.busy) { if (afterSend) page.refreshAfterPoll = true; return; }
    page.busy = true;
    try {
      const result = await bridge($, 'ui_revision', { target: id, revision: page.revision });
      if (!state.opened || state.selected !== id || state.generation !== gen) return;
      if (result.error || result.offline) throw new Error(failureText(result));
      const changed = result.agent && control.mutationEpoch === mutationEpoch && !control.stopping && !control.sending && updateAgent(id, result.agent);
      let dirty = changed || Boolean(page.liveError);
      page.liveError = '';
      let entriesChanged = false, appended = false; const hadRevision = page.revision !== undefined;
      if (result.entries && result.revision !== page.revision) {
        const known = new Set(page.live.map(entryKey));
        appended = result.entries.some(entry => !known.has(entryKey(entry)));
        entriesChanged = mergeLive(page, result.entries);
        page.revision = result.revision;
        dirty ||= entriesChanged;
      }
      if (appended && page.followTail) page.windowAnchor = null;
      if (dirty) await invalidate($);
      if (entriesChanged && hadRevision && page.followTail && !page.navigating && !page.scroller?.pending && !page.windowAnchor && page.afterSendGeneration === undefined && !state.imagePreview) {
        await requestTail($, id);
      }
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
        if (sentGeneration === gen && state.opened && state.selected === id && state.generation === gen && page.followTail && page.afterSendScrollGeneration === page.scrollGeneration && !state.imagePreview) await requestTail($, id);
      }
    }
  }
  function prefetchHistory($, id) {
    const page = pageFor(id), cursor = page.cursor, cursorKey = JSON.stringify(cursor);
    if (!cursor || !state.opened || state.selected !== id) return;
    const cache = page.historyPrefetches ??= new Map(), generation = state.generation;
    const start = value => {
      const key = JSON.stringify(value);
      if (!cache.has(key)) {
        cache.set(key, { promise: bridge($, 'ui_history', { target: id, cursor: value, limit: RAW_WINDOW_LIMIT, character_budget: 64000 }).catch(error => ({ error: { message: failureText(error) } })) });
        while (cache.size > 2) cache.delete(cache.keys().next().value);
      }
      return cache.get(key);
    };
    const entry = start(cursor);
    if (!entry.warmed) {
      entry.warmed = true;
      void entry.promise.then(result => {
        if (state.opened && state.selected === id && state.generation === generation && !result.error && result.next_cursor && JSON.stringify(result.next_cursor) !== cursorKey) start(result.next_cursor);
      });
    }
    return entry.promise;
  }
  function queueHistoryPrefetch($, id) {
    if (!pageFor(id).cursor) return;
    const gen = state.generation;
    $.clock.after(0, () => { if (state.opened && state.selected === id && state.generation === gen) prefetchHistory($, id); });
  }
  async function history($, id) {
    const page = pageFor(id), gen = state.generation, cursor = page.cursor;
    if (!cursor) return;
    if (page.historyLoading) return page.historyRequest?.promise;
    const scrollGen = page.scrollGeneration, request = {};
    request.promise = new Promise(resolve => { request.finish = resolve; });
    let continueHistory = false, changed = false, loaded = false;
    page.historyLoading = true; page.historyRequest = request;
    void invalidate($);
    try {
      const result = await prefetchHistory($, id);
      if (!state.opened || state.selected !== id || state.generation !== gen) return;
      page.historyPrefetches?.delete(JSON.stringify(cursor));
      if (result.error || result.offline || !Array.isArray(result.entries)) throw new Error(failureText(result));
      if (result.next_cursor && JSON.stringify(result.next_cursor) === JSON.stringify(cursor)) throw new Error('历史读取位置未推进');
      const previous = drawnWindow(page), first = previous.entries[0] && entryKey(previous.entries[0]);
      changed = mergeLive(page, result.entries, true);
      if (changed && !page.followTail && first) {
        timelineWindow(page);
        const index = page.timeline.findIndex(entry => entryKey(entry) === first);
        if (index >= 0) {
          const delta = index - previous.start;
          page.windowStart = previous.start + delta; page.windowEnd = previous.start + previous.entries.length + delta;
          page.windowSize = Math.max(1, previous.entries.length);
          if (page.renderedGroups) page.renderedGroups = page.renderedGroups.map(group => ({ ...group, start: group.start + delta, end: group.end + delta }));
        }
      } else if (changed && !page.followTail && !first) {
        // There was no readable anchor to preserve (for example a page of
        // filtered reasoning records). Do not retain an empty [0, 0) window.
        const count = Math.min(VISIBLE_ENTRIES, timelineWindow(page).total);
        page.windowStart = 0; page.windowEnd = count; page.windowSize = Math.max(1, count);
      }
      page.cursor = result.next_cursor ?? null; page.historyError = '';
      continueHistory = !changed && Boolean(page.cursor) && page.scrollGeneration === scrollGen;
      loaded = true;
    } catch (error) { if (state.opened && state.selected === id && state.generation === gen) page.historyError = `无法读取对话记录：${failureText(error)}。请重试。`; }
    finally {
      try {
        if (page.historyRequest === request) {
          page.historyLoading = false; page.historyRequest = null;
          if (state.opened && state.selected === id && state.generation === gen) {
            await invalidate($);
            if (loaded) queueHistoryPrefetch($, id);
            if (continueHistory && page.scrollGeneration === scrollGen) $.clock.after(0, () => history($, id));
          }
        }
      } finally { request.finish(); }
    }
  }
  async function select($, id) {
    const previous = state.pages.get(state.selected); if (previous) cancelNavigation(previous);
    state.selected = id; state.generation++; state.imagePreview = null;
    const page = pageFor(id); page.historyLoading = false; page.historyRequest = null;
    state.restore = state.scroll.has(id) && !page.followTail;
    page.detailRequests.clear();
    await poll($);
    await invalidate($);
  }
  async function showImagePreview($, id, preview) {
    if (!state.opened || state.selected !== id || !state.folds.has(preview.foldKey)) return;
    const page = pageFor(id); if (!page.followTail) holdWindow(page); cancelNavigation(page); page.scrollGeneration++;
    page.tailRequest = null;
    state.imagePreview = { ...preview, agentId: id, scrollOffset: state.scroll.get(id) || 0 }; await invalidate($);
  }
  async function closeImagePreview($, id) {
    const preview = state.imagePreview, gen = state.generation;
    if (!preview || preview.agentId !== id) return;
    const page = pageFor(id);
    state.imagePreview = null; state.restoringPreview = true;
    state.scroll.set(id, preview.scrollOffset); state.restore = true;
    page.layoutRevision = (page.layoutRevision || 0) + 1;
    try {
      await invalidate($);
      for (const delay of [0, 32, 64, 128]) {
        if (!state.opened || state.selected !== id || state.generation !== gen || !state.restore) break;
        if (delay) await new Promise(resolve => $.clock.after(delay, resolve));
        await refreshPaneGeometry($, page);
        await scrollPane($, { to: { key: historyKey(id, page) }, block: 'start' }).catch(() => {});
      }
    } finally { state.restoringPreview = false; }
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
    geometryPulse = false;
    if (result.isPlaced === false) { state.opened = false; state.generation++; return; }
    if (state.restore) await scrollPane($, { to: 'start' }).catch(() => {});
    else await requestTail($, state.selected, true);
    if (!state.timer) state.timer = $.clock.every(1000, () => poll($).catch(() => {}));
  }
  async function detail($, id, entry, offset = 0, foldKey = `${id}:${entryKey(entry)}`, filePath, background = false, view) {
    const page = pageFor(id), key = detailKey(entry, filePath, view), gen = state.generation, historyGen = page.historyGeneration, request = ++page.detailSequence;
    page.detailRequests.set(key, request);
    while (page.detailRequests.size > MAX_DETAILS) page.detailRequests.delete(page.detailRequests.keys().next().value);
    const fetch = async () => {
      if (request !== page.detailRequests.get(key) || state.selected !== id || !state.opened || state.generation !== gen || !state.folds.has(foldKey)) return;
      const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, offset, ...(filePath !== undefined ? { file_path: filePath } : view ? { view } : outputTypes.has(entry.type) ? { view: 'output' } : {}) }).catch((error) => ({ error: { message: failureText(error) } }));
      if (request !== page.detailRequests.get(key)) return;
      page.detailRequests.delete(key);
      if (state.selected !== id || !state.opened || state.generation !== gen || page.historyGeneration !== historyGen || !state.folds.has(foldKey)) return;
      if (result.error || result.offline || (result.next_offset != null && (!Number.isInteger(result.next_offset) || result.next_offset <= offset))) cacheDetail(page, key, { text: `无法读取内容：${result.error || result.offline ? failureText(result) : '读取位置未推进'}`, error: true, next_offset: null, offset });
      else cacheDetail(page, key, { text: result.text || '', next_offset: result.next_offset, previous_offset: result.previous_offset, rows: result.rows, offset, format: result.format, startLine: result.start_line });
      await invalidate($);
    };
    if (background) $.clock.after(0, fetch);
    await invalidate($);
    if (!background) await fetch();
  }
  async function copyWithFeedback($, id, key, surface, read) {
    const page = pageFor(id), gen = state.generation, intent = ++copyIntent;
    const valid = () => intent === copyIntent && state.opened && state.selected === id && state.generation === gen;
    page.copyFeedback = { key, phase: 'pending', intent, generation: gen };
    page.copyError = null;
    void invalidate($);
    try {
      const text = typeof read === 'function' ? await read(valid) : read;
      if (!valid() || typeof text !== 'string') return;
      const result = await $.ui.copy({ text, surface });
      if (result?.isCopied !== true) throw new Error(result?.reason || '剪贴板未确认复制成功');
      if (!valid()) return;
      page.copyFeedback = { key, phase: 'copied', intent, generation: gen };
      await invalidate($);
      $.clock.after(1600, async () => {
        if (!valid() || page.copyFeedback?.intent !== intent) return;
        page.copyFeedback = null;
        await invalidate($);
      });
    } catch (error) {
      if (valid()) {
        page.copyFeedback = { key, phase: 'failed', intent, generation: gen };
        page.copyError = { key, text: `复制失败：${failureText(error)}` };
        await invalidate($);
      }
    }
  }
  async function copyMessage($, id, entry, surface, view = 'message') {
    return copyWithFeedback($, id, entryKey(entry), surface, async valid => {
      let text = view === 'communication' ? entry.communication.text : body(entry);
      if (view === 'communication' ? entry.communication.truncated : entry.message?.truncated) {
        text = ''; let offset = 0, pages = 0;
        while (true) {
          if (++pages > MAX_COPY_PAGES) throw new Error('正文超过复制大小限制');
          const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, view, offset, bulk: true });
          if (!valid()) return;
          if (result.error || result.offline || typeof result.text !== 'string') throw new Error(failureText(result));
          text += result.text;
          if (text.length > MAX_COPY_LENGTH || (Number.isFinite(result.total_length) && result.total_length > MAX_COPY_LENGTH)) throw new Error('正文超过复制大小限制');
          if (result.next_offset == null) break;
          if (!Number.isSafeInteger(result.next_offset) || result.next_offset <= offset) throw new Error('读取位置未推进');
          offset = result.next_offset;
        }
      }
      return text;
    });
  }
  async function expandBody($, id, entry, view, foldKey) {
    const page = pageFor(id), key = detailKey(entry, undefined, view), gen = state.generation, historyGen = page.historyGeneration;
    if (page.detailRequests.has(key)) return;
    const request = ++page.detailSequence;
    page.detailRequests.set(key, request);
    while (page.detailRequests.size > MAX_DETAILS) page.detailRequests.delete(page.detailRequests.keys().next().value);
    await invalidate($);
    try {
      const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, view, expand: true, offset: 0 });
      if (page.detailRequests.get(key) !== request || !state.opened || state.selected !== id || state.generation !== gen || page.historyGeneration !== historyGen || !state.folds.has(foldKey)) return;
      if (result.error || result.offline || typeof result.text !== 'string' || (result.external && typeof result.file_url !== 'string')) throw new Error(failureText(result));
      cacheDetail(page, key, result);
    } catch (error) {
      if (page.detailRequests.get(key) === request && state.opened && state.selected === id && state.generation === gen && state.folds.has(foldKey)) cacheDetail(page, key, { error: true, text: `无法读取内容：${failureText(error)}` });
    } finally {
      if (page.detailRequests.get(key) === request) { page.detailRequests.delete(key); await invalidate($); }
    }
  }
  async function loadMedia($, id, entry, foldKey, offset = 0) {
    const page = pageFor(id), key = detailKey(entry, undefined, 'media'), gen = state.generation, historyGen = page.historyGeneration;
    if (page.detailRequests.has(key)) return;
    const request = ++page.detailSequence, previous = page.details.get(key);
    page.detailRequests.set(key, request);
    try {
      const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, view: 'media', offset });
      if (page.detailRequests.get(key) !== request || !state.opened || state.selected !== id || state.generation !== gen || page.historyGeneration !== historyGen || !state.folds.has(foldKey)) return;
      if (result.error || result.offline || !Array.isArray(result.images) || (result.next_offset != null && (!Number.isSafeInteger(result.next_offset) || result.next_offset <= offset))) throw new Error(failureText(result));
      cacheDetail(page, key, { images: result.images, offset, next_offset: result.next_offset, ...(typeof result.notice === 'string' ? { notice: result.notice } : {}) });
    } catch (error) {
      if (page.detailRequests.get(key) === request && state.opened && state.selected === id && state.generation === gen && state.folds.has(foldKey)) cacheDetail(page, key, { ...previous, error: `无法读取图片：${failureText(error)}`, retryOffset: offset });
    } finally {
      if (page.detailRequests.get(key) === request) { page.detailRequests.delete(key); await invalidate($); }
    }
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
    if (e.id === PANE) { state.opened = false; state.imagePreview = null; state.generation++; state.timer?.cancel(); state.timer = null; for (const page of state.pages.values()) { page.scroller?.cancel(); page.scroller = null; page.browseTimer?.cancel(); } }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    // Claude suppresses the registration that raised a nested event. Programmatic
    // measurements must therefore be observed by a DIFFERENT registration below.
    if (e.origin.kind !== 'person') return next(e);
    if (state.imagePreview || state.restoringPreview) return next(e);
    const id = state.selected;
    const page = id && pageFor(id), gen = state.generation;
    const oldGeometry = page?.scrollGeometry;
    if (page) page.scrollGeometry = { contentRows: e.contentRows, bodyRows: e.bodyRows };
    // Before the new tail marker is painted, native layout/clamping may emit
    // "person" scroll events. They cannot cancel the requested initial/jump
    // placement; after the first reveal, genuine upward input owns it again.
    const tail = page?.tailRequest;
    if (tail?.placement && (!tail.revealed || tail.geometry && (e.contentRows !== tail.geometry.contentRows || e.bodyRows !== tail.geometry.bodyRows))) return next(e);
    const view = page && drawnWindow(page);
    const atBottom = Number.isFinite(e.contentRows) && Number.isFinite(e.bodyRows) && e.offset >= e.contentRows - e.bodyRows - 1;
    const controller = page && scrollController($, id, page);
    const intent = controller?.intent, observed = controller?.observe(e);
    if (controller && controller.intent === intent) return next(observed);
    if (e.origin.kind === 'person' && id) {
      const wasFollowing = page.followTail;
      page.browseTimer?.cancel();
      page.tailRequest = null;
      if (page.navigationRequest && Math.sign(e.by) !== page.navigationRequest.direction) page.navigationRequest = null;
      state.scroll.set(id, e.offset); page.scrollGeneration++;
      const stableGeometry = !oldGeometry || oldGeometry.contentRows === e.contentRows && oldGeometry.bodyRows === e.bodyRows;
      if (!page.navigating && Date.now() >= (page.edgeCooldownUntil || 0) && stableGeometry) {
        const oldOffset = e.offset - e.by;
        if (page.boundaryBlocked === -1 && Math.max(e.offset, oldOffset) > 3 || page.boundaryBlocked === 1 && Math.min(e.offset, oldOffset) < e.contentRows - e.bodyRows - 3) {
          page.boundaryBlocked = null; page.lastEdgeRequest = null;
        }
      }
      page.windowAnchor = null;
      holdWindow(page);
      if (page.windowEnd == null) page.windowStart = view.start;
      // DOM resize/anchor adjustments also arrive as "person" scrolls on the
      // desktop. They may not re-enable following after an upward read.
      page.followTail = wasFollowing && e.by >= 0 && atBottom && view.start + view.entries.length >= view.total;
      page.awayFromBottom = !page.followTail;
    }
    // Return the wheel dispatch immediately. History, state writes and paint
    // barriers run outside the host's scroll request chain.
    if (e.origin.kind === 'person' && id && state.opened && !page.navigating && Date.now() >= (page.edgeCooldownUntil || 0)) {
      const threshold = Math.max(2, (e.bodyRows || 12) * 2);
      if (e.by < 0 && e.offset <= threshold && page.cursor) prefetchHistory($, id);
      const needsTrim = view.entries.length >= 300 || page.renderCost?.chars > 48000 || page.renderCost?.nodes > 5500;
      const earlier = page.boundaryBlocked !== -1 && e.by < 0 && e.offset <= (needsTrim ? 1 : threshold) && (view.start > 0 || page.cursor);
      const later = page.boundaryBlocked !== 1 && e.by > 0 && e.offset >= e.contentRows - e.bodyRows - (needsTrim ? 1 : threshold) && view.start + view.entries.length < view.total;
      if (earlier || later) {
        const scrollGen = page.scrollGeneration;
        page.browseTimer = $.clock.after(32, () => {
          if (state.opened && state.selected === id && gen === state.generation && scrollGen === page.scrollGeneration) return requestHistoryNavigation($, id, earlier ? -1 : 1);
        });
      }
    }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE, origin: { kind: 'plugin' } }, ($, e, next) => {
    const id = state.selected, page = id && pageFor(id);
    if (!page) return next(e);
    const transfer = state.programmaticScroll;
    if (transfer && !transfer.valid()) return next({ ...e, offset: state.scroll.get(id) ?? Math.max(0, e.offset - e.by) });
    page.scrollGeometry = { contentRows: e.contentRows, bodyRows: e.bodyRows };
    transfer?.observe?.(e);
    if (transfer?.controller?.pending) return next(transfer.controller.observe(e));
    if (page.scroller?.pending) return next(page.scroller.observe(e));
    if (state.restore) return next({ ...e, offset: state.scroll.get(id) || 0 });
    // A cancelled header measurement must never become an actual jump to top.
    if (e.offset === 0 && state.scroll.has(id)) return next({ ...e, offset: state.scroll.get(id) });
    if (state.imagePreview) return next(e);
    state.scroll.set(id, e.offset);
    return next(e);
  });
  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    const action = state.opened && state.controls.get(state.selected)?.navigationActions?.get(e.element);
    // Run navigation under this registered frame, rather than the Button's raw
    // callback origin (which suppresses every hook owned by this plugin).
    return action ? (await action(), {}) : next(e);
  });
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (!state.opened || !state.selected) return next(e);
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'edge') {
      const id = state.selected, page = pageFor(id), generation = state.generation;
      if (!e.data.token || e.data.token !== page.edgeKey || page.lastEdgeRequest === e.data.token || page.navigating || page.navigationRequest || page.tailRequest || state.imagePreview) return {};
      page.lastEdgeRequest = e.data.token;
      page.shortFillDone = true;
      const direction = e.data.direction === 1 ? 1 : -1;
      $.clock.after(0, () => { if (state.opened && state.selected === id && state.generation === generation) return requestHistoryNavigation($, id, direction); });
      return {};
    }
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'tail') {
      const id = state.selected, page = pageFor(id), request = page.tailRequest;
      if (!request || request.token !== e.data.token || request.generation !== state.generation || request.scrollGeneration !== page.scrollGeneration || !page.followTail || state.imagePreview) return {};
      // to:'end' also enables native followEnd(), which can pull a later upward
      // scroll back down. A keyed reveal is strictly a single movement.
      let previousGeometry = null, elapsed = 0;
      for (const delay of [0, 32, 64, 128]) {
        if (delay) await new Promise(resolve => $.clock.after(delay, resolve));
        elapsed += delay;
        if (state.selected !== id || page.tailRequest !== request || request.generation !== state.generation || request.scrollGeneration !== page.scrollGeneration || !page.followTail || state.imagePreview) break;
        await refreshPaneGeometry($, page);
        if (state.selected !== id || page.tailRequest !== request || !page.followTail) break;
        let geometry;
        const result = await scrollPane($, { to: { key: tailKey(id, request.token) }, block: 'end' }, () => page.tailRequest === request && request.scrollGeneration === page.scrollGeneration && page.followTail, null, event => {
          geometry = { contentRows: event.contentRows, bodyRows: event.bodyRows };
          request.geometry = geometry;
        }).catch(() => ({ deny: 'not painted' }));
        if (!result?.deny) {
          request.revealed = true;
          if (elapsed >= 96 && geometry && previousGeometry && geometry.contentRows === previousGeometry.contentRows && geometry.bodyRows === previousGeometry.bodyRows) break;
          previousGeometry = geometry;
        }
      }
      if (page.tailRequest === request) { page.tailRequest = null; await invalidate($); }
      return {};
    }
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'navigate') {
      const page = pageFor(state.selected), request = page.navigationRequest;
      if (!request?.ready || request.token !== e.data.token || request.generation !== state.generation) return {};
      page.navigationRequest = null;
      // surface.post creates a fresh registered dispatch. Timers and raw
      // callbacks can lose their originating registration after it returns,
      // which would suppress all our scroll observers. Keep this frame alive
      // until both measurements complete; never run a probe from a timer.
      await browseHistory($, state.selected, request.direction);
      return {};
    }
    const preview = controlFor(state.selected).imageActions?.get(e.element);
    if (preview && e.data?.action === 'preview' && state.folds.has(preview.foldKey) && !state.imagePreview) {
      await showImagePreview($, state.selected, preview); return {};
    }
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
function renderPane($, e, next) {
    if (e.requestId !== PANE) return next(e);
    // A native scroll already schedules a render. Reuse the entire transcript
    // and handler tree on those frames; only the small overlay wrapper moves.
    // No scroll timer, state write, Markdown parsing or list regrouping here.
    const currentPage = state.pages.get(state.selected);
    const frameKey = JSON.stringify([state.generation, paneRevision, e.surface, e.props?.bodyColumns, e.props?.scroll?.bodyRows, currentPage?.navigationRequest?.token, currentPage?.navigationRequest?.ready, currentPage?.tailRequest?.token]);
    const cached = state.pages.get(state.selected)?.renderCache;
    const draft = state.controls.get(state.selected)?.draft;
    if (cached?.key === frameKey && cached.draft === draft) return cached.draw(e.props?.scroll);
    const budget = nativeRenderBudget($.ui.resolve(e), {
      copy: (text, key) => copyWithFeedback($, state.selected, `full-content:${key}`, e.surface, text),
      copyLabel: key => {
        const feedback = state.pages.get(state.selected)?.copyFeedback;
        return feedback?.key === `full-content:${key}` && feedback.generation === state.generation ? copyLabels[feedback.phase] : null;
      },
    });
    const { Box, Text, Button, Input, Markdown, Image, Code, Svg, Client } = budget.ui, id = state.selected;
    const selected = state.agents.find((agent) => idOf(agent) === id);
    if (!selected) return Box({ key: 'codex_recovery', flexDirection: 'column', gap: 'sm', children: [Text({ size: 'caption', dimColor: true, children: [state.error || '重新读取代理列表以恢复对话。'] }), Button({ key: 'codex_retry', variant: 'secondary', label: '重新读取', onPress: () => openAgent($, state.requested) })] });
    const page = pageFor(id), control = controlFor(id);
    page.surface = e.surface;
    control.iconActions = new Map();
    control.imageActions = new Map();
    control.navigationActions = new Map();
    if (state.imagePreview?.agentId === id) {
      const preview = state.imagePreview, columns = e.props?.bodyColumns, rows = e.props?.scroll?.bodyRows;
      const maxColumns = Number.isFinite(columns) && columns > 0 ? Math.max(1, Math.floor(columns) - 4) : 48;
      const maxRows = Number.isFinite(rows) && rows > 0 ? Math.max(1, Math.floor(rows) - 4) : 18;
      const size = imageSize(preview.image, columns, Math.min(255, maxColumns), Math.min(255, maxRows));
      control.navigationActions.set('codex_image_preview_close', () => closeImagePreview($, id));
      return Box({ key: 'codex_image_preview', flexDirection: 'column', gap: 'sm', children: [
        Box({ key: 'codex_image_preview_header', flexDirection: 'row', justifyContent: 'flex-end', children: [Button({ key: 'codex_image_preview_close', role: 'dismiss', label: '×', onPress: () => {} })] }),
        ...(e.surface === 'desktop' ? (preview.image.desktop_preview ? [Markdown({ key: 'codex_image_preview_image', text: `![图片](${preview.image.desktop_preview})` })] : []) : [Image({ key: 'codex_image_preview_image', source: { file: preview.image.path, format: 'png' }, ...size, alt: safe(preview.image.alt || '图片') })]),
        ...(preview.image.file_url ? [Markdown({ key: 'codex_image_preview_original', text: `[打开原图](${preview.image.file_url})` })] : []),
        ...(preview.image.notice ? [Text({ key: 'codex_image_preview_notice', size: 'caption', children: [safe(preview.image.notice)] })] : []),
      ] });
    }
    let view = timelineWindow(page), entries = view.entries;
    const jump = async () => {
      cancelNavigation(page);
      page.followTail = true; page.awayFromBottom = false; page.scrollGeneration++; page.windowAnchor = null; page.windowEnd = null; page.windowSize = VISIBLE_ENTRIES; page.renderedWindow = null;
      await requestTail($, id, true);
    };
    const navigation = [], composer = [];
    const caption = (key, value) => Text({ key, size: 'caption', dimColor: true, children: [safe(value)] });
    const previewImage = (key, image, foldKey) => {
      const size = imageSize(image, e.props?.bodyColumns), actionKey = `image_action_${key}`;
      control.imageActions.set(actionKey, { image, foldKey });
      const imageNode = e.surface === 'desktop'
        ? Markdown({ key: `image_view_${key}`, text: image.desktop_thumbnail ? `![图片](${image.desktop_thumbnail})` : image.file_url ? `[打开图片](${image.file_url})` : '图片预览暂不可用' })
        : Image({ key: `image_view_${key}`, source: { file: image.path, format: 'png' }, ...size, alt: safe(image.alt || '图片') });
      if (typeof Client !== 'function') return Box({ key: `image_region_${key}`, flexDirection: 'column', children: [imageNode, Button({ key: actionKey, plain: true, label: '查看大图', onPress: () => showImagePreview($, id, { image, foldKey }) })] });
      return Box({ key: `image_region_${key}`, position: 'relative', width: size.columns, ...(e.surface === 'desktop' ? {} : { height: size.rows }), children: [imageNode,
        Box({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, children: [Client({ key: actionKey, width: size.columns, ...(e.surface === 'desktop' ? { flexGrow: 1 } : { height: size.rows }), module: './image-control.js', props: { rows: size.rows, natural: e.surface === 'desktop' } })] }),
      ] });
    };
    const hint = (key, child, label, width = 18, left = 0, visible = false) => Box({ key, position: 'relative', alignSelf: 'center', children: [child, Box({ position: 'absolute', bottom: 1, left, width, display: visible ? 'flex' : 'none', hover: { display: 'flex' }, children: [Text({ size: 'caption', inverse: true, children: [label] })] })] });
    const iconFor = (key, icon) => e.surface === 'desktop' && typeof Svg === 'function' ? Svg({ key, source: icon.source, alt: icon.alt, width: 14, height: 14, ...(icon.animated ? { isInteractive: true } : {}) }) : caption(key, icon.glyph);
    const agentMark = (key, agentId) => {
      const visual = agentVisual(agentId);
      return e.surface === 'desktop' && typeof Svg === 'function' ? Svg({ key, source: visual.source, alt: visual.alt, width: 16, height: 16 }) : caption(key, agentIcon(agentId));
    };
    const iconButton = (key, { source, label, onPress, action = 'activate', expanded = false, width = 2, height = 1, size = 12, align = 'center' }) => {
      control.iconActions.set(key, { action, expanded, onPress });
      return Box({ key: `icon_region_${key}`, position: 'relative', width, height, flexShrink: 0, hover: { backgroundColor: 'rgba(128,128,128,0.12)' }, children: [
        Box({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: align, children: [Svg({ key: `icon_${key}`, source, alt: label, width: size, height: size })] }),
        Box({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, children: [Client({ key, module: './icon-control.js', width, height, props: { expanded, action, rows: height } })] }),
      ] });
    };
    const copyButton = (key, feedbackKey, label, onPress) => {
      const feedback = page.copyFeedback?.key === feedbackKey && page.copyFeedback.generation === state.generation ? page.copyFeedback : null;
      const status = copyLabels[feedback?.phase];
      const source = feedback?.phase === 'copied' ? copiedIcon : feedback?.phase === 'failed' ? copyFailedIcon : copyIcon;
      return e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function'
        ? hint(`${key}_hint`, iconButton(key, { source, label: status || label, size: 14, onPress }), status || label, 18, -10, !!status)
        : Button({ key, plain: true, label: status || label, onPress });
    };
    const disclosure = (key, label, onPress, entry, integration = false, expanded) => {
      const activate = entry ? (...args) => {
        page.scrollGeneration++; if (!page.followTail) holdWindow(page); page.windowAnchor = entryKey(entry);
        // Request the reading anchor without blocking the visible disclosure.
        if (!page.scroller?.pending) scrollPane($, { to: { key }, block: 'nearest' }).catch(() => {});
        return onPress(...args);
      } : onPress;
      const vector = typeof expanded === 'boolean' && e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function';
      const button = Button({ key, plain: true, dimColor: true, label: `${label}${typeof expanded === 'boolean' && !vector ? ` ${expanded ? '⌄' : '›'}` : ''}`, onPress: activate });
      const children = [button];
      if (vector) {
        const hitKey = `chevron_${key}`;
        children.push(iconButton(hitKey, { source: disclosureIcon(expanded), label: expanded ? '收起' : '展开', onPress: activate, action: 'toggle', expanded, width: 1.5, align: 'flex-start' }));
      }
      const title = vector ? Box({ key: `title_${key}`, flexDirection: 'row', alignItems: 'center', gap: 0, minWidth: 0, children }) : button;
      return entry ? Box({ key: `row_${key}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [iconFor(`icon_${key}`, activityIcon(entry, integration)), title] }) : button;
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
    navigation.push(Box({ key: `codex_title_row_${id}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [agentMark(`codex_title_icon_${id}`, id), Text({ key: `codex_title_${id}`, size: 'body', weight: 'semibold', children: [safe(agentDisplayName(selected.name || 'Codex'))] })] }));
    const sourceLabel = ({ new: '新建', claude: '继承 Claude', codex: 'Codex 历史', unknown: '来源未记录' })[selected.context_source];
    if (sourceLabel) navigation.push(caption(`codex_origin_${id}`, sourceLabel));
    let hasEarlier = view.start > 0 || !!page.cursor;
    const jumpControl = suffix => e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function'
      ? hint(`codex_jump_hint_${id}_${suffix}`, iconButton(`codex_jump_${id}_${suffix}`, { source: jumpIcon, label: '回到最新消息', size: 28, width: 4, height: 2, onPress: jump }), '回到最新消息', 18, -7)
      : Button({ key: `codex_jump_${id}_${suffix}`, plain: true, label: '↓ 最新消息', onPress: jump });
    // The host owns scrolling. History controls stay in the transcript; the
    // single jump control is positioned by the cheap frame wrapper below.
    navigation.push(Box({ key: `codex_history_bar_${id}`, height: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', children: [
      Box({ flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [
        Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key: historyKey(id, page), plain: true, label: '·', onPress: () => {} })] }),
        Box({ key: `codex_history_loading_${id}`, width: 2, height: 1, children: page.historyLoading || page.navigating || page.navigationRequest ? [e.surface === 'desktop' && typeof Svg === 'function'
          ? Svg({ key: `codex_history_spinner_${id}`, source: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#888" stroke-opacity=".25" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#888" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur=".8s" repeatCount="indefinite"/></path></svg>', alt: '正在加载历史消息', width: 14, height: 14, isInteractive: true })
          : caption(`codex_history_loading_label_${id}`, '…')] : [] }),
      ] }),
    ] }));
    if (state.error) navigation.push(caption('codex_open_error', state.error));
    if (state.error || page.liveError || page.historyError) {
      if (page.liveError) navigation.push(caption('codex_update_error', page.liveError));
      if (page.historyError) navigation.push(caption('codex_history_error', page.historyError));
      navigation.push(disclosure('codex_retry_conversation', '重新读取', async () => { if (state.error) return openAgent($, id); if (page.cursor && page.historyError) return history($, id); page.historyChecked = false; await poll($); }));
    }
    const renderGroup = record => {
      const group = record.group;
      const first = group.items[0], groupKey = `${id}:${entryKey(first)}:group`, folded = !state.folds.has(groupKey);
      const groupRows = [], rowGap = e.surface === 'desktop' ? 0.7 : 'sm';
      const groupBox = (children) => {
        const key = entryKey(first), props = { key: `activity_group_${id}:${key}`, flexDirection: 'column', rowGap, minWidth: 0 };
        const groupTree = Box({ ...props, children });
        const anchored = node => record.key === page.measureAnchor ? Box({ key: `activity_read_anchor_${id}:${key}`, position: 'relative', flexDirection: 'column', minWidth: 0, children: [
          Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key: `codex_read_anchor_${id}_${record.key}`, plain: true, label: '·', onPress: () => {} })] }), node,
        ] }) : node;
        // Leave room for both neighbours. A single nearly-full tree otherwise
        // rejects every prepend/append and traps navigation on the same item.
        const paginate = (limit = { chars: 32000, nodes: 4000, depth: 22 }) => {
          if (budget.fits(groupTree, limit)) return anchored(groupTree);
          const parts = budget.pages(groupTree, limit);
          page.contentPages ??= new Map();
          const current = Math.max(0, Math.min(page.contentPages.get(key) ?? 0, parts.length - 1));
          const turn = value => { page.contentPages.set(key, value); return invalidate($); };
          return anchored(Box({ ...props, key: `activity_paged_${id}:${key}`, children: [parts[current], Box({ key: `content_pages_${id}:${key}`, flexDirection: 'row', gap: 'sm', children: [
            ...(current > 0 ? [Button({ key: `content_prev_${id}:${key}`, plain: true, label: '上一页内容', onPress: () => turn(current - 1) })] : []),
            caption(`content_page_${id}:${key}`, `内容 ${current + 1} / ${parts.length}`),
            ...(current + 1 < parts.length ? [Button({ key: `content_next_${id}:${key}`, plain: true, label: '下一页内容', onPress: () => turn(current + 1) })] : []),
          ] })] }));
        };
        const node = paginate();
        return { node, cost: budget.cost(node), paginate };
      };
      if (group.items.length > 1 || group.integration) {
        const groupLabel = group.integration ? `已使用 ${safe(group.integration)} 集成` : group.type === 'webSearch' ? '搜索' : safe(description(first)).slice(0, 120);
        groupRows.push(disclosure(`group_${groupKey}`, `${groupLabel}${!group.integration ? ` (${group.items.length})` : ''}`, () => { toggle(groupKey); return invalidate($); }, first, Boolean(group.integration), !folded));
        if (folded) return groupBox(groupRows);
      }
      const itemRows = [];
      for (const entry of group.items) {
        if (['collabAgentToolCall', 'collabToolCall', 'subAgentActivity'].includes(entry.type) && !entry.communication) {
          const d = entry.data || {}, target = d.agentThreadId || d.agent_id || d.agentId || d.agents?.[0]?.id || d.receiverThreadIds?.[0] || d.name || d.names?.[0] || entry.id;
          const waiting = d.tool === 'wait';
          itemRows.push(Box({ key: `activity_${id}:${entryKey(entry)}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [waiting ? iconFor(`wait_icon_${id}:${entryKey(entry)}`, activityIcon(entry)) : agentMark(`agent_icon_${id}:${entryKey(entry)}`, target), caption(`activity_label_${id}:${entryKey(entry)}`, description(entry))] }));
          continue;
        }
        if (entry.type === 'contextCompaction') { itemRows.push(Box({ key: `activity_${id}:${entryKey(entry)}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [iconFor(`icon_${id}:${entryKey(entry)}`, activityIcon(entry)), caption(`activity_label_${id}:${entryKey(entry)}`, description(entry))] })); continue; }
        const key = `${id}:${entryKey(entry)}`, expanded = state.folds.has(key);
        if (['agentMessage', 'userMessage', 'parentMessage', 'directUserMessage', 'plan'].includes(entry.type)) {
          const view = 'message', cacheKey = detailKey(entry, undefined, view), bodyKey = `${key}:body`, bodyOpen = state.folds.has(bodyKey);
          const loaded = detailFor(page, entry, undefined, view), local = String(entry.id).startsWith('action:');
          const rawBody = body(entry), truncated = Boolean(entry.message?.truncated || entry.deferred || (entry.preview?.length ?? 0) >= 4096 || (local && rawBody.length > 4096));
          const message = [];
          if (['userMessage', 'parentMessage', 'directUserMessage'].includes(entry.type)) message.push(caption(`author_${key}`, description(entry)));
          const incoming = ['userMessage', 'parentMessage', 'directUserMessage'].includes(entry.type);
          const shown = bodyOpen && loaded && !loaded.error ? loaded : null;
          const text = safe(shown?.text ?? (local && truncated && !bodyOpen ? rawBody.slice(0, 4096) : rawBody));
          message.push(shown?.external ? Text({ key: `message_${key}`, size: 'body', children: [text] }) : Markdown({ key: `message_${key}`, text: normalizeMessageMarkdown(text, { displayMath: e.surface === 'desktop' }) }));
          if (entry.type === 'agentMessage' && entry.message?.is_final) {
            const copy = (press = {}) => copyMessage($, id, entry, press.surface ?? e.surface);
            const action = copyButton(`message_copy_${key}`, entryKey(entry), '复制回复', copy);
            message.push(Box({ key: `message_actions_${key}`, flexDirection: 'row', justifyContent: 'flex-start', children: [action] }));
            if (page.copyError?.key === entryKey(entry)) message.push(caption(`message_copy_error_${key}`, page.copyError.text));
          }
          const attachments = Array.isArray(entry.data?.attachments) ? entry.data.attachments : Array.isArray(entry.data?.content) ? entry.data.content.filter((part) => ['localImage', 'mention'].includes(part?.type)) : [];
          if (attachments.length) message.push(Box({ key: `attachments_${key}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', children: attachments.map((part, index) => {
            const path = part?.path, name = part?.name || (typeof path === 'string' ? path.split(/[\\/]/).at(-1) : '') || '文件';
            return Box({ key: `sent_attachment_${key}_${index}`, flexDirection: 'column', children: [...(typeof Image === 'function' && typeof path === 'string' && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path) && /\.png$/i.test(path) ? [Image({ key: `sent_image_${key}_${index}`, source: { file: path, format: 'png' }, columns: 12, rows: 5, alt: safe(name) })] : []), caption(`sent_name_${key}_${index}`, `附件：${safe(attachmentName(name, index))}`)] });
          }) }));
          if (bodyOpen && loaded?.error) message.push(caption(`message_error_${key}`, loaded.text));
          if (bodyOpen && shown?.external) message.push(Markdown({ key: `message_link_${key}`, text: `[打开完整正文](${shown.file_url})` }));
          const bodyActive = bodyOpen && (local || Boolean(loaded) || page.detailRequests.has(cacheKey));
          if (truncated) message.push(disclosure(`item_${key}`, bodyActive && !loaded?.error ? '收起' : loaded?.error && bodyOpen ? '重试读取正文' : '展开全文', () => {
            if (bodyActive && !loaded?.error) { state.folds.delete(bodyKey); page.detailRequests.delete(cacheKey); return invalidate($); }
            state.folds.add(bodyKey);
            if (local || (loaded && !loaded.error)) return invalidate($);
            return expandBody($, id, entry, view, bodyKey);
          }));
          const content = Box({ key: `message_content_${key}`, flexDirection: 'column', gap: 'sm', ...(incoming ? { alignSelf: 'flex-end', minWidth: 0, borderStyle: 'round', borderDimColor: true, padding: 1, ...(e.surface === 'desktop' ? { backgroundColor: 'rgba(128,128,128,0.08)' } : {}) } : { width: '100%', paddingY: e.surface === 'desktop' ? 0.8 : 1 }), children: message });
          const bounded = incoming ? Box({ key: `message_limit_${key}`, width: '85%', flexDirection: 'column', alignItems: 'flex-end', children: [content] }) : content;
          itemRows.push(Box({ key: `message_container_${key}`, flexDirection: 'row', justifyContent: incoming ? 'flex-end' : 'flex-start', children: [bounded] }));
          continue;
        }
        const fileList = entry.data?.fileSummary?.length ? entry.data.fileSummary : entry.data?.changes;
        if (entry.type === 'fileChange' && Array.isArray(fileList) && fileList.length) {
          fileList.forEach((change, index) => {
            const fileKey = `${key}:file:${index}`, open = state.folds.has(fileKey);
            const rawChange = entry.data?.changes?.find((item) => item.path === change.path) ?? change;
            const diff = rawChange.content ?? rawChange.unified_diff ?? rawChange.diff;
            const filePath = typeof change.path === 'string' ? change.path : '';
            const deferred = entry.file_preview?.complete === false || entry.deferred || typeof diff !== 'string' || diff.length >= 4096 || diff.includes('[truncated]');
            const summary = entry.data?.fileSummary?.length ? change : fileChangeSummary(deferred ? { ...rawChange, diff: undefined, content: undefined, unified_diff: undefined } : rawChange);
            itemRows.push(disclosure(`file_${fileKey}`, changeLabel(summary), () => {
              toggle(fileKey);
              if (open) page.detailRequests.delete(detailKey(entry, filePath));
              else if (deferred && !detailFor(page, entry, filePath)) return detail($, id, entry, 0, fileKey, filePath, true);
              return invalidate($);
            }, entry, false, open));
            if (open) {
              const loaded = detailFor(page, entry, filePath);
              const inline = !deferred ? fileChangeSource(rawChange) : { text: null, format: 'source' };
              const rawSource = loaded && !loaded.error ? loaded.text : inline.text;
              const source = safe(rawSource ?? '');
              const format = loaded && !loaded.error ? loaded.format : inline.format;
              const paged = loaded && !loaded.error && (loaded.previous_offset != null || loaded.next_offset != null);
              const copyControl = (copyText, localPaged) => {
                const label = paged || localPaged ? '复制当前页差异' : '复制差异';
                const copy = (press = {}) => copyWithFeedback($, id, `diff:${fileKey}`, press.surface ?? e.surface, copyText);
                return copyButton(`diff_copy_${fileKey}`, `diff:${fileKey}`, label, copy);
              };
              const diffView = e.surface === 'desktop' && format === 'diff' ? renderDiff({ Box, Text, Button }, { key: `file_diff_${fileKey}`, source: rawSource, rows: loaded && !loaded.error ? loaded.rows : undefined, page: page.diffPages?.get(fileKey) ?? 0, copyControl, onPage: (value) => {
                page.diffPages ??= new Map(); page.diffPages.set(fileKey, value);
                if (page.diffPages.size > 64) page.diffPages.delete(page.diffPages.keys().next().value);
                return invalidate($);
              } }) : null;
              if (rawSource != null) itemRows.push(diffView ?? (typeof Code === 'function' ? Code({ key: `file_code_${fileKey}`, source, ...(filePath ? { path: filePath.split(/[\\/]/).at(-1) } : {}), ...(Number.isSafeInteger(loaded?.startLine) && loaded.startLine > 0 ? { startLine: loaded.startLine } : {}), format: format === 'diff' && (!loaded || (loaded.offset === 0 && loaded.next_offset == null)) ? 'diff' : 'source', wrap: 'wrap' }) : Text({ key: `file_code_${fileKey}`, mono: true, size: 'caption', children: [source] })));
              if (page.copyError?.key === `diff:${fileKey}`) itemRows.push(caption(`diff_copy_error_${fileKey}`, page.copyError.text));
              if (loaded?.error) itemRows.push(caption(`file_error_${fileKey}`, loaded.text));
              if (loaded?.previous_offset != null) itemRows.push(disclosure(`file_prev_${fileKey}`, '上一页输出', () => detail($, id, entry, loaded.previous_offset, fileKey, filePath)));
              if (!page.detailRequests.has(detailKey(entry, filePath)) && !String(entry.id).startsWith('action:') && ((!loaded && deferred) || loaded?.error || loaded?.next_offset != null)) itemRows.push(disclosure(`file_detail_${fileKey}`, loaded?.error ? '重试获取内容' : loaded ? '下一页输出' : '获取更多', () => detail($, id, entry, loaded?.error ? loaded.offset : loaded?.next_offset ?? 0, fileKey, filePath)));
            }
          });
          continue;
        }
        const toolStart = itemRows.length;
        if (entry.communication && typeof entry.communication.text === 'string') {
          const view = 'communication', cacheKey = detailKey(entry, undefined, view);
          const bodyKey = `${key}:body`, bodyOpen = state.folds.has(bodyKey);
          itemRows.push(disclosure(`item_${key}`, safe(description(entry)).slice(0, 120), async () => {
            toggle(key);
            if (expanded) { page.detailRequests.delete(cacheKey); state.folds.delete(bodyKey); }
            await invalidate($);
          }, entry, false, expanded));
          if (expanded) {
            const loaded = detailFor(page, entry, undefined, view), shown = bodyOpen && loaded && !loaded.error ? loaded : null;
            const text = safe(shown?.text ?? entry.communication.text);
            const contents = [shown?.external ? Text({ key: `communication_${key}`, size: 'body', children: [text] }) : Markdown({ key: `communication_${key}`, text: normalizeMessageMarkdown(text, { displayMath: e.surface === 'desktop' }) })];
            const failure = communicationFailure(entry);
            if (failure) contents.push(caption(`communication_failure_${key}`, `发送异常：${failure}`));
            if (bodyOpen && loaded?.error) contents.push(caption(`communication_error_${key}`, loaded.text));
            if (page.copyError?.key === entryKey(entry)) contents.push(caption(`communication_copy_error_${key}`, page.copyError.text));
            const rawKey = `${key}:raw`, sections = toolSections(entry);
            if (sections.length) {
              contents.push(Box({ key: `tool_raw_row_${key}`, flexDirection: 'row', children: [hint(`tool_raw_hover_${key}`, disclosure(`tool_raw_${key}`, '‹/›', () => { toggle(rawKey); return invalidate($); }), state.folds.has(rawKey) ? '收起原始调用' : '显示原始调用', 16)] }));
              if (state.folds.has(rawKey)) sections.forEach((section, index) => contents.push(...(section.compact ? [caption(`tool_status_${key}:${index}`, section.source)] : [caption(`tool_label_${key}:${index}`, section.label), sourceCode(`tool_raw_source_${key}:${index}`, section.source)])));
            }
            itemRows.push(Box({ key: `tool_content_${key}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 0.7 : 'sm', paddingX: 1, children: contents }));
            const bodyActive = bodyOpen && (Boolean(loaded) || page.detailRequests.has(cacheKey));
            if (entry.communication.truncated) itemRows.push(disclosure(`communication_detail_${key}`, bodyActive && !loaded?.error ? '收起' : bodyOpen && loaded?.error ? '重试读取正文' : '展开全文', () => {
              if (bodyActive && !loaded?.error) { state.folds.delete(bodyKey); page.detailRequests.delete(cacheKey); return invalidate($); }
              state.folds.add(bodyKey);
              if (loaded && !loaded.error) return invalidate($);
              return expandBody($, id, entry, view, bodyKey);
            }));
            if (shown?.external) {
              itemRows.push(Markdown({ key: `communication_link_${key}`, text: `[打开完整正文](${shown.file_url})` }));
            }
          }
          itemRows.push(Box({ key: `tool_entry_${key}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 0.5 : 'sm', children: itemRows.splice(toolStart) }));
          continue;
        }
        itemRows.push(disclosure(`item_${key}`, safe(description(entry)).slice(0, 120), async () => {
          toggle(key); if (expanded) { page.detailRequests.delete(detailKey(entry)); page.detailRequests.delete(detailKey(entry, undefined, 'media')); }
          if (!expanded && (entry.media?.has_images || entry.media?.omitted || (entry.deferred && ['mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(entry.type))) && !detailFor(page, entry, undefined, 'media')) loadMedia($, id, entry, key);
          if (!expanded && entry.deferred && outputTypes.has(entry.type) && !detailFor(page, entry)) return detail($, id, entry, 0, key, undefined, true);
          await invalidate($);
        }, entry));
        if (expanded) {
          const loaded = detailFor(page, entry), loading = page.detailRequests.has(detailKey(entry));
          const sections = toolSections(entry);
          const mediaState = detailFor(page, entry, undefined, 'media'), mediaLoading = page.detailRequests.has(detailKey(entry, undefined, 'media'));
          const hasMedia = entry.media?.has_images || mediaState?.images?.length;
          const output = loaded && !loaded.error ? [{ label: '输出', source: loaded.text }] : sections.filter((section) => ['输出', '错误'].includes(section.label));
          const raw = sections.filter((section) => !['输出', '错误'].includes(section.label));
          const contents = loaded?.error ? [caption(`tool_error_${key}`, loaded.text)] : output.filter((section) => section.source).map((section, index) => sourceCode(`tool_source_${key}:${index}`, section.source));
          if (!contents.length && !loading && !hasMedia && !mediaLoading) contents.push(sections.length || loaded ? caption(`tool_empty_${key}`, '暂无输出') : sourceCode(`tool_source_${key}`, body(entry)));
          if (raw.length) {
            const rawKey = `${key}:raw`;
            const rawToggle = Box({ key: `tool_raw_row_${key}`, flexDirection: 'row', children: [hint(`tool_raw_hover_${key}`, disclosure(`tool_raw_${key}`, '‹/›', () => { toggle(rawKey); return invalidate($); }), state.folds.has(rawKey) ? '收起原始调用' : '显示原始调用', 16)] });
            contents.splice(0, contents.length, Box({ key: `tool_output_${key}`, flexDirection: 'column', gap: 0, children: [...contents, rawToggle] }));
            if (state.folds.has(rawKey)) raw.forEach((section, index) => contents.push(...(section.compact ? [caption(`tool_status_${key}:${index}`, section.source)] : [caption(`tool_label_${key}:${index}`, section.label), sourceCode(`tool_raw_source_${key}:${index}`, section.source)])));
          }
          itemRows.push(Box({ key: `tool_content_${key}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 0.7 : 'sm', paddingX: 1, children: contents }));
          if (entry.media?.has_images || mediaState?.images?.length || mediaState?.error || mediaState?.notice) {
            const media = mediaState;
            const images = (media?.images || []).map(img => {
              const children = [];
              if (img.previewable && (e.surface === 'desktop' || typeof Image === 'function') && typeof img.path === 'string' && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(img.path) && /\.png$/i.test(img.path)) children.push(previewImage(`tool_media_${key}_${img.index}`, img, key));
              else if (img.file_url) children.push(Markdown({ key: `tool_media_link_${key}_${img.index}`, text: `[${safe(img.notice || '打开图片')}](${img.file_url})` }));
              else if (img.notice) children.push(caption(`tool_media_notice_${key}_${img.index}`, safe(img.notice)));
              if (img.previewable && img.notice) children.push(caption(`tool_media_notice_${key}_${img.index}`, safe(img.notice)));
              return Box({ key: `tool_media_cell_${key}_${img.index}`, flexDirection: 'column', children });
            });
            if (images.length) itemRows.push(Box({ key: `tool_media_gallery_${key}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'xs', children: images }));
            if (media?.notice) itemRows.push(caption(`tool_media_scan_notice_${key}`, media.notice));
            if (!mediaLoading && media?.offset > 0) itemRows.push(disclosure(`tool_media_prev_${key}`, '上一页图片', () => loadMedia($, id, entry, key, Math.max(0, media.offset - 8))));
            if (!mediaLoading && (media?.error || media?.next_offset != null)) itemRows.push(disclosure(`tool_media_more_${key}`, media.error ? '重试读取图片' : '更多图片', () => loadMedia($, id, entry, key, media.error ? media.retryOffset : media.next_offset)));
          }
          const imagePath = entry.data?.path || entry.data?.savedPath || entry.data?.saved_path;
          const localImage = typeof imagePath === 'string' && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(imagePath);
          if (['imageView', 'imageGeneration'].includes(entry.type) && localImage && !entry.media?.has_images) {
            if (typeof Image === 'function' && /\.png$/i.test(imagePath)) itemRows.push(previewImage(`legacy_${key}`, { ...entry.data, path: imagePath, alt: `图片：${imagePath}` }, key));
            itemRows.push(copyButton(`copy_${key}`, `image:${key}`, '复制图片路径', press => copyWithFeedback($, id, `image:${key}`, press.surface ?? e.surface, imagePath)));
            if (page.copyError?.key === `image:${key}`) itemRows.push(caption(`image_copy_error_${key}`, page.copyError.text));
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
      return groupBox(groupRows);
    };
    if (control.attachments.length) composer.push(Box({ key: `codex_attachments_${id}`, flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', children: control.attachments.map((path, index) => Box({ key: `attachment_hover_${id}_${index}`, position: 'relative', flexDirection: 'column', children: [
      ...(typeof Image === 'function' && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path) && /\.png$/i.test(path) ? [Image({ key: `attachment_image_${id}_${index}`, source: { file: path, format: 'png' }, columns: 12, rows: 5, alt: safe(attachmentName(path, index)) })] : []),
      disclosure(`attachment_${id}_${index}`, `${safe(attachmentName(path, index))} ×`, () => { control.attachments = control.attachments.filter((_, i) => i !== index); control.attachmentVersion++; return invalidate($); }), Box({ position: 'absolute', top: -2, left: 0, width: 40, display: 'none', hover: { display: 'flex' }, children: [Text({ size: 'caption', inverse: true, children: [safe(displayLabel(path.split(/[\\/]/).at(-1) || path))] })] })] })) }));
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
    let hasLater = view.start + entries.length < view.total;
    const historyEnd = Box({ key: `codex_history_end_${id}`, height: 1, children: [] });
    const timeline = rows => Box({ key: `codex_timeline_${id}`, flexDirection: 'column', rowGap: e.surface === 'desktop' ? 1 : 'md', minWidth: 0, ...(fillPane ? { flexGrow: 1 } : {}), children: rows });
    const navigationProps = { token: page.navigationRequest?.ready ? page.navigationRequest.token : 0, tailToken: page.tailRequest?.token || 0 };
    const tailMarker = Box({ position: 'absolute', bottom: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key: tailKey(id, page.tailMarkerToken), plain: true, label: '·', onPress: () => {} })] });
    const jumpNode = jumpControl('viewport');
    const overlay = scroll => {
      const offset = Math.max(0, Number.isFinite(scroll?.offset) ? scroll.offset : state.scroll.get(id) || 0);
      const visible = hasLater || page.awayFromBottom || (Number.isFinite(scroll?.contentRows) && offset < scroll.contentRows - bodyRows - 1);
      return Box({ key: `codex_jump_overlay_${id}`, position: 'absolute', left: 0, right: 0, top: Math.max(0, offset + bodyRows - 3), height: 2, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', display: visible ? 'flex' : 'none', children: [jumpNode] });
    };
    const headerNode = Box({ key: 'codex_navigation', flexDirection: 'column', gap: 'sm', children: navigation });
    const composerNode = Box({ key: `codex_composer_${id}`, flexDirection: 'column', flexShrink: 0, ...(e.surface === 'desktop' ? { gap: 0 } : { gap: 'sm', borderStyle: 'round', borderDimColor: true, padding: 1 }), children: composer });
    let renderedContent;
    const root = (content, scroll = e.props?.scroll) => {
      renderedContent = content;
      // Keep the message port in the viewport: desktop surfaces may suspend
      // off-screen Client regions. Its empty node never handles pointer input.
      const offset = Math.max(0, Number.isFinite(scroll?.offset) ? scroll.offset : state.scroll.get(id) || 0);
      const contentRows = scroll?.contentRows ?? page.scrollGeometry?.contentRows;
      const short = Number.isFinite(contentRows) && contentRows <= bodyRows + 1;
      const canRequest = !page.navigating && !page.navigationRequest && !page.tailRequest && !page.historyLoading && !page.historyError && !state.restoringPreview;
      const edgeDirection = canRequest && short && !page.shortFillDone ? hasEarlier ? -1 : hasLater ? 1 : 0 : 0;
      const edgeToken = edgeDirection ? JSON.stringify([state.generation, id, edgeDirection, view.start, entries.length, view.total, page.cursor]) : '';
      page.edgeKey = edgeToken;
      const sync = typeof Client === 'function' ? [Box({ key: `codex_sync_region_${id}`, position: 'absolute', top: offset, left: 0, width: 1, height: 1, children: [Client({ key: `codex_navigation_sync_${id}`, module: './navigation-sync.js', width: 1, height: 1, props: { ...navigationProps, edgeToken, edgeDirection } })] })] : [];
      const frame = Box({ key: 'codex_conversation', position: 'relative', overflow: 'hidden', flexDirection: 'column', gap: 'lg', ...(fillPane ? { minHeight: Math.max(bodyRows, page.layoutFloor || 0) } : {}), children: [...sync, tailMarker, headerNode, ...content, ...(hasLater ? [historyEnd] : []), composerNode, ...(fillPane ? [overlay(scroll)] : page.awayFromBottom || hasLater ? [jumpNode] : [])] });
      page.renderCost = budget.cost(frame);
      return frame;
    };
    // Preserve the partitions already on screen. Joining newly prepended tool
    // calls to a retained folded group would change its title, key and height.
    const candidateStart = view.start, candidateEnd = view.start + entries.length;
    const boundaries = new Set([candidateStart, candidateEnd]);
    if (page.adding || !page.followTail) {
      for (const group of page.renderedGroups ?? []) {
        if (group.start > candidateStart && group.start < candidateEnd) boundaries.add(group.start);
        if (group.end > candidateStart && group.end < candidateEnd) boundaries.add(group.end);
      }
      for (const boundary of [page.adding?.start, page.adding?.end]) if (boundary > candidateStart && boundary < candidateEnd) boundaries.add(boundary);
    }
    const cuts = [...boundaries].sort((a, b) => a - b), groups = [];
    for (let index = 0; index + 1 < cuts.length; index++) {
      let start = cuts[index];
      for (const group of groupEntries(entries.slice(start - candidateStart, cuts[index + 1] - candidateStart))) {
        const end = start + group.items.length;
        groups.push({ start, end, key: entryKey(group.items[0]), group }); start = end;
      }
    }
    // Measure all fixed furniture, including the sync port, pager marker and
    // jump overlay. A small token allowance covers changed edge JSON digits.
    hasEarlier = true; hasLater = true;
    const measuredShell = budget.cost(root([timeline([])]));
    const shellCost = { ...measuredShell, chars: measuredShell.chars + 512 };
    const paneLimit = { chars: 80000, nodes: 12000, depth: 28 };
    const retained = page.adding;
    const anchor = page.windowAnchor ? (page.navigationTimeline ?? page.timeline).findIndex(entry => entryKey(entry) === page.windowAnchor) : undefined;
    const plan = planHistoryWindow({ groups, renderGroup, retained, direction: page.adding?.direction ?? -1, anchor: anchor >= 0 ? anchor : undefined, shellCost, limit: paneLimit, maxEntries: 400 });
    // Expanding several retained groups can increase their combined cost. Keep
    // every retained boundary and apply the existing content pager to the
    // largest representations rather than evicting a message being read.
    const selectedGroups = plan.groups;
    const sumCost = () => selectedGroups.reduce((cost, group) => ({ chars: cost.chars + group.cost.chars, nodes: cost.nodes + group.cost.nodes, depth: Math.max(cost.depth, group.cost.depth + 2) }), { ...shellCost });
    for (let pass = 0; pass < selectedGroups.length * 12; pass++) {
      const cost = sumCost();
      if (cost.chars <= paneLimit.chars && cost.nodes <= paneLimit.nodes && cost.depth <= paneLimit.depth) break;
      const candidates = selectedGroups.filter(group => group.paginate && (group.cost.chars > 512 || group.cost.nodes > 32 || group.cost.depth + 2 > paneLimit.depth));
      candidates.sort((a, b) => Math.max(b.cost.chars / paneLimit.chars, b.cost.nodes / paneLimit.nodes) - Math.max(a.cost.chars / paneLimit.chars, a.cost.nodes / paneLimit.nodes));
      const group = candidates[0];
      if (!group) break;
      const node = group.paginate({ chars: Math.max(256, Math.floor(group.cost.chars * 0.55)), nodes: Math.max(16, Math.floor(group.cost.nodes * 0.55)), depth: 22 });
      const nextCost = budget.cost(node);
      if (nextCost.chars >= group.cost.chars && nextCost.nodes >= group.cost.nodes && nextCost.depth >= group.cost.depth) { group.paginate = null; continue; }
      group.node = node; group.cost = nextCost;
    }
    // Fixed controls may themselves exceed the allowance after several pending
    // details resolve. Keep the reading anchor and discard only the far edge;
    // never hand an oversized tree to the host or rebuild the candidate groups.
    while (selectedGroups.length > 1) {
      const cost = sumCost();
      if (cost.chars <= paneLimit.chars && cost.nodes <= paneLimit.nodes && cost.depth <= paneLimit.depth) break;
      const anchorIndex = selectedGroups.findIndex(group => group.key === page.measureAnchor || Number.isInteger(anchor) && group.start <= anchor && group.end > anchor);
      if (anchorIndex >= selectedGroups.length / 2 || page.adding?.direction > 0 && anchorIndex < 0) selectedGroups.shift();
      else selectedGroups.pop();
    }
    if (selectedGroups.length) { plan.start = selectedGroups[0].start; plan.end = selectedGroups.at(-1).end; }
    entries = entries.slice(plan.start - candidateStart, plan.end - candidateStart);
    view = { ...view, start: plan.start, entries };
    hasEarlier = view.start > 0 || !!page.cursor;
    hasLater = view.start + entries.length < view.total;
    const tree = root([timeline(selectedGroups.map(group => group.node))]);
    page.renderedGroups = selectedGroups.map(({ start, end, key, cost }) => ({ start, end, key, cost }));
    page.renderedWindow = { ...view, entries, timeline: page.navigationTimeline ?? page.timeline }; page.renderCost = budget.cost(tree);
    if (!page.followTail) { page.windowStart = view.start; page.windowEnd = view.start + entries.length; page.windowSize = Math.max(1, entries.length); }
    const content = renderedContent;
    page.renderCache = { key: frameKey, draft: control.draft, draw: scroll => root(content, scroll) };
    return tree;
}
export function closeUI() { state.opened = false; state.imagePreview = null; state.generation++; state.timer?.cancel(); state.timer = null; for (const page of state.pages.values()) { page.scroller?.cancel(); page.browseTimer?.cancel(); } state.pages.clear(); state.controls.clear(); state.folds.clear(); state.scroll.clear(); state.agents = []; state.selected = null; state.requested = null; state.error = ''; clearIcons(); }
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

import { requestBridge as bridge, pickFiles, pasteAttachments } from './bridge.js';
import { agentIcon, agentVisual, displayLabel, agentDisplayName } from './presentation.js';
import { toolSections, communicationFailure } from './tool-presentation.js';
import { activityIcon, contextIndicator, disclosureIcon, jumpIcon, copyIcon, copyPendingIcon, copiedIcon, copyFailedIcon, copyFileIcon } from './tool-icons.js';
import { normalizeMessageMarkdown } from './message-markdown.js';
import { orderWaits } from '../shared/activity-order.mjs';
import { durationLabel, finalTimestamp, turnTimeline, expandProcessReferences } from './turn-history.js';
import { renderDiff } from './diff-view.js';
import { fileChangeSummary, fileChangeSource } from '../shared/file-changes.mjs';
import { nativeRenderBudget } from './render-budget.js';
import { paneScroll } from './pane-scroll.js';
import { planHistoryWindow } from './history-window.js';
import { renderAgentDirectory } from './agent-directory.js';
import { fileViewEntries, appendFilePage } from './file-stream.js';
import { parseUnifiedDiffDetailed } from '../shared/unified-diff.mjs';
import { MAX_CLIPBOARD_LENGTH } from '../shared/clipboard.mjs';
import { nativeGraphicButton } from './native-graphic-button.js';

const PANE = 'codex_subagent_activity';
const PANE_REVISION = { plugin: 'codex-subagents', key: 'paneRevision' };
const ENTRY_REVISION = { plugin: 'codex-subagents', key: 'entryRevision' };
let paneRevision = 0;
let entryRevision = 0;
let entrySignature = '';
const MAX_DETAILS = 16;
// Candidate safety cap only; actual visible content is chosen by render cost.
const VISIBLE_ENTRIES = 400;
const RAW_WINDOW_LIMIT = 400;
let copyIntent = 0;
const copyLabels = { pending: '正在复制…', copied: '已复制', failed: '复制失败，请重试', file: '已保存完整内容' };
const copyIcons = { pending: copyPendingIcon, copied: copiedIcon, failed: copyFailedIcon, file: copyFileIcon };
const clipboardUnavailable = new Set(['no-clipboard', 'no-surface', 'unanswered']);
const safe = (value) => String(value).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
const idOf = (agent) => agent.agent_id || agent.id;
const summaryFields = ['name', 'model', 'reasoning_effort', 'context_source', 'permissions_mode', 'context_used_tokens', 'context_limit_tokens', 'status', 'user_paused', 'user_control_status', 'created_at_ms', 'last_activity_at_ms', 'parent_continuation_pending', 'turn_origin', 'parent_notification', 'final_report_pending'];
const summaries = (agents) => agents.map((agent) => ({ agent_id: idOf(agent), ...Object.fromEntries(summaryFields.filter((key) => Object.hasOwn(agent, key)).map((key) => [key, agent[key]])) }));
const entryKey = (entry) => `${entry.turn_id || ''}:${entry.id}`;
const detailKey = (entry, filePath, view) => JSON.stringify([entryKey(entry), filePath ?? null, ...(view ? [view] : [])]);
const detailFor = (page, entry, filePath, view) => page.details.get(detailKey(entry, filePath, view));
function cacheDetail(page, key, value) {
  page.details.delete(key); page.details.set(key, value);
  while (page.details.size > MAX_DETAILS) page.details.delete(page.details.keys().next().value);
}
function cacheFileDetail(page, key, value, foldKey) {
  page.fileDetails ??= new Map();
  page.fileDetails.delete(key); page.fileDetails.set(key, { ...value, foldKey });
  // Tool-output cache churn must never evict a file being read. Reclaim only
  // closed files; their next expansion can reload them without moving a reader.
  const files = [...page.fileDetails];
  let size = files.reduce((sum, [, detail]) => sum + (detail.chunks ?? []).reduce((n, chunk) => n + chunk.text.length, 0), 0);
  for (const [candidate, detail] of files) {
    if (page.fileDetails.size <= MAX_DETAILS && size <= 16 * 1024 * 1024) break;
    if (candidate === key || state.folds.has(detail.foldKey)) continue;
    page.fileDetails.delete(candidate);
    size -= (detail.chunks ?? []).reduce((n, chunk) => n + chunk.text.length, 0);
  }
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
function messageOrigin(entry) {
  if (entry.type === 'parentMessage') return 'parent';
  if (entry.type === 'directUserMessage') return 'user';
  const origin = entry.data?.message_origin;
  if (entry.type === 'userMessage' && (origin === 'parent' || origin === 'user')) return origin;
}
const description = (entry) => {
  const d = entry.data || {};
  if (typeof entry.communication?.title === 'string' && entry.communication.title.trim()) return entry.communication.title;
  const origin = messageOrigin(entry);
  if (origin === 'parent') return 'Claude';
  if (origin === 'user') return 'User';
  if (entry.type === 'userMessage') return '消息';
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
    if (entry.type === 'turnProcessPending' && last?.type === entry.type && last.items[0].pageKey === entry.pageKey) {
      last.items.push(entry); continue;
    }
    const sameTool = !['mcpToolCall', 'dynamicToolCall'].includes(entry.type) || (integrationOf(entry) ? integrationOf(last?.items[0] || {}) === integrationOf(entry) : last?.items[0]?.data?.tool === entry.data?.tool);
    if (groupable.has(entry.type) && last && last.type === entry.type && last.turn_id === entry.turn_id && sameTool) last.items.push(entry);
    else groups.push({ type: entry.type, turn_id: entry.turn_id, integration: integrationOf(entry), items: [entry] });
  }
  return groups;
}

// The caller feeds its existing low-frequency observe result to observeUI.
// There are no session hooks, model calls, or delivery acknowledgements here.
const state = { agents: [], selected: null, requested: null, view: 'agent', error: '', opened: false, timer: null, pages: new Map(), controls: new Map(), folds: new Set(), scroll: new Map(), restore: false, generation: 0 };
const directory = { openOffset: 0, completedOffset: 0, offset: 0, loading: false, error: '', request: null, minute: 0, restore: null, actions: new Map(), confirmStopAll: false, stopFeedback: '' };
let toggleQueue = Promise.resolve();
const mergeSummaries = (agents) => {
  const previous = new Map(state.agents.map(agent => [idOf(agent), agent]));
  return summaries(agents).map(agent => ({ ...previous.get(idOf(agent)), ...agent }));
};
const failureText = (error) => safe(error?.message || error?.error?.message || error?.error || (typeof error === 'string' ? error : JSON.stringify(error)) || '连接未返回有效响应').slice(0, 400);
function restoreNativeOrder(live, history, positions) {
  const matched = new Map(), seen = new Set();
  for (const entry of history) {
    const index = positions.get(entryKey(entry));
    if (!entry.turn_id || index === undefined || seen.has(index)) continue;
    seen.add(index);
    if (!matched.has(entry.turn_id)) matched.set(entry.turn_id, []);
    matched.get(entry.turn_id).push(index);
  }
  let changed = false;
  for (const indices of matched.values()) {
    if (!indices.some((index, i) => i && index < indices[i - 1])) continue;
    // Reorder only same-turn rows that this native batch actually returned.
    // Live-only records and other turns retain their positions and identities.
    const records = indices.map(index => live[index]);
    indices.sort((a, b) => a - b);
    indices.forEach((slot, i) => { live[slot] = records[i]; positions.set(entryKey(records[i]), slot); });
    changed = true;
  }
  return changed;
}
function mergeLive(page, entries, prepend = false, turns = []) {
  let changed = false;
  page.turns ??= new Map();
  for (const turn of turns) {
    const old = page.turns.get(turn.id);
    const next = prepend ? { ...turn, ...old } : { ...old, ...turn };
    // History may return after a final stream notification, or be the first
    // source to learn that a formerly active turn has finished.
    if (['completed', 'failed', 'interrupted'].includes(turn.status)) next.status = turn.status;
    if (old?.history_start_loaded || turn.history_start_loaded) next.history_start_loaded = true;
    if (JSON.stringify(next) !== JSON.stringify(old)) { page.turns.set(turn.id, next); changed = true; }
  }
  const positions = new Map(page.live.map((entry, index) => [entryKey(entry), index]));
  if (prepend) {
    const history = expandProcessReferences(entries);
    if (restoreNativeOrder(page.live, history, positions)) changed = true;
    // Insert gaps at the matching native record. The live cache can contain a
    // prompt and answer while some intervening process records are absent.
    const insertions = new Map(), seen = new Set();
    let pending = [], last = -1;
    const insert = index => {
      if (!pending.length) return;
      insertions.set(index, (insertions.get(index) ?? []).concat(pending)); pending = [];
    };
    for (const entry of history) {
      const key = entryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      const index = positions.get(key);
      if (index === undefined) pending.push(entry);
      else {
        insert(index); last = index;
        const old = page.live[index];
        const origin = !messageOrigin(old) && messageOrigin(entry);
        if (origin || entry.turn_input && !old.turn_input || entry.completed_at_ms && !old.completed_at_ms || entry.message?.is_final && !old.message?.is_final) {
          page.live[index] = { ...old, ...(entry.completed_at_ms ? { completed_at_ms: entry.completed_at_ms } : {}),
            ...(origin ? { data: { ...old.data, message_origin: origin } } : {}), ...(entry.turn_input ? { turn_input: entry.turn_input } : {}),
            ...(entry.message?.is_final ? { message: { ...old.message, ...entry.message } } : {}) };
          changed = true;
        }
      }
    }
    insert(last + 1);
    if (insertions.size) {
      const merged = [];
      for (let i = 0; i <= page.live.length; i++) {
        if (insertions.has(i)) merged.push(...insertions.get(i));
        if (i < page.live.length) merged.push(page.live[i]);
      }
      page.live = merged; changed = true;
    }
    if (changed) page.timeline = null;
    return changed;
  }
  for (const entry of entries) {
    const index = positions.get(entryKey(entry));
    if (index === undefined) { positions.set(entryKey(entry), page.live.length); page.live.push(entry); changed = true; }
    else {
      const previous = page.live[index];
      const value = { ...entry, ...(entry.started_at_ms == null && previous.started_at_ms != null ? { started_at_ms: previous.started_at_ms } : {}),
        ...(!messageOrigin(entry) && messageOrigin(previous) ? { data: { ...entry.data, message_origin: messageOrigin(previous) } } : {}),
        ...(!entry.turn_input && previous.turn_input ? { turn_input: previous.turn_input } : {}),
        ...(entry.completed_at_ms == null && previous.completed_at_ms != null ? { completed_at_ms: previous.completed_at_ms } : {}) };
      if (JSON.stringify(page.live[index]) !== JSON.stringify(value)) { page.live[index] = value; changed = true; }
    }
  }
  if (changed) page.timeline = null;
  return changed;
}
function fileStreamDetail(page, entry, path) {
  const loaded = page.fileDetails?.get(detailKey(entry, path));
  if (loaded?.chunks) return loaded;
  const change = entry.data?.changes?.find(item => item.path === path);
  const raw = change?.content ?? change?.unified_diff ?? change?.diff;
  if (entry.file_preview?.complete === false || entry.deferred || typeof raw !== 'string' || raw.length >= 4096 || raw.includes('[truncated]')) return loaded;
  const source = fileChangeSource(change);
  return { chunks: [{ offset: 0, ...source, rows: source.format === 'diff' ? parseUnifiedDiffDetailed(source.text) : undefined }], next_offset: null, offset: 0 };
}
function conversationEntries(all, page) {
  const copies = new Map(), matchedActions = new Set(), nativeMetadata = new Map();
  for (const entry of all) {
    if (!entry.turn_id || !['userMessage', 'parentMessage', 'directUserMessage'].includes(entry.type)) continue;
    const attachments = entry.data?.attachments ?? entry.data?.content?.filter(part => ['localImage', 'mention'].includes(part.type)) ?? [];
    if (!entry.input_digest && (entry.deferred || (entry.preview?.length ?? 0) >= 4096)) continue;
    const key = JSON.stringify([entry.turn_id, entry.input_digest ?? [body(entry), attachments.map(part => part.path)]]);
    if (!copies.has(key)) copies.set(key, { parent: [], user: [], unknown: [], actions: [] });
    const group = copies.get(key);
    group[String(entry.id).startsWith('action:') ? 'actions' : messageOrigin(entry) ?? 'unknown'].push(entry);
  }
  const match = (native, action) => {
    matchedActions.add(action);
    nativeMetadata.set(native, { ...native, ...(!native.turn_input && action.turn_input ? { turn_input: action.turn_input } : {}),
      data: { ...native.data, message_origin: messageOrigin(action) } });
  };
  for (const group of copies.values()) {
    const pending = [];
    for (const action of group.actions) {
      const native = group[messageOrigin(action)]?.shift();
      if (native) match(native, action);
      else pending.push(action);
    }
    // With conflicting senders or multiple indistinguishable native records,
    // retain the original rows. An action must account for exactly one echo.
    if (group.unknown.length === 1 && pending.length && new Set(pending.map(messageOrigin)).size === 1) match(group.unknown[0], pending[0]);
  }
  const entries = all.filter(entry => !matchedActions.has(entry)).map(entry => nativeMetadata.get(entry) ?? entry);
  if (!page) return orderWaits(entries);
  const timeline = turnTimeline(entries, page.turns, turnId => page.openTurns?.has(turnId), page.processPages);
  return timeline.flatMap(entry => fileViewEntries(entry, page.agentId, { isOpen: key => state.folds.has(key), getDetail: path => fileStreamDetail(page, entry, path) }));
}
function refreshTimeline(page) {
  const old = drawnWindow(page), first = old.entries[0] && entryKey(old.entries[0]);
  page.timeline = conversationEntries(page.live, page);
  if (page.navigationTimeline) return;
  const size = Math.min(RAW_WINDOW_LIMIT, Math.max(1, old.entries.length + Math.max(0, page.timeline.length - old.total)));
  if (!page.followTail && first) {
    const start = page.timeline.findIndex(entry => entryKey(entry) === first);
    if (start >= 0) {
      page.windowStart = start; page.windowEnd = start + size;
      page.windowSize = size;
    }
  }
  const indices = new Map(page.timeline.map((entry, index) => [entryKey(entry), index]));
  page.renderedGroups = page.renderedGroups?.flatMap(group => indices.has(group.key) ? [{ ...group, start: indices.get(group.key), end: indices.get(group.key) + group.end - group.start }] : []);
  page.renderedWindow = null;
}
async function loadProcessPage($, id, ref) {
  const page = pageFor(id), pages = page.processPages ??= new Map();
  const request = pages.get(ref.pageKey);
  if (request?.loading || request?.records) return;
  const loading = { loading: true };
  pages.set(ref.pageKey, loading);
  const visible = () => state.opened && state.selected === id && state.pages.get(id) === page && page.openTurns?.has(ref.turn_id);
  if (request?.error && visible()) { refreshTimeline(page); await invalidate($); }
  try {
    const result = await bridge($, 'ui_history', { target: id, process_page: ref.locator });
    if (pages.get(ref.pageKey) !== loading) return;
    if (!Array.isArray(result.entries)) throw new Error(failureText(result));
    const records = new Map(result.entries.map(entry => [entry.id, { ...entry, pageKey: ref.pageKey }]));
    if (!records.has(ref.id) || page.live.some(entry => entry.pageKey === ref.pageKey && !records.has(entry.id))) throw new Error('历史记录位置已变更');
    pages.set(ref.pageKey, { records });
    const inView = new Set(drawnWindow(page).entries.map(entry => entry.pageKey).filter(Boolean));
    for (const [key, value] of pages) {
      if (pages.size <= 16) break;
      if (key !== ref.pageKey && !value.loading && !inView.has(key)) pages.delete(key);
    }
  } catch (error) {
    if (pages.get(ref.pageKey) === loading) pages.set(ref.pageKey, { error: failureText(error) });
  }
  if (visible()) { refreshTimeline(page); await invalidate($); }
  else page.timeline = null;
}
function hydrateVisibleProcess($, id, page) {
  if (!page.openTurns?.size || page.navigating || page.navigationRequest || state.imagePreview) return;
  const pages = page.processPages ??= new Map(), running = [...pages.values()].filter(value => value.loading).length;
  let slots = 2 - running;
  for (const entry of drawnWindow(page).entries) {
    if (slots <= 0) break;
    if (entry.type !== 'turnProcessPending' || pages.has(entry.pageKey) || !page.openTurns.has(entry.turn_id)) continue;
    slots--; void loadProcessPage($, id, entry);
  }
}
function timelineWindow(page, count = page.windowSize ?? VISIBLE_ENTRIES, from) {
  const all = page.navigationTimeline ?? (page.timeline ??= conversationEntries(page.live, page)), lastStart = Math.max(0, all.length - count);
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
function scrollPane($, args, valid = () => true, controller = null, targetOffset = null) {
  const id = state.selected, generation = state.generation;
  const request = { controller, targetOffset, restore: state.restore, valid: () => state.opened && state.selected === id && state.generation === generation && valid() };
  const run = async () => {
    if (!request.valid()) return { deny: 'obsolete navigation' };
    // Raw Button callbacks can suppress our own scroll hook. A disclosure's
    // keyed move still releases native following, so the next live revision
    // must be able to re-arm it when the reader is at the tail.
    if (args.to !== 'end' && state.pages.has(id)) state.pages.get(id).nativeFollowing = false;
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
  page.scroller?.cancel(); page.scroller = null; page.edgeGesture = null;
}
function resetTailWindow(page) {
  cancelNavigation(page);
  page.nativeFollowing = false;
  page.followTail = true; page.awayFromBottom = false; page.scrollGeneration++;
  page.upwardRead = null;
  page.boundaryBlocked = null; page.measureAnchor = null;
  page.windowAnchor = null; page.windowEnd = null; page.windowSize = VISIBLE_ENTRIES; page.renderedWindow = null;
}
function atPaneBottom(offset, contentRows, bodyRows, surface) {
  // Desktop floors viewport rows, rounds scrollTop, and rounds content height
  // up. The physical end can be two cells short of the reported row maximum.
  return offset >= contentRows - bodyRows - (surface === 'desktop' ? 2 : 1);
}
function requestTail($, id, placement = false) {
  const page = pageFor(id);
  page.tailRequest = { token: ++navigationSequence, generation: state.generation, scrollGeneration: page.scrollGeneration, placement };
  page.tailMarkerToken = page.tailRequest.token;
  return invalidate($);
}
async function revealTail($, id, token) {
  const page = pageFor(id), request = page.tailRequest;
  if (!request || request.token !== token || request.running) return;
  const current = () => state.opened && state.selected === id && page.tailRequest === request &&
    request.generation === state.generation && request.scrollGeneration === page.scrollGeneration &&
    page.followTail && !state.imagePreview;
  request.running = true;
  const marker = tailKey(id, page.tailMarkerToken);
  let previous = null;
  for (const delay of [0, 32, 64, 128]) {
    if (delay) await new Promise(resolve => $.clock.after(delay, resolve));
    if (!current()) break;
    await refreshPaneGeometry($, page).catch(() => {});
    if (!current()) break;
    let geometry;
    const result = await scrollPane($, { to: { key: marker }, block: 'end' }, current, null, event => {
      geometry = request.geometry = { contentRows: event.contentRows, bodyRows: event.bodyRows };
      return Math.max(0, event.contentRows - event.bodyRows);
    }).catch(() => ({ deny: 'not painted' }));
    if (result?.deny || !geometry) continue;
    request.revealed = true;
    if (page.surface === 'desktop' || delay >= 64 && previous?.contentRows === geometry.contentRows && previous.bodyRows === geometry.bodyRows) break;
    previous = geometry;
  }
  const view = page.renderedWindow;
  if (current() && page.surface === 'desktop' && view && view.start + view.entries.length === view.total) {
    // A keyed jump is a one-time position. Native end follows the physical
    // pixel bottom as Markdown and images grow, until the next real scroll.
    // It also works when a host omits the marker from its bounded key table.
    let observed = false;
    const result = await scrollPane($, { to: 'end' }, current, null, event => {
      observed = true;
      return Math.max(0, event.contentRows - event.bodyRows);
    }).catch(() => ({ deny: 'scroll refused' }));
    if (current()) page.nativeFollowing = observed && !result?.deny;
  }
  if (page.tailRequest === request) {
    page.tailRequest = null;
    if (state.opened && state.selected === id && state.generation === request.generation) await invalidate($);
  }
}
async function requestHistoryNavigation($, id, direction, automatic = false) {
  const page = pageFor(id), generation = state.generation;
  if (page.navigating || state.imagePreview) return;
  if (page.boundaryBlocked === direction) return;
  if (page.navigationRequest?.direction === direction && page.navigationRequest.generation === generation) return;
  page.boundaryBlocked = direction;
  const request = { token: ++navigationSequence, direction, generation, scrollGeneration: page.scrollGeneration, resumeTail: automatic && page.followTail };
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
    if (request.resumeTail && page.scrollGeneration === request.scrollGeneration) page.followTail = true;
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
    settleBeforeCommit: page.surface === 'desktop',
    synchronousLayout: () => page.synchronousFileLayout === true,
  });
  return page.scroller = controller;
}
async function resizeWindow($, id, page, start, end, above, owner) {
  // Height differences must describe this navigation only. Polls may keep
  // merging into the data cache, but cannot append/resize a different record
  // in the middle of our two measured frames.
  page.navigationTimeline ??= page.timeline ??= conversationEntries(page.live, page);
  const scroller = scrollController($, id, page), gen = state.generation;
  const oldView = drawnWindow(page);
  const oldGroups = page.renderedGroups;
  const anchorGroup = above && start < oldView.start ? page.renderedGroups?.find(group => group.start === oldView.start) : null;
  const anchored = !!anchorGroup;
  if (anchored && page.measureAnchor !== anchorGroup.key) {
    page.measureAnchor = anchorGroup.key;
    // Desktop drops press keys longer than 256 characters. An item identity
    // may include a full file path; only the compact token travels to the host.
    page.measureKey = `codex_read_anchor_${id}_${++navigationSequence}`;
    await invalidate($);
  }
  const measurementKey = () => anchored ? page.measureKey : historyKey(id, page);
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
  if (!after && state.opened && state.selected === id && gen === state.generation && page.navigationOwner === owner) {
    // Never reveal an unpositioned candidate when a keyed sample was refused.
    page.windowStart = oldView.start; page.windowEnd = oldView.start + oldView.entries.length;
    page.windowSize = Math.max(1, oldView.entries.length); page.renderedGroups = oldGroups;
    page.adding = null; page.layoutRevision++;
    await invalidate($);
    if (!state.opened || state.selected !== id || gen !== state.generation || page.navigationOwner !== owner) return false;
    await refreshPaneGeometry($, page);
    if (!state.opened || state.selected !== id || gen !== state.generation || page.navigationOwner !== owner) return false;
    state.scroll.set(id, before.offset);
    await scrollPane($, { to: 'start' }, () => page.navigationOwner === owner, null, () => before.offset);
  }
  if (page.navigationOwner === owner) page.layoutFloor = null;
  return !!after && state.opened && state.selected === id && gen === state.generation && page.navigationOwner === owner;
}
async function browseHistory($, id, direction) {
  const page = pageFor(id), gen = state.generation;
  if (page.navigating || state.imagePreview) return;
  const owner = {}; page.navigationOwner = owner;
  page.navigating = true; holdWindow(page);
  try {
    // Native Markdown leaves are matched by ordinal while a new tree is
    // installed. Cover that transient layout; expose only a positioned frame.
    if (page.surface === 'desktop') await invalidate($);
    if (gen !== state.generation || state.selected !== id || page.navigationOwner !== owner) return;
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
    if (page.edgeGesture) page.edgeGesture.settled = true;
    if (!page.followTail && first && last) {
      const all = page.timeline ??= conversationEntries(page.live, page), start = all.findIndex(entry => entryKey(entry) === entryKey(first)), end = all.findIndex(entry => entryKey(entry) === entryKey(last));
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
function deliveryChoice(agent) {
  if (!agent) return;
  if (agent.final_report_pending) return;
  if (agent.parent_continuation_pending && !active(agent)) return 'continue';
  if (active(agent) && agent.turn_origin === 'parent') return;
  if (['unavailable', 'unknown'].includes(agent.parent_notification?.status)) return 'report';
}
const interruptible = (agent) => (!agent?.user_paused && active(agent)) || agent?.status === 'unknown' || ['stopping', 'unconfirmed'].includes(agent?.user_control_status);
function updateAgent(id, fields) {
  const agent = state.agents.find((a) => idOf(a) === id);
  if (!agent) return false;
  let changed = false;
  for (const key of summaryFields) {
    if (!Object.hasOwn(fields, key) || agent[key] === fields[key]) continue;
    if (key === 'parent_notification' && agent[key]?.status === fields[key]?.status && agent[key]?.reason === fields[key]?.reason) continue;
    agent[key] = fields[key]; changed = true;
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
const directoryOpen = () => state.opened && state.view === 'directory';
const canStopAllFromDirectory = () => directoryOpen() && !directory.loading && !directory.error && !stoppingAll &&
  state.agents.some(agent => agent.user_control_status === 'unconfirmed' || (!agent.user_paused && agent.user_control_status !== 'stopping'));

async function stopAllAgents($) {
  if (stoppingAll) return stoppingAll;
  directory.confirmStopAll = false;
  directory.stopFeedback = '';
  const operation = (async () => {
    try {
      const result = await bridge($, 'ui_interrupt_all', {}, { requestId: actionId() });
      if (result.offline) return { text: '当前会话的 Codex 助手未运行，已有记录保留。' };
      if (result.error || !Array.isArray(result.results)) return { text: `停止结果未确认：${failureText(result)}` };
      if (stoppingAll === operation) {
        // A list started before the stop can still contain the old pause state.
        directory.request = null;
        for (const item of result.results) {
          const status = item.user_control_status ?? item.status;
          if (['stopped', 'stopping', 'unconfirmed'].includes(status)) {
            updateAgent(item.agent_id, { user_paused: item.user_paused ?? true, user_control_status: status });
          }
        }
        const listed = await bridge($, 'ui_list', {}).catch(() => null);
        if (stoppingAll === operation && Array.isArray(listed?.agents)) {
          directory.loading = false; directory.error = '';
          await observeUI($, listed);
        }
      }
      if (!result.results.length) return { text: '当前会话没有 Codex 代理。' };
      const stopped = result.results.filter(item => (item.user_control_status ?? item.status) === 'stopped').length;
      const stopping = result.results.filter(item => (item.user_control_status ?? item.status) === 'stopping').length;
      const unconfirmed = result.results.length - stopped - stopping;
      return { text: [stopped && `已停止 ${stopped} 个`, stopping && `正在停止 ${stopping} 个`, unconfirmed && `停止未确认 ${unconfirmed} 个`].filter(Boolean).join('；') + ' Codex 代理（含所属子代理）。' };
    } catch (error) { return { text: `停止结果未确认：${failureText(error)}` }; }
  })();
  stoppingAll = operation;
  if (directoryOpen()) void invalidate($);
  try {
    const result = await operation;
    if (stoppingAll === operation) directory.stopFeedback = result.text;
    return result;
  } finally {
    if (stoppingAll === operation) {
      stoppingAll = null;
      if (state.opened) await invalidate($);
    }
  }
}
async function sendAgent($, id) {
  const control = controlFor(id), message = control.draft, attachments = [...control.attachments], attachmentVersion = control.attachmentVersion, stopEpoch = control.stopEpoch;
  let refreshActivity = false;
  const selected = state.agents.find((agent) => idOf(agent) === id);
  if (!selected || control.sending || control.stopping || selected.user_control_status === 'stopping' || (!message.trim() && !attachments.length)) return;
  const choice = deliveryChoice(selected);
  const route = choice === 'continue' && control.privateTask ? { private_task: true }
    : choice === 'report' && control.reportFinal ? { report_to_parent: true } : {};
  const page = pageFor(id); cancelNavigation(page); page.scrollGeneration++;
  control.sending = true; control.mutationEpoch++; control.sendResult = '发送中…'; await invalidate($);
  try {
    const result = await bridge($, 'ui_send', { target: id, message, ...route, ...(attachments.length ? { attachments: attachments.map((path) => ({ path })) } : {}) }, { requestId: actionId() });
    if (result.error || result.offline) {
      control.sendResult = result.offline || result.error?.code === 'action_status_unknown' ? '发送状态未知，请查看活动后再试。' : `发送失败：${safe(result.error?.message || result.error).slice(0, 600)}。草稿已保留。`;
    } else if (result.agent_id === id && result.status === 'steer_unconfirmed') {
      refreshActivity = true;
      control.sendResult = '发送结果未确认。请查看同一代理的活动后再试。草稿已保留。';
    } else if (result.agent_id === id && typeof result.status === 'string') {
      refreshActivity = true; control.sendResult = '';
      control.privateTask = false; control.reportFinal = false;
      if (control.draft === message) { control.draft = ''; control.inputVersion++; }
      if (control.attachmentVersion === attachmentVersion) { control.attachments = []; control.attachmentVersion++; }
      if (state.controls.get(id) === control && control.stopEpoch === stopEpoch) {
        const { status, ...fields } = result;
        updateAgent(id, status === 'steered' ? fields : result);
      }
    } else control.sendResult = '发送状态未知，请查看活动后再试。';
  } catch (error) { control.sendResult = `发送状态未知：${safe(error?.message || error).slice(0, 600)}。请查看活动后再试，草稿已保留。`; }
  finally {
    control.sending = false;
    if (state.opened && state.selected === id && state.controls.get(id) === control) {
      if (refreshActivity) await poll($, true);
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
    if (!state.pages.has(id)) state.pages.set(id, { agentId: id, live: [], windowStart: 0, followTail: true, revision: undefined, historyChecked: false, cursor: null, liveError: '', historyError: '', busy: false, historyLoading: false, historyGeneration: 0, scrollGeneration: 0, detailSequence: 0, details: new Map(), detailRequests: new Map() });
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
  function invalidateEntry($) {
    const signature = `${state.opened}:${state.agents.length}`;
    if (signature === entrySignature) return Promise.resolve();
    const revision = ++entryRevision;
    return $.state.set(ENTRY_REVISION, revision).then(result => {
      if (result?.isSet !== false && revision === entryRevision) entrySignature = signature;
    }).catch(() => {});
  }
  function stopPane() {
    state.opened = false; state.opening = false; state.imagePreview = null; state.generation++;
    state.timer?.cancel(); state.timer = null; directory.request = null; directory.loading = false; directory.restore = null; directory.confirmStopAll = false;
    for (const page of state.pages.values()) { cancelNavigation(page); page.tailRequest = null; }
  }
  function startPanePolling($) {
    if (!state.timer) state.timer = $.clock.every(1000, () => (state.view === 'directory' ? refreshDirectory($) : poll($)).catch(() => {}));
  }
  async function refreshDirectory($) {
    if (!directoryOpen() || directory.request || stoppingAll) return;
    const request = { generation: state.generation }; directory.request = request;
    try {
      const result = await bridge($, 'ui_list', {});
      if (directory.request !== request || !state.opened || state.view !== 'directory' || request.generation !== state.generation) return;
      if (result.error || result.offline || !Array.isArray(result.agents)) throw new Error(failureText(result));
      const before = JSON.stringify(state.agents);
      const dirty = directory.loading || directory.error || directory.minute !== Math.floor(Date.now() / 60000);
      directory.loading = false; directory.error = ''; directory.minute = Math.floor(Date.now() / 60000);
      await observeUI($, result);
      if (dirty && before === JSON.stringify(state.agents)) await invalidate($);
    } catch (error) {
      if (directory.request !== request || request.generation !== state.generation) return;
      const message = failureText(error), dirty = directory.loading || directory.error !== message;
      directory.loading = false; directory.error = message; directory.confirmStopAll = false;
      if (dirty) await invalidate($);
    } finally { if (directory.request === request) directory.request = null; }
  }
  export async function openDirectory($) {
    const previous = state.pages.get(state.selected); if (previous) { cancelNavigation(previous); previous.tailRequest = null; }
    state.opened = true; state.opening = false; state.view = 'directory'; state.selected = null; state.requested = null; state.restore = false; state.imagePreview = null;
    const generation = ++state.generation;
    directory.request = null; directory.loading = true; directory.error = ''; directory.confirmStopAll = false;
    directory.restore = { token: ++navigationSequence, generation, offset: directory.offset };
    await invalidateEntry($); await invalidate($);
    await $.ui.open({ id: PANE, title: 'Codex', focus: true, closeOnEscape: true, rows: 24 });
    if (!state.opened || state.generation !== generation) return;
    startPanePolling($);
    // Open with cached summaries immediately; fetching never holds the click.
    void refreshDirectory($);
  }
  function toggleDirectory($) {
    const toggle = async () => {
      const panes = await $.ui.panes();
      if (panes.some(pane => pane.id === PANE)) {
        const result = await $.ui.close({ id: PANE });
        if (!result?.deny) { stopPane(); await invalidateEntry($); }
      } else await openDirectory($);
    };
    const operation = toggleQueue.then(toggle);
    toggleQueue = operation.catch(() => {});
    return operation.catch(() => { $.ui.toast('无法切换 Codex 侧栏，请重试。'); });
  }
  async function latestHistory($, id) {
    const page = pageFor(id), gen = state.generation, historyGen = page.historyGeneration;
    if (page.historyChecked) return;
    page.historyChecked = true;
    try {
      const result = await bridge($, 'ui_history', { target: id, limit: RAW_WINDOW_LIMIT, character_budget: 64000, fold_turns: true });
      if (!state.opened || state.selected !== id || state.generation !== gen || page.historyGeneration !== historyGen) return;
      if (result.error || result.offline || !Array.isArray(result.entries)) throw new Error(failureText(result));
      const before = drawnWindow(page), first = before.entries[0] && entryKey(before.entries[0]);
      const changed = mergeLive(page, result.entries, true, result.turns), cursorChanged = JSON.stringify(page.cursor) !== JSON.stringify(result.next_cursor ?? null);
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
    if (afterSend) { resetTailWindow(page); page.afterSendGeneration = gen; page.afterSendScrollGeneration = page.scrollGeneration; }
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
        entriesChanged = mergeLive(page, result.entries, false, result.turns);
        page.revision = result.revision;
        dirty ||= entriesChanged;
      }
      if (appended && page.followTail) page.windowAnchor = null;
      if (entriesChanged && hadRevision && !state.opening && page.followTail && !page.nativeFollowing && !page.navigating && !page.scroller?.pending && !page.windowAnchor && page.afterSendGeneration === undefined && !state.imagePreview) {
        // Install the tail request before the changed tree can emit layout
        // scroll events. One invalidation paints both content and its request.
        await requestTail($, id);
      } else if (dirty) await invalidate($);
      const selected = state.agents.find((agent) => idOf(agent) === id);
      if (selected && selected.status !== 'starting' && !page.historyChecked) await latestHistory($, id);
      if (state.opened && state.selected === id && state.generation === gen) hydrateVisibleProcess($, id, page);
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
        cache.set(key, { promise: bridge($, 'ui_history', { target: id, cursor: value, limit: RAW_WINDOW_LIMIT, character_budget: 64000, fold_turns: true }).catch(error => ({ error: { message: failureText(error) } })) });
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
      changed = mergeLive(page, result.entries, true, result.turns);
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
  async function select($, id, gen) {
    state.selected = id; state.imagePreview = null;
    const page = pageFor(id); page.historyLoading = false; page.historyRequest = null;
    resetTailWindow(page);
    page.scrollGeometry = null;
    state.scroll.delete(id);
    page.detailRequests.clear();
    await poll($);
    if (state.opened && state.generation === gen && state.selected === id) await invalidate($);
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
    directory.request = null; directory.restore = null;
    const previous = state.pages.get(state.selected);
    if (previous) { cancelNavigation(previous); previous.tailRequest = null; }
    state.view = 'agent';
    state.opened = true; state.selected = null; state.opening = true; state.restore = false; state.requested = id || null; state.error = ''; const gen = ++state.generation;
    const current = () => state.opened && state.generation === gen && state.view === 'agent';
    await invalidate($);
    if (!current()) return;
    try {
      const list = await bridge($, 'ui_list', {});
      if (!state.opened || state.generation !== gen) return;
      if (list.error || list.offline || !Array.isArray(list.agents)) throw new Error(failureText(list));
      state.agents = mergeSummaries(list.agents);
    } catch (error) { if (current()) state.error = `无法读取代理列表：${failureText(error)}。请重试。`; }
    if (!state.opened || state.generation !== gen) return;
    await invalidateEntry($);
    if (!current()) return;
    const selected = id ? state.agents.find((agent) => idOf(agent) === id) : [...state.agents].reverse().find(active) || state.agents.at(-1);
    if (selected) await select($, idOf(selected), gen);
    else { state.selected = null; state.opening = false; if (!state.error) state.error = id ? '未找到此代理。请重新读取代理列表。' : '当前会话没有可打开的 Codex 代理。'; await invalidate($); }
    if (!current()) return;
    const result = await $.ui.open({ id: PANE, title: 'Codex', focus: true, closeOnEscape: true, rows: 24 });
    if (!current()) return;
    geometryPulse = false;
    state.opening = false;
    if (result.isPlaced === false) { state.opened = false; state.generation++; return; }
    if (state.selected) await requestTail($, state.selected, true);
    if (!current()) return;
    startPanePolling($);
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
  async function loadFileStream($, id, entry, path, foldKey, expectedOffset) {
    const page = pageFor(id), key = detailKey(entry, path), gen = state.generation;
    const cached = fileStreamDetail(page, entry, path);
    const offset = cached?.chunks?.length ? cached.next_offset : 0;
    if (page.detailRequests.has(key) || offset == null || expectedOffset !== undefined && expectedOffset !== offset) return;
    const request = ++page.detailSequence;
    page.detailRequests.set(key, request);
    const current = () => page.detailRequests.get(key) === request && state.selected === id && state.opened && state.generation === gen && state.folds.has(foldKey);
    try {
      let position = offset;
      // Two transport pages ahead: reading the next screen normally uses cache.
      for (let ahead = 0; ahead < 2 && position != null; ahead++) {
        const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, file_path: path, offset: position });
        if (!current()) return;
        if (result.error || result.offline || typeof result.text !== 'string') throw new Error(failureText(result));
        const next = appendFilePage(fileStreamDetail(page, entry, path), result, position);
        cacheFileDetail(page, key, next, foldKey);
        refreshTimeline(page);
        await invalidate($);
        position = next.next_offset;
      }
    } catch (error) {
      if (current()) {
        cacheFileDetail(page, key, { ...fileStreamDetail(page, entry, path), error: `无法读取文件内容：${failureText(error)}` }, foldKey);
      }
    } finally {
      if (current()) {
        page.detailRequests.delete(key);
        refreshTimeline(page);
        await invalidate($);
      } else if (page.detailRequests.get(key) === request) page.detailRequests.delete(key);
    }
  }
  function copyFile($, id, entry, path, foldKey, surface) {
    const cached = fileStreamDetail(pageFor(id), entry, path);
    const chunks = cached?.chunks;
    const text = chunks?.length && cached.next_offset === null && chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) <= MAX_CLIPBOARD_LENGTH
      ? chunks.map(chunk => chunk.text).join('') : undefined;
    copyWithFeedback($, id, `diff:${foldKey}`, surface, text, { turn_id: entry.turn_id, item_id: entry.id, file_path: path });
  }
  const localCopyFile = url => typeof url === 'string' && /^file:\/\/[^<>\r\n]+$/i.test(url);
  function copyWithFeedback($, id, key, surface, text, source) {
    if (!state.opened || state.selected !== id) return;
    const page = pageFor(id), generation = state.generation;
    if (page.copyFeedback?.key === key && page.copyFeedback.phase === 'pending' && page.copyFeedback.generation === generation) return;
    const intent = ++copyIntent, feedback = { key, intent, generation };
    const current = () => intent === copyIntent && state.opened && state.selected === id && state.generation === generation;
    const update = (phase, extra) => {
      if (!current()) return;
      page.copyFeedback = { ...feedback, phase, ...extra };
      void invalidate($);
    };
    const prepare = async copy => {
      const value = await bridge($, 'ui_detail', { target: id, ...source, copy });
      if (value.error || value.offline) throw new Error(failureText(value));
      if (localCopyFile(value.file_url)) return { fileUrl: value.file_url };
      if (copy === true && typeof value.text === 'string' && value.next_offset == null) return { text: value.text };
      throw new Error('未能读取完整内容');
    };
    const execute = async () => {
      try {
        const value = source && (typeof text !== 'string' || text.length > MAX_CLIPBOARD_LENGTH) ? await prepare(true) : { text };
        if (!current()) return;
        if (value.fileUrl) { update('file', value); return; }
        if (typeof value.text !== 'string' || value.text.length > MAX_CLIPBOARD_LENGTH) throw new Error('内容超过剪贴板大小限制');
        const result = await $.ui.copy({ text: value.text, surface });
        if (!current()) return;
        if (result?.isCopied !== true) {
          if (source && clipboardUnavailable.has(result?.reason)) {
            const file = await prepare('file');
            update('file', file);
            return;
          }
          throw new Error(result?.reason || '剪贴板未确认复制成功');
        }
        update('copied');
        $.clock.after(1600, async () => {
          if (!current() || page.copyFeedback?.intent !== intent) return;
          page.copyFeedback = null;
          await invalidate($);
        });
      } catch (error) {
        update('failed', { text: `复制失败：${failureText(error)}` });
      }
    };
    page.copyFeedback = { ...feedback, phase: 'pending' };
    // Keep the clipboard call in the native Button's own closure so desktop
    // can associate it with the press. The host need not await clipboard I/O.
    void execute();
    if (page.copyFeedback.phase === 'pending') void invalidate($);
  }
  function copyMessage($, id, entry, surface) {
    const cached = detailFor(pageFor(id), entry, undefined, 'message');
    const text = !entry.message?.truncated && !entry.deferred && typeof entry.data?.text === 'string' ? entry.data.text
      : !cached?.external && !cached?.error && typeof cached?.text === 'string' && cached.total_length === cached.text.length ? cached.text : undefined;
    copyWithFeedback($, id, entryKey(entry), surface, text, { turn_id: entry.turn_id, item_id: entry.id, view: 'message' });
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
    await openDirectory($);
    return {};
  });
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { stopPane(); await invalidateEntry($); }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    // Claude suppresses the registration that raised a nested event. Programmatic
    // measurements must therefore be observed by a DIFFERENT registration below.
    if (e.origin.kind !== 'person') return next(e);
    if (state.view === 'directory') {
      if (!directory.restore) directory.offset = e.offset;
      return next(e);
    }
    if (state.opening || state.imagePreview || state.restoringPreview) return next(e);
    const id = state.selected;
    const page = id && pageFor(id), gen = state.generation;
    const now = Date.now(), direction = Math.sign(e.by);
    const gesture = page?.edgeGesture;
    // Desktop reports displacement, with no wheel-start or wheel-end event.
    // Keep consuming the tail of a gesture while events keep arriving. A
    // fixed delay from the layout commit can expire in the middle of inertia.
    const continuing = gesture && direction === gesture.direction && now - gesture.lastAt < 180;
    if (direction && gesture) {
      if (continuing || page.navigating) gesture.lastAt = now;
      else page.edgeGesture = null;
    }
    if (page?.navigating && page.surface === 'desktop') {
      // Repeated wheel input during settlement is one loading gesture, not a
      // backlog of moves to replay after the reading position is restored.
      return next({ ...e, offset: state.scroll.get(id) ?? Math.max(0, e.offset - e.by) });
    }
    if (continuing && gesture.settled && page.surface === 'desktop') {
      return next({ ...e, offset: state.scroll.get(id) ?? e.offset - e.by });
    }
    const oldGeometry = page?.scrollGeometry;
    if (page) page.scrollGeometry = { contentRows: e.contentRows, bodyRows: e.bodyRows };
    const atBottom = atPaneBottom(e.offset, e.contentRows, e.bodyRows, page?.surface);
    // Before the new tail marker is painted, native layout/clamping may emit
    // "person" scroll events. They cannot cancel the requested initial/jump
    // placement; after the first reveal, genuine upward input owns it again.
    const tail = page?.tailRequest;
    if (tail?.placement) {
      const layoutChanged = tail.geometry && (e.contentRows !== tail.geometry.contentRows || e.bodyRows !== tail.geometry.bodyRows);
      if (!tail.revealed || layoutChanged && (e.by >= 0 || atBottom)) return next(e);
    }
    // Desktop reports content growth/resizing as person scrolls even when the
    // viewport did not move. That is not an instruction to stop live following.
    const view = page && drawnWindow(page);
    const newest = view && view.start + view.entries.length >= view.total;
    const grew = oldGeometry && e.contentRows - e.bodyRows > oldGeometry.contentRows - oldGeometry.bodyRows;
    if (page && !page.scroller?.pending && (e.by === 0 || page.followTail && (tail || page.nativeFollowing) && !page.windowAnchor && newest && direction > 0)) {
      // A mounted Markdown leaf can grow after the first placement and before
      // any new message arrives. One request covers repeated resize reports.
      if (page.followTail && (grew && !atBottom || direction > 0 && page.nativeFollowing) && state.opened &&
          !tail && !page.navigating && !page.navigationRequest && !page.windowAnchor) void requestTail($, id);
      return next(e);
    }
    const controller = page && scrollController($, id, page);
    const intent = controller?.intent, observed = controller?.observe(e);
    if (controller && controller.intent === intent) return next(observed);
    if (e.origin.kind === 'person' && id) {
      const wasFollowing = page.followTail;
      page.nativeFollowing = false;
      page.tailRequest = null;
      if (page.navigationRequest && e.by !== 0 && Math.sign(e.by) !== page.navigationRequest.direction) page.navigationRequest = null;
      const previousOffset = state.scroll.get(id);
      state.scroll.set(id, e.offset); page.scrollGeneration++;
      const stableGeometry = !oldGeometry || oldGeometry.contentRows === e.contentRows && oldGeometry.bodyRows === e.bodyRows;
      // An actual upward move is observable even inside the rounding margin.
      if (e.by !== 0 || !stableGeometry) {
        page.upwardRead = atBottom && e.by < 0 && stableGeometry && e.offset < (previousOffset ?? e.offset)
          ? { offset: e.offset, contentRows: e.contentRows, bodyRows: e.bodyRows } : null;
      }
      page.windowAnchor = null;
      holdWindow(page);
      if (page.windowEnd == null) page.windowStart = view.start;
      // A downward move to the end of the newest window resumes following.
      // Layout clamps and repeated reports at an unchanged offset do not.
      page.followTail = atBottom && newest && e.by > 0;
      page.awayFromBottom = !page.followTail;
      if (!wasFollowing && page.followTail && page.surface === 'desktop') void requestTail($, id);
    }
    // Return the wheel dispatch immediately. History, state writes and paint
    // barriers run outside the host's scroll request chain.
    if (direction && id && state.opened && !page.navigating && !page.navigationRequest && !page.edgeGesture) {
      const threshold = Math.max(2, (e.bodyRows || 12) * 2);
      if (e.by < 0 && e.offset <= threshold && page.cursor) prefetchHistory($, id);
      const needsTrim = view.entries.length >= 300 || page.renderCost?.chars > 48000 || page.renderCost?.nodes > 5500;
      const earlier = direction < 0 && e.offset <= (needsTrim ? 1 : threshold) && (view.start > 0 || page.cursor);
      const nearEnd = needsTrim ? atBottom : e.offset >= e.contentRows - e.bodyRows - threshold;
      const later = direction > 0 && nearEnd && view.start + view.entries.length < view.total;
      if (earlier || later) {
        page.boundaryBlocked = null;
        const gesture = page.edgeGesture = { direction, lastAt: now, settled: false };
        $.clock.after(0, () => {
          if (state.opened && state.selected === id && gen === state.generation && page.edgeGesture === gesture) return requestHistoryNavigation($, id, direction);
        });
      }
    }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE, origin: { kind: 'plugin' } }, ($, e, next) => {
    if (state.view === 'directory') {
      const offset = directory.restore?.offset ?? e.offset;
      directory.offset = offset;
      return next({ ...e, offset });
    }
    const id = state.selected, page = id && pageFor(id);
    if (!page) return next(e);
    const transfer = state.programmaticScroll;
    if (transfer && !transfer.valid()) return next({ ...e, offset: state.scroll.get(id) ?? Math.max(0, e.offset - e.by) });
    page.scrollGeometry = { contentRows: e.contentRows, bodyRows: e.bodyRows };
    if (transfer?.targetOffset) {
      const offset = transfer.targetOffset(e);
      state.scroll.set(id, offset);
      return next({ ...e, offset });
    }
    // Ordinary keyed moves, including a tool disclosure or a history probe,
    // release Desktop's native end-follow mode.
    page.nativeFollowing = false;
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
    const action = state.opened && (state.view === 'directory' ? directory.actions.get(e.element) : state.controls.get(state.selected)?.navigationActions?.get(e.element));
    // Run navigation under this registered frame, rather than the Button's raw
    // callback origin (which suppresses every hook owned by this plugin).
    return action ? (await action(), {}) : next(e);
  });
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (state.opened && e.data?.action === 'open-agent' && e.element?.startsWith('directory_hit_')) {
      const id = e.element.slice('directory_hit_'.length);
      if (state.agents.some(agent => idOf(agent) === id)) await openAgent($, id);
      return {};
    }
    if (state.opened && state.view === 'directory' && e.element === 'codex_directory_sync') {
      const request = directory.restore;
      if (e.data?.action !== 'navigate' || !request || e.data.token !== request.token) return {};
      await refreshPaneGeometry($, directory);
      if (state.view !== 'directory' || directory.restore !== request || state.generation !== request.generation) return {};
      await $.ui.scroll({ in: PANE, to: 'start' });
      if (directory.restore === request) { directory.restore = null; await invalidate($); }
      return {};
    }
    if (!state.opened || !state.selected) return next(e);
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'edge') {
      const id = state.selected, page = pageFor(id), generation = state.generation;
      if (!e.data.token || e.data.token !== page.edgeKey || page.lastEdgeRequest === e.data.token || page.navigating || page.navigationRequest || page.tailRequest || state.imagePreview) return {};
      page.lastEdgeRequest = e.data.token;
      page.shortFillDone = true;
      const direction = e.data.direction === 1 ? 1 : -1;
      $.clock.after(0, () => { if (state.opened && state.selected === id && state.generation === generation) return requestHistoryNavigation($, id, direction, true); });
      return {};
    }
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'tail') {
      await revealTail($, state.selected, e.data.token);
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
      if (request.resumeTail && page.scrollGeneration === request.scrollGeneration && state.generation === request.generation && !page.followTail) {
        const view = drawnWindow(page);
        if (view.start + view.entries.length === view.total) {
          page.followTail = true;
          await requestTail($, state.selected);
        }
      }
      return {};
    }
    const file = controlFor(state.selected).fileActions?.get(e.element);
    if (file && e.data?.action === 'file-load' && file.token === e.data.token) {
      await loadFileStream($, state.selected, file.source, file.path, file.key, file.offset);
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
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const inherited = await next(e);
    if (e.surface !== 'desktop') return inherited;
    await $.state.get(ENTRY_REVISION);
    const { Box, Button } = $.ui.resolve(e);
    return Box({ flexDirection: 'row', children: [inherited, Button({ key: 'codex_directory_toggle', plain: true, label: `Codex·${state.agents.length}`, onPress: () => toggleDirectory($) })] });
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inherited = await next(e);
    if (e.surface === 'desktop' || e.props?.hasSurvey) return inherited;
    await $.state.get(ENTRY_REVISION);
    const { Box, Button } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [inherited, Button({ key: 'codex_directory_toggle', plain: true, label: `Codex·${state.agents.length}`, onPress: () => toggleDirectory($) })] });
  });
}
function renderPane($, e, next) {
    if (e.requestId !== PANE) return next(e);
    if (state.view === 'directory') {
      const ui = $.ui.resolve(e), { Box, Client } = ui;
      directory.surface = e.surface; directory.actions.clear();
      if (typeof Client !== 'function') directory.restore = null;
      const onPage = async (group, offset) => {
        directory[group === 'open' ? 'openOffset' : 'completedOffset'] = Math.max(0, offset);
        directory.offset = 0;
        directory.restore = { token: ++navigationSequence, generation: state.generation, offset: 0 };
        await invalidate($);
      };
      const onRetry = async () => { directory.error = ''; directory.loading = true; await invalidate($); await refreshDirectory($); };
      const onRequestStop = async () => {
        if (!canStopAllFromDirectory() || directory.confirmStopAll) return;
        directory.confirmStopAll = true; directory.stopFeedback = ''; await invalidate($);
      };
      const onCancelStop = async () => {
        if (!directoryOpen() || !directory.confirmStopAll) return;
        directory.confirmStopAll = false; await invalidate($);
      };
      const onConfirmStop = async () => {
        if (directory.confirmStopAll && canStopAllFromDirectory()) await stopAllAgents($);
      };
      const stopAll = { available: canStopAllFromDirectory(), confirming: directory.confirmStopAll, pending: !!stoppingAll, feedback: directory.stopFeedback, onRequest: onRequestStop, onCancel: onCancelStop, onConfirm: onConfirmStop };
      for (const agent of state.agents) directory.actions.set(`directory_open_${idOf(agent)}`, () => openAgent($, idOf(agent)));
      directory.actions.set('directory_retry', onRetry);
      directory.actions.set('directory_stop_all', onRequestStop);
      directory.actions.set('directory_stop_all_cancel', onCancelStop);
      directory.actions.set('directory_stop_all_confirm', onConfirmStop);
      return Box({ key: 'codex_directory', position: 'relative', overflow: 'hidden', flexDirection: 'column', gap: 'sm', children: [
        ...(typeof Client === 'function' && directory.restore ? [Box({ position: 'absolute', top: Math.max(0, e.props?.scroll?.offset || 0), left: 0, width: 1, height: 1, children: [Client({ key: 'codex_directory_sync', module: './navigation-sync.js', props: { token: directory.restore.token }, width: 1, height: 1 })] })] : []),
        renderAgentDirectory(ui, { agents: state.agents, surface: e.surface, columns: e.props?.bodyColumns, openOffset: directory.openOffset, completedOffset: directory.completedOffset, loading: directory.loading, error: directory.error, onOpen: id => openAgent($, id), onPage, onRetry, stopAll }),
      ] });
    }
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
    if (state.opening && !selected) return Text({ size: 'caption', dimColor: true, children: ['正在打开对话…'] });
    if (!selected) return Box({ key: 'codex_recovery', flexDirection: 'column', gap: 'sm', children: [Text({ size: 'caption', dimColor: true, children: [state.error || '重新读取代理列表以恢复对话。'] }), Button({ key: 'codex_retry', variant: 'secondary', label: '重新读取', onPress: () => openAgent($, state.requested) })] });
    const page = pageFor(id), control = controlFor(id);
    page.surface = e.surface;
    control.iconActions = new Map();
    control.imageActions = new Map();
    control.fileActions = new Map();
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
    const jump = async event => {
      resetTailWindow(page);
      await requestTail($, id, true);
      // The icon already runs in a registered message frame. Drive its jump
      // here even if replacing a tall older window moves the sync Client out
      // of the viewport. The request is shared with any concurrent paint post.
      if (e.surface === 'desktop' && event?.data?.action === 'activate') await revealTail($, id, page.tailRequest?.token);
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
    const copyStatus = key => page.copyFeedback?.key === key && page.copyFeedback.generation === state.generation ? page.copyFeedback : null;
    const copyNotice = (key, feedbackKey, label) => {
      const feedback = copyStatus(feedbackKey);
      if (feedback?.phase === 'file') return Markdown({ key, text: `[${label}](<${feedback.fileUrl}>)` });
      if (feedback?.phase === 'failed') return caption(key, feedback.text);
    };
    const copyButton = (key, feedbackKey, label, onPress) => {
      const feedback = copyStatus(feedbackKey);
      const status = copyLabels[feedback?.phase];
      const name = status || label;
      if (e.surface !== 'desktop' || typeof Svg !== 'function') return Button({ key, plain: true, label: name, onPress });
      const control = nativeGraphicButton({ Box, Button }, { key, label: name, onPress, width: 3, children: [
        Svg({ key: `${key}_icon`, source: copyIcons[feedback?.phase] || copyIcon, alt: '', width: 15, height: 15 }),
      ] });
      return hint(`${key}_hint`, control, name, 18, 0, !!status);
    };
    const disclosure = (key, label, onPress, entry, integration = false, expanded) => {
      const activate = entry ? (...args) => {
        page.scrollGeneration++; if (!page.followTail) holdWindow(page); page.windowAnchor = entryKey(entry);
        // Request the reading anchor without blocking the visible disclosure.
        if (!page.scroller?.pending) scrollPane($, { to: { key }, block: 'nearest' }).catch(() => {});
        return onPress(...args);
      } : onPress;
      const vector = typeof expanded === 'boolean' && e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function';
      if (entry?.type === 'turnSummary' && e.surface === 'desktop') {
        return nativeGraphicButton({ Box, Button }, { key, label, onPress: activate, gap: 0, dimColor: true, children: [
          Text({ key: `label_${key}`, dimColor: true, children: [label] }),
          typeof Svg === 'function' ? Svg({ key: `icon_${key}`, source: disclosureIcon(expanded), alt: '', width: 12, height: 12 })
            : caption(`icon_${key}`, expanded ? '⌄' : '›'),
        ] });
      }
      const button = Button({ key, plain: true, dimColor: true, label: `${label}${typeof expanded === 'boolean' && !vector ? ` ${expanded ? '⌄' : '›'}` : ''}`, onPress: activate });
      const children = [button];
      if (vector) {
        const hitKey = `chevron_${key}`;
        children.push(iconButton(hitKey, { source: disclosureIcon(expanded), label: expanded ? '收起' : '展开', onPress: activate, action: 'toggle', expanded, width: 1.5, align: 'flex-start' }));
      }
      const title = vector ? Box({ key: `title_${key}`, flexDirection: 'row', alignItems: 'center', gap: 0, minWidth: 0, children }) : button;
      if (entry?.type === 'turnSummary') return title;
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
    const backToDirectory = () => openDirectory($);
    control.navigationActions.set('codex_back_directory', backToDirectory);
    navigation.push(Button({ key: 'codex_back_directory', plain: true, label: '‹ 代理列表', onPress: backToDirectory }));
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
          Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key: page.measureKey, plain: true, label: '·', onPress: () => {} })] }), node,
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
        return { node, cost: budget.cost(node), ...(first.fileView ? {} : { paginate }) };
      };
      if (first.type === 'turnProcessPending') {
        const key = `turn_process_page_${id}:${entryKey(first)}`;
        if (!first.error) return groupBox([caption(key, '正在读取过程…')]);
        return groupBox([caption(key + '_error', first.error), disclosure(key, '重新读取这段过程', () => loadProcessPage($, id, first), first)]);
      }
      if (group.items.length > 1 || group.integration) {
        const groupLabel = group.integration ? `已使用 ${safe(group.integration)} 集成` : group.type === 'webSearch' ? '搜索' : safe(description(first)).slice(0, 120);
        groupRows.push(disclosure(`group_${groupKey}`, `${groupLabel}${!group.integration ? ` (${group.items.length})` : ''}`, () => { toggle(groupKey); return invalidate($); }, first, Boolean(group.integration), !folded));
        if (folded) return groupBox(groupRows);
      }
      const itemRows = [];
      for (const entry of group.items) {
        if (entry.type === 'turnSummary') {
          const key = `turn_process_${id}:${entry.turn_id}`, label = durationLabel(entry.duration_ms);
          if (!entry.hasProcess) {
            if (Number.isFinite(entry.duration_ms)) itemRows.push(caption(key, label));
          } else itemRows.push(disclosure(key, label, async () => {
            page.openTurns ??= new Set();
            if (entry.open) page.openTurns.delete(entry.turn_id);
            else page.openTurns.add(entry.turn_id);
            refreshTimeline(page);
            await invalidate($);
            if (!entry.open && entry.firstPage) return loadProcessPage($, id, entry.firstPage);
          }, entry, false, entry.open));
          continue;
        }
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
          message.push(shown?.external ? Text({ key: `message_${key}`, size: 'body', children: [text] }) : Markdown({ key: `message_${key}`, text: normalizeMessageMarkdown(text, { nativeMath: e.surface === 'desktop' }) }));
          if (entry.type === 'agentMessage' && entry.message?.is_final) {
            const copy = (press = {}) => copyMessage($, id, entry, press.surface ?? e.surface);
            const action = copyButton(`message_copy_${key}`, entryKey(entry), '复制回复', copy);
            const time = finalTimestamp(entry.completed_at_ms ?? page.turns?.get(entry.turn_id)?.completed_at_ms);
            message.push(Box({ key: `message_actions_${key}`, flexDirection: 'row', alignItems: 'center', gap: 'xs', justifyContent: 'flex-start',
              children: [action, ...(time ? [caption(`message_time_${key}`, time)] : [])] }));
            const notice = copyNotice(`message_copy_error_${key}`, entryKey(entry), '打开完整回复');
            if (notice) message.push(notice);
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
          const content = Box({ key: `message_content_${key}`, flexDirection: 'column', gap: 'sm', ...(incoming ? { flexShrink: 1, minWidth: 0, borderStyle: 'round', borderDimColor: true, padding: 1, ...(e.surface === 'desktop' ? { backgroundColor: 'rgba(128,128,128,0.08)' } : {}) } : { width: '100%', paddingY: e.surface === 'desktop' ? 0.8 : 1 }), children: message });
          const bounded = incoming ? Box({ key: `message_limit_${key}`, width: '85%', minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end', children: [content] }) : content;
          itemRows.push(Box({ key: `message_container_${key}`, flexDirection: 'row', minWidth: 0, justifyContent: incoming ? 'flex-end' : 'flex-start', children: [bounded] }));
          continue;
        }
        if (entry.fileView) {
          const file = entry.fileView, fileKey = file.key, original = file.source;
          const loaded = fileStreamDetail(page, original, file.path);
          if (file.kind === 'header') {
            const open = state.folds.has(fileKey);
            const deferred = original.deferred || original.file_preview?.complete === false;
            const summary = file.summary ?? fileChangeSummary(deferred ? { ...file.change, diff: undefined, content: undefined, unified_diff: undefined } : file.change);
            itemRows.push(disclosure(`file_${fileKey}`, changeLabel(summary), async () => {
              if (!page.followTail) holdWindow(page);
              toggle(fileKey);
              if (open) page.detailRequests.delete(detailKey(original, file.path));
              refreshTimeline(page);
              await invalidate($);
              if (!open && !loaded?.chunks) await loadFileStream($, id, original, file.path, fileKey);
            }, { ...entry, type: 'fileChange' }, false, open));
          } else if (file.kind === 'chunk') {
            const copy = file.isFirst ? copyButton(`diff_copy_${fileKey}`, `diff:${fileKey}`, '复制差异', (press = {}) => copyFile($, id, original, file.path, fileKey, press.surface ?? e.surface)) : undefined;
            const diff = file.format === 'diff' && Array.isArray(file.rows)
              ? renderDiff({ Box, Text, Button }, { key: `file_diff_${fileKey}:${file.chunkIndex}`, rows: file.rows, source: file.text, framed: false, lineWidth: file.lineWidth, copyControl: copy })
              : null;
            if (diff) itemRows.push(diff);
            else if (file.format !== 'diff') itemRows.push(Box({ key: `file_source_${key}`, flexDirection: 'column', children: [
              ...(copy ? [copy] : []), sourceCode(`file_code_${fileKey}:${file.chunkIndex}`, file.text),
            ] }));
          } else if (file.error) {
            itemRows.push(caption(`file_error_${fileKey}`, file.error));
            itemRows.push(disclosure(`file_retry_${fileKey}`, '重试读取', () => loadFileStream($, id, original, file.path, fileKey)));
          } else {
            itemRows.push(caption(`file_loading_${fileKey}`, '正在读取文件内容…'));
          }
          if ((file.prefetch || file.kind === 'tail') && !loaded?.error && (loaded?.next_offset != null || !loaded?.chunks)) {
            const offset = loaded?.chunks?.length ? loaded.next_offset : 0;
            const token = JSON.stringify([state.generation, fileKey, offset]);
            const controlKey = `file_load_${key}`;
            control.fileActions.set(controlKey, { ...file, token, offset });
            if (typeof Client === 'function') itemRows.push(Box({ position: 'relative', height: 0, children: [Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 1, children: [Client({ key: controlKey, module: './file-stream-control.js', width: 1, height: 1, props: { token } })] })] }));
          }
          const notice = file.isFirst && copyNotice(`diff_copy_error_${fileKey}`, `diff:${fileKey}`, '打开完整差异');
          if (notice) itemRows.push(notice);
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
            const contents = [shown?.external ? Text({ key: `communication_${key}`, size: 'body', children: [text] }) : Markdown({ key: `communication_${key}`, text: normalizeMessageMarkdown(text, { nativeMath: e.surface === 'desktop' }) })];
            const failure = communicationFailure(entry);
            if (failure) contents.push(caption(`communication_failure_${key}`, `发送异常：${failure}`));
            if (bodyOpen && loaded?.error) contents.push(caption(`communication_error_${key}`, loaded.text));
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
            itemRows.push(copyButton(`copy_${key}`, `image:${key}`, '复制图片路径', (press = {}) => copyWithFeedback($, id, `image:${key}`, press.surface ?? e.surface, imagePath)));
            const notice = copyNotice(`image_copy_error_${key}`, `image:${key}`);
            if (notice) itemRows.push(notice);
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
    if (selected.final_report_pending) composer.push(caption(`codex_report_pending_${id}`, '本轮最终回复将发给 Claude'));
    const choice = deliveryChoice(selected);
    if (choice) {
      const key = `codex_delivery_choice_${id}`;
      const toggleChoice = () => {
        if (control.sending || state.selected !== id || deliveryChoice(state.agents.find(agent => idOf(agent) === id)) !== choice) return;
        if (choice === 'continue') control.privateTask = !control.privateTask;
        else control.reportFinal = !control.reportFinal;
        return invalidate($);
      };
      control.navigationActions.set(key, toggleChoice);
      const label = choice === 'continue'
        ? (control.privateTask ? '单独提问 · 切换为继续 Claude 的任务' : '继续 Claude 的任务 · 切换为单独提问')
        : `${control.reportFinal ? '☑' : '☐'} 把本轮最终回复发给 Claude`;
      composer.push(Button({ key, plain: true, label, onPress: toggleChoice }));
    }
    composer.push(Box({ key: `codex_input_${id}`, flexDirection: 'column', width: '100%', alignItems: 'stretch', children: [Input({ key: `codex_message_${id}_${control.inputVersion}`, placeholder: '给代理发送消息', value: control.draft, rows: 3, ...(e.surface === 'desktop' ? {} : { submitLabel: '发送' }), onInput: control.actions.input, onSubmit: control.actions.submit })] }));
    const permission = ({ 'full-access': '完全访问', 'auto-review': '自动审查', ask: '需要批准' })[selected?.permissions_mode];
    const used = selected?.context_used_tokens, limit = selected?.context_limit_tokens;
    const context = contextIndicator(used, limit);
    const paste = hint(`codex_paste_hover_${id}`, Button({ key: `codex_paste_${id}`, plain: true, dimColor: true, label: '📎︎', onPress: control.actions.paste }), '粘贴图片或文件');
    const attach = hint(`codex_attach_hover_${id}`, Button({ key: `codex_attach_${id}`, plain: true, dimColor: true, label: control.picking ? '…' : '+', onPress: control.actions.attach }), '添加文件', 12);
    control.navigationActions.set('codex_back_directory_footer', backToDirectory);
    const left = [Button({ key: 'codex_back_directory_footer', plain: true, dimColor: true, label: '‹ 列表', onPress: backToDirectory }), Box({ key: `codex_attachment_actions_${id}`, flexDirection: 'row', alignItems: 'center', gap: 0, children: [attach, paste] }), ...(permission ? [caption(`codex_permissions_${id}`, permission)] : [])];
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
    const settling = e.surface === 'desktop' && page.navigating;
    const overlay = scroll => {
      const offset = Math.max(0, Number.isFinite(scroll?.offset) ? scroll.offset : state.scroll.get(id) || 0);
      const contentRows = scroll?.contentRows ?? page.scrollGeometry?.contentRows;
      const reading = page.upwardRead;
      const aboveEnd = reading?.offset === offset && reading.contentRows === contentRows && reading.bodyRows === bodyRows;
      const visible = hasLater || aboveEnd || (Number.isFinite(contentRows) ? !atPaneBottom(offset, contentRows, bodyRows, e.surface) : page.awayFromBottom);
      return Box({ key: `codex_jump_overlay_${id}`, position: 'absolute', alignSelf: 'center', width: 4, top: Math.max(0, offset + bodyRows - 3), height: 2, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', display: visible ? 'flex' : 'none', children: [jumpNode] });
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
      const loadingLayer = settling ? [Box({ key: `codex_history_settling_${id}`, position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'background', children: [
        Box({ key: `codex_history_settling_indicator_${id}`, position: 'absolute', top: offset + 2, left: 0, right: 0, height: 2, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', children: [
          typeof Svg === 'function' ? Svg({ key: `codex_history_settling_spinner_${id}`, source: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#888" stroke-opacity=".25" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#888" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur=".8s" repeatCount="indefinite"/></path></svg>', alt: '正在加载历史消息', width: 18, height: 18, isInteractive: true }) : caption(`codex_history_settling_label_${id}`, '正在加载历史消息'),
        ] }),
      ] })] : [];
      const frame = Box({ key: 'codex_conversation', position: 'relative', overflow: 'hidden', flexDirection: 'column', gap: 'lg', ...(fillPane ? { minHeight: Math.max(bodyRows, page.layoutFloor || 0) } : {}), children: [...sync, tailMarker, headerNode, ...content, ...(hasLater ? [historyEnd] : []), composerNode, ...loadingLayer, ...(fillPane ? [overlay(scroll)] : page.awayFromBottom || hasLater ? [jumpNode] : [])] });
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
      if (page.followTail && !page.windowAnchor || anchorIndex >= selectedGroups.length / 2 || page.adding?.direction > 0 && anchorIndex < 0) selectedGroups.shift();
      else selectedGroups.pop();
    }
    if (selectedGroups.length) { plan.start = selectedGroups[0].start; plan.end = selectedGroups.at(-1).end; }
    entries = entries.slice(plan.start - candidateStart, plan.end - candidateStart);
    page.synchronousFileLayout = entries.length > 0 && entries.every(entry => entry.fileView && (entry.fileView.kind !== 'chunk' || entry.fileView.format === 'diff'));
    view = { ...view, start: plan.start, entries };
    hasEarlier = view.start > 0 || !!page.cursor;
    hasLater = view.start + entries.length < view.total;
    // Adjacent chunks are one visual file, with no paragraph gap at buffer edges.
    const visualGroups = [];
    let cluster = null;
    for (const group of selectedGroups) {
      const file = group.group.items[0]?.fileView;
      if (file?.kind === 'chunk') {
        if (!cluster || cluster.key !== file.key) {
          cluster = { key: file.key, nodes: [] }; visualGroups.push(cluster);
        }
        cluster.nodes.push(group.node);
      } else { cluster = null; visualGroups.push({ node: group.node }); }
    }
    const tree = root([timeline(visualGroups.map(group => group.node ?? Box({ key: `file_buffer_${group.key}`, flexDirection: 'column', gap: 0, minWidth: 0, children: group.nodes })))]);
    page.renderedGroups = selectedGroups.map(({ start, end, key, cost }) => ({ start, end, key, cost }));
    page.renderedWindow = { ...view, entries, timeline: page.navigationTimeline ?? page.timeline }; page.renderCost = budget.cost(tree);
    if (!page.followTail) { page.windowStart = view.start; page.windowEnd = view.start + entries.length; page.windowSize = Math.max(1, entries.length); }
    const content = renderedContent;
    page.renderCache = { key: frameKey, draft: control.draft, draw: scroll => root(content, scroll) };
    return tree;
}
export function closeUI() { stopPane(); state.pages.clear(); state.controls.clear(); state.folds.clear(); state.scroll.clear(); state.agents = []; state.selected = null; state.requested = null; state.view = 'agent'; state.error = ''; entrySignature = ''; directory.openOffset = 0; directory.completedOffset = 0; directory.offset = 0; directory.error = ''; directory.stopFeedback = ''; directory.actions.clear(); stoppingAll = null; }
export async function observeUI($, result) {
    if (!Array.isArray(result?.agents)) return;
    const before = JSON.stringify(state.agents);
    state.agents = mergeSummaries(result.agents);
    if (!canStopAllFromDirectory()) directory.confirmStopAll = false;
    await invalidateEntry($);
    const ids = new Set(state.agents.map(idOf));
    for (const id of state.controls.keys()) if (!ids.has(id)) state.controls.delete(id);
    for (const id of state.pages.keys()) if (!ids.has(id)) {
      state.pages.delete(id); state.scroll.delete(id);
      for (const key of state.folds) if (key.startsWith(`${id}:`)) state.folds.delete(key);
    }
    if (state.opened && before !== JSON.stringify(state.agents)) await invalidate($);
}

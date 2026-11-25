import { requestBridge as bridge, pickFiles, pasteAttachments } from './bridge.js';
import { agentIcon, agentVisual, displayLabel, agentDisplayName } from './presentation.js';
import { toolSections, communicationFailure } from './tool-presentation.js';
import { activityIcon, contextIndicator, disclosureIcon, jumpIcon, copyIcon, copyPendingIcon, copiedIcon, copyFailedIcon, copyFileIcon } from './tool-icons.js';
import { normalizeMessageMarkdown } from './message-markdown.js';
import { orderWaits } from '../shared/activity-order.mjs';
import { mergeTurnMetadata } from '../shared/turn-history.mjs';
import { durationLabel, finalTimestamp, turnTimeline, expandProcessReferences, processPageError } from './turn-history.js';
import { renderDiff } from './diff-view.js';
import { fileChangeSummary, fileChangeSource } from '../shared/file-changes.mjs';
import { compactKey, GROUP_RENDER_LIMIT, INPUT_RENDER_LIMIT, nativeRenderBudget, RENDER_LIMIT } from './render-budget.js';
import { paneMarkerOffset, paneScroll, probeDenial } from './pane-scroll.js';
import { historyWindowCost, historyWindowFits, planHistoryWindow } from './history-window.js';
import { bandSections, cropBandSections, historyBand, historyCoreLimit, maxBandRows } from './history-band.js';
import { mostRecentAgent, renderAgentDirectory } from './agent-directory.js';
import { fileViewEntries, appendFilePage } from './file-stream.js';
import { parseUnifiedDiffDetailed } from '../shared/unified-diff.mjs';
import { MAX_CLIPBOARD_LENGTH } from '../shared/clipboard.mjs';
import { nativeGraphicButton, retainedCopyButtons } from './native-graphic-button.js';

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
const copyLabelWidth = Math.max(...Object.values(copyLabels).map(label => label.length));
const copyIconSize = Math.max(copyIcon.length, ...Object.values(copyIcons).map(source => source.length));
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
    // History may return after a final stream notification, or be the first
    // source to learn that a formerly active turn has finished.
    const next = mergeTurnMetadata(old, turn, prepend);
    if (JSON.stringify(next) !== JSON.stringify(old)) { page.turns.set(turn.id, next); changed = true; }
  }
  if (!entries.length) {
    if (changed) page.timeline = null;
    return changed;
  }
  // Live deltas and deferred page reads can alternate throughout a long
  // turn. Build the lookup once; keep it aligned with the canonical array.
  let positions = page.livePositions;
  if (!positions) {
    positions = page.livePositions = new Map();
    for (let index = 0; index < page.live.length; index++) positions.set(entryKey(page.live[index]), index);
  }
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
        const process = entry.type === 'turnProcessRef' && old.type === 'agentMessage' && !old.turn_process;
        const completeMessage = entry.message?.complete && (!old.message?.complete || entry.message.is_final && !old.message?.is_final ||
          entry.message.delivery === 'async' && old.message?.delivery !== 'async');
        if (origin || process || entry.turn_input && !old.turn_input || entry.completed_at_ms && !old.completed_at_ms || completeMessage) {
          page.live[index] = { ...old, ...(entry.completed_at_ms ? { completed_at_ms: entry.completed_at_ms } : {}),
            ...(origin ? { data: { ...old.data, message_origin: origin } } : {}), ...(entry.turn_input ? { turn_input: entry.turn_input } : {}),
            ...(process ? { turn_process: true } : {}),
            ...(completeMessage ? { data: entry.data, preview: entry.preview, message: entry.message } : {}) };
          changed = true;
        }
      }
    }
    insert(last + 1);
    if (insertions.size) {
      const merged = [];
      for (let i = 0; i <= page.live.length; i++) {
        const inserted = insertions.get(i);
        if (inserted) for (const entry of inserted) { positions.set(entryKey(entry), merged.length); merged.push(entry); }
        if (i < page.live.length) {
          const entry = page.live[i];
          positions.set(entryKey(entry), merged.length); merged.push(entry);
        }
      }
      page.live = merged; changed = true;
    }
    if (changed) { page.timeline = null; page.reconciledInputs = null; }
    return changed;
  }
  for (const entry of entries) {
    const index = positions.get(entryKey(entry));
    if (index === undefined) { positions.set(entryKey(entry), page.live.length); page.live.push(entry); changed = true; }
    else {
      const previous = page.live[index];
      const staleMessage = previous.message?.complete && entry.message && !entry.message.complete;
      const value = { ...(staleMessage ? previous : entry), ...(entry.started_at_ms == null && previous.started_at_ms != null ? { started_at_ms: previous.started_at_ms } : {}),
        ...(!messageOrigin(entry) && messageOrigin(previous) ? { data: { ...entry.data, message_origin: messageOrigin(previous) } } : {}),
        ...(!entry.turn_input && previous.turn_input ? { turn_input: previous.turn_input } : {}),
        ...(entry.type === 'agentMessage' && (previous.turn_process || previous.type === 'turnProcessRef') ? { turn_process: true } : {}),
        ...(entry.completed_at_ms == null && previous.completed_at_ms != null ? { completed_at_ms: previous.completed_at_ms } : {}) };
      if (previous.message?.delivery === 'async' && value.message && value.message.delivery !== 'async') {
        value.message = { ...value.message, delivery: 'async', is_final: false };
      }
      if (JSON.stringify(page.live[index]) !== JSON.stringify(value)) { page.live[index] = value; changed = true; }
    }
  }
  if (changed) { page.timeline = null; page.reconciledInputs = null; }
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
function reconcileInputs(all) {
  if (!all.some(entry => ['parentMessage', 'directUserMessage', 'userMessage'].includes(entry.type) && String(entry.id).startsWith('action:'))) return all;
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
  return matchedActions.size ? all.filter(entry => !matchedActions.has(entry)).map(entry => nativeMetadata.get(entry) ?? entry) : all;
}
function conversationEntries(all, page) {
  const entries = page ? page.reconciledInputs ??= reconcileInputs(all) : reconcileInputs(all);
  if (!page) return orderWaits(entries);
  const timeline = turnTimeline(entries, page.turns, turnId => page.openTurns?.has(turnId), page.processPages);
  return timeline.flatMap(entry => fileViewEntries(entry, page.agentId, { isOpen: key => state.folds.has(key), getDetail: path => fileStreamDetail(page, entry, path) }));
}
function refreshTimeline(page) {
  const old = drawnWindow(page), first = old.entries[0];
  page.timeline = conversationEntries(page.live, page);
  if (page.navigationTimeline) return;
  const size = Math.min(RAW_WINDOW_LIMIT, Math.max(1, old.entries.length + Math.max(0, page.timeline.length - old.total)));
  if (!page.followTail && first) {
    const key = entryKey(first), source = entryKey(first.fileView?.source ?? first);
    let start = page.timeline.findIndex(entry => entryKey(entry) === key);
    if (start < 0) start = page.timeline.findIndex(entry => entryKey(entry.fileView?.source ?? entry) === source);
    if (start >= 0) {
      page.windowStart = start; page.windowEnd = start + size;
      page.windowSize = size;
    }
  }
  const indices = new Map(page.timeline.map((entry, index) => [entryKey(entry), index]));
  page.renderedGroups = page.renderedGroups?.flatMap(group => indices.has(group.key) ? [{ ...group, start: indices.get(group.key), end: indices.get(group.key) + group.end - group.start }] : []);
  page.renderedWindow = null;
}
function retainedHistoryWindow(page, previous) {
  const first = previous.entries[0];
  if (!first || page.followTail) return;
  const entries = page.timeline ??= conversationEntries(page.live, page);
  const start = entries.findIndex(entry => entryKey(entry) === entryKey(first));
  if (start < 0) return;
  const next = previous.entries[1];
  if (first.type === 'turnSummary' && first.open && next?.turn_id === first.turn_id) {
    // An older continuation of this turn inserts its records after the
    // summary. Advance the retained window from the first unchanged body row
    // so the newly available prefix can enter through normal navigation.
    const body = entries.findIndex(entry => entryKey(entry) === entryKey(next));
    if (body > start + 1) return { start: body, count: previous.entries.length - 1 };
  }
  return { start, count: previous.entries.length };
}
const PROCESS_PARALLEL_PAGES = 2;
const PROCESS_CACHE_LIMIT = 16;
const PROCESS_PREFETCH_ENTRIES = 50;
function currentProcessPane(id, page) {
  return state.opened && state.selected === id && state.pages.get(id) === page && !state.imagePreview;
}
function visibleProcessEntries(page, view) {
  const geometry = page.scrollGeometry, offset = state.scroll.get(page.agentId);
  if (!page.hasHistoryBands || view !== page.renderedWindow || !geometry || !Number.isFinite(offset)) return view.entries;
  const nearby = (band, distance) => band?.timeline === view.timeline && distance <= geometry.bodyRows + band.rows ? band.entries ?? [] : [];
  return [...nearby(page.upperBand, offset), ...view.entries, ...nearby(page.lowerBand, paneEnd(geometry) - offset)];
}
function processViewportPages(page, direction = page.processDirection ?? 1) {
  const view = drawnWindow(page), timeline = page.navigationTimeline ?? page.timeline;
  const end = view.start + view.entries.length;
  const mounted = visibleProcessEntries(page, view);
  const visible = direction < 0 ? mounted : mounted.slice().reverse();
  const ahead = (direction < 0 ? timeline.slice(Math.max(0, view.start - PROCESS_PREFETCH_ENTRIES), view.start).reverse()
    : timeline.slice(end, end + PROCESS_PREFETCH_ENTRIES));
  const candidates = new Map();
  for (const item of [...visible, ...ahead]) {
    const entry = item.fileView?.source ?? item;
    if (entry.pageKey && !candidates.has(entry.pageKey) && page.openTurns.has(entry.turn_id)) candidates.set(entry.pageKey, entry);
    if (candidates.size >= PROCESS_CACHE_LIMIT / 2) break;
  }
  return candidates;
}
function queueProcessHydration($, id, page) {
  if (page.processHydration || !page.openTurns?.size) return;
  const generation = state.generation;
  const request = {};
  page.processHydration = request;
  $.clock.after(0, () => {
    if (page.processHydration !== request) return;
    page.processHydration = null;
    if (state.generation === generation) hydrateVisibleProcess($, id, page);
  });
}
function revealCachedProcess($, page) {
  if (!page.processPages?.size || page.navigationTimeline || page.disclosurePlacement?.running) return;
  const layoutChanged = visibleProcessEntries(page, drawnWindow(page)).some(item => {
    const entry = item.fileView?.source ?? item;
    if (!entry.pageKey) return false;
    const cached = page.processPages.get(entry.pageKey), hydrated = cached?.records?.has(entry.id);
    return entry.type === 'turnProcessPending' ? hydrated || entry.error !== processPageError(cached) : !hydrated;
  });
  if (!layoutChanged) return;
  refreshTimeline(page);
  void invalidate($);
}
async function loadProcessPage($, id, ref) {
  const page = pageFor(id), pages = page.processPages ??= new Map();
  const previous = pages.get(ref.pageKey), generation = state.generation;
  if (previous?.loading || previous?.records?.has(ref.id) || (page.processInFlight ?? 0) >= PROCESS_PARALLEL_PAGES || !page.openTurns?.has(ref.turn_id)) return;
  const request = { loading: true, turnId: ref.turn_id };
  pages.set(ref.pageKey, request);
  page.processInFlight = (page.processInFlight ?? 0) + 1;
  const current = () => state.generation === generation && currentProcessPane(id, page) && page.openTurns.has(ref.turn_id);
  let settled = false;
  try {
    if (previous?.error && current()) { refreshTimeline(page); await invalidate($); }
    if (!current() || pages.get(ref.pageKey) !== request) return;
    const result = await bridge($, 'ui_history', { target: id, process_page: ref.locator });
    if (!current() || pages.get(ref.pageKey) !== request) return;
    if (!Array.isArray(result.entries)) throw new Error(failureText(result));
    const records = new Map(result.entries.map(entry => [entry.id, { ...entry, pageKey: ref.pageKey }]));
    if (!(ref.processIds ?? [ref.id]).every(itemId => records.has(itemId))) throw new Error('历史记录位置已变更');
    pages.delete(ref.pageKey);
    pages.set(ref.pageKey, { records, turnId: ref.turn_id });
    settled = true;
  } catch (error) {
    if (current() && pages.get(ref.pageKey) === request) {
      pages.set(ref.pageKey, { error: failureText(error), turnId: ref.turn_id });
      settled = true;
    }
  } finally {
    page.processInFlight--;
    if (pages.get(ref.pageKey) === request) pages.delete(ref.pageKey);
    if (settled && current()) {
      if (pages.size > PROCESS_CACHE_LIMIT) {
        const keep = processViewportPages(page);
        for (const [key, value] of pages) {
          if (pages.size <= PROCESS_CACHE_LIMIT) break;
          if (value.loading || key === ref.pageKey || keep.has(key)) continue;
          pages.delete(key);
        }
      }
      revealCachedProcess($, page);
    }
    if (currentProcessPane(id, page)) queueProcessHydration($, id, page);
  }
}
function hydrateVisibleProcess($, id, page) {
  if (!currentProcessPane(id, page) || !page.openTurns?.size || page.disclosurePlacement?.running) return;
  revealCachedProcess($, page);
  if (page.navigating || page.navigationRequest) return;
  let slots = PROCESS_PARALLEL_PAGES - (page.processInFlight ?? 0);
  if (slots <= 0) return;
  for (const [key, entry] of processViewportPages(page)) {
    if (entry.type !== 'turnProcessPending' || page.processPages?.has(key)) continue;
    slots--; void loadProcessPage($, id, entry);
    if (!slots) break;
  }
}
async function placeDisclosure($, id, page, { key, entry, generation, geometry, keepHeight = false, inline = false }, apply) {
  if (state.generation !== generation || !currentProcessPane(id, page)) return;
  holdWindow(page);
  cancelNavigation(page, true);
  page.tailRequest = null;
  const wasFollowing = page.nativeFollowing;
  page.nativeFollowing = false;
  const scrollGeneration = ++page.scrollGeneration;
  const position = page.scrollGeometry ?? geometry;
  const offset = state.scroll.get(id) ?? geometry?.offset ?? 0;
  const preserve = page.surface === 'desktop' && Number.isFinite(position?.bodyRows);
  const placement = { key, running: preserve, minHeight: preserve && keepHeight ? offset + position.bodyRows : 0 };
  page.disclosurePlacement = placement;
  const current = () => state.generation === generation && currentProcessPane(id, page) && page.disclosurePlacement === placement;
  const canPlace = () => current() && page.scrollGeneration === scrollGeneration;
  let before;
  if (preserve) {
    for (const block of ['start', 'end']) {
      const probe = { probing: true, observe(e) {
        const clipped = e.offset < 0 || (block === 'start' ? e.offset >= paneEnd(e) : e.offset === 0);
        if (!clipped) before = { block, offset: e.offset, viewport: Math.max(0, e.offset - e.by) };
        return { deny: probeDenial };
      } };
      await scrollPane($, { to: { key }, block }, canPlace, probe).catch(() => {});
      if (before || !canPlace()) break;
    }
  }
  if (!current()) return;
  const entryId = entryKey(entry);
  holdDisclosureWindow(page, entryId);
  const marker = canPlace() && preserve ? `codex_read_anchor_${id}_${++navigationSequence}` : null;
  if (marker) {
    if (inline) placement.marker = marker;
    else { page.measureAnchor = entryId; page.measureKey = marker; }
  }
  let changed;
  try {
    changed = apply();
    await invalidate($);
    if (marker) {
      for (const delay of [0, 16, 32, 64]) {
        if (!canPlace()) break;
        if (delay) await new Promise(resolve => $.clock.after(delay, resolve));
        if (!canPlace()) break;
        await refreshPaneGeometry($, page).catch(() => {});
        const targetOffset = e => {
          const clipped = e.offset < 0 || (before?.block === 'end' ? e.offset === 0 : e.offset >= paneEnd(e));
          const target = before && !clipped ? before.viewport + e.offset - before.offset : offset;
          return Math.max(0, Math.min(paneEnd(e), target));
        };
        const args = { to: { key: marker }, block: before?.block ?? 'start' };
        let sample;
        const probe = { probing: true, observe(e) {
          sample = { target: targetOffset(e), viewport: Math.max(0, e.offset - e.by) };
          return { deny: probeDenial };
        } };
        await scrollPane($, args, canPlace, probe).catch(() => {});
        if (!sample || !canPlace()) continue;
        // A same-cell commit rounds the native pixel position. Only move for
        // an actual displacement, or to release native end following.
        if (sample.target === sample.viewport && !wasFollowing) break;
        const result = await scrollPane($, args, canPlace, null, targetOffset).catch(() => ({ deny: 'not painted' }));
        if (!result?.deny) break;
      }
    }
  } finally {
    placement.running = false;
    placement.marker = null;
    if (marker && page.measureKey === marker && !page.navigationOwner) page.measureAnchor = null;
    if (current()) queueProcessHydration($, id, page);
  }
  return changed;
}
async function toggleTurnProcess($, id, page, key, entry, generation, geometry) {
  if (Boolean(page.openTurns?.has(entry.turn_id)) !== entry.open) return;
  const applied = await placeDisclosure($, id, page, { key, entry, generation, geometry, keepHeight: entry.open }, () => {
    page.shortFillDirection = page.processDirection = 1;
    page.openTurns ??= new Set();
    if (entry.open) {
      page.openTurns.delete(entry.turn_id);
      for (const [pageKey, value] of page.processPages ?? []) {
        if (value.turnId === entry.turn_id && !value.records) page.processPages.delete(pageKey);
      }
    } else page.openTurns.add(entry.turn_id);
    refreshTimeline(page);
    return true;
  });
  if (applied && state.generation === generation && !entry.open && entry.firstPage) void loadProcessPage($, id, entry.firstPage);
}
function timelineWindow(page, count = page.windowSize ?? VISIBLE_ENTRIES, from) {
  const all = page.navigationTimeline ?? (page.timeline ??= conversationEntries(page.live, page));
  const tail = page.followedBandWindow;
  if (page.followTail && tail?.timeline === all && !page.windowAnchor && !page.adding) {
    return { entries: all.slice(tail.start, tail.end), start: tail.start, total: all.length };
  }
  if (page.adding) {
    const { direction, start, end, count } = page.adding;
    const from = direction < 0 ? Math.max(0, start - count) : start;
    const to = direction > 0 ? Math.min(all.length, end + count) : end;
    return { entries: all.slice(from, to), start: from, total: all.length };
  }
  const lastStart = Math.max(0, all.length - count);
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
function holdDisclosureWindow(page, key) {
  const view = drawnWindow(page);
  page.bandCore = null;
  holdWindow(page);
  page.windowAnchor = key;
  page.disclosurePrefix = { first: view.entries[0] && entryKey(view.entries[0]), key };
  const band = page.upperBand, last = band?.entries?.at(-1);
  if (last?.type === 'turnSummary' && entryKey(last) === key && band.timeline === view.timeline) {
    // Retain the physical summary immediately above the core. The newly
    // opened process belongs in the core that begins under it.
    const { seam, rows, columns, bodyRows, cost } = band;
    page.disclosurePrefix.upper = { seam, rows, columns, bodyRows, cost, count: band.entries.length, first: entryKey(band.entries[0]) };
  }
  if (view.entries.some(entry => entryKey(entry) === key)) return;
  const all = page.navigationTimeline ?? (page.timeline ??= conversationEntries(page.live, page));
  const index = all.findIndex(entry => entryKey(entry) === key);
  if (index < 0) return;
  const size = Math.min(all.length, Math.max(1, view.entries.length));
  const start = index < view.start ? index : Math.max(0, index - size + 1);
  page.disclosurePrefix.first = entryKey(all[start]);
  page.windowStart = start; page.windowEnd = start + size; page.windowSize = size;
  page.renderedWindow = null; page.renderedGroups = null;
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
    if (!controller?.probing && args.to !== 'end' && state.pages.has(id)) state.pages.get(id).nativeFollowing = false;
    state.programmaticScroll = request;
    try {
      const result = await $.ui.scroll({ in: PANE, ...args });
      if (!result?.deny && request.valid()) {
        if (Number.isFinite(request.offset)) state.scroll.set(id, request.offset);
        if (request.restore) state.restore = false;
      }
      return result;
    }
    finally { if (state.programmaticScroll === request) state.programmaticScroll = null; }
  };
  const operation = (state.scrollQueue || Promise.resolve()).catch(() => {}).then(run);
  state.scrollQueue = operation.catch(() => {});
  return operation;
}
function cancelNavigation(page, keepBandCore = false) {
  page.followedBandWindow = null;
  if (!keepBandCore) page.bandTrail = null;
  if (page.bandExposure && !page.bandExposure.placed) page.bandExposure.frame.rows = page.bandExposure.rows;
  page.bandExposure = null;
  page.bandIntent = 0;
  page.resumeOnBandSize = false;
  if (!keepBandCore) page.bandCore = null;
  page.waitingBand = null;
  page.disclosurePrefix = null;
  page.navigationOwner = null; page.navigationRequest = null;
  page.navigationTimeline = null; page.adding = null; page.navigating = false;
  page.historyBlockedNavigation = null; page.obsoleteScroll = null;
  page.layoutFloor = null; page.measureAnchor = null; page.historyPositionedAt = null;
  page.scroller?.cancel(); page.scroller = null; page.edgeGesture = null; page.readingAnchor = null;
  page.historyApproach = 0; page.boundary = null; page.disclosurePlacement = null;
}
function resetTailWindow(page) {
  cancelNavigation(page);
  page.primeHistoryPages = 2;
  page.nativeFollowing = false;
  page.followTail = true; page.awayFromBottom = false; page.scrollGeneration++;
  page.upwardRead = null;
  page.shortFillDirection = null; page.measureAnchor = null;
  page.windowAnchor = null; page.windowEnd = null; page.windowSize = VISIBLE_ENTRIES; page.renderedWindow = null;
}
function atPaneBottom(offset, contentRows, bodyRows, surface) {
  // Desktop floors viewport rows, rounds scrollTop, and rounds content height
  // up. The physical end can be two cells short of the reported row maximum.
  return offset >= contentRows - bodyRows - (surface === 'desktop' ? 2 : 1);
}
const paneEnd = ({ contentRows, bodyRows }) => Math.max(0, contentRows - bodyRows);
const bandSeamRows = 0.5;
function reachesTail(page, view) {
  return view && (view.start + view.entries.length >= view.total ||
    page.lowerBand?.open && page.lowerBand.timeline === view.timeline && page.lowerBand.groups?.at(-1)?.end === view.total);
}
function promoteUpperBand(page, e) {
  const band = page.upperBand, all = page.timeline;
  if (!all || !band?.groups?.length || !band.naturalRows || band.rows < band.naturalRows ||
      e.offset + e.bodyRows + 1 > band.rows || band.timeline !== all) return false;
  const first = band.groups[0], last = band.groups.at(-1);
  if (first.start <= 0 || last.end > drawnWindow(page).start) return false;
  // The whole viewport lies in this measured band. Keep that exact native
  // height and bottom alignment as the new core. Its next older neighbour
  // first mounts at zero height, leaving the old first pixel where it was.
  page.bandCore = { first: first.key, last: last.key, rows: band.rows,
    partRows: band.partRows?.slice(), naturalRows: band.naturalRows, partCounts: band.partCounts?.slice() };
  page.windowStart = first.start; page.windowEnd = last.end;
  page.windowSize = last.end - first.start;
  page.renderedWindow = null; page.renderedGroups = band.groups;
  page.upperBand = null; page.lowerBand = null; page.bandIntent = 0;
  page.readingAnchor = null; page.measureAnchor = null; page.historyApproach = 0;
  return true;
}
function promoteLowerBand(page, e) {
  const core = page.bandCore, band = page.lowerBand, all = page.timeline;
  if (!core || !band?.open || !band.naturalRows || band.timeline !== all ||
      paneEnd(e) - e.offset + e.bodyRows + 1 > band.rows) return false;
  const first = band.groups[0], last = band.groups.at(-1);
  if (!first || last.end >= all.length) return false;
  const prefixRows = (page.upperBand?.rows ?? 0) + core.rows + bandSeamRows;
  if (prefixRows > maxBandRows) return false;
  const remember = frame => frame && { seam: frame.seam, columns: frame.columns, bodyRows: frame.bodyRows,
    rows: frame.rows, open: frame.open, token: ++navigationSequence };
  const trail = page.bandTrail ??= [];
  trail.push({ core, upper: remember(page.upperBand), lower: remember(band), end: paneEnd(e) });
  // Every component before this band has an explicit native height. Reuse
  // their real measured extent as the prefix for the next window. The older
  // window stays in the trail and is restored on approach from this side.
  page.bandCore = { first: first.key, last: last.key, rows: band.rows, align: 'start', prefixRows };
  page.windowStart = first.start; page.windowEnd = last.end; page.windowSize = last.end - first.start;
  page.renderedWindow = null; page.renderedGroups = band.groups;
  page.upperBand = null; page.lowerBand = null; page.bandIntent = 1;
  page.historyApproach = 0; page.boundary = null;
  return true;
}
function restoreBandOnApproach(page, e) {
  const trail = page.bandTrail, all = page.timeline;
  let core = page.bandCore, step;
  while (trail?.length && core?.prefixRows != null && e.offset <= core.prefixRows + e.bodyRows * 2 &&
      e.offset + 1 < trail.at(-1).end) {
    step = trail.pop(); core = step.core;
  }
  if (!step) return false;
  const start = all.findIndex(entry => entryKey(entry) === core.first), last = all.findIndex(entry => entryKey(entry) === core.last);
  if (start < 0 || last < start) { trail.length = 0; return false; }
  page.bandCore = core; page.upperBand = step.upper; page.lowerBand = step.lower;
  page.windowStart = start; page.windowEnd = last + 1; page.windowSize = last - start + 1;
  page.renderedWindow = null; page.renderedGroups = null; page.bandIntent = -1;
  return true;
}
function waitForUpperBand($, id, page) {
  const core = page.waitingBand = page.bandCore, generation = state.generation;
  $.clock.after(600, () => {
    if (!state.opened || state.selected !== id || generation !== state.generation || page.waitingBand !== core) return;
    page.waitingBand = null;
    if ((state.scroll.get(id) || 0) <= 1) return requestHistoryNavigation($, id, -1);
  });
}
async function resumeUpperBand($, id, page) {
  const geometry = page.scrollGeometry, offset = state.scroll.get(id) ?? 0, band = page.upperBand;
  if (!geometry || offset > 1 || !band?.groups?.length) return false;
  if (promoteUpperBand(page, { ...geometry, offset })) {
    waitForUpperBand($, id, page);
    await invalidate($);
    return true;
  }
  if (band.naturalRows > band.rows) {
    return exposeUpperBand($, id, page, offset);
  }
  if (band.groups[0].start === 0 && page.cursor && !page.historyError) {
    page.historyApproach = -1;
    await history($, id);
    return true;
  }
  if (!band.naturalRows) { page.resumeOnBandSize = true; return true; }
  return band.groups[0].start === 0 && !page.cursor;
}
function exposeUpperBand($, id, page, offset) {
  if (page.bandExposure) return true;
  const frame = page.upperBand, delta = frame.naturalRows - frame.rows;
  if (delta <= 0) return false;
  const token = ++navigationSequence;
  const exposure = page.bandExposure = { token, frame, rows: frame.rows, delta, offset, attempt: 0,
    marker: `codex_band_exposure_${id}_${token}`, strip: page.captureBandStrip?.() };
  frame.rows += delta; page.historyApproach = 0; page.bandIntent = 0;
  void invalidate($);
  const retry = () => {
    if (page.bandExposure !== exposure || exposure.running) return;
    if (exposure.attempt++ < 2) { void invalidate($); $.clock.after(350, retry); }
    else { frame.rows = exposure.rows; page.bandExposure = null; void invalidate($); void requestHistoryNavigation($, id, -1); }
  };
  $.clock.after(350, retry);
  return true;
}
async function placeExposedBand($, id, page, token) {
  const exposure = page.bandExposure;
  // Retries redraw the same immutable extent/marker. A delayed first post
  // is just as valid as the most recent one once the native key is present.
  if (!exposure || exposure.running || typeof token !== 'string' || !token.startsWith(`${exposure.token}/`)) return;
  exposure.running = true;
  const current = () => state.opened && state.selected === id && page.bandExposure === exposure && page.upperBand === exposure.frame;
  try {
    for (const delay of [0, 16, 32, 64, 128, 192]) {
      if (!current()) break;
      if (delay) { await new Promise(resolve => $.clock.after(delay, resolve)); await refreshPaneGeometry($, page); }
      const target = exposure.offset + exposure.delta;
      const controller = { pending: true, observe: e => {
        if (paneEnd(e) < target) return { deny: 'unpainted extent' };
        exposure.target = target;
        return { ...e, offset: target };
      } };
      const result = await scrollPane($, { to: { key: exposure.marker }, block: 'start' }, current, controller).catch(() => ({ deny: 'unpainted' }));
      if (!result?.deny && current()) { exposure.placed = true; state.scroll.set(id, target); break; }
    }
  } finally {
    if (page.bandExposure === exposure) {
      if (!exposure.placed) exposure.frame.rows = exposure.rows;
      page.bandExposure = null; page.historyApproach = 0;
      await invalidate($);
      if (!exposure.placed) void requestHistoryNavigation($, id, -1);
    }
  }
}
const historyMargin = (geometry, desktop) => desktop ? Math.max(2, Math.ceil(paneEnd(geometry) / 5)) : Math.max(2, (geometry.bodyRows || 12) * 2);
const samePaneGeometry = (a, b) => a && a.contentRows === b.contentRows && a.bodyRows === b.bodyRows;
const desktopWheelQuietMs = 180;
function desktopMovement(e, offset, oldGeometry) {
  const from = e.offset - e.by;
  const projected = Math.min(offset, paneEnd(e));
  const current = Math.abs(from - offset) <= 2;
  if (!e.by || !current && Math.abs(from - projected) > 2 || e.offset === projected) return 0;
  // A changed bottom can move the native scrollbar without a wheel event.
  if (atPaneBottom(e.offset, e.contentRows, e.bodyRows, 'desktop') && oldGeometry && !samePaneGeometry(oldGeometry, e) &&
      (Math.abs(e.offset - projected) <= 2 || atPaneBottom(offset, oldGeometry.contentRows, oldGeometry.bodyRows, 'desktop'))) return 0;
  return projected === offset || !current ? e.by : e.offset - projected;
}
function requestTail($, id, placement = null) {
  const page = pageFor(id);
  const pending = page.tailRequest;
  if (placement || !pending || pending.generation !== state.generation || pending.scrollGeneration !== page.scrollGeneration) {
    page.tailRequest = { token: ++navigationSequence, generation: state.generation, scrollGeneration: page.scrollGeneration, placement,
      before: { ...page.scrollGeometry, offset: state.scroll.get(id) } };
    page.tailMarkerToken = page.tailRequest.token;
  }
  return invalidate($);
}
async function revealTail($, id, token, painted = false) {
  const page = pageFor(id), request = page.tailRequest;
  if (!request || request.token !== token) return;
  request.painted ||= painted;
  if (request.running) return;
  const current = () => state.opened && state.selected === id && state.pages.get(id) === page && page.tailRequest === request &&
    request.generation === state.generation && request.scrollGeneration === page.scrollGeneration &&
    page.followTail && !state.imagePreview;
  request.running = true;
  const marker = tailKey(id, page.tailMarkerToken);
  const desktop = page.surface === 'desktop';
  const desktopDelays = [0, 32, 64, 128, 256, 512, 512];
  const delays = desktop ? desktopDelays : [0, 32, 64, 128];
  const newestDrawn = () => {
    const view = page.renderedWindow;
    return reachesTail(page, view);
  };
  const beforeMove = event => Math.max(0, Math.min(paneEnd(event), event.offset - event.by));
  const geometry = (event, offset) => ({ contentRows: event.contentRows, bodyRows: event.bodyRows, offset });
  let ready = false;
  try {
    for (const [attempt, delay] of delays.entries()) {
      if (delay) await new Promise(resolve => $.clock.after(delay, resolve));
      if (!current()) break;
      await refreshPaneGeometry($, page).catch(() => {});
      if (!current()) break;
      let sample;
      const capture = event => {
        sample = geometry(event, desktop ? beforeMove(event) : paneEnd(event));
        return sample.offset;
      };
      // A read of the end marker can overlap the first upward wheel. Only
      // the later explicit end commit should ever move the desktop pane.
      const probe = desktop ? { probing: true, observe(event) { capture(event); return { deny: probeDenial }; } } : null;
      const result = await scrollPane($, { to: { key: marker }, block: 'end' }, current, probe, desktop ? null : capture).catch(() => ({ deny: 'not painted' }));
      if (!current()) break;
      const measured = (desktop ? result?.deny === probeDenial : !result?.deny) && sample;
      const stable = measured && samePaneGeometry(request.sample, sample);
      if (measured) request.sample = sample;
      if (!desktop) {
        if (delay >= 64 && stable) break;
        continue;
      }
      // A surface acknowledgment proves the new tree is painted even when
      // the host's bounded key table has no tail marker.
      if (newestDrawn() && (stable || measured && attempt === delays.length - 1 || request.painted && delay >= 64)) {
        ready = true;
        break;
      }
    }
    if (!ready) return;
    // Give an accepted layout its own bounded end retries. A refusal can race
    // a surface report even if the first usable paint was the last probe.
    for (const delay of desktopDelays) {
      if (!current()) break;
      if (delay) {
        await new Promise(resolve => $.clock.after(delay, resolve));
        if (!current()) break;
        await refreshPaneGeometry($, page).catch(() => {});
      }
      if (!current() || !newestDrawn()) continue;
      let observed = false;
      const end = await scrollPane($, { to: 'end' }, current, null, event => {
        observed = true;
        request.sample = geometry(event, beforeMove(event));
        return event.offset;
      }).catch(() => ({ deny: 'scroll refused' }));
      if (current() && observed && !end?.deny) {
        page.nativeFollowing = true;
        page.jumpSettledAt = request.placement === 'jump' ? Date.now() : undefined;
        break;
      }
    }
  } finally {
    if (page.tailRequest === request) {
      page.tailRequest = null;
      if (state.opened && state.selected === id && state.generation === request.generation) await invalidate($);
    }
  }
}
function retryNavigationPost($, request) {
  if (!request?.ready || Date.now() < request.retryAt) return;
  request.attempt++;
  request.retryAt = Date.now() + 800;
  void invalidate($);
}
async function requestHistoryNavigation($, id, direction, automatic = false) {
  const page = pageFor(id), generation = state.generation;
  if (page.navigating || state.imagePreview) return;
  if (page.navigationRequest?.direction === direction && page.navigationRequest.generation === generation) return;
  page.shortFillDirection = direction;
  const request = { token: ++navigationSequence, direction, generation, scrollGeneration: page.scrollGeneration, resumeTail: automatic && page.followTail };
  page.navigationRequest = request; holdWindow(page);
  const current = () => state.opened && state.selected === id && state.generation === generation
    && page.navigationRequest === request && !state.imagePreview && !page.followTail;
  const needsHistory = () => direction < 0 && drawnWindow(page).start === 0 && page.cursor;
  if (needsHistory()) await invalidate($);
  let retry = !automatic;
  const prepare = async () => {
    if (!current()) return;
    if (needsHistory() && (retry || !page.historyError)) {
      retry = false;
      await history($, id, request);
      if (!current()) return;
      if (needsHistory() && !page.historyError) {
        $.clock.after(0, prepare);
        return;
      }
    }
    const view = drawnWindow(page);
    if (direction < 0 ? view.start === 0 : view.start + view.entries.length >= view.total) {
      page.navigationRequest = null;
      if (page.edgeGesture) page.edgeGesture.settled = true;
      if (request.resumeTail && page.scrollGeneration === request.scrollGeneration) page.followTail = true;
    } else {
      request.ready = true;
      request.attempt = 0;
      request.retryAt = Date.now() + 350;
      // Desktop may discard the one surface post during a remount. Redraw
      // the same token; only its first registered dispatch can claim it.
      $.clock.after(400, () => { if (current()) retryNavigationPost($, request); });
    }
    await invalidate($);
  };
  await prepare();
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
async function resizeWindow($, id, page, owner) {
  const scroller = scrollController($, id, page), gen = state.generation;
  const oldView = drawnWindow(page);
  const oldGroups = page.renderedGroups;
  const start = oldView.start, end = start + oldView.entries.length;
  const above = owner.direction < 0;
  // The boundary next to the incoming history survives opposite-side
  // eviction. That marker measures the exact prefix change in both directions.
  const anchorGroup = above ? oldGroups?.find(group => group.start === start) : oldGroups?.findLast(group => group.end === end);
  const anchored = !!anchorGroup;
  const block = page.surface === 'desktop' && !above && anchored ? 'end' : 'start';
  if (anchored && page.measureAnchor !== anchorGroup.key) {
    page.measureAnchor = anchorGroup.key;
    // Desktop drops press keys longer than 256 characters. An item identity
    // may include a full file path; only the compact token travels to the host.
    page.measureKey = `codex_read_anchor_${id}_${++navigationSequence}`;
    await invalidate($);
  }
  const measurementKey = () => anchored ? page.measureKey : historyKey(id, page);
  const before = await scroller.measure(measurementKey(), null, false, anchored, block);
  if (!before || !state.opened || state.selected !== id || gen !== state.generation || page.navigationOwner !== owner) return false;
  // Native wheel frames can be ahead of the host's last accepted position.
  // Carry the actual boundary crossing through a slow fetch and both layouts.
  if (page.surface === 'desktop') before.offset = page.edgeGesture?.offset ?? owner.preparingOffset ?? before.offset;
  page.followTail = false; page.windowAnchor = null;
  const anchorSize = anchored ? anchorGroup.end - anchorGroup.start : 0;
  page.adding = { direction: owner.direction, start, end, count: RAW_WINDOW_LIMIT - anchorSize };
  page.layoutRevision = (page.layoutRevision ?? 0) + 1;
  page.readingAnchor = null;
  if (anchored) page.measureKey = `codex_read_anchor_${id}_${++navigationSequence}`;
  if (!above) page.layoutFloor = before.contentRows;
  owner.staged = true; owner.movement = 0;
  const atEdge = above ? before.offset <= 2 : atPaneBottom(before.offset, before.contentRows, before.bodyRows, page.surface);
  const accept = (offset, sample) => {
    const newView = drawnWindow(page), newEnd = newView.start + newView.entries.length;
    const progressed = above ? newView.start < start : newEnd > end;
    const trimmed = above ? newEnd < end : newView.start > start;
    const clippedRows = above ? offset - paneEnd(sample) : -offset;
    // If the far-side cut would land inside a tall visible group, keep its
    // old frame and wait until the reader has actually passed that cut.
    owner.blocked = progressed && anchored && trimmed && clippedRows > 2 && !atEdge
      ? { direction: owner.direction, offset: before.offset + owner.movement, requiredDistance: Math.ceil(clippedRows) } : null;
    return progressed && !owner.blocked;
  };
  scroller.stage(before, above, anchored, () => owner.movement, { accept, singleShift: anchored });
  await invalidate($);
  const after = await scroller.measure(measurementKey(), before, above, anchored, block);
  if (after && page.navigationOwner === owner) {
    page.historyBlockedNavigation = null;
    if (page.surface === 'desktop') page.historyPositionedAt = Date.now();
    if (page.edgeGesture) page.edgeGesture.offset = after.offset;
    if (anchored && page.surface === 'desktop' && !page.synchronousFileLayout) {
      page.readingAnchor = { key: measurementKey(), distance: after.offset - after.anchorOffset + owner.movement - (after.movement ?? 0),
        block: after.block, anchorOffset: after.anchorOffset, movement: 0, contentRows: after.contentRows, bodyRows: after.bodyRows, sizes: new Map() };
    }
  }
  if (!after && state.opened && state.selected === id && gen === state.generation && page.navigationOwner === owner) {
    // Never reveal an unpositioned candidate when a keyed sample was refused.
    if (owner.blocked) page.historyBlockedNavigation = owner.blocked;
    page.windowStart = start; page.windowEnd = end;
    page.windowSize = Math.max(1, oldView.entries.length); page.renderedGroups = oldGroups;
    page.renderedWindow = { ...oldView, timeline: page.navigationTimeline };
    page.adding = null; page.layoutRevision++;
    await invalidate($);
    if (!state.opened || state.selected !== id || gen !== state.generation || page.navigationOwner !== owner) return false;
    await refreshPaneGeometry($, page);
    if (!state.opened || state.selected !== id || gen !== state.generation || page.navigationOwner !== owner) return false;
    const restoreOffset = () => Math.max(0, Math.min(paneEnd(before), before.offset + owner.movement));
    state.scroll.set(id, restoreOffset());
    await scrollPane($, { to: 'start' }, () => page.navigationOwner === owner, null, restoreOffset);
  }
  owner.staged = false;
  if (page.navigationOwner === owner) page.layoutFloor = null;
  return !!after && state.opened && state.selected === id && gen === state.generation && page.navigationOwner === owner;
}
async function reconcileReadingAnchor($, id, key, sensor, rows) {
  const page = pageFor(id), anchor = page.readingAnchor;
  const gesture = page.edgeGesture;
  const current = () => page.readingAnchor === anchor && state.opened && state.selected === id && !page.navigating && !page.navigationRequest && !state.imagePreview;
  if (!anchor || anchor.key !== key || !Number.isSafeInteger(rows) || rows <= 0 || !current() || anchor.sizes.get(sensor) === rows) return;
  anchor.sizes.set(sensor, rows);
  anchor.dirty = true;
  if (anchor.measuring) return;
  anchor.measuring = true;
  let retries = 0;
  try {
    while (anchor.dirty && current()) {
      anchor.dirty = false;
      await refreshPaneGeometry($, page);
      if (!current()) break;
      let sample;
      const block = anchor.block ?? 'start';
      const committed = await scrollPane($, { to: { key }, block }, current, null, event => {
        if (block === 'end' && event.offset === 0) {
          sample = { clipped: true };
          return null;
        }
        const marker = paneMarkerOffset(event, block);
        // The host reports browser scroll anchoring and wheel displacement in
        // the same way. An initial native move matching the marker's shift
        // already includes the prefix growth, so account for it only once.
        const shift = marker - anchor.anchorOffset, layout = anchor.layoutDisplacement;
        const browserDisplacement = Number.isFinite(layout) && Math.sign(shift) === Math.sign(layout) && Math.abs(shift - layout) <= 1 ? layout : 0;
        const viewport = Math.max(0, event.offset - event.by);
        const movement = anchor.movement;
        const readerDisplacement = shift === 0 ? viewport - marker - anchor.distance : movement - browserDisplacement;
        const offset = Math.max(0, Math.min(marker + anchor.distance + readerDisplacement, paneEnd(event)));
        sample = { offset, marker, movement, readerDisplacement, contentRows: event.contentRows, bodyRows: event.bodyRows };
        // The host may commit an accepted request after several more wheel
        // events. A marker that is already in place has nothing to write.
        return offset === viewport ? null : offset;
      });
      if (current() && (!committed?.deny || committed.deny === probeDenial) && sample) {
        if (sample.clipped) { anchor.block = 'start'; anchor.dirty = true; continue; }
        anchor.anchorOffset = sample.marker;
        anchor.distance += sample.readerDisplacement;
        anchor.movement -= sample.movement;
        anchor.layoutDisplacement = null;
        anchor.release ||= sample.readerDisplacement !== 0;
        anchor.contentRows = sample.contentRows; anchor.bodyRows = sample.bodyRows;
        if (anchor.movement) anchor.dirty = true;
        if (gesture && page.edgeGesture === gesture) gesture.offset = sample.offset;
        retries = 0;
      } else if (current() && retries++ < 2) {
        anchor.dirty = true;
        await new Promise(resolve => $.clock.after(32 * retries, resolve));
      }
    }
  } finally {
    anchor.measuring = false;
    if (anchor.release && current()) { page.readingAnchor = null; page.measureAnchor = null; }
  }
}
function finishHistoryNavigation(page, owner) {
  if (page.navigationOwner !== owner) return false;
  const previous = drawnWindow(page), first = previous.entries[0], last = previous.entries.at(-1);
  const snapshot = page.navigationTimeline;
  if (first && page.disclosurePrefix?.upper && entryKey(first) !== page.disclosurePrefix.key) page.disclosurePrefix = null;
  page.navigationTimeline = null; page.adding = null; page.navigating = false; page.navigationOwner = null;
  page.layoutFloor = null;
  page.bandIntent = 0;
  if (!page.readingAnchor) page.measureAnchor = null;
  if (page.edgeGesture) { page.edgeGesture.settled = true; page.edgeGesture.lastAt = Date.now(); }
  if (snapshot && !page.followTail && first && last) {
    const all = page.timeline ??= conversationEntries(page.live, page);
    if (all !== snapshot) {
      const indices = new Map(all.map((entry, index) => [entryKey(entry), index]));
      const start = indices.get(entryKey(first)), end = indices.get(entryKey(last));
      if (start !== undefined && end >= start) {
        page.windowStart = start; page.windowEnd = end + 1; page.windowSize = end - start + 1;
      }
      page.renderedGroups = page.renderedGroups?.flatMap(group => {
        const start = indices.get(group.key), last = snapshot[group.end - 1];
        const end = last && indices.get(entryKey(last));
        return start !== undefined && end >= start ? [{ ...group, start, end: end + 1 }] : [];
      });
    }
  }
  return true;
}
async function browseHistory($, id, direction) {
  const page = pageFor(id), gen = state.generation;
  if (page.navigating || state.imagePreview) return;
  const owner = { direction }; page.navigationOwner = owner;
  page.readingAnchor = null;
  page.navigating = true; holdWindow(page);
  try {
    let view = drawnWindow(page);
    if (direction < 0 && view.start === 0 && page.cursor) {
      await history($, id);
      if (gen !== state.generation || state.selected !== id || page.navigationOwner !== owner) return;
      view = drawnWindow(page);
    }
    if (direction < 0 ? view.start === 0 : view.start + view.entries.length >= view.total) return;
    // Polls can keep merging into the cache. Measure both frames against the
    // same transcript so no unrelated layout change enters their displacement.
    page.navigationTimeline = page.timeline ??= conversationEntries(page.live, page);
    return await resizeWindow($, id, page, owner);
  } finally {
    if (finishHistoryNavigation(page, owner) && state.opened && state.selected === id && gen === state.generation) {
      void invalidate($);
      queueProcessHydration($, id, page);
    }
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
      const before = drawnWindow(page);
      const changed = mergeLive(page, result.entries, true, result.turns), cursorChanged = JSON.stringify(page.cursor) !== JSON.stringify(result.next_cursor ?? null);
      const retained = changed && retainedHistoryWindow(page, before);
      if (retained) {
        page.windowStart = retained.start;
        page.windowEnd = retained.start + retained.count;
        page.windowSize = Math.max(1, retained.count);
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
  async function history($, id, navigation = null) {
    const page = pageFor(id), gen = state.generation, cursor = page.cursor;
    if (!cursor) return;
    if (page.historyLoading) return page.historyRequest?.promise;
    const scrollGen = page.scrollGeneration, request = {};
    request.promise = new Promise(resolve => { request.finish = resolve; });
    let continueHistory = false, changed = false, loaded = false;
    page.historyLoading = true; page.historyRequest = request;
    if (!navigation) void invalidate($);
    try {
      const result = await prefetchHistory($, id);
      if (!state.opened || state.selected !== id || state.generation !== gen) return;
      page.historyPrefetches?.delete(JSON.stringify(cursor));
      if (result.error || result.offline || !Array.isArray(result.entries)) throw new Error(failureText(result));
      if (result.next_cursor && JSON.stringify(result.next_cursor) === JSON.stringify(cursor)) throw new Error('历史读取位置未推进');
      const previous = drawnWindow(page);
      changed = mergeLive(page, result.entries, true, result.turns);
      const retained = changed && retainedHistoryWindow(page, previous);
      if (retained) {
        const drop = previous.entries.length - retained.count, delta = retained.start - previous.start - drop;
        page.windowStart = retained.start; page.windowEnd = retained.start + retained.count;
        page.windowSize = Math.max(1, retained.count);
        if (page.renderedGroups) page.renderedGroups = page.renderedGroups.filter(group => group.start >= previous.start + drop)
          .map(group => ({ ...group, start: group.start + delta, end: group.end + delta }));
      } else if (changed && !page.followTail && !previous.entries.length) {
        // There was no readable anchor to preserve (for example a page of
        // filtered reasoning records). Do not retain an empty [0, 0) window.
        const count = Math.min(VISIBLE_ENTRIES, timelineWindow(page).total);
        page.windowStart = 0; page.windowEnd = count; page.windowSize = Math.max(1, count);
      }
      page.cursor = result.next_cursor ?? null; page.historyError = '';
      page.historyPage = (page.historyPage ?? 0) + 1;
      continueHistory = !changed && Boolean(page.cursor) && page.scrollGeneration === scrollGen;
      loaded = true;
    } catch (error) { if (state.opened && state.selected === id && state.generation === gen) page.historyError = `无法读取对话记录：${failureText(error)}。请重试。`; }
    finally {
      try {
        if (page.historyRequest === request) {
          page.historyLoading = false; page.historyRequest = null;
          if (state.opened && state.selected === id && state.generation === gen) {
            // The owning edge request paints loading and readiness once. A
            // cursor containing only folded operations has nothing to redraw.
            if (!navigation || page.navigationRequest !== navigation) await invalidate($);
            if (loaded) queueHistoryPrefetch($, id);
            if (continueHistory && !page.navigationRequest && !page.navigating && page.scrollGeneration === scrollGen) $.clock.after(0, () => history($, id));
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
    const selected = id ? state.agents.find((agent) => idOf(agent) === id) : mostRecentAgent(state.agents);
    if (selected) await select($, idOf(selected), gen);
    else { state.selected = null; state.opening = false; if (!state.error) state.error = id ? '未找到此代理。请重新读取代理列表。' : '当前会话没有可打开的 Codex 代理。'; await invalidate($); }
    if (!current()) return;
    const result = await $.ui.open({ id: PANE, title: 'Codex', focus: true, closeOnEscape: true, rows: 24 });
    if (!current()) return;
    geometryPulse = false;
    state.opening = false;
    if (result.isPlaced === false) { state.opened = false; state.generation++; return; }
    if (state.selected) await requestTail($, state.selected, 'open');
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
    if (page.pendingCopy?.key === key && page.pendingCopy.generation === generation) return;
    const intent = ++copyIntent, feedback = { key, intent, generation };
    const current = () => intent === copyIntent && state.opened && state.selected === id && state.generation === generation;
    const toast = surface === 'desktop';
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
        if (toast) {
          if (page.copyFeedback?.key === key) {
            page.copyFeedback = null;
            page.renderCache = null;
          }
          $.ui.toast('已复制', { timeoutMs: 1600 });
          return;
        }
        update('copied');
        $.clock.after(1600, async () => {
          if (!current() || page.copyFeedback?.intent !== intent) return;
          page.copyFeedback = null;
          await invalidate($);
        });
      } catch (error) {
        if (!current()) return;
        const message = `复制失败：${failureText(error)}`;
        if (toast) $.ui.toast(message);
        else update('failed', { text: message });
      } finally {
        if (page.pendingCopy === feedback) page.pendingCopy = null;
      }
    };
    page.pendingCopy = feedback;
    if (!toast) page.copyFeedback = { ...feedback, phase: 'pending' };
    // Keep the clipboard call in the native Button's own closure so desktop
    // can associate it with the press. The host need not await clipboard I/O.
    void execute();
    if (!toast && page.copyFeedback?.phase === 'pending') void invalidate($);
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
    const desktop = page?.surface === 'desktop', originOffset = e.offset - e.by;
    const oldGeometry = page?.scrollGeometry, geometry = { contentRows: e.contentRows, bodyRows: e.bodyRows };
    const viewportOffset = state.scroll.get(id) ?? Math.max(0, originOffset);
    const owner = page?.navigationOwner;
    if (page?.bandExposure) {
      const transaction = page.bandExposure;
      // A reversal before placement stays on the old, still visible strip.
      if (e.by > 0 && transaction.target == null && Math.abs(e.offset - e.by - transaction.offset) <= 2) {
        transaction.frame.rows = transaction.rows; page.bandExposure = null; void invalidate($);
      } else return next(e);
    }
    const nativeTarget = owner?.staged ? page.scroller?.nativeTarget : null;
    // Only a real placement can reset the native origin during a transaction.
    // Once a packet starts there, later packets must continue from its end.
    const fromCommit = nativeTarget && samePaneGeometry(nativeTarget, e) && Math.abs(originOffset - nativeTarget.offset) <= 2;
    const movement = desktop ? desktopMovement(e, fromCommit && Math.abs(originOffset - viewportOffset) > 2 ? nativeTarget.offset : viewportOffset, oldGeometry) : e.by;
    if (desktop && owner) {
      if (!movement) return next(e);
      if (fromCommit) page.scroller.consumeNativeTarget();
      const reversing = Math.sign(movement) !== owner.direction;
      if (owner.staged) {
        // After staging only displacement is portable between the two frames.
        // Scrolling toward more history is as intentional as going back.
        owner.movement += movement;
        if (reversing) { page.edgeGesture = null; page.shortFillDirection = Math.sign(movement); }
        page.scrollGeneration++;
        page.scrollGeometry = geometry;
        state.scroll.set(id, e.offset);
        return next(e);
      }
      if (!reversing) {
        owner.preparingOffset = e.offset;
        if (page.edgeGesture) page.edgeGesture.offset = e.offset;
        state.scroll.set(id, e.offset);
        page.scrollGeometry = geometry;
        return next(e);
      }
      page.edgeGesture = null;
      page.shortFillDirection = Math.sign(movement);
      page.scroller?.cancel(); page.scroller = null;
      finishHistoryNavigation(page, owner);
      void invalidate($);
    }
    const gesture = page?.edgeGesture;
    const anchor = page?.readingAnchor;
    const sameGesture = desktop && gesture && direction === gesture.direction && (!gesture.settled || now - gesture.lastAt < desktopWheelQuietMs);
    if (desktop && direction && Math.abs(originOffset - viewportOffset) > 2 && (!samePaneGeometry(oldGeometry, e) || !movement)) {
      const obsolete = page.obsoleteScroll;
      const repeated = obsolete?.offset === e.offset && obsolete.by === e.by && samePaneGeometry(obsolete, e);
      if (repeated || anchor?.measuring || now - (page.historyPositionedAt ?? -Infinity) < desktopWheelQuietMs) {
        page.obsoleteScroll = { ...geometry, offset: e.offset, by: e.by };
        return next({ ...e, offset: viewportOffset });
      }
    }
    if (movement) page.obsoleteScroll = null;
    const pendingDirection = page?.navigationRequest?.direction ?? (gesture && !gesture.settled ? gesture.direction : 0);
    if (desktop && direction && direction === pendingDirection) retryNavigationPost($, page.navigationRequest);
    if (desktop && pendingDirection && direction === -pendingDirection && !movement) return next({ ...e, offset: viewportOffset });
    const anchorLayoutChanged = anchor && !samePaneGeometry(anchor, e);
    if (anchorLayoutChanged && !movement) {
      // The prefix's size report accounts for layout-driven movement. Keep
      // the measured geometry so a wheel that arrives first can coexist with it.
      return next(e);
    }
    // Desktop sends RAF-coalesced movement, not wheel phases. Packets from
    // the same physical burst may reference either side of the prepend.
    if (sameGesture && (!gesture.settled || !movement)) {
      if (!gesture.settled) {
        // A slow cache read has not changed the drawn window. Let the reader
        // reach its real edge and carry that last position into the prepend.
        gesture.lastAt = now;
        gesture.offset = e.offset; state.scroll.set(id, e.offset);
      }
      return next({ ...e, offset: gesture?.offset ?? state.scroll.get(id) ?? Math.max(0, e.offset - e.by) });
    }
    if (direction && gesture) {
      const remaining = direction < 0 ? e.offset : paneEnd(e) - e.offset;
      const margin = historyMargin(e, desktop);
      const crossed = remaining <= margin && remaining + Math.abs(movement) > margin;
      if (!sameGesture || gesture.settled && movement && (crossed || remaining <= 2)) page.edgeGesture = null;
    }
    const atBottom = atPaneBottom(e.offset, e.contentRows, e.bodyRows, page?.surface);
    const tail = page?.tailRequest;
    if (desktop && page.nativeFollowing && !page.windowAnchor) {
      const end = paneEnd(e);
      if (direction >= 0) return next({ ...e, offset: end });
      // A queued wheel from the replaced window can arrive just after the
      // jump. Forgive one mismatched start while that packet can be in flight.
      const justJumped = now - page.jumpSettledAt < 150;
      page.jumpSettledAt = undefined;
      if (justJumped && Math.abs(originOffset - end) > 2) return next({ ...e, offset: end });
    }
    if (page) page.scrollGeometry = geometry;
    if (tail?.placement) {
      const prior = tail.sample ?? tail.before;
      const sameFrame = samePaneGeometry(prior, e);
      // Native clamping during the window swap also arrives as person input.
      // Genuine wheel input from the measured viewport can cancel the jump.
      const fromCurrent = sameFrame && Math.abs(originOffset - prior.offset) <= 2;
      if (desktop ? !fromCurrent : !tail.sample || !sameFrame && (direction >= 0 || atBottom)) return next(e);
    }
    // Desktop reports content growth/resizing as person scrolls even when the
    // viewport did not move. That is not an instruction to stop live following.
    const view = page && drawnWindow(page);
    const newest = reachesTail(page, view);
    const grew = oldGeometry && e.contentRows - e.bodyRows > oldGeometry.contentRows - oldGeometry.bodyRows;
    if (page && !page.scroller?.pending && (e.by === 0 || page.followTail && tail && !page.windowAnchor && newest && direction > 0)) {
      // A mounted Markdown leaf can grow after the first placement and before
      // any new message arrives. One request covers repeated resize reports.
      if (page.followTail && grew && !atBottom && state.opened &&
          !tail && !page.navigating && !page.navigationRequest && !page.windowAnchor) void requestTail($, id);
      return next(e);
    }
    const controller = page && scrollController($, id, page);
    const intent = controller?.intent, observed = controller?.observe(e);
    if (controller && controller.intent === intent) return next(observed);
    if (direction && page) {
      if (anchor && movement && !page.hasHistoryBands && (anchorLayoutChanged || anchor.measuring || anchor.movement)) {
        // The browser can report a wheel after the prefix grew, while the
        // size observer is still in flight. Preserve the reader's motion as
        // well as the growth, then release the reconciled marker.
        if (anchorLayoutChanged) anchor.layoutDisplacement ??= movement;
        anchor.movement += movement;
        if (anchor.measuring) anchor.dirty = true;
      } else if (anchor) { page.readingAnchor = null; page.measureAnchor = null; }
      page.historyApproach = direction; page.boundary = null;
      if (movement && page.openTurns?.size) {
        page.processDirection = direction;
        queueProcessHydration($, id, page);
      }
      if (movement && page.disclosurePlacement?.minHeight) { page.disclosurePlacement.minHeight = 0; void invalidate($); }
    }
    if (e.origin.kind === 'person' && id) {
      const wasFollowing = page.followTail;
      page.nativeFollowing = false;
      page.tailRequest = null;
      if (page.navigationRequest && movement && Math.sign(movement) !== page.navigationRequest.direction) {
        page.navigationRequest = null;
        page.shortFillDirection = Math.sign(movement);
        void invalidate($);
      }
      const previousOffset = state.scroll.get(id);
      state.scroll.set(id, e.offset); page.scrollGeneration++;
      if (sameGesture && gesture.settled) gesture.offset = e.offset;
      const stableGeometry = !oldGeometry || samePaneGeometry(oldGeometry, e);
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
      if (page.followTail && page.lowerBand?.open && view.start + view.entries.length < view.total) {
        page.followedBandWindow = { timeline: view.timeline, start: view.start, end: view.start + view.entries.length };
      } else if (!page.followTail) page.followedBandWindow = null;
      page.awayFromBottom = !page.followTail;
      if (!wasFollowing && page.followTail && page.surface === 'desktop') void requestTail($, id);
    }
    // Return the wheel dispatch immediately. History, state writes and paint
    // barriers run outside the host's scroll request chain.
    if (direction && id && state.opened && !page.navigating && !page.navigationRequest && !page.edgeGesture) {
      const threshold = historyMargin(e, desktop);
      if (e.by < 0 && e.offset <= threshold && page.cursor) prefetchHistory($, id);
      const earlier = direction < 0 && e.offset <= threshold && (view.start > 0 || page.cursor);
      const nearEnd = e.offset >= paneEnd(e) - threshold;
      const later = direction > 0 && nearEnd && !newest;
      const blocked = page.historyBlockedNavigation;
      const atEdge = direction < 0 ? e.offset <= 1 : atBottom;
      const retryDistance = Math.max(1, blocked?.requiredDistance || 0, Math.min(e.bodyRows, Math.ceil(threshold / 3)));
      if (page.hasHistoryBands && direction < 0 && restoreBandOnApproach(page, e)) {
        void invalidate($); return next(e);
      }
      if (page.hasHistoryBands && later && promoteLowerBand(page, e)) {
        void invalidate($); return next(e);
      }
      if (page.hasHistoryBands && earlier && promoteUpperBand(page, e)) {
        if (atEdge) waitForUpperBand($, id, page);
        void invalidate($);
        return next(e);
      }
      if (page.hasHistoryBands && earlier && atEdge && page.upperBand?.groups?.[0]?.start === 0 &&
          !page.cursor && page.upperBand.rows >= page.upperBand.naturalRows && page.upperBand.naturalRows > 0) {
        return next(e);
      }
      if (page.hasHistoryBands && earlier && atEdge && page.upperBand?.naturalRows > page.upperBand.rows) {
        exposeUpperBand($, id, page, e.offset);
        return next(e);
      }
      if (page.hasHistoryBands && earlier && atEdge && page.upperBand?.groups?.[0]?.start === 0 && page.cursor && !page.historyError) {
        page.historyApproach = -1;
        void history($, id);
        return next(e);
      }
      if (page.hasHistoryBands && (earlier || later) && !atEdge) {
        // The adjacent native rows already belong to the scrollable pane.
        // Warm the continuation while the reader crosses them. Rebuilding the
        // in-flow window here would displace the visible text by whole cells.
        if (page.bandIntent !== direction) {
          page.bandIntent = direction;
          if (later && page.lowerBand) {
            page.lowerBand.open = true;
            if (page.lowerBand.naturalRows) page.lowerBand.rows = page.lowerBand.naturalRows + 1;
          }
          if (earlier && page.cursor && page.bandCanMerge) void history($, id);
          else void invalidate($);
        }
        return next(e);
      }
      if ((earlier || later) && (!blocked || blocked.direction !== direction || atEdge || (e.offset - blocked.offset) * direction >= retryDistance)) {
        page.historyApproach = 0;
        page.readingAnchor = null; page.measureAnchor = null;
        const gesture = page.edgeGesture = { direction, lastAt: now, offset: e.offset, settled: false };
        $.clock.after(0, () => {
          if (state.opened && state.selected === id && gen === state.generation && page.edgeGesture === gesture) return requestHistoryNavigation($, id, direction);
        });
      }
    }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE, origin: { kind: 'plugin' } }, ($, e, next) => {
    const transfer = state.programmaticScroll;
    if (transfer && !transfer.valid()) return { deny: 'obsolete navigation' };
    if (state.view === 'directory') {
      const offset = directory.restore?.offset ?? e.offset;
      directory.offset = offset;
      return next({ ...e, offset });
    }
    const id = state.selected, page = id && pageFor(id);
    if (!page) return next(e);
    if (transfer?.controller?.probing) return transfer.controller.observe(e);
    page.scrollGeometry = { contentRows: e.contentRows, bodyRows: e.bodyRows };
    if (transfer?.targetOffset) {
      transfer.offset = transfer.targetOffset(e);
      if (transfer.offset === null) return { deny: probeDenial };
      return next({ ...e, offset: transfer.offset });
    }
    // Keyed placements release Desktop's native end-follow mode.
    page.nativeFollowing = false;
    if (transfer?.controller?.pending) {
      const observed = transfer.controller.observe(e);
      return observed.deny ? observed : next(observed);
    }
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
    if (!action) return next(e);
    await action();
    return { element: e.element };
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
    if (e.data?.action === 'history-band-part-size') {
      const frame = pageFor(state.selected).upperBand, { key, part, rows } = e.data;
      if (frame?.token === key && Number.isInteger(part) && part >= 0 && part < (frame.partCounts?.length ?? 0) &&
          e.element === `codex_band_part_${state.selected}_${part}` && Number.isFinite(rows) && rows > 0) frame.partRows[part] = rows;
      return {};
    }
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'expose-band') {
      await placeExposedBand($, state.selected, pageFor(state.selected), e.data.token);
      return {};
    }
    if (e.data?.action === 'history-band-size') {
      const page = pageFor(state.selected);
      const upper = e.element === `codex_band_size_${state.selected}_above`;
      const lower = e.element === `codex_band_size_${state.selected}_below`;
      const frame = upper ? page.upperBand : lower ? page.lowerBand : null;
      if (frame && frame.token === e.data.key && Number.isSafeInteger(e.data.rows) && e.data.rows > 0) {
        if (e.data.rows + (lower ? 1 : 0) > maxBandRows) {
          // A single native band requires an explicit Box height. Use the
          // ordinary measured window at this width when the content exceeds it.
          page.bandGeometryLimit = frame.columns;
          page.bandTrail = null;
          page.waitingBand = null;
          page.resumeOnBandSize = false;
          if (page.bandExposure?.frame === frame) page.bandExposure = null;
          await invalidate($);
          return {};
        }
        frame.naturalRows = e.data.rows;
        if (lower && frame.open && frame.rows !== frame.naturalRows + 1) {
          frame.rows = frame.naturalRows + 1; await invalidate($);
        }
        if (upper && page.resumeOnBandSize) {
          page.resumeOnBandSize = false;
          if (await resumeUpperBand($, state.selected, page)) return {};
        }
        if (upper && page.waitingBand && page.waitingBand === page.bandCore && frame.rows === 0) {
          page.waitingBand = null;
          const offset = state.scroll.get(state.selected) || 0;
          if (offset <= 1) exposeUpperBand($, state.selected, page, offset);
        }
        if (upper && page.followTail && !page.navigationOwner && !page.navigationRequest) {
          const rows = frame.naturalRows;
          if (rows > frame.rows) { frame.rows = rows; await invalidate($); }
          if (page.primeHistoryPages > 0 && frame.groups?.[0]?.start === 0 && page.cursor && !page.historyLoading && !page.historyError) {
            page.primeHistoryPages--; void history($, state.selected);
          }
        }
      }
      return {};
    }
    if (e.data?.action === 'history-size' && (e.element === `codex_prefix_size_${state.selected}_timeline` || e.element === `codex_prefix_size_${state.selected}_file`)) {
      await reconcileReadingAnchor($, state.selected, e.data.key, e.element, e.data.rows);
      return {};
    }
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'edge') {
      const id = state.selected, page = pageFor(id), generation = state.generation;
      const boundary = page.boundary?.token === e.data.token ? page.boundary : null;
      if (!e.data.token || (e.data.token !== page.edgeKey && !boundary) || page.lastEdgeRequest === e.data.token || page.navigating || page.navigationRequest || page.tailRequest || state.imagePreview) return {};
      page.lastEdgeRequest = e.data.token;
      const direction = e.data.direction === 1 ? 1 : -1;
      if (boundary) {
        page.historyApproach = 0;
        page.boundary = null;
        if (direction < 0 && page.hasHistoryBands && await resumeUpperBand($, id, page)) return {};
      }
      const scrollGeneration = page.scrollGeneration;
      $.clock.after(0, () => {
        if (!state.opened || state.selected !== id || state.generation !== generation || page.scrollGeneration !== scrollGeneration || page.navigationRequest || page.navigating || page.tailRequest || state.imagePreview) return;
        if (boundary) page.edgeGesture = { direction, lastAt: Date.now(), offset: boundary.offset, settled: false };
        return requestHistoryNavigation($, id, direction, true);
      });
      return {};
    }
    if (e.element === `codex_navigation_sync_${state.selected}` && e.data?.action === 'tail') {
      await revealTail($, state.selected, e.data.token, true);
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
    const now = new Date();
    const frameKey = JSON.stringify([state.generation, paneRevision, now.toDateString(), e.surface, e.props?.bodyColumns, e.props?.scroll?.bodyRows, currentPage?.navigationRequest?.token, currentPage?.navigationRequest?.attempt, currentPage?.tailRequest?.token]);
    const cached = state.pages.get(state.selected)?.renderCache;
    const draft = state.controls.get(state.selected)?.draft;
    if (cached?.key === frameKey && cached.draft === draft) return cached.draw(e.props?.scroll);
    const id = state.selected, generation = state.generation;
    const native = $.ui.resolve(e);
    const budget = nativeRenderBudget(native, {
      copy: (text, key) => {
        if (state.generation === generation) copyWithFeedback($, id, `full-content:${key}`, e.surface, text);
      },
      copyLabelWidth,
      copyLabel: key => {
        const feedback = state.pages.get(id)?.copyFeedback;
        return feedback?.key === `full-content:${key}` && feedback.generation === generation ? copyLabels[feedback.phase] : null;
      },
    });
    const { Box, Text, Button, Input, Markdown, Image, Code, Svg, Client } = budget.ui;
    const selected = state.agents.find((agent) => idOf(agent) === id);
    if (state.opening && !selected) return Text({ size: 'caption', dimColor: true, children: ['正在打开对话…'] });
    if (!selected) return Box({ key: 'codex_recovery', flexDirection: 'column', gap: 'sm', children: [Text({ size: 'caption', dimColor: true, children: [state.error || '重新读取代理列表以恢复对话。'] }), Button({ key: 'codex_retry', variant: 'secondary', label: '重新读取', onPress: () => openAgent($, state.requested) })] });
    const page = pageFor(id), control = controlFor(id);
    page.surface = e.surface;
    const copyTarget = e.surface === 'desktop' ? retainedCopyButtons(page, generation, native.Button, budget) : Button;
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
    const jump = async (registered = false) => {
      if (state.generation !== generation || state.selected !== id || page.tailRequest?.placement === 'jump') return;
      resetTailWindow(page);
      const invalidation = requestTail($, id, 'jump');
      const token = page.tailRequest.token;
      await invalidation;
      // Keep the registered click frame alive even if a window swap suspends
      // the sync Client. Both paths share the same request.
      if (e.surface === 'desktop' && registered) await revealTail($, id, token);
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
      const press = event => { if (state.generation === generation) onPress(event); };
      const labelPadding = Math.max(label.length, copyLabelWidth) - name.length;
      if (e.surface !== 'desktop' || typeof Svg !== 'function') return budget.reserveChars(Button({ key, plain: true, label: name, onPress: press }), labelPadding);
      const source = copyIcons[feedback?.phase] || copyIcon;
      const control = nativeGraphicButton({ Box, Button: copyTarget }, { key, label: name, onPress: press, width: 3, children: [
        Svg({ key: `${key}_icon`, source, alt: name, width: 15, height: 15 }),
      ] });
      // Feedback paints over the same control. Budget for the largest icon and
      // label from the first frame so copy cannot change the transcript window.
      return budget.reserveChars(hint(`${key}_hint`, control, name, 18, 0, !!status), 3 * labelPadding, 3 * labelPadding + copyIconSize - source.length);
    };
    const disclosure = (key, label, onPress, entry, integration = false, expanded) => {
      const activate = entry && entry.type !== 'turnSummary' ? (...args) => {
        page.scrollGeneration++; page.readingAnchor = null; page.historyApproach = 0; page.boundary = null;
        if (!page.followTail) holdWindow(page); page.windowAnchor = entryKey(entry);
        // Request the reading anchor without blocking the visible disclosure.
        if (!page.scroller?.pending) scrollPane($, { to: { key }, block: 'nearest' }).catch(() => {});
        return onPress(...args);
      } : onPress;
      const vector = typeof expanded === 'boolean' && e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function';
      if (entry?.type === 'turnSummary' && e.surface === 'desktop') {
        return nativeGraphicButton({ Box, Button: copyTarget }, { key, label, onPress: activate, gap: 0, dimColor: true, children: [
          Text({ key: `label_${key}`, dimColor: true, children: [label] }),
          typeof Svg === 'function' ? Svg({ key: `icon_${key}`, source: disclosureIcon(expanded), alt: expanded ? '收起过程' : '展开过程', width: 12, height: 12 })
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
    const jumpControl = suffix => {
      const key = `codex_jump_${id}_${suffix}`;
      if (e.surface === 'desktop' && typeof Svg === 'function' && typeof Client === 'function') {
        return hint(`codex_jump_hint_${id}_${suffix}`, iconButton(key, { source: jumpIcon, label: '回到最新消息', size: 28, width: 4, height: 2, onPress: () => jump(true) }), '回到最新消息', 18, -7);
      }
      if (e.surface === 'desktop') control.navigationActions.set(key, () => jump(true));
      return Button({ key, plain: true, label: '↓ 最新消息', onPress: () => jump() });
    };
    // The host owns scrolling. History controls stay in the transcript; the
    // single jump control is positioned by the cheap frame wrapper below.
    const historyBusy = page.historyLoading || page.navigating || page.navigationRequest;
    const historySpinner = e.surface === 'desktop' && typeof Svg === 'function'
      ? Svg({ key: `codex_history_spinner_${id}`, source: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#888" stroke-opacity=".25" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#888" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur=".8s" repeatCount="indefinite"/></path></svg>', alt: '正在加载历史消息', width: 14, height: 14, isInteractive: true })
      : caption(`codex_history_loading_label_${id}`, '…');
    navigation.push(Box({ key: `codex_history_bar_${id}`, height: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', children: [
      Box({ flexDirection: 'row', alignItems: 'center', gap: 'xs', children: [
        Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key: historyKey(id, page), plain: true, label: '·', onPress: () => {} })] }),
        Box({ key: `codex_history_loading_${id}`, width: 2, height: 1, children: historyBusy ? [historySpinner] : [] }),
      ] }),
    ] }));
    if (state.error) navigation.push(caption('codex_open_error', state.error));
    if (state.error || page.liveError || page.historyError) {
      if (page.liveError) navigation.push(caption('codex_update_error', page.liveError));
      if (page.historyError) navigation.push(caption('codex_history_error', page.historyError));
      navigation.push(disclosure('codex_retry_conversation', '重新读取', async () => { if (state.error) return openAgent($, id); if (page.cursor && page.historyError) return history($, id); page.historyChecked = false; await poll($); }));
    }
    const fileBuffer = (key, children) => Box({ key: `file_buffer_${key}`, flexDirection: 'column', gap: 0, minWidth: 0, children });
    const markerGroup = (start, key, children) => Box({ key: `activity_read_anchor_${id}:${start}`, position: 'relative', flexDirection: 'column', minWidth: 0, children: [
      Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key, plain: true, label: '·', onPress: () => {} })] }), ...children,
    ] });
    const measureBodies = e.surface === 'desktop' && Number.isFinite((page.scrollGeometry ?? e.props?.scroll)?.bodyRows);
    const bodyAnchor = key => compactKey(`codex_body_start_${key}`, 200);
    const bodyContent = (key, node, truncated) => {
      if (!measureBodies || !truncated) return node;
      const anchor = bodyAnchor(key), placement = page.disclosurePlacement;
      return markerGroup(key, (placement?.key === anchor && placement.marker) || anchor, [node]);
    };
    const bodyToggle = (buttonKey, key, label, entry, collapsing, change) => {
      if (!measureBodies) return disclosure(buttonKey, label, async () => {
        const pending = change();
        await invalidate($);
        return pending;
      });
      // The control moves to the end of the expanded text. Measure the original
      // passage instead so opening it never asks the host to reveal its new end.
      const activate = () => placeDisclosure($, id, page, {
        key: bodyAnchor(key), entry, generation, geometry: e.props?.scroll, keepHeight: collapsing, inline: true,
      }, () => { void change(); });
      control.navigationActions.set(buttonKey, activate);
      return disclosure(buttonKey, label, activate);
    };
    const groupCost = node => {
      const cost = budget.cost(node);
      // The reading marker wraps its group. Either prefix observer can wrap
      // another group once, since the timeline prefix excludes the anchor file.
      return { ...cost, depth: cost.depth + 1 };
    };
    const renderGroup = record => {
      const group = record.group;
      const first = group.items[0], groupKey = `${id}:${entryKey(first)}:group`, folded = !state.folds.has(groupKey);
      const groupRows = [], rowGap = e.surface === 'desktop' ? 0.7 : 'sm';
      const groupBox = (children) => {
        const key = entryKey(first), props = { key: `activity_group_${id}:${key}`, flexDirection: 'column', rowGap, minWidth: 0 };
        const groupTree = Box({ ...props, children });
        // Leave room for both neighbours. A single nearly-full tree otherwise
        // rejects every prepend/append and traps navigation on the same item.
        const paginate = (limit = pageGroupLimit) => {
          if (budget.fits(groupTree, limit)) return groupTree;
          const parts = budget.pages(groupTree, limit);
          page.contentPages ??= new Map();
          const current = Math.max(0, Math.min(page.contentPages.get(key) ?? 0, parts.length - 1));
          const turn = value => { page.contentPages.set(key, value); return invalidate($); };
          return Box({ ...props, key: `activity_paged_${id}:${key}`, children: [parts[current], Box({ key: `content_pages_${id}:${key}`, flexDirection: 'row', gap: 'sm', children: [
            ...(current > 0 ? [Button({ key: `content_prev_${id}:${key}`, plain: true, label: '上一页内容', onPress: () => turn(current - 1) })] : []),
            caption(`content_page_${id}:${key}`, `内容 ${current + 1} / ${parts.length}`),
            ...(current + 1 < parts.length ? [Button({ key: `content_next_${id}:${key}`, plain: true, label: '下一页内容', onPress: () => turn(current + 1) })] : []),
          ] })] });
        };
        const node = paginate();
        // Adjacent file chunks share one wrapper in the final tree. Counting
        // it with each chunk keeps the planner safe even for scattered files.
        const cost = groupCost(first.fileView?.kind === 'chunk' ? fileBuffer(first.fileView.key, [node]) : node);
        return { node, cost, ...(first.fileView ? {} : { paginate }) };
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
          const key = `turn_process_${id}:${entry.turn_id}`, label = durationLabel(entry.duration_ms, entry.status);
          if (!entry.hasProcess) {
            if (Number.isFinite(entry.duration_ms)) itemRows.push(caption(key, label));
          } else {
            const activate = () => toggleTurnProcess($, id, page, key, entry, generation, e.props?.scroll);
            control.navigationActions.set(key, activate);
            itemRows.push(disclosure(key, label, activate, entry, false, entry.open));
          }
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
          message.push(bodyContent(key, shown?.external ? Text({ key: `message_${key}`, size: 'body', children: [text] }) : Markdown({ key: `message_${key}`, text: normalizeMessageMarkdown(text, { nativeMath: e.surface === 'desktop' }) }), truncated));
          if (entry.type === 'agentMessage' && entry.message?.is_final) {
            const copy = (press = {}) => copyMessage($, id, entry, press.surface ?? e.surface);
            const action = copyButton(`message_copy_${key}`, entryKey(entry), '复制回复', copy);
            const time = finalTimestamp(entry.completed_at_ms ?? page.turns?.get(entry.turn_id)?.completed_at_ms, now);
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
          if (truncated) message.push(bodyToggle(`item_${key}`, key, bodyActive && !loaded?.error ? '收起' : loaded?.error && bodyOpen ? '重试读取正文' : '展开全文', entry, bodyActive, () => {
            if (bodyActive && !loaded?.error) { state.folds.delete(bodyKey); page.detailRequests.delete(cacheKey); return; }
            state.folds.add(bodyKey);
            if (local || (loaded && !loaded.error)) return;
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
            const contents = [bodyContent(key, shown?.external ? Text({ key: `communication_${key}`, size: 'body', children: [text] }) : Markdown({ key: `communication_${key}`, text: normalizeMessageMarkdown(text, { nativeMath: e.surface === 'desktop' }) }), entry.communication.truncated)];
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
            if (entry.communication.truncated) itemRows.push(bodyToggle(`communication_detail_${key}`, key, bodyActive && !loaded?.error ? '收起' : bodyOpen && loaded?.error ? '重试读取正文' : '展开全文', entry, bodyActive, () => {
              if (bodyActive && !loaded?.error) { state.folds.delete(bodyKey); page.detailRequests.delete(cacheKey); return; }
              state.folds.add(bodyKey);
              if (loaded && !loaded.error) return;
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
      const field = choice === 'continue' ? 'privateTask' : 'reportFinal';
      const checked = !!control[field];
      const key = `codex_delivery_choice_${id}`;
      const setChoice = () => {
        if (control.sending || state.selected !== id || deliveryChoice(state.agents.find(agent => idOf(agent) === id)) !== choice) return;
        if (!!control[field] !== checked) return;
        control[field] = !checked;
        return invalidate($);
      };
      control.navigationActions.set(key, setChoice);
      const label = choice === 'continue'
        ? (checked ? '单独提问 · 切换为继续 Claude 的任务' : '继续 Claude 的任务 · 切换为单独提问')
        : `${checked ? '☑' : '☐'} 把本轮最终回复发给 Claude`;
      composer.push(Button({ key, plain: true, label, onPress: setChoice }));
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
    const exposure = page.bandExposure;
    const navigationProps = { token: page.navigationRequest?.ready ? page.navigationRequest.token : 0, attempt: page.navigationRequest?.attempt || 0, tailToken: page.tailRequest?.token || 0,
      exposure: exposure ? `${exposure.token}/${exposure.attempt}` : '' };
    const tailMarker = Box({ position: 'absolute', bottom: 0, left: 0, width: 1, height: 0, overflow: 'hidden', children: [Button({ key: tailKey(id, page.tailMarkerToken), plain: true, label: '·', onPress: () => {} })] });
    const jumpNode = jumpControl('viewport');
    const jumping = e.surface === 'desktop' && page.tailRequest?.placement === 'jump';
    const settling = e.surface === 'desktop' && (page.navigationOwner?.staged || jumping);
    const settlingLabel = jumping ? '正在定位最新消息' : '正在加载历史消息';
    const canWatchSize = e.surface === 'desktop' && typeof Client === 'function';
    const useBands = canWatchSize && fillPane && Number.isFinite(e.props?.bodyColumns) &&
      e.props.bodyColumns > 1 && e.props.bodyColumns !== page.bandGeometryLimit;
    const prefixBox = (scope, gap, rows, key, contentRows) => Box({ key: `codex_prefix_${id}_${scope}`, position: 'relative', flexDirection: 'column', rowGap: gap, minWidth: 0, children: [
      ...rows,
      ...(key ? [Box({ position: 'absolute', left: 0, top: 0, bottom: 0, width: 0, overflow: 'hidden',
        children: [Client({ key: `codex_prefix_size_${id}_${scope}`, module: './history-size.js', width: 1, height: '100%', props: { key, contentRows } })] })] : []),
    ] });
    const overlay = scroll => {
      const offset = Math.max(0, Number.isFinite(scroll?.offset) ? scroll.offset : state.scroll.get(id) || 0);
      const contentRows = scroll?.contentRows ?? page.scrollGeometry?.contentRows;
      const reading = page.upwardRead;
      const aboveEnd = reading?.offset === offset && reading.contentRows === contentRows && reading.bodyRows === bodyRows;
      const aboveBottom = Number.isFinite(contentRows) ? !atPaneBottom(offset, contentRows, bodyRows, e.surface) : page.awayFromBottom;
      const visible = !jumping && (hasLater || aboveEnd || !page.nativeFollowing && aboveBottom);
      return Box({ key: `codex_jump_overlay_${id}`, position: 'absolute', alignSelf: 'center', width: 4, top: Math.max(0, offset + bodyRows - 3), height: 2, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', display: visible ? 'flex' : 'none', children: [jumpNode] });
    };
    const headerNode = Box({ key: 'codex_navigation', flexDirection: 'column', gap: 'sm', children: navigation });
    // Keep the history window stable as the draft consumes its wire allowance.
    const draftReserve = Math.max(0, INPUT_RENDER_LIMIT - control.draft.length);
    const composerNode = budget.reserveChars(Box({ key: `codex_composer_${id}`, flexDirection: 'column', flexShrink: 0, ...(e.surface === 'desktop' ? { gap: 0 } : { gap: 'sm', borderStyle: 'round', borderDimColor: true, padding: 1 }), children: composer }), 0, draftReserve);
    let renderedContent;
    const root = (content, scroll = e.props?.scroll, reserving = false) => {
      renderedContent = content;
      // Keep the message port in the viewport: desktop surfaces may suspend
      // off-screen Client regions. Its empty node never handles pointer input.
      const offset = Math.max(0, Number.isFinite(scroll?.offset) ? scroll.offset : state.scroll.get(id) || 0);
      const contentRows = scroll?.contentRows ?? page.scrollGeometry?.contentRows;
      const short = Number.isFinite(contentRows) && atPaneBottom(0, contentRows, bodyRows, e.surface);
      const canRequest = !page.navigating && !page.navigationRequest && !page.tailRequest && !page.historyLoading && !page.historyError && !state.restoringPreview && !page.waitingBand && !page.bandExposure;
      const fillDirection = page.shortFillDirection ?? (hasEarlier ? -1 : 1);
      // A resize can put a previously moving reader at a physical endpoint.
      // The host has no further displacement to report there.
      let boundaryDirection = 0;
      if (e.surface === 'desktop' && !page.edgeGesture && Number.isFinite(scroll?.offset)) {
        if (page.historyApproach === -1 && hasEarlier && scroll.offset === 0) boundaryDirection = -1;
        if (page.historyApproach === 1 && hasLater && atPaneBottom(scroll.offset, contentRows, bodyRows, 'desktop')) boundaryDirection = 1;
      }
      const edgeDirection = !canRequest ? 0 : boundaryDirection || (short && (fillDirection < 0 ? hasEarlier : hasLater) ? fillDirection : 0);
      const edgeToken = !reserving && edgeDirection ? JSON.stringify([state.generation, id, page.scrollGeneration, edgeDirection, view.start, entries.length, view.total, page.historyPage ?? 0]) : '';
      if (!reserving) {
        if (boundaryDirection && edgeDirection) page.boundary = { token: edgeToken, offset };
        page.edgeKey = edgeToken;
      }
      const sync = typeof Client === 'function' ? [Box({ key: `codex_sync_region_${id}`, position: 'absolute', top: offset, left: 0, width: 1, height: 1, children: [Client({ key: `codex_navigation_sync_${id}`, module: './navigation-sync.js', width: 1, height: 1, props: reserving ? { token: 0, tailToken: 0, edgeToken: '', edgeDirection: 0 } : { ...navigationProps, edgeToken, edgeDirection } })] })] : [];
      const loadingLayer = settling || reserving && e.surface === 'desktop' ? [Box({ key: `codex_history_settling_${id}`, position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'composerSidebarBackground', children: [
        Box({ key: `codex_history_settling_indicator_${id}`, position: 'absolute', top: offset + 2, left: 0, right: 0, height: 2, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', children: [
          typeof Svg === 'function' ? Svg({ key: `codex_history_settling_spinner_${id}`, source: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#888" stroke-opacity=".25" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#888" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur=".8s" repeatCount="indefinite"/></path></svg>', alt: settlingLabel, width: 18, height: 18, isInteractive: true }) : caption(`codex_history_settling_label_${id}`, settlingLabel),
        ] }),
      ] })] : [];
      const frame = Box({ key: 'codex_conversation', position: 'relative', overflow: 'hidden', flexDirection: 'column', gap: 'lg', ...(e.surface === 'desktop' ? { backgroundColor: 'composerSidebarBackground' } : {}), ...(fillPane ? { minHeight: Math.max(bodyRows, page.layoutFloor || 0, page.disclosurePlacement?.minHeight ?? 0) } : {}), children: [...sync, tailMarker, headerNode, ...content, ...(hasLater ? [historyEnd] : []), composerNode, ...loadingLayer, ...(fillPane ? [overlay(scroll)] : page.awayFromBottom || hasLater ? [jumpNode] : [])] });
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
        // A long consecutive run can fill the raw window as one folded
        // group. Leave room for at least one overlapping group on a shift.
        const groupLimit = RAW_WINDOW_LIMIT - 1;
        for (let index = 0; index < group.items.length; index += groupLimit) {
          const items = group.items.length <= groupLimit ? group.items : group.items.slice(index, index + groupLimit);
          const end = start + items.length;
          groups.push({ start, end, key: entryKey(items[0]), group: { ...group, items } }); start = end;
        }
      }
    }
    // A measurement paint must retain the exact groups it measures. Reserve
    // the marker, both possible prefix observers and the loading controls in
    // every frame; add them to the selected groups only after budget planning.
    hasEarlier = true; hasLater = true;
    const maxToken = Number.MAX_SAFE_INTEGER, markerBudgetKey = `codex_read_anchor_${id}_${maxToken}`;
    const decorations = [markerGroup(maxToken, markerBudgetKey, []), ...(canWatchSize ? [
      prefixBox('timeline', 1, [], markerBudgetKey, maxToken), prefixBox('file', 0, [], markerBudgetKey, maxToken),
    ] : [])];
    const measuredShell = budget.cost(root([timeline(decorations)], e.props?.scroll, true));
    const spinnerCost = budget.cost(historySpinner);
    const shellCost = { nodes: measuredShell.nodes + (historyBusy ? 0 : spinnerCost.nodes),
      depth: Math.max(measuredShell.depth, spinnerCost.depth + 5),
      chars: measuredShell.chars + (historyBusy ? 0 : spinnerCost.chars) + 512,
      wireChars: measuredShell.wireChars + (historyBusy ? 0 : spinnerCost.wireChars) + 512 };
    const paneLimit = RENDER_LIMIT;
    const coreLimit = useBands ? historyCoreLimit(shellCost, paneLimit) : paneLimit;
    const heldUpper = useBands && !page.adding && page.disclosurePrefix?.key === groups[0]?.key ? page.disclosurePrefix?.upper : null;
    if (heldUpper?.cost) {
      for (const field of ['chars', 'wireChars', 'nodes']) coreLimit[field] = Math.min(coreLimit[field], paneLimit[field] - heldUpper.cost[field]);
    }
    // A composer with attachments and its reserved draft can leave less than
    // two default wire budgets. Keep room for the neighbouring group and the
    // controls around a paginated group.
    const pageGroupLimit = { ...GROUP_RENDER_LIMIT,
      wireChars: Math.min(GROUP_RENDER_LIMIT.wireChars, Math.max(512, Math.floor((paneLimit.wireChars - shellCost.wireChars) / 2) - 1024)) };
    let retained = page.adding;
    const anchor = page.windowAnchor ? (page.navigationTimeline ?? page.timeline).findIndex(entry => entryKey(entry) === page.windowAnchor) : undefined;
    if (!retained && page.disclosurePrefix?.key === page.windowAnchor && anchor >= 0) {
      const first = groups.find(group => group.key === page.disclosurePrefix.first);
      if (first && first.start <= anchor) retained = { start: first.start, end: anchor + 1 };
    }
    const maxCoreEntries = useBands ? Math.min(Math.floor(RAW_WINDOW_LIMIT * 0.7), RAW_WINDOW_LIMIT - (heldUpper?.count ?? 0)) : RAW_WINDOW_LIMIT;
    const plan = planHistoryWindow({ groups, renderGroup, retained, direction: page.adding?.direction ?? (retained ? 1 : -1), anchor: anchor >= 0 ? anchor : undefined, shellCost, limit: coreLimit, maxEntries: maxCoreEntries, shift: !!page.adding });
    // Expanding several retained groups can increase their combined cost. Keep
    // every retained boundary and apply the existing content pager to the
    // largest representations rather than evicting a message being read.
    const selectedGroups = plan.groups;
    // Even a cache containing only the newest fetch needs a real upper
    // neighbour before the next cursor is read. Its native slot then exists
    // in the initial tail layout and can absorb that fetch while reading.
    if (useBands && page.cursor && plan.start === 0 && !page.adding && !page.windowAnchor && selectedGroups.length > 2 && page.followTail) {
      selectedGroups.splice(0, Math.min(3, Math.ceil(selectedGroups.length / 4)));
    }
    const sumCost = () => historyWindowCost(shellCost, selectedGroups);
    const fraction = cost => Math.max(cost.chars / paneLimit.chars, cost.wireChars / paneLimit.wireChars, cost.nodes / paneLimit.nodes);
    for (let pass = 0; pass < selectedGroups.length * 12; pass++) {
      const cost = sumCost();
      if (historyWindowFits(cost, paneLimit)) break;
      const candidates = selectedGroups.filter(group => group.paginate && (group.cost.chars > 512 || group.cost.wireChars > 1024 || group.cost.nodes > 32 || group.cost.depth + 2 > paneLimit.depth));
      candidates.sort((a, b) => fraction(b.cost) - fraction(a.cost));
      const group = candidates[0];
      if (!group) break;
      const node = group.paginate({ chars: Math.max(256, Math.floor(group.cost.chars * 0.55)), wireChars: Math.max(512, Math.floor(group.cost.wireChars * 0.55)), nodes: Math.max(16, Math.floor(group.cost.nodes * 0.55)), depth: GROUP_RENDER_LIMIT.depth });
      const nextCost = groupCost(node);
      if (nextCost.chars >= group.cost.chars && nextCost.wireChars >= group.cost.wireChars && nextCost.nodes >= group.cost.nodes && nextCost.depth >= group.cost.depth) { group.paginate = null; continue; }
      group.node = node; group.cost = nextCost;
    }
    // Fixed controls may themselves exceed the allowance after several pending
    // details resolve. Keep the reading anchor and discard only the far edge;
    // never hand an oversized tree to the host or rebuild the candidate groups.
    while (selectedGroups.length > 1) {
      const cost = sumCost();
      if (historyWindowFits(cost, paneLimit)) break;
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
    const upperSummary = heldUpper && selectedGroups[0]?.key === page.disclosurePrefix.key ? selectedGroups[0] : null;
    // Adjacent chunks are one visual file, with no paragraph gap at buffer edges.
    const visualGroups = [];
    let cluster = null, timelineAnchor = -1, fileAnchor = -1;
    for (const group of selectedGroups) {
      if (group === upperSummary) continue;
      const file = group.group.items[0]?.fileView;
      const anchored = group.key === page.measureAnchor;
      const node = anchored ? markerGroup(group.start, page.measureKey, [group.node]) : group.node;
      if (file?.kind === 'chunk') {
        if (!cluster || cluster.key !== file.key) {
          cluster = { key: file.key, nodes: [] }; visualGroups.push(cluster);
        }
        if (anchored) fileAnchor = cluster.nodes.length;
        cluster.nodes.push(node);
      } else { cluster = null; visualGroups.push({ node }); }
      if (anchored) timelineAnchor = visualGroups.length - 1;
    }
    // Observe only the material before the original reading marker. A file
    // can straddle it, so its zero-gap chunk stack has its own prefix.
    const watchPrefix = (rows, index, scope, gap) => {
      if (index < 1 || !canWatchSize || page.followTail || page.synchronousFileLayout) return rows;
      const key = page.readingAnchor?.key;
      return [prefixBox(scope, gap, rows.slice(0, index), key, page.readingAnchor?.contentRows), ...rows.slice(index)];
    };
    const rows = visualGroups.map((group, index) => group.node ?? fileBuffer(group.key,
      index === timelineAnchor ? watchPrefix(group.nodes, fileAnchor, 'file', 0) : group.nodes));
    let contentTimeline = timeline(watchPrefix(rows, timelineAnchor, 'timeline', 1));
    const bandCore = useBands && !page.adding && page.bandCore?.first === selectedGroups[0]?.key &&
      page.bandCore?.last === selectedGroups.at(-1)?.key ? page.bandCore : null;
    if (!bandCore) page.bandCore = null;
    const stack = children => Box({ flexDirection: 'column', flexShrink: 0, rowGap: 1, minWidth: 0, children });
    const nativeBand = (key, frame, children, alignStart) => Box({ key, flexDirection: alignStart ? 'column' : 'column-reverse', height: frame.rows,
      flexShrink: 0, overflow: 'hidden', children: [stack(children)] });
    let compactCore;
    if (bandCore) {
      const coreSections = bandSections(rows, budget.cost);
      const matches = bandCore.partCounts?.length === coreSections.length && coreSections.every((section, i) => section.length === bandCore.partCounts[i]);
      contentTimeline = nativeBand(`codex_resident_core_${id}`, bandCore, coreSections.map(stack), bandCore.align === 'start');
      if (matches) compactCore = visibleRows => {
        const reduced = cropBandSections({ sections: coreSections, heights: bandCore.partRows, naturalRows: bandCore.naturalRows,
          height: bandCore.rows, visibleRows, alignStart: bandCore.align === 'start', Box });
        return reduced ? nativeBand(undefined, bandCore, reduced, bandCore.align === 'start') : null;
      };
    }
    page.hasHistoryBands = useBands;
    page.captureBandStrip = null;
    page.bandCanMerge = false;
    if (!useBands || (!hasEarlier && !upperSummary) || !selectedGroups.length) page.upperBand = null;
    if (!useBands || !hasLater || !selectedGroups.length) page.lowerBand = null;
    if (useBands && selectedGroups.length && (hasEarlier || hasLater || upperSummary)) {
      const all = page.navigationTimeline ?? page.timeline;
      let cost = sumCost(), remaining = RAW_WINDOW_LIMIT - entries.length;
      const band = direction => {
        const upper = direction < 0;
        const pinned = upper && upperSummary;
        const seam = pinned ? heldUpper.seam : upper ? selectedGroups[0].key : selectedGroups.at(-1).key;
        const scope = upper ? 'upperBand' : 'lowerBand';
        let frame = page[scope];
        if (frame?.seam !== seam || frame.columns !== e.props.bodyColumns || frame.bodyRows !== bodyRows) {
          frame = page[scope] = { seam, columns: e.props.bodyColumns, bodyRows, token: ++navigationSequence };
        }
        if (pinned && frame.columns === heldUpper.columns && frame.bodyRows === heldUpper.bodyRows) frame.rows ??= heldUpper.rows;
        const boundary = direction < 0 ? plan.start : plan.end;
        // Limit both construction and mounted entries. Partition neighbouring
        // tool calls exactly as in the ordinary timeline.
        const count = Math.min(remaining, pinned ? heldUpper.count - 1 : 48);
        let index = direction < 0 ? Math.max(0, boundary - count) : boundary;
        if (pinned) {
          const first = all.findIndex(entry => entryKey(entry) === heldUpper.first);
          if (first >= index && first <= boundary) index = first;
        }
        const end = direction < 0 ? boundary : Math.min(all.length, boundary + count);
        const records = groupEntries(all.slice(index, end)).map(group => {
          const start = index; index += group.items.length;
          return { start, end: index, key: entryKey(group.items[0]), group };
        });
        if (direction < 0) records.reverse();
        // Opening a disclosure often introduces a lower neighbour. Keep the
        // existing upper lane's budget while its visible prefix is held.
        const holdingDisclosure = pinned || page.disclosurePrefix?.key === page.windowAnchor && page.windowAnchor;
        const shared = upper && hasLater && !holdingDisclosure ? historyCoreLimit(cost, paneLimit) : paneLimit;
        const result = historyBand({ records, render: renderGroup, cost, limit: shared, remaining, direction });
        cost = result.cost; remaining = result.remaining;
        const mounted = pinned ? [...result.groups, upperSummary] : result.groups;
        frame.entries = mounted.flatMap(group => group.group.items); frame.timeline = all;
        frame.groups = mounted.map(({ start, end, key }) => ({ start, end, key }));
        frame.cost = historyWindowCost({ chars: 0, wireChars: 0, nodes: 0, depth: 0 }, mounted);
        if (!mounted.length) { page[scope] = null; return null; }
        const frontier = upper ? mounted[0].key : mounted.at(-1).key;
        if (frame.frontier !== frontier) {
          frame.frontier = frontier; frame.token = ++navigationSequence; frame.naturalRows = null;
        }
        const cells = [];
        for (const group of mounted) {
          const file = group.group.items[0]?.fileView;
          if (file?.kind === 'chunk') {
            const prior = cells.at(-1);
            if (prior?.file === file.key) prior.chunks.push(group.node);
            else cells.push({ file: file.key, chunks: [group.node] });
          } else cells.push({ node: pinned && group.key === page.measureAnchor ? markerGroup(group.start, page.measureKey, [group.node]) : group.node });
        }
        const children = cells.map(cell => cell.node ?? fileBuffer(cell.file, cell.chunks));
        // A numeric height is supported by the native Box. When neighbouring
        // groups are short, only reserve the inter-group gaps and the padding
        // that the actual message renderer puts in the pane. This remains
        // filled even if Markdown is still mounting or has no visible text.
        const gapRows = Math.max(0, cells.length - 1) * bandSeamRows;
        const messagePadding = mounted.filter(group => ['agentMessage', 'plan', 'userMessage', 'parentMessage', 'directUserMessage'].includes(group.group.type)).length;
        if (!upper && bandCore?.align === 'start') frame.open = true;
        frame.rows ??= upper && bandCore ? bandCore.prefixRows ?? 0 : Math.min(bodyRows * 2, Math.max(1, Math.floor(gapRows + messagePadding)));
        if (upper) page.bandCanMerge = true;
        const name = upper ? 'above' : 'below';
        const key = `codex_history_band_${name}_${id}`;
        const sensor = Box({ position: 'absolute', left: 0, top: 0, bottom: 0, width: 0, overflow: 'hidden', children: [
          Client({ key: `codex_band_size_${id}_${name}`, module: './history-size.js', width: 1, height: '100%',
            props: { key: frame.token, band: true, contentRows: Math.max(bodyRows, page.scrollGeometry?.contentRows || 0) } }),
        ] });
        const sections = upper ? bandSections(children, budget.cost) : null;
        let measured = children;
        if (sections) {
          const counts = sections.map(section => section.length);
          if (frame.partToken !== frame.token || frame.partCounts?.length !== counts.length || counts.some((n, i) => frame.partCounts[i] !== n)) {
            frame.partToken = frame.token; frame.partCounts = counts; frame.partRows = counts.map(() => 0);
          }
          // The desktop host accepts up to three percentage digits per Box.
          // Compose the scale so its sub-row measurement passes native validation.
          const partSensor = part => {
            const scale = 8 * 8 * 2;
            let node = Client({ key: `codex_band_part_${id}_${part}`, module: './history-size.js', width: 1, height: '100%',
              props: { key: frame.token, part, scale, contentRows: Math.max(32, Math.min(131072, (page.scrollGeometry?.contentRows || bodyRows) * scale)) } });
            for (const height of ['200%', '800%', '800%']) {
              node = Box({ height, flexShrink: 0, width: 0, overflow: 'hidden', flexDirection: 'column', children: [node] });
            }
            return node;
          };
          measured = sections.map((section, part) => Box({ position: 'relative', flexDirection: 'column', flexShrink: 0, rowGap: 1, minWidth: 0, children: [
            ...section, ...(sections.length > 1 ? [Box({ position: 'absolute', left: 0, top: 0, bottom: 0, width: 0, overflow: 'hidden', flexDirection: 'column', children: [
              partSensor(part),
            ] })] : []),
          ] }));
          frame.compact = visibleRows => {
            const reduced = cropBandSections({ sections, heights: frame.partRows, naturalRows: frame.naturalRows, height: frame.rows, visibleRows, alignStart: false, Box });
            return reduced ? nativeBand(undefined, frame, reduced, false) : null;
          };
        }
        return Box({ key, overflow: 'hidden', flexShrink: 0,
          height: frame.rows, flexDirection: upper ? 'column-reverse' : 'column', children: [
            Box({ position: 'relative', flexDirection: 'column', flexShrink: 0, minWidth: 0, rowGap: 1, children: [...measured, sensor] }),
          ] });
      };
      // Keep the main Markdown/Code leaves first in native traversal. Desktop
      // reuses those portal slots by ordinal, even when the Box keys match.
      const upper = hasEarlier || upperSummary ? band(-1) : null;
      const lower = hasLater ? band(1) : null;
      if (lower && page.lowerBand.open && page.lowerBand.groups.at(-1)?.end === view.total) hasLater = false;
      if (upper || lower) {
        const originalCore = contentTimeline;
        if (upper) {
          const oldUpperRows = page.upperBand.rows;
          const frame = page.upperBand;
          page.captureBandStrip = () => {
            const oldUpper = oldUpperRows ? frame.compact?.(bodyRows + 1) ?? upper : Box({ height: 0, children: [] });
            const core = oldUpperRows < bodyRows + 1 ? compactCore?.(bodyRows + 1 - oldUpperRows) ?? originalCore : null;
            return budget.readingStrip(Box({ flexDirection: 'column', rowGap: bandCore ? 0 : 1, children: core ? [oldUpper, core] : [oldUpper] }));
          };
        }
        const core = upper ? Box({ flexDirection: 'column-reverse', minWidth: 0, rowGap: bandCore ? 0 : 1, children: [contentTimeline, upper] }) : contentTimeline;
        contentTimeline = lower ? Box({ flexDirection: 'column', minWidth: 0, rowGap: 1, children: [core, lower] }) : core;
      }
    }
    let tree;
    if (exposure) {
      // Keep the old source pixels at their original scroll coordinate while
      // Desktop acknowledges the new extent. The marker belongs exclusively
      // to this paint. No stale native key table can authorize the move.
      const marker = Box({ position: 'absolute', top: 0, left: 0, width: 1, height: 0, overflow: 'hidden',
        children: [Button({ key: exposure.marker, plain: true, label: '·', onPress: () => {} })] });
      const copy = exposure.strip && budget.drawStrip(exposure.strip);
      const withLayer = content => Box({ position: 'relative', flexDirection: 'column', children: [marker, contentTimeline, Box({ key: `codex_band_${content ? 'reading_strip' : 'positioning'}_${id}`, position: 'absolute',
        top: 0, left: 0, right: 0, height: bodyRows + 1, overflow: 'hidden', backgroundColor: 'composerSidebarBackground', flexDirection: 'column',
        children: content ? [Box({ flexDirection: 'column', flexShrink: 0, children: [content] })] : [caption(`codex_band_placement_${id}`, '正在定位历史消息…')] })] });
      if (copy) {
        const staged = root([withLayer(copy)]);
        // A temporary display-only duplicate may use part of the normal
        // 20k text margin. Check the actual full tree; native text still has
        // a 6k margin, and wire, nodes and depth keep their ordinary limits.
        if (budget.fits(staged, { ...RENDER_LIMIT, chars: 94000 })) tree = staged;
      }
      if (!tree) contentTimeline = withLayer(null);
    }
    tree ??= root([contentTimeline]);
    page.renderedGroups = selectedGroups.map(({ start, end, key }) => ({ start, end, key }));
    page.renderedWindow = { ...view, entries, timeline: page.navigationTimeline ?? page.timeline };
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

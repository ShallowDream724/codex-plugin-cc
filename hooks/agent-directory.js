import { agentDisplayName, agentVisual, displayLabel } from './presentation.js';

const finished = new Set(['completed', 'failed', 'interrupted']);
const idOf = agent => String(agent?.agent_id || agent?.id || '');
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const activityTime = agent => timestamp(agent?.last_activity_at_ms) ?? timestamp(agent?.created_at_ms);
const statusLabel = status => ({ waiting: '等待中', unknown: '状态未知', failed: '失败', interrupted: '已停止' })[status] || '';
const safeName = agent => {
  const name = String(agent?.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  // An ID is an action key, not a useful substitute for a missing name.
  return agentDisplayName(displayLabel(name && name !== idOf(agent) ? name : '子代理'));
};

export function relativeAgentTime(value, now = Date.now()) {
  const time = timestamp(value);
  if (time === null) return '时间未记录';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** Prepare a stable, bounded directory without mutating the source list. */
export function agentDirectoryModel(agents, { now = Date.now(), openOffset = 0, completedOffset = 0 } = {}) {
  const open = [], completed = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const id = idOf(agent);
    if (!id) continue;
    const time = activityTime(agent);
    const row = { id, name: safeName(agent), time, relativeTime: relativeAgentTime(time, now), agent };
    (finished.has(agent.status) ? completed : open).push(row);
  }
  const compare = (a, b) => {
    if (a.time !== b.time) {
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return b.time - a.time;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  open.sort(compare); completed.sort(compare);
  const page = (rows, requested) => {
    const last = Math.max(0, Math.floor((rows.length - 1) / 50) * 50);
    const offset = Math.min(last, Math.max(0, Number.isFinite(requested) ? Math.floor(requested / 50) * 50 : 0));
    return { rows: rows.slice(offset, offset + 50), total: rows.length, offset, hasPrev: offset > 0, hasMore: offset + 50 < rows.length };
  };
  const a = page(open, openOffset), b = page(completed, completedOffset);
  return { open: a.rows, openTotal: a.total, openOffset: a.offset, hasPrevOpen: a.hasPrev, hasMoreOpen: a.hasMore,
    completed: b.rows, completedTotal: b.total, completedOffset: b.offset, hasPrev: b.hasPrev, hasMore: b.hasMore };
}

// Approximate terminal cell widths while retaining complete emoji and combining sequences.
const segments = text => typeof Intl.Segmenter === 'function'
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(item => item.segment)
  : Array.from(text);
function cellWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (/^\p{Mark}/u.test(grapheme)) return 0;
  return /\p{Extended_Pictographic}/u.test(grapheme) || cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}
const widthOf = text => segments(text).reduce((width, part) => width + cellWidth(part), 0);
function truncateName(name, maxWidth) {
  const parts = segments(name);
  if (parts.reduce((width, part) => width + cellWidth(part), 0) <= maxWidth) return name;
  let used = 0, result = '';
  for (const part of parts) {
    const width = cellWidth(part);
    if (used + width > maxWidth - 1) break;
    result += part; used += width;
  }
  return result + '…';
}

/** Render with the host's public UI components; actions remain owned by the caller. */
export function renderAgentDirectory(ui, { agents = [], now = Date.now(), columns, onOpen = () => {}, openOffset = 0, completedOffset = 0, onPage = () => {}, loading = false, error = null, onRetry = () => {}, surface = 'desktop' } = {}) {
  const { Box, Text, Button, Svg, Client } = ui;
  const model = agentDirectoryModel(agents, { now, openOffset, completedOffset });
  const caption = (key, text, extra = {}) => Text({ key, size: 'caption', children: [text], ...extra });
  const row = item => {
    const visual = agentVisual(item.id);
    const icon = surface === 'desktop' && typeof Svg === 'function'
      ? Svg({ key: `directory_icon_${item.id}`, source: visual.source, alt: visual.alt, width: 16, height: 16 })
      : caption(`directory_icon_${item.id}`, visual.glyph);
    const status = statusLabel(item.agent.status);
    const available = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
    const nameWidth = Math.max(1, Math.min(48, available - 6 - widthOf(item.relativeTime) - (status ? widthOf(status) + 1 : 0)));
    return Box({ key: `directory_row_${item.id}`, position: 'relative', minWidth: 0, height: 1, paddingX: 0.5, flexDirection: 'row', alignItems: 'center', gap: 'sm', hover: { backgroundColor: 'rgba(128,128,128,0.12)' }, children: [
      Box({ flexShrink: 0, children: [icon] }),
      Box({ minWidth: 0, flexGrow: 1, flexShrink: 1, overflow: 'hidden', children: [Button({ key: `directory_open_${item.id}`, plain: true, label: truncateName(item.name, nameWidth), onPress: () => onOpen(item.id) })] }),
      ...(status ? [Box({ flexShrink: 0, children: [caption(`directory_status_${item.id}`, status, { dimColor: true })] })] : []),
      Box({ flexShrink: 0, children: [caption(`directory_time_${item.id}`, item.relativeTime, { dimColor: true })] }),
      ...(typeof Client === 'function' ? [Box({ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, children: [Client({ key: `directory_hit_${item.id}`, module: './icon-control.js', width: available, height: 1, props: { action: 'open-agent', rows: 1 } })] })] : []),
    ] });
  };
  const group = (key, title, count, rows, offset, hasPrev, hasMore) => Box({ key: `directory_group_${key}`, flexDirection: 'column', gap: 0.5, minWidth: 0, children: [
    caption(`directory_heading_${key}`, `${title} · ${count}${offset ? ` · ${offset + 1}–${Math.min(count, offset + 50)}` : ''}`, { dimColor: true }),
    ...rows.map(row),
    ...(!count ? [caption(`directory_empty_${key}`, key === 'open' ? '没有已开启的代理' : '没有已完成的代理', { dimColor: true })] : []),
    ...(hasPrev ? [Button({ key: `directory_prev_${key}`, plain: true, label: '较新的 50 个', onPress: () => onPage(key, offset - 50) })] : []),
    ...(hasMore ? [Button({ key: `directory_next_${key}`, plain: true, label: '更早的 50 个', onPress: () => onPage(key, offset + 50) })] : []),
  ] });
  const children = [];
  if (loading && !model.open.length && !model.completedTotal) children.push(caption('directory_loading', '正在读取代理'));
  if (error) children.push(Box({ key: 'directory_error', flexDirection: 'row', gap: 'sm', children: [caption('directory_error_text', '读取代理失败', { dimColor: true }), Button({ key: 'directory_retry', plain: true, label: '重试', onPress: onRetry })] }));
  if (!loading || model.open.length || model.completedTotal) {
    children.push(group('open', '已开启', model.openTotal, model.open, model.openOffset, model.hasPrevOpen, model.hasMoreOpen));
    children.push(group('completed', '完成', model.completedTotal, model.completed, model.completedOffset, model.hasPrev, model.hasMore));
    if (!model.open.length && !model.completedTotal && !error) children.push(caption('directory_empty', '暂无子代理', { dimColor: true }));
  }
  return Box({ key: 'agent_directory', flexDirection: 'column', gap: 'lg', minWidth: 0, width: '100%', children });
}

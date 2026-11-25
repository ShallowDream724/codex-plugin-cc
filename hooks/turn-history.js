import { finishedTurn, processItem } from '../shared/turn-history.mjs';
import { orderWaits } from '../shared/activity-order.mjs';

export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '查看过程';
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
  return `用时 ${minutes >= 60 ? Math.floor(minutes / 60) + '小时' : ''}${minutes % 60}分${seconds % 60}秒`;
}

export function finalTimestamp(ms, now = new Date()) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
  const previous = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
  const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  const day = '日一二三四五六'[date.getDay()];
  const calendar = date >= monday && date < next ? '周' + day : date >= previous && date < monday ? '上周' + day : `${date.getMonth() + 1}月${date.getDate()}日`;
  const pad = value => String(value).padStart(2, '0');
  return `${calendar} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Native history transfers contiguous runs as IDs and a shared, bounded page
// locator. The timeline can deduplicate the IDs against live events without
// fetching or rendering a tool's arguments, output, diff, media or Markdown.
export function expandProcessReferences(entries) {
  return entries.flatMap(entry => {
    if (entry.type !== 'turnProcessPage') return [entry];
    const locator = { turn_id: entry.turn_id, cursor: entry.cursor, limit: entry.limit };
    const pageKey = JSON.stringify([entry.turn_id, entry.cursor, entry.limit]);
    return entry.ids.map(id => ({ id, turn_id: entry.turn_id, type: 'turnProcessRef', locator, pageKey }));
  });
}

export function turnTimeline(entries, turns, isOpen, pages) {
  // Apply native wait ordering after hydration, before placing the turn header.
  entries = orderWaits(pages?.size ? entries.map(entry => entry.type === 'turnProcessRef' && isOpen(entry.turn_id)
    ? pages.get(entry.pageKey)?.records?.get(entry.id) ?? entry : entry) : entries);
  const spans = new Map();
  for (const entry of entries) {
    const meta = turns?.get(entry.turn_id);
    if (!finishedTurn(meta)) continue;
    let span = spans.get(entry.turn_id);
    if (!span) {
      span = { meta, open: isOpen(entry.turn_id) };
      spans.set(entry.turn_id, span);
    }
    if (processItem(entry.type, entry.message?.phase)) {
      if (!span.firstProcess) {
        span.firstProcess = entry;
        if (entry.locator && !pages?.get(entry.pageKey)?.records) span.firstPage = entry;
      }
    } else if (entry.message?.is_final) span.firstFinal ??= entry;
    span.last = entry;
  }
  const out = [];
  for (const entry of entries) {
    const span = spans.get(entry.turn_id);
    if (!span) { out.push(entry); continue; }
    const before = span.open && span.firstProcess ? span.firstProcess : span.firstFinal;
    const header = (span.firstProcess || Number.isFinite(span.meta.duration_ms)) && (entry === before || (!before && entry === span.last)) &&
      { type: 'turnSummary', id: '@turn-summary', turn_id: entry.turn_id, duration_ms: span.meta.duration_ms,
        open: span.open, hasProcess: !!span.firstProcess, firstPage: span.firstPage };
    if (header && entry === before) out.push(header);
    if (!processItem(entry.type, entry.message?.phase)) out.push(entry);
    else if (span.open) {
      if (entry.type !== 'turnProcessRef') out.push(entry);
      else {
        // Keep one index per item while loading. A 400-row render window then
        // hydrates only its own pages even for a very long open turn.
        out.push({ ...entry, type: 'turnProcessPending', error: pages?.get(entry.pageKey)?.error });
      }
    }
    if (header && !before && entry === span.last) out.push(header);
  }
  return out;
}

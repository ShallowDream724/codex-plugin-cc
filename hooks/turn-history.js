import { finishedTurn, inputItem, processItem } from '../shared/turn-history.mjs';
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
  const midnight = offset => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const today = midnight(0);
  let calendar;
  if (date >= today && date < midnight(1)) calendar = '今天';
  else if (date < today && date >= midnight(-1)) calendar = '昨天';
  else {
    const mondayOffset = -((now.getDay() + 6) % 7);
    const monday = midnight(mondayOffset);
    const day = '日一二三四五六'[date.getDay()];
    if (date >= monday && date < midnight(mondayOffset + 7)) calendar = '周' + day;
    else if (date < monday && date >= midnight(mondayOffset - 7)) calendar = '上周' + day;
    else calendar = `${date.getMonth() + 1}月${date.getDate()}日`;
  }
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

function openingInput(items, meta) {
  const explicit = items.find(item => item.turn_input === 'start' && inputItem(item.type));
  if (explicit) return explicit;
  if (meta.opening_item_id) {
    const native = items.find(item => item.id === meta.opening_item_id && inputItem(item.type));
    if (native?.turn_input !== 'steer') return native;
  }
  // A bounded revision or history suffix may begin at a steer. Only native
  // order from the actual turn start can identify an otherwise unmarked input.
  if (meta.history_start_loaded === false || meta.opening_item_id === null && !meta.history_start_loaded) return;
  const first = items.find(item => inputItem(item.type));
  return first?.turn_input !== 'steer' ? first : undefined;
}

export function turnTimeline(entries, turns, isOpen, pages) {
  // Apply native wait ordering after hydration, before placing the turn header.
  entries = orderWaits(pages?.size ? entries.map(entry => entry.type === 'turnProcessRef' && isOpen(entry.turn_id)
    ? pages.get(entry.pageKey)?.records?.get(entry.id) ?? entry : entry) : entries);
  const spans = new Map();
  for (const entry of entries) {
    if (!entry.turn_id || !finishedTurn(turns?.get(entry.turn_id))) continue;
    if (!spans.has(entry.turn_id)) spans.set(entry.turn_id, []);
    spans.get(entry.turn_id).push(entry);
  }
  const out = [];
  for (const entry of entries) {
    const items = spans.get(entry.turn_id);
    if (!items) { out.push(entry); continue; }
    if (entry !== items[0]) continue;
    const meta = turns.get(entry.turn_id), open = isOpen(entry.turn_id);
    const opener = openingInput(items, meta);
    const process = item => item !== opener && processItem(item.type, item.message?.phase, true);
    const firstProcess = items.find(process);
    if (opener) out.push(opener);
    if (firstProcess || Number.isFinite(meta.duration_ms)) {
      out.push({ type: 'turnSummary', id: '@turn-summary', turn_id: entry.turn_id, duration_ms: meta.duration_ms,
        open, hasProcess: !!firstProcess,
        firstPage: firstProcess?.locator && !pages?.get(firstProcess.pageKey)?.records ? firstProcess : undefined });
    }
    // Late native echoes can arrive after the final or even after the next
    // turn starts. Keep their native order within this turn and its final last.
    const finals = [];
    for (const item of items) {
      if (item === opener) continue;
      if (item.message?.phase === 'final_answer' || item.message?.is_final) { finals.push(item); continue; }
      if (!open && process(item)) continue;
      out.push(item.type === 'turnProcessRef' ? { ...item, type: 'turnProcessPending', error: pages?.get(item.pageKey)?.error } : item);
    }
    for (const final of finals) out.push(final);
  }
  return out;
}

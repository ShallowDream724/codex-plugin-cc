import { foldableTurn, inputItem } from '../shared/turn-history.mjs';
import { orderWaits } from '../shared/activity-order.mjs';

export function durationLabel(ms, status) {
  const outcome = status === 'interrupted' ? '已中断' : status === 'failed' ? '执行失败' : '';
  if (!Number.isFinite(ms) || ms < 0) return outcome || '执行过程';
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
  const duration = `用时 ${minutes >= 60 ? Math.floor(minutes / 60) + '小时' : ''}${minutes % 60}分${seconds % 60}秒`;
  return outcome ? `${outcome} · ${duration}` : duration;
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
  entries = orderWaits(pages?.size ? entries.map(entry => {
    if (entry.type !== 'turnProcessRef' || !isOpen(entry.turn_id)) return entry;
    const record = pages.get(entry.pageKey)?.records?.get(entry.id);
    return record?.type === 'agentMessage' ? { ...record, turn_process: true } : record ?? entry;
  }) : entries);
  const spans = new Map();
  for (const entry of entries) {
    if (!entry.turn_id || !foldableTurn(turns?.get(entry.turn_id))) continue;
    if (!spans.has(entry.turn_id)) spans.set(entry.turn_id, []);
    spans.get(entry.turn_id).push(entry);
  }
  const out = [];
  for (const entry of entries) {
    const items = spans.get(entry.turn_id);
    const meta = turns?.get(entry.turn_id);
    if (!items) {
      out.push(withoutFinalActions(entry));
      continue;
    }
    if (entry !== items[0]) continue;
    const open = isOpen(entry.turn_id);
    const opener = openingInput(items, meta);
    // History can identify the final before earlier pages are loaded. A
    // live-only turn uses the last completed candidate in its current order.
    const final = meta.status === 'completed' ? items.findLast(item => item.type === 'agentMessage' && item.message?.is_final
      && (meta.final_item_id !== undefined ? item.id === meta.final_item_id : !item.turn_process)) : undefined;
    let legacyReply;
    if (meta.status === 'completed' && meta.history_start_loaded === true && !meta.final_item_id && !final
        && !items.some(item => item.message?.phase === 'final_answer')) {
      const candidates = items.filter(item => item.type === 'agentMessage' && item.message?.phase == null && item.message?.delivery !== 'async' && !item.turn_process);
      if (candidates.length === 1 && candidates[0].message?.complete) [legacyReply] = candidates;
    }
    const process = item => item !== opener && item !== final && item !== legacyReply;
    const firstProcess = items.find(process);
    if (opener) out.push(opener);
    if (firstProcess || Number.isFinite(meta.duration_ms)) {
      out.push({ type: 'turnSummary', id: '@turn-summary', turn_id: entry.turn_id, duration_ms: meta.duration_ms, status: meta.status,
        open, hasProcess: !!firstProcess,
        firstPage: firstProcess?.locator && !pages?.get(firstProcess.pageKey)?.records ? firstProcess : undefined });
    }
    // Keep earlier replies and late echoes in process order, even if their
    // notifications arrived after the turn closed.
    if (open) {
      for (const item of items.filter(process)) {
        out.push(item.type === 'turnProcessRef' ? { ...item, type: 'turnProcessPending', error: pages?.get(item.pageKey)?.error } : withoutFinalActions(item));
      }
    }
    if (final || legacyReply) out.push(final ?? legacyReply);
  }
  return out;
}

function withoutFinalActions(entry) {
  return entry.message?.is_final ? { ...entry, message: { ...entry.message, is_final: false } } : entry;
}

import { appendRenderCost, renderCostFits, RENDER_LIMIT } from './render-budget.js';

const ZERO = Object.freeze({ chars: 0, nodes: 0, depth: 0 });
export const HISTORY_RENDER_LIMIT = RENDER_LIMIT;

export function historyWindowCost(shellCost = ZERO, groups = []) {
  // A group is a child of the timeline, itself a child of the root.
  return groups.reduce((cost, group) => appendRenderCost(cost, group.cost, 2), { ...shellCost });
}
export function historyWindowFits(cost, limit = HISTORY_RENDER_LIMIT) {
  return renderCostFits(cost, limit);
}

// Descriptors are cheap contiguous groups; renderGroup constructs their native
// representation lazily. A failed boundary ends that side's search: skipping it
// would create a hole in the transcript. The cache also covers retained groups.
export function planHistoryWindow({ groups, renderGroup, retained, direction = -1, anchor, shellCost = ZERO, limit = HISTORY_RENDER_LIMIT, maxEntries = 400 }) {
  const cache = new Map();
  const materialize = index => {
    if (!cache.has(index)) cache.set(index, { ...groups[index], ...renderGroup(groups[index]) });
    return cache.get(index);
  };
  let first = -1, last = -1;
  if (retained && retained.end > retained.start) {
    first = groups.findIndex(group => group.end > retained.start && group.start < retained.end);
    if (first >= 0) {
      last = first;
      while (last + 1 < groups.length && groups[last + 1].start < retained.end) last++;
    }
  }
  if (first < 0 && groups.length) {
    first = Number.isInteger(anchor) ? groups.findIndex(group => group.start <= anchor && group.end > anchor) : -1;
    if (first < 0) first = direction > 0 ? 0 : groups.length - 1;
    last = first;
  }
  if (first < 0) return { start: retained?.start ?? 0, end: retained?.start ?? 0, groups: [], cost: { ...shellCost }, overflow: !historyWindowFits(shellCost, limit), evaluated: 0 };
  const selected = [];
  for (let index = first; index <= last; index++) selected.push(materialize(index));
  let cost = historyWindowCost(shellCost, selected);
  const add = side => {
    const index = side < 0 ? first - 1 : last + 1;
    if (index < 0 || index >= groups.length) return false;
    const start = side < 0 ? groups[index].start : groups[first].start;
    const end = side < 0 ? groups[last].end : groups[index].end;
    if (end - start > maxEntries) return false;
    const group = materialize(index);
    const next = appendRenderCost(cost, group.cost, 2);
    if (!historyWindowFits(next, limit)) return false;
    if (side < 0) { first = index; selected.unshift(group); } else { last = index; selected.push(group); }
    cost = next;
    return true;
  };
  if (historyWindowFits(cost, limit)) {
    if (retained || !Number.isInteger(anchor)) while (add(direction < 0 ? -1 : 1)) { /* stop at the first full boundary */ }
    else {
      let before = true, after = true;
      while (before || after) {
        if (before) before = add(-1);
        if (after) after = add(1);
      }
    }
  }
  return { start: groups[first].start, end: groups[last].end, groups: selected, cost, overflow: !historyWindowFits(cost, limit), evaluated: cache.size };
}

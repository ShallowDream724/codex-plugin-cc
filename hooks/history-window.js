import { appendRenderCost, renderCostFits, RENDER_LIMIT } from './render-budget.js';

const ZERO = Object.freeze({ chars: 0, nodes: 0, depth: 0 });
const RESOURCES = ['chars', 'wireChars', 'nodes'];
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
export function planHistoryWindow({ groups, renderGroup, retained, direction = -1, anchor, shellCost = ZERO, limit = HISTORY_RENDER_LIMIT, maxEntries = 400, shift = false }) {
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
  if (shift && retained) {
    const fixed = direction < 0 ? first : last;
    const targetEntries = Math.max(1, Math.round(maxEntries / 3));
    const targetCost = field => ((limit[field] ?? Infinity) - (shellCost[field] ?? 0)) / 3;
    let added = 0, addedCost = ZERO;
    // Spend about one third of the pane on fresh history. Keep the overlap
    // as large as possible, and commit opposite-side evictions only when
    // the immediate neighbour actually fits.
    while (added < targetEntries && !RESOURCES.some(field => (addedCost[field] ?? 0) >= targetCost(field))) {
      const index = direction < 0 ? first - 1 : last + 1;
      if (index < 0 || index >= groups.length) break;
      const group = materialize(index);
      let trim = 0, next = appendRenderCost(cost, group.cost, 2);
      while (true) {
        const start = direction < 0 ? group.start : selected[trim].start;
        const end = direction < 0 ? selected.at(-1 - trim).end : group.end;
        if (end - start <= maxEntries && historyWindowFits(next, limit)) {
          if (direction < 0) {
            selected.length -= trim;
            selected.unshift(group);
            first = index; last -= trim;
          } else {
            selected.splice(0, trim);
            selected.push(group);
            first += trim; last = index;
          }
          cost = next;
          added += group.end - group.start;
          addedCost = appendRenderCost(addedCost, group.cost);
          break;
        }
        if ((direction < 0 ? last - trim : first + trim) === fixed) break;
        trim++;
        const overlap = direction < 0 ? selected.slice(0, -trim) : selected.slice(trim);
        next = appendRenderCost(historyWindowCost(shellCost, overlap), group.cost, 2);
      }
      if (direction < 0 ? first !== index : last !== index) break;
    }
    return { start: groups[first].start, end: groups[last].end, groups: selected, cost, overflow: !historyWindowFits(cost, limit), evaluated: cache.size };
  }
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

// A wait may be recorded at completion even though it began before later
// lifecycle events. Move only waits whose recorded start proves the ordering.
export function orderWaits(entries) {
  const records = new Map(), children = new Map(), moved = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], time = entry.started_at_ms;
    if (!Number.isFinite(time)) continue;
    let maxima = records.get(entry.turn_id);
    if (!maxima) { maxima = []; records.set(entry.turn_id, maxima); }
    if (['collabAgentToolCall', 'collabToolCall'].includes(entry.type) && entry.data?.tool === 'wait') {
      // Prefix maxima identify the earliest prior item later than this wait.
      let low = 0, high = maxima.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (maxima[middle].time > time) high = middle; else low = middle + 1;
      }
      if (low < maxima.length) {
        const target = maxima[low].index;
        if (!children.has(target)) children.set(target, []);
        children.get(target).push(i); moved.add(i);
      }
    }
    if (!maxima.length || time > maxima[maxima.length - 1].time) maxima.push({ time, index: i });
  }
  const result = [], stack = [];
  for (let i = entries.length - 1; i >= 0; i--) if (!moved.has(i)) stack.push([i, false]);
  while (stack.length) {
    const [index, emit] = stack.pop();
    if (emit) { result.push(entries[index]); continue; }
    stack.push([index, true]);
    const before = children.get(index) ?? [];
    for (let i = before.length - 1; i >= 0; i--) stack.push([before[i], false]);
  }
  return result;
}

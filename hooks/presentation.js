import { agentVisuals } from './agent-icons.js';

// Labels stay small even when a remote field is unexpectedly large. Stored
// names, model settings and the IDs used by actions remain unchanged.
export function displayLabel(value, limit = 512) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  let end = limit;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + '…';
}

// Slots are shared by the timeline and conversation, and bounded for long sessions.
const icons = agentVisuals.map(visual => visual.glyph);
const assigned = new Map();
let activeIds = new Set();
let next = 0;
function agentSlot(id) {
  const key = String(id || 'codex');
  if (!assigned.has(key)) {
    const used = new Set(assigned.values());
    let slot = icons.findIndex((_, i) => !used.has(i));
    if (slot < 0 && activeIds.size) {
      const activeSlots = new Set([...activeIds].map(id => assigned.get(id)));
      slot = icons.findIndex((_, i) => !activeSlots.has(i));
    }
    if (slot < 0) slot = next++ % icons.length;
    assigned.set(key, slot);
    if (assigned.size > 256) assigned.delete(assigned.keys().next().value);
  }
  return assigned.get(key);
}
export function agentIcon(id) { return icons[agentSlot(id)]; }
export function agentVisual(id) { return agentVisuals[agentSlot(id)]; }
export function retainIcons(ids, active = ids) {
  const keep = new Set(ids.map(String));
  for (const key of assigned.keys()) if (!keep.has(key)) assigned.delete(key);
  activeIds = new Set(active.map(String).filter(id => keep.has(id)));
  const occupied = new Set();
  for (const id of activeIds) {
    let slot = assigned.get(id);
    if (slot === undefined || occupied.has(slot)) slot = icons.findIndex((_, i) => !occupied.has(i));
    if (slot < 0) slot = next++ % icons.length;
    assigned.set(id, slot); occupied.add(slot);
  }
}
export function clearIcons() { assigned.clear(); activeIds.clear(); next = 0; }

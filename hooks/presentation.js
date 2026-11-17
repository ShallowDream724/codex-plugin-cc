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

export function agentDisplayName(value) {
  return displayLabel(value).replace(/\p{L}/u, letter => letter.toUpperCase());
}

// Identity is independent of render order, current agent membership and status.
// Historical descendants can leave the directory while remaining in a timeline.
// A pure mapping also stays stable across pane/host reopen without a growing cache.
function agentSlot(id) {
  const key = String(id || 'codex');
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  return ((hash ^ (hash >>> 13)) >>> 0) % agentVisuals.length;
}
export function agentIcon(id) { return agentVisual(id).glyph; }
export function agentVisual(id) { return agentVisuals[agentSlot(id)]; }

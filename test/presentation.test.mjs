import test from 'node:test';
import assert from 'node:assert/strict';
import { agentIcon, agentVisual, retainIcons, clearIcons } from '../hooks/presentation.js';

test('active agents retain distinct stable icons among many saved conversations', () => {
  clearIcons();
  const ids = Array.from({ length: 80 }, (_, i) => `agent-${i}`);
  ids.forEach(agentIcon);
  const active = [ids[1], ids[8], ids[15], ids[22], ids[29], ids[36], ids[43]];
  retainIcons(ids, active);
  const icons = active.map(agentIcon);
  assert.equal(new Set(icons).size, 7);
  retainIcons(ids, active);
  assert.deepEqual(active.map(agentIcon), icons);
  clearIcons();
});

test('agent visuals share stable slots with text icons and provide distinct self-contained SVGs', () => {
  clearIcons();
  const ids = Array.from({ length: 16 }, (_, i) => `agent-${i}`);
  const visuals = ids.map(agentVisual);
  assert.equal(new Set(visuals.map(visual => visual.source)).size, 16);
  assert.equal(new Set(visuals.map(visual => visual.glyph)).size, 16);
  for (const [index, visual] of visuals.entries()) {
    assert.strictEqual(agentVisual(ids[index]), visual);
    assert.equal(agentIcon(ids[index]), visual.glyph);
    assert.match(visual.alt, /^代理图标：/);
    assert.match(visual.source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16" height="16" viewBox="0 0 24 24"/);
    assert.match(visual.source, /<\/(?:svg)>$/);
    assert.doesNotMatch(visual.source, /<(?:image|use|foreignObject|style|script)\b|\b(?:href|class|style)=/i);
  }
  clearIcons();
});

test('active visual slots stay distinct and stable when older assignments overlap', () => {
  clearIcons();
  const ids = Array.from({ length: 80 }, (_, i) => `agent-${i}`);
  ids.forEach(agentVisual);
  const active = [ids[1], ids[8], ids[15], ids[22], ids[29], ids[36], ids[43]];
  retainIcons(ids, active);
  const visuals = active.map(agentVisual);
  assert.equal(new Set(visuals).size, active.length);
  retainIcons(ids, active);
  assert.deepEqual(active.map(agentVisual), visuals);
  clearIcons();
});

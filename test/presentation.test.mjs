import test from 'node:test';
import assert from 'node:assert/strict';
import { agentIcon, agentVisual } from '../hooks/presentation.js';

test('history icons remain stable after traversing more than the former assignment cache', () => {
  const ids = Array.from({ length: 600 }, (_, i) => `historical-child-${i}`);
  const expected = new Map(ids.map(id => [id, agentVisual(id)]));
  for (const id of ids.toReversed()) assert.strictEqual(agentVisual(id), expected.get(id), id);
  for (const id of ids) assert.strictEqual(agentVisual(id), expected.get(id), id);
});

test('agent visuals share their identity with text icons and keep the varied self-contained SVG palette', () => {
  const ids = Array.from({ length: 600 }, (_, i) => `agent-${i}`);
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
});

test('independent render lifecycles choose the same icons regardless of encounter order', async () => {
  const first = await import('../hooks/presentation.js?icon-lifecycle-first');
  const second = await import('../hooks/presentation.js?icon-lifecycle-second');
  const ids = ['root-A', 'root-B', '/root/history-child', 'archived-child', 'adopted-thread'];
  const expected = new Map(ids.map(id => [id, first.agentVisual(id).source]));
  for (const id of ids.toReversed()) assert.equal(second.agentVisual(id).source, expected.get(id), id);
});

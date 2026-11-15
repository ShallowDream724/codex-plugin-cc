import test from 'node:test';
import assert from 'node:assert/strict';
import { agentIcon, retainIcons, clearIcons } from '../hooks/presentation.js';

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

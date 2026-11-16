import test from 'node:test';
import assert from 'node:assert/strict';
import { paneScroll } from '../hooks/pane-scroll.js';

const event = (kind, offset, by, contentRows, bodyRows = 10) => ({ origin: { kind }, offset, by, contentRows, bodyRows });

test('measurement retries until the revision Button is painted and compensates for added rows', async () => {
  let controller, attempts = 0; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n), scroll: async ({ to }) => {
    assert.equal(to.key, 'revision-button');
    if (++attempts === 1) throw Error('not painted');
    const returned = controller.observe(event('plugin', 10, -10, 140));
    assert.equal(returned.offset, 50);
  } });
  const result = await controller.measure('revision-button', { offset: 20, contentRows: 110, bodyRows: 10 }, true);
  assert.equal(attempts, 2); assert.equal(result.offset, 50); assert.deepEqual(positions, [50]);
});

test('a delayed plugin sample preserves the latest human offset', async () => {
  let controller, finish; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n), scroll: async () => { await new Promise(resolve => { finish = resolve; }); controller.observe(event('plugin', 0, 0, 200)); } });
  const measuring = controller.measure('revision-button', { offset: 10, contentRows: 100, bodyRows: 10 }, true);
  controller.observe(event('person', 35, 5, 100)); finish();
  assert.equal((await measuring).offset, 35); assert.deepEqual(positions, [35]);
});

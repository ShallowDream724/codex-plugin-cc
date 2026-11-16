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
  assert.ok(attempts >= 2); assert.equal(result.offset, 50); assert.ok(positions.every(offset => offset === 50));
});

for (const sample of [
  { name: 'before the prepend paints', rows: 100, expected: 135 },
  { name: 'after the prepend paints', rows: 200, expected: 35 },
]) test(`human movement ${sample.name} preserves its reading position`, async () => {
  let controller, finish, first = true; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n), scroll: async () => { if (first) { first = false; await new Promise(resolve => { finish = resolve; }); } controller.observe(event('plugin', 0, 0, 200)); } });
  const measuring = controller.measure('revision-button', { offset: 10, contentRows: 100, bodyRows: 10 }, true);
  controller.observe(event('person', 35, 5, sample.rows)); finish();
  assert.equal((await measuring).offset, sample.expected); assert.ok(positions.every(offset => offset === sample.expected));
});

test('late native leaf layout preserves the reading anchor after an earlier frame was measured', async () => {
  let controller, paintedRows = 120; const positions = [];
  controller = paneScroll({
    valid: () => true,
    later: (_ms, fn) => { paintedRows = 160; fn(); },
    position: offset => positions.push(offset),
    scroll: async () => controller.observe(event('plugin', 0, 0, paintedRows)),
  });
  const result = await controller.measure('revision-button', { offset: 35, contentRows: 100, bodyRows: 10 }, true);
  assert.equal(positions[0], 55, 'the first partial paint adds 20 rows above the anchor');
  assert.equal(result.offset, 95, 'the settled layout adds all 60 rows above the same anchor');
  assert.equal(positions.at(-1), 95);
});

for (const scenario of [
  { name: 'layout adjustment', events: [event('person', 10, 0, 140)], expected: 50 },
  { name: 'human movement after layout adjustment', events: [event('person', 10, 0, 140), event('person', 45, 35, 140)], expected: 45 },
  { name: 'human movement before layout adjustment', events: [event('person', 5, -5, 100), event('person', 5, 0, 140)], expected: 45 },
]) test(`staged prepend preserves ${scenario.name}`, async () => {
  let controller; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: offset => positions.push(offset),
    scroll: async () => controller.observe(event('plugin', 0, 0, 140)),
  });
  const before = { offset: 10, contentRows: 100, bodyRows: 10 };
  controller.stage(before, true);
  for (const input of scenario.events) controller.observe(input);
  const result = await controller.measure('revision-button', before, true);
  assert.equal(result.offset, scenario.expected);
  assert.equal(positions.at(-1), scenario.expected);
});

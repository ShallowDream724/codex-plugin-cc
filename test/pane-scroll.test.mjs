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

test('a denied native scroll cannot confirm a sampled measurement', async () => {
  let controller, attempts = 0; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n), scroll: async () => {
    attempts++;
    controller.observe(event('plugin', 10, -10, 140));
    return { deny: 'the window moved meanwhile' };
  } });
  const result = await controller.measure('revision-button', { offset: 20, contentRows: 110, bodyRows: 10 }, true);
  assert.equal(result, null);
  assert.ok(attempts > 1, 'a denied scroll is retried');
  assert.deepEqual(positions, [], 'a denied measurement cannot confirm a position');
});

test('a denied native scroll is retried until the sampled measurement succeeds', async () => {
  let controller, attempts = 0, positionsAtRetry; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n), scroll: async () => {
    attempts++;
    if (attempts === 2) positionsAtRetry = positions.length;
    controller.observe(event('plugin', 10, -10, 140));
    return attempts === 1 ? { deny: 'the window moved meanwhile' } : {};
  } });
  const result = await controller.measure('revision-button', { offset: 20, contentRows: 110, bodyRows: 10 }, true);
  assert.ok(attempts > 1, 'the rejected first sample must not terminate measurement');
  assert.equal(positionsAtRetry, 0, 'the denied sample did not confirm a position');
  assert.equal(result.offset, 50);
  assert.ok(positions.length > 0);
  assert.ok(positions.every(n => n === 50));
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

test('reading marker displacement ignores layout growth below the anchor', async () => {
  let controller, calls = 0; const positions = [];
  controller = paneScroll({ valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n), scroll: async ({ to }) => {
    assert.equal(to.key, 'reading-marker');
    calls++;
    const marker = calls === 1 ? 20 : 30;
    const rows = calls < 3 ? 140 : 190;
    controller.observe(event('plugin', marker, marker - 35, rows));
    return {};
  } });
  const before = { offset: 35, anchorOffset: 20, contentRows: 100, bodyRows: 10 };
  controller.stage(before, true, true);
  const result = await controller.measure('reading-marker', before, true, true);
  assert.equal(result.offset, 45, 'only the ten rows inserted before the marker shift the reading position');
  assert.equal(result.anchorOffset, 30);
  assert.equal(result.contentRows, 190, 'later content below the marker has grown');
  assert.equal(positions.at(-1), 45);
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

test('desktop geometry probes make no native writes through changing geometry', async () => {
  let controller, calls = 0; const returned = [], positions = [];
  const frames = [[20, 130], [25, 150], [30, 180], [30, 190], [30, 190]];
  controller = paneScroll({ settleBeforeCommit: true, valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n),
    scroll: async () => {
      const [marker, rows] = frames[Math.min(calls++, frames.length - 1)];
      const observed = controller.observe(event('plugin', marker, marker - 35, rows));
      returned.push(observed.deny ? 'probe' : observed.offset);
      return observed;
    },
  });
  const before = { offset: 35, anchorOffset: 20, contentRows: 100, bodyRows: 10 };
  controller.stage(before, true, true);
  // A zero-delta host layout notification is not a new reading intent.
  controller.observe(event('person', 35, 0, 100));
  const result = await controller.measure('marker', before, true, true);
  assert.equal(result.offset, 45);
  assert.deepEqual(returned, ['probe', 'probe', 'probe', 'probe', 45]);
  assert.deepEqual(positions, [45]);
});

test('a continuously growing reading marker commits its actual coordinate in the same native event', async () => {
  const before = { offset: 4, anchorOffset: 9, contentRows: 50, bodyRows: 10 };
  let controller, marker = 9;
  const positions = [];
  controller = paneScroll({ settleBeforeCommit: true, valid: () => true, later: (_delay, run) => run(),
    position: offset => positions.push(offset), scroll: async () => {
      marker += 7;
      return controller.observe(event('plugin', marker, marker - 4, 100 + marker));
    },
  });
  controller.stage(before, true, true);
  const committed = await controller.measure('painted-marker', before, true, true);
  assert.equal(committed.offset, marker - 5);
  assert.deepEqual(positions, [marker - 5]);
});

test('synchronous layout commits two stable anchor samples after 32ms', async () => {
  let controller, calls = 0; const delays = [], positions = [];
  controller = paneScroll({ settleBeforeCommit: true, synchronousLayout: () => true, valid: () => true,
    later: (ms, fn) => { delays.push(ms); fn(); }, position: n => positions.push(n),
    scroll: async () => { calls++; return controller.observe(event('plugin', 30, -5, 140)); },
  });
  const before = { offset: 35, anchorOffset: 20, contentRows: 100, bodyRows: 10 };
  controller.stage(before, true, true);
  const result = await controller.measure('marker', before, true, true);
  assert.deepEqual(delays, [32]); assert.equal(calls, 3);
  assert.equal(result.offset, 45); assert.deepEqual(positions, [45]);
});

test('synchronous layout retries when geometry changes before committing', async () => {
  let controller, calls = 0; const delays = [], positions = [];
  const frames = [[20, 130], [30, 150], [30, 150]];
  controller = paneScroll({ settleBeforeCommit: true, synchronousLayout: () => true, valid: () => true,
    later: (ms, fn) => { delays.push(ms); fn(); }, position: n => positions.push(n),
    scroll: async () => {
      const [marker, rows] = frames[Math.min(calls++, frames.length - 1)];
      return controller.observe(event('plugin', marker, marker - 35, rows));
    },
  });
  const before = { offset: 35, anchorOffset: 20, contentRows: 100, bodyRows: 10 };
  controller.stage(before, true, true);
  const result = await controller.measure('marker', before, true, true);
  assert.deepEqual(delays, [32, 64]); assert.equal(calls, 4);
  assert.equal(result.offset, 45); assert.deepEqual(positions, [45]);
});

test('cancelling settlement prevents a stale final commit', async () => {
  let controller, release, calls = 0;
  controller = paneScroll({ settleBeforeCommit: true, valid: () => true, position: () => assert.fail('cancelled position'),
    later: (_ms, fn) => { release = fn; },
    scroll: async () => { calls++; return controller.observe(event('plugin', 10, -10, 140)); },
  });
  const measuring = controller.measure('marker', { offset: 20, contentRows: 100, bodyRows: 10 }, true);
  await Promise.resolve();
  controller.cancel(); release();
  assert.equal(await measuring, null);
  assert.equal(calls, 1);
});

test('a denied settled commit cannot report success or confirm position', async () => {
  let controller, calls = 0; const positions = [];
  controller = paneScroll({ settleBeforeCommit: true, valid: () => true, later: (_ms, fn) => fn(), position: n => positions.push(n),
    scroll: async () => {
      calls++;
      const observed = controller.observe(event('plugin', 10, -10, 140));
      return calls === 4 ? { deny: 'commit rejected' } : observed;
    },
  });
  const result = await controller.measure('marker', { offset: 20, contentRows: 100, bodyRows: 10 }, true);
  assert.equal(result, null);
  assert.equal(calls, 4);
  assert.deepEqual(positions, []);
});

test('settled commits resample wheel motion that arrives while native acknowledges positioning', async () => {
  const before = { offset: 10, anchorOffset: 8, contentRows: 100, bodyRows: 10 };
  let controller, calls = 0, movement = 4;
  const targets = [], positions = [];
  controller = paneScroll({ settleBeforeCommit: true, synchronousLayout: () => true, valid: () => true,
    later: (_ms, run) => run(), position: n => positions.push(n), scroll: async () => {
      const sample = controller.observe(event('plugin', 38, 38 - before.offset, 130));
      if (++calls > 2) {
        assert.equal(controller.nativeTarget.offset, sample.offset);
        controller.consumeNativeTarget();
        assert.equal(controller.nativeTarget, null);
        targets.push(sample.offset);
      } else assert.ok(sample.deny && !controller.nativeTarget);
      if (calls === 3 || calls === 4) movement += 3;
      return sample;
    },
  });
  controller.stage(before, true, true, () => movement);
  const result = await controller.measure('marker', before, true, true);
  assert.deepEqual(targets, [44, 47, 50]);
  assert.equal(result.offset, 50);
  assert.equal(result.movement, 10);
  assert.deepEqual(positions, [50]);
});

test('a newer trim measures the same marker after an end-aligned sample clamps at the top', async () => {
  const before = { offset: 30, anchorOffset: 20, contentRows: 130, bodyRows: 10 };
  let controller;
  const blocks = [];
  controller = paneScroll({ settleBeforeCommit: true, synchronousLayout: () => true, valid: () => true,
    later: (_ms, run) => run(), position: () => {}, scroll: async ({ block }) => {
      blocks.push(block);
      const target = block === 'end' ? 0 : 4;
      return controller.observe(event('plugin', target, target - 30, 100));
    },
  });
  controller.stage(before, true, true);
  const committed = await controller.measure('marker', before, true, true, 'end');
  assert.deepEqual(blocks, ['end', 'start', 'start', 'start']);
  assert.equal(committed.anchorOffset, 4);
  assert.equal(committed.offset, 14);
});

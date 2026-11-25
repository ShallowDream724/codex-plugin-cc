import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';
import navigationSync from '../hooks/navigation-sync.js';
import historySize from '../hooks/history-size.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = i => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', data: { text: `message-${i}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = predicate();
    if (value) return value;
    await pause(20);
  }
  assert.fail('the expected native frame did not appear');
};

async function setup({ live = [], history = () => ({ entries: [], next_cursor: null }), revision = () => ({ revision: 1, entries: live }), onMeasurement = async () => {}, onProbeReply = () => {}, onRender = () => {}, commitScroll = () => ({}), prefixGrowth = () => 0, measureOffset = (_, offset) => offset, autoPost = true, shortViewport = false, nativeContentRows, messageRows = () => 1, vectorControls = false, bodyColumns, agents = [{ agent_id: 'a', status: 'completed' }] } = {}) {
  closeUI();
  const hooks = [], scrolls = [], samples = [], calls = [], timers = [];
  let painted = [], nativePainted = [], offset = 0, drawQueued = false, closed = false, constructed = 0, maxConstructed = 0, invalidations = 0;
  const rows = tree => typeof nativeContentRows === 'function' ? nativeContentRows(tree) : nativeContentRows ?? Math.max(20, tree.filter(n => n.type === 'Markdown').length + 10);
  const surfacePending = new Set();
  const surface = { state: 0, setState(value) { this.state = value; }, elements: { Box: props => props }, post(data) {
    const task = new Promise(resolve => setImmediate(resolve)).then(() => { if (!closed) return host.surface(() => host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data })); });
    surfacePending.add(task); task.finally(() => surfacePending.delete(task));
  } };
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Client', ...(vectorControls ? ['Svg'] : [])].map(type => [type, props => { constructed++; return { type, props }; }])),
      open: async () => { nativePainted = painted; return { isPlaced: true }; }, invalidate() {},
      scroll: async args => {
        scrolls.push(args);
        if (args.to?.key || args.to === 'end') {
          if (args.to.key && (args.to.key.length > 256 || !nativePainted.some(n => n.type === 'Button' && n.props.key === args.to.key))) throw Error('key not painted');
          if (args.to.key) await onMeasurement(args.to.key);
          const contentRows = rows(nativePainted);
          const markerIndex = nativePainted.findIndex(n => n.type === 'Button' && n.props.key === args.to.key);
          const precedingRows = nativePainted.slice(0, markerIndex).filter(n => n.type === 'Markdown' || n.type === 'Text' && n.props.key?.startsWith('message_'))
            .reduce((sum, node) => sum + messageRows(node), 0);
          const isReadingMarker = ['codex_read_anchor_', 'turn_process_a:', 'codex_body_start_'].some(prefix => args.to?.key?.startsWith(prefix));
          const marker = 3 + precedingRows + prefixGrowth();
          const destination = measureOffset(args, isReadingMarker ? Math.max(0, Math.min(contentRows - 10, marker - (args.block === 'end' ? 9 : 0)))
            : args.to === 'end' || args.block === 'end' ? contentRows - 10 : 3);
          const e = { origin: { kind: 'plugin' }, offset: destination, by: destination - offset, contentRows, bodyRows: 10 };
          const result = await host.dispatch('ui.scroll', e);
          if (result.deny) {
            await onProbeReply(args);
            samples.push({ args, before: offset, after: offset, deny: result.deny });
            return result;
          }
          const commit = await commitScroll(args, e, result);
          samples.push({ args, before: offset, after: commit.deny ? offset : result.offset });
          if (commit.deny) return commit;
          offset = result.offset;
        }
        return {};
      },
    },
    state: { get: async () => ({ value: 0, version: 0 }), set: async () => {
      invalidations++;
      if (!drawQueued) { drawQueued = true; setImmediate(async () => { drawQueued = false; if (!closed) await draw(); }); }
      return { isSet: true };
    } },
    clock: { every: (_ms, fn) => { timers.push(fn); return { cancel() {} }; }, after: (ms, fn) => { const timer = setTimeout(() => host.callback(fn), ms); return { cancel: () => clearTimeout(timer) }; } },
    session: { id: async () => 'session', cwd: async () => 'C:/work' }, env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin), { operation, args } = request; calls.push({ operation, args });
      const result = operation === 'ui_list' ? { agents } : operation === 'ui_revision' ? revision(args) : await history(args);
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
  };
  const host = nativeHooks(hooks, $); registerUI(host.on);
  const draw = async (restoredScroll = {}) => {
    constructed = 0;
    painted = nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { bodyColumns, scroll: { bodyRows: 10, ...(shortViewport ? { contentRows: 10, offset: 0 } : {}), ...restoredScroll } } }, () => null));
    onRender(painted);
    maxConstructed = Math.max(maxConstructed, constructed);
    const sync = painted.find(n => n.type === 'Client' && n.props.module === './navigation-sync.js');
    if ((typeof autoPost === 'function' ? autoPost() : autoPost) && sync) navigationSync(sync.props.props, surface);
    return painted;
  };
  await openAgent($, 'a'); await draw();
  // Navigation exercises start after the initial tail has actually painted.
  // Some tests disable automatic surface posts only for later navigation tokens.
  if (!autoPost) {
    const sync = painted.find(n => n.type === 'Client' && n.props.module === './navigation-sync.js');
    if (sync?.props.props.tailToken) await host.surface(() => host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'tail', token: sync.props.props.tailToken } }));
  }
  await pause(80); while (surfacePending.size) await Promise.all([...surfacePending]);
  const wheel = (direction, at = direction < 0 ? 0 : Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10) - 10) => {
    const by = at - offset; offset = at;
    const e = { origin: { kind: 'person' }, by, offset: at, contentRows: Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10), bodyRows: 10 };
    return host.dispatch('ui.scroll', e);
  };
  const nativeMove = async delta => {
    const contentRows = rows(painted), next = Math.max(0, Math.min(offset + delta, contentRows - 10));
    if (next === offset) return;
    const event = { origin: { kind: 'person' }, by: next - offset, offset: next, contentRows, bodyRows: 10 };
    offset = (await host.dispatch('ui.scroll', event)).offset;
  };
  const waitNavigation = async () => { await pause(300); while (surfacePending.size) await Promise.all([...surfacePending]); };
  const visitEdge = async direction => { wheel(-direction, 5); await pause(200); wheel(direction); await waitNavigation(); };
  return { $, draw, wheel, nativeMove, visitEdge, calls, scrolls, samples, tick: () => timers[0](), waitNavigation, open: id => openAgent($, id), press: key => host.dispatch('ui.press', { requestId: 'codex_subagent_activity', element: key }), resetConstructed: () => { maxConstructed = 0; }, get maxConstructed() { return maxConstructed; }, get invalidations() { return invalidations; }, host, get offset() { return offset; }, get painted() { return painted; }, close: () => { closed = true; closeUI(); } };
}
const messages = h => h.painted.filter(n => n.type === 'Markdown').map(n => n.props.text);
const hasMessage = (h, prefix) => h.painted.some(n => n.type === 'Markdown' && n.props.text?.startsWith(prefix) || n.type === 'Text' && n.props.key?.startsWith('message_') && n.props.children?.some(value => typeof value === 'string' && value.startsWith(prefix)));
const older = h => h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('codex_history_a_'));

const upward = (h, contentRows = 10, by = -1) => h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, by, offset: 0, contentRows, bodyRows: 10 });
const navigations = h => h.host.calls.filter(call => call.event === 'ui.message' && call.input.data?.action === 'navigate').length;
const readyToken = h => h.painted.find(n => n.props.module === './navigation-sync.js')?.props.props.token;
const settling = h => h.painted.some(n => n.props.key === 'codex_history_settling_a');

const longEntries = () => Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));

test('desktop waits for the painted band revision before placing the measured row', async t => {
  const h = await setup({ live: longEntries(), bodyColumns: 82, nativeContentRows: 610 });
  t.after(h.close);
  await h.nativeMove(120 - h.offset);
  const painted = await h.draw(), upper = painted.find(node => node.props.key === 'codex_history_band_above_a');
  const sensor = painted.find(node => node.props.key === 'codex_band_size_a_above');
  assert.ok(upper && sensor);
  const oldRows = upper.props.height, delta = 43;
  const count = h.scrolls.length;
  await h.host.surface(() => h.host.dispatch('ui.message', { element: sensor.props.key,
    data: { action: 'history-band-size', key: sensor.props.props.key, rows: oldRows + delta } }));
  await h.nativeMove(-h.offset);
  assert.equal(h.offset, 0, 'the native reply must not move against the old extent');
  await waitFor(() => h.offset === delta).catch(error => {
    throw new Error(JSON.stringify({ offset: h.offset, scrolls: h.scrolls.slice(count), messages: h.host.calls.filter(call => call.event === 'ui.message').map(call => call.input.data?.action) }), { cause: error });
  });
  const expanded = await h.draw();
  assert.equal(expanded.find(node => node.props.key === upper.props.key).props.height, oldRows + delta);
  assert.ok(h.scrolls.slice(count).every(request => request.to.key.startsWith('codex_band_exposure_')));
  assert.equal(settling(h), false);
});

test('a full history window fetches older and newer records at one fifth of scrollbar travel', async t => {
  const h = await setup({ live: longEntries(), nativeContentRows: 1010 }); t.after(h.close);
  const tail = messages(h).at(-1), first = messages(h)[0];
  await h.nativeMove(201 - h.offset);
  assert.equal(navigations(h), 0);
  await h.nativeMove(-1);
  await waitFor(() => messages(h)[0] !== first && !settling(h));
  const middle = messages(h).at(-1);
  assert.notEqual(middle, tail);
  const count = navigations(h);
  await h.nativeMove(799 - h.offset);
  assert.equal(navigations(h), count);
  await h.nativeMove(1);
  await waitFor(() => messages(h).at(-1) !== middle && !settling(h));
  assert.equal(navigations(h), count + 1);
});

test('a restored hard top spends a prior upward approach once without another wheel event', async t => {
  const h = await setup({ live: longEntries(), nativeContentRows: 400 }); t.after(h.close);
  const initial = messages(h)[0];
  await h.nativeMove(-50);
  assert.equal(navigations(h), 0, 'the reader is still far from the edge');
  // qv only reports displacement. Resizing/restoring the pane can paint at
  // row zero with no further actionable wheel notification at that hard edge.
  const restored = { offset: 0, bodyRows: 10 };
  const painted = await h.draw(restored);
  assert.equal(painted.find(n => n.props.module === './navigation-sync.js').props.props.edgeDirection, -1);
  await h.waitNavigation();
  assert.equal(navigations(h), 1, h.host.calls.filter(call => call.event === 'ui.message').map(call => call.input.data.action).join(','));
  assert.notEqual(messages(h)[0], initial);
  assert.equal(navigations(h), 1);
  await h.draw(restored); await h.draw(restored); await h.waitNavigation();
  assert.equal(navigations(h), 1, 'unchanged boundary paints do not spend the same approach twice');
});

test('late growing Markdown above the reader is corrected after navigation returns', async t => {
  let growth = 0;
  const h = await setup({ live: longEntries(), nativeContentRows: () => 600 + growth, prefixGrowth: () => growth }); t.after(h.close);
  await h.nativeMove(-1000); await h.waitNavigation();
  const client = (await h.draw()).find(n => n.type === 'Client' && n.props.module === './history-size.js');
  assert.ok(client, 'a retained rich prefix owns a size observer');
  const held = h.offset, dispatched = [];
  const surface = { elements: { Box: props => props }, rows: 50, setState(value) { this.state = value; }, post(data) {
    dispatched.push(h.host.surface(() => h.host.dispatch('ui.message', { element: client.props.key, data })));
  } };
  const firstSample = h.samples.length;
  historySize(client.props.props, surface);
  historySize(client.props.props, surface); await Promise.all(dispatched);
  const initial = h.samples.slice(firstSample).filter(sample => sample.args.to?.key === client.props.props.key);
  assert.ok(initial.length && initial.every(sample => sample.deny), 'mounting an unchanged prefix never schedules a stale native scroll write');
  growth = 73; surface.rows += growth;
  historySize(client.props.props, surface); await Promise.all(dispatched);
  assert.equal(h.offset, held + 73, 'the retained item stays at its previous viewport row');
  historySize(client.props.props, surface);
  assert.equal(dispatched.length, 2, 'unchanged geometry does not start another native probe');
  const probes = h.scrolls.length;
  surface.state = null;
  historySize(client.props.props, surface);
  historySize(client.props.props, surface); await Promise.all(dispatched);
  assert.equal(h.scrolls.length, probes, 'a remounted Client cannot remeasure an already reconciled size');
  await pause(200); await h.nativeMove(1);
  const moved = h.offset;
  growth += 10; surface.rows += 10;
  historySize(client.props.props, surface); await Promise.all(dispatched);
  assert.equal(h.offset, moved, 'a later human move owns the viewport');
});

for (const autodrift of [false, true]) test(`reverse movement preserves the reading coordinate with ${autodrift ? 'native anchoring' : 'unchanged native position'}`, async t => {
  let growth = 0;
  const h = await setup({ live: longEntries(), nativeContentRows: () => 600 + growth, prefixGrowth: () => growth }); t.after(h.close);
  await h.nativeMove(-1000); await h.waitNavigation();
  const client = await waitFor(() => h.painted.find(n => n.props.module === './history-size.js'));
  const report = rows => h.host.surface(() => h.host.dispatch('ui.message', { element: client.props.key,
    data: { action: 'history-size', key: client.props.props.key, rows },
  }));
  await report(50);
  const held = h.offset;
  growth = 73;
  if (autodrift) await h.nativeMove(growth);
  await h.nativeMove(4); await h.nativeMove(6);
  assert.equal(h.offset, held + 10 + (autodrift ? growth : 0), 'fresh motion is accepted before the delayed size report');
  await report(123);
  assert.equal(h.offset, held + 10 + growth, 'only the actual prefix growth is added to the moved position');
  await h.nativeMove(3);
  growth += 20;
  await report(143);
  assert.equal(h.offset, held + 86, 'the old size observer no longer owns the reader after reconciliation');
});

test('a delayed prefix measurement cannot replace the start of a new hard-top navigation', async t => {
  let anchorKey, release;
  const h = await setup({ live: longEntries(), nativeContentRows: 600, onProbeReply({ to }) {
    if (anchorKey && to?.key === anchorKey && !release) return new Promise(resolve => { release = resolve; });
    return {};
  } }); t.after(() => { release?.({}); h.close(); });
  await h.nativeMove(-1000); await h.waitNavigation();
  const client = await waitFor(() => h.painted.find(n => n.props.module === './history-size.js'));
  const first = messages(h)[0];
  await pause(200);
  anchorKey = client.props.props.key;
  const measuring = h.host.surface(() => h.host.dispatch('ui.message', { element: client.props.key,
    data: { action: 'history-size', key: anchorKey, rows: 80 },
  }));
  await waitFor(() => release);
  await h.nativeMove(-1000);
  assert.equal(h.offset, 0);
  release({}); await measuring;
  await waitFor(() => !settling(h) && messages(h)[0] !== first);
  assert.equal(h.offset, messages(h).indexOf(first), 'the new prepend uses the acknowledged hard-top row');
});

test('one prepend keeps its native reading marker even with long source item IDs', async t => {
  const h = await setup({ live: longEntries().map(e => ({ ...e, id: 'x'.repeat(270) + e.id })) }); t.after(h.close);
  const first = messages(h)[0];
  h.wheel(-1); await h.waitNavigation();
  assert.notEqual(messages(h)[0], first);
  assert.ok(messages(h).includes(first));
  assert.ok(h.scrolls.every(call => (call.to?.key?.length ?? 0) <= 256));
});

test('one downward movement reaching the rounded desktop end loads the next window', async t => {
  const h = await setup({ live: longEntries() }); t.after(h.close);
  h.wheel(-1); await h.waitNavigation();
  const last = messages(h).at(-1), rows = messages(h).length + 10;
  assert.ok(!last.startsWith('message-99 '));
  await h.nativeMove(rows - 10 - 2 - h.offset);
  await h.waitNavigation();
  assert.notEqual(messages(h).at(-1), last);
});

test('installing a reading marker at the render budget keeps tall history at the same viewport row', async t => {
  const tall = (i, length = 8550) => ({ ...entry(i), data: { text: `message-${i}\n`.padEnd(length, 'a line of history content\n') } });
  let revision = 1, live = Array.from({ length: 25 }, (_, i) => tall(i)), growth = 0, h;
  const loaded = Array.from({ length: 6 }, (_, i) => tall(25 + i, 6500));
  const ids = () => messages(h).map(text => Number(text.match(/^message-(\d+)/)[1]));
  const textRows = text => text.split('\n').length;
  const messageRows = node => textRows(node.props.text);
  const precedingRows = index => 3 + messages(h).slice(0, index).reduce((sum, text) => sum + textRows(text), 0);
  const nativeContentRows = tree => {
    const rows = 10 + growth + tree.filter(node => node.type === 'Markdown').reduce((sum, node) => sum + messageRows(node), 0);
    return Math.max(rows, tree[0]?.props.minHeight ?? 0);
  };
  const markerFrames = [];
  h = await setup({ revision: () => ({ revision, entries: live }), vectorControls: true, messageRows, nativeContentRows,
    prefixGrowth: () => growth, onMeasurement: key => {
      if (key.startsWith('codex_read_anchor_')) markerFrames.push(ids());
    } });
  t.after(h.close);
  await h.nativeMove(-80);
  const old = ids(), end = old.at(-1), tail = h.offset + 80;
  revision++; live = [...live, ...loaded];
  await h.tick(); await h.draw();
  assert.deepEqual(ids(), old, 'live arrivals leave the budget-limited reading window intact');
  assert.equal(end, 24);
  assert.ok(old[0] > 0, 'the original window reaches the native render budget');
  const oldEndRow = precedingRows(-1);
  await h.nativeMove(80);
  await waitFor(() => markerFrames.length && !settling(h) && ids().at(-1) > end);
  assert.deepEqual(markerFrames[0], old, 'painting the baseline marker retains all the original groups');
  const newer = ids();
  assert.ok(newer[0] > old[0] && newer.includes(end) && newer.at(-1) > end);
  assert.deepEqual(newer, Array.from({ length: newer.length }, (_, i) => newer[0] + i));
  const newEndRow = precedingRows(newer.indexOf(end));
  assert.equal(h.offset - newEndRow, tail - oldEndRow, 'the first exposed frame keeps the last old message at its previous viewport row');

  const before = newer[0];
  await h.nativeMove(-10000);
  const sensor = await waitFor(() => ids()[0] < before && !settling(h) && h.painted.find(node => node.props.module === './history-size.js'));
  const held = h.offset;
  const report = rows => h.host.surface(() => h.host.dispatch('ui.message', { element: sensor.props.key,
    data: { action: 'history-size', key: sensor.props.props.key, rows },
  }));
  await report(100);
  growth = 180;
  await report(100 + growth);
  assert.equal(h.offset, held + growth, 'a later prefix resize keeps the same old message at the same viewport row');
});

test('reversing before the ready surface post clears the request and ignores its delayed token', async t => {
  let post = true;
  const h = await setup({ live: longEntries(), nativeContentRows: 600, autoPost: () => post }); t.after(h.close);
  post = false;
  const oldFirst = messages(h)[0];
  await h.nativeMove(-1000);
  const token = await waitFor(() => readyToken(h));
  await h.nativeMove(4);
  assert.equal(h.offset, 4);
  await waitFor(() => !readyToken(h));
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'navigate', token } }));
  assert.equal(messages(h)[0], oldFirst);
  assert.ok(!settling(h));
});

test('reversing during the old-window probe moves immediately and releases the loading layer', async t => {
  let h, release, block = false;
  h = await setup({ live: longEntries(), nativeContentRows: 600, onMeasurement(key) {
    if (block && !key.startsWith('codex_tail_') && !release) return new Promise(resolve => { release = resolve; });
  } }); t.after(() => { release?.(); h.close(); });
  const oldFirst = messages(h)[0];
  block = true;
  await h.nativeMove(-1000);
  await waitFor(() => release);
  await h.nativeMove(5);
  assert.equal(h.offset, 5, 'reversal belongs to the old frame still on screen');
  await waitFor(() => !settling(h));
  release(); await h.waitNavigation();
  assert.equal(h.offset, 5, 'a late probe cannot undo the reversal');
  assert.equal(messages(h)[0], oldFirst);
});

test('a delayed geometry probe preserves successive equal native moves across a history shift', async t => {
  let h, oldFirst, releaseOld, releaseNew, growth = 0;
  h = await setup({ live: longEntries(), nativeContentRows: () => 600 + growth, prefixGrowth: () => growth,
    onProbeReply({ to }) {
      if (oldFirst && to?.key?.startsWith('codex_read_anchor_') && messages(h)[0] === oldFirst && !releaseOld) {
        return new Promise(resolve => { releaseOld = resolve; });
      }
    },
    onMeasurement(key) {
      if (oldFirst && key.startsWith('codex_read_anchor_') && messages(h)[0] !== oldFirst && !releaseNew) {
        return new Promise(resolve => { releaseNew = resolve; });
      }
    },
  }); t.after(() => { releaseOld?.(); releaseNew?.(); h.close(); });
  oldFirst = messages(h)[0];
  await h.nativeMove(110 - h.offset);
  await waitFor(() => releaseOld);
  await h.nativeMove(-6);
  await h.nativeMove(-6);
  releaseOld();
  await waitFor(() => releaseNew);
  assert.equal(h.offset, 98, 'the old-window reply cannot rewind the two native moves');
  growth = 45;
  await h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: -6, offset: 98, contentRows: 645, bodyRows: 10 });
  await h.nativeMove(-6);
  releaseNew();
  await waitFor(() => !settling(h));
  assert.equal(h.offset, messages(h).indexOf(oldFirst) + growth + 92);
});

test('reversed movement during a painted prepend survives slow geometry and old-frame packets', async t => {
  let h, oldFirst, release, growth = 0;
  h = await setup({ live: longEntries(), nativeContentRows: () => 600 + growth, prefixGrowth: () => growth,
    onMeasurement(key) {
      if (oldFirst && key.startsWith('codex_read_anchor_') && messages(h)[0] !== oldFirst && !release) {
        return new Promise(resolve => { release = resolve; });
      }
    },
  }); t.after(() => { release?.(); h.close(); });
  oldFirst = messages(h)[0];
  await h.nativeMove(-1000);
  await waitFor(() => release);
  assert.ok(settling(h));
  await h.nativeMove(4);
  growth = 45;
  await h.nativeMove(6);
  await h.nativeMove(2);
  assert.equal(h.offset, 12, 'repeated reverse deltas advance the native viewport in the covered frame');
  release();
  await waitFor(() => !settling(h));
  const committed = messages(h).indexOf(oldFirst) + growth + 12;
  assert.equal(h.offset, committed, 'the commit combines marker displacement and the reader’s movement');
  const queued = await h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: 3, offset: 15, contentRows: 645, bodyRows: 10 });
  assert.equal(queued.offset, committed, 'an uncommitted old starting coordinate cannot replace the anchored row');
  await h.nativeMove(3);
  assert.equal(h.offset, committed + 3, 'a real wheel event starting at the committed row applies immediately');
  assert.equal(navigations(h), 1);
});

test('one append evicts the far side and preserves its reading anchor through prefix growth', async t => {
  let h, boundary, grown, first;
  const frames = [];
  const weight = text => 12 + (text === grown ? 21 : 0);
  const body = tree => {
    const texts = tree.filter(n => n.type === 'Markdown').map(n => n.props.text);
    return Math.max(tree[0]?.props.minHeight ?? 0, 30 + texts.reduce((sum, value) => sum + weight(value), 0));
  };
  const marker = () => 3 + messages(h).slice(0, messages(h).indexOf(boundary)).reduce((sum, text) => sum + weight(text), 0);
  h = await setup({ live: longEntries(), nativeContentRows: body, messageRows: node => weight(node.props.text), onRender() {
    if (boundary) {
      const current = messages(h);
      frames.push([current[0], current.at(-1)]);
    }
  }, onMeasurement(key) {
    if (!boundary || !key.startsWith('codex_read_anchor_')) return;
    const current = messages(h);
    if (!grown && current.at(-1) !== boundary) grown = current[current.indexOf(boundary) - 1];
  } }); t.after(() => h.close());
  await h.nativeMove(-1000); await h.waitNavigation();
  first = messages(h)[0]; boundary = messages(h).at(-1);
  assert.ok(!boundary.startsWith('message-99 '));
  const distance = body(h.painted) - 10 - marker();
  await h.nativeMove(1000);
  await waitFor(() => !settling(h) && messages(h).at(-1) !== boundary);
  assert.ok(grown, 'a retained item grew while the replacement was still covered');
  assert.notEqual(messages(h)[0], first, 'the same replacement released the far side');
  assert.ok(frames.length > 1 && frames.every(([start, end]) => start === first || end !== boundary), 'every render shows the original window or an advanced window');
  assert.equal(h.offset, marker() + distance);
  const placed = h.offset;
  for (let i = 0; i < 3; i++) await h.nativeMove(4);
  assert.equal(h.offset, placed + 12, 'genuine scrolling resumes before the settled gesture expires');
  assert.equal(navigations(h), 2);
});

test('a near-end shift keeps a tall message under the viewport and retries at the physical edge', async t => {
  const entries = longEntries();
  let giant, revision = 1, live = entries.slice(0, 25);
  const messageRows = node => node.props.text === giant ? 1000 : 1;
  const nativeContentRows = tree => {
    const messages = tree.filter(n => n.type === 'Markdown');
    giant ??= messages[0]?.props.text;
    const rows = 10 + messages.reduce((sum, node) => sum + messageRows(node), 0);
    return Math.max(tree[0]?.props.minHeight ?? 0, rows);
  };
  const h = await setup({ revision: () => ({ revision, entries: live }), messageRows, nativeContentRows });
  t.after(h.close);
  const original = messages(h), end = original.at(-1);
  assert.equal(original[0], giant);
  await h.nativeMove(-300);
  live = entries.slice(0, 31); revision++;
  await h.tick(); await h.draw();
  const max = nativeContentRows(h.painted) - 10;
  const near = max - Math.ceil(max / 5);
  await h.nativeMove(near - h.offset);
  await h.waitNavigation();
  assert.equal(navigations(h), 1);
  assert.deepEqual(messages(h), original);
  assert.equal(h.offset, near, 'the reader stays at the same row in the tall message');
  await pause(200);
  await h.nativeMove(35);
  await h.waitNavigation();
  assert.equal(navigations(h), 1, 'movement within the tall message does not repeat the unsafe shift');
  await h.nativeMove(max - h.offset);
  await waitFor(() => messages(h).at(-1) !== end && !settling(h));
  assert.equal(navigations(h), 2);
  assert.notEqual(messages(h)[0], giant, 'the old prefix can leave once it is above the viewport');
});

test('continuous wheel inertia crossing a prepend keeps the committed reading position', async t => {
  const h = await setup({ live: longEntries() }); t.after(h.close);
  h.wheel(-1);
  const wheel = setInterval(() => upward(h, messages(h).length + 10, -3), 24);
  t.after(() => clearInterval(wheel));
  await h.waitNavigation();
  const held = h.offset;
  assert.ok(held > 0, 'the previous top record has been positioned after the prepend');
  await pause(300);
  assert.equal((await upward(h, messages(h).length + 10, -3)).offset, held);
  assert.equal(navigations(h), 1, 'events continuing after settlement belong to the same gesture');
  clearInterval(wheel);
  await h.nativeMove(-1);
  assert.equal(h.offset, held - 1, 'matching the committed row lets a genuine move resume reading');
  await pause(210);
  await h.nativeMove(-1);
  assert.equal(h.offset, held - 2, 'a new gesture immediately moves the reader');
  await h.nativeMove(-1000); await h.waitNavigation();
  assert.equal(navigations(h), 2, 'subsequent sustained input reaches the new edge');
});

test('one jump from older history settles at the newest footer through a delayed layout and refused commit', async t => {
  let mounted = true, delayedRows = 0, refused = false;
  const contentRows = tree => Math.max(20, tree.filter(n => n.type === 'Markdown').length + 10 + delayedRows);
  const h = await setup({ live: longEntries(), vectorControls: true, autoPost: () => mounted, nativeContentRows: contentRows,
    commitScroll({ to }) {
      if (!mounted && !refused && to === 'end') {
        refused = true;
        delayedRows = 48;
        return { deny: 'the window moved meanwhile' };
      }
      return {};
    },
  }); t.after(h.close);
  h.wheel(-1); await h.waitNavigation();
  assert.ok(!hasMessage(h, 'message-99 '));
  assert.ok(Number.isFinite(h.offset), JSON.stringify(h.samples));
  mounted = false;
  const prior = h.samples.length;
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_jump_a_viewport', data: { action: 'activate', expanded: false } }));
  await h.draw();
  assert.ok(hasMessage(h, 'message-99 '));
  assert.ok(h.painted.some(node => node.props.key === 'codex_back_directory_footer'));
  const samples = h.samples.slice(prior), end = contentRows(h.painted) - 10;
  const moved = samples.filter(sample => sample.before !== sample.after);
  assert.ok(refused);
  assert.equal(samples.filter(sample => sample.args.to === 'end').length, 2, 'the same click retries the refused end');
  assert.deepEqual(moved.map(sample => [sample.args.to, sample.after]), [['end', end]], 'probes leave the viewport in place');
  assert.equal(h.offset, end);

  const queued = await h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: -4, offset: 6, contentRows: contentRows(h.painted), bodyRows: 10 });
  assert.equal(queued.offset, end, 'a queued old-window wheel report preserves the committed end');
  await h.nativeMove(-3);
  assert.equal(h.offset, end - 3, 'an upward wheel beginning at the real end can read immediately');
});

test('one jump reaches native end after the latest frame paints without a tail marker', async t => {
  let jumping = false, refused = 0, missing = 0;
  const h = await setup({ live: longEntries(), vectorControls: true,
    onMeasurement(key) {
      if (jumping && key.startsWith('codex_tail_a_')) {
        missing++;
        throw Error('the tail marker is absent from the native key table');
      }
    },
    commitScroll({ to }) {
      if (jumping && to === 'end' && ++refused <= 6) return { deny: 'the window moved meanwhile' };
      return {};
    },
  }); t.after(h.close);
  await h.wheel(-1); await h.waitNavigation();
  assert.ok(!hasMessage(h, 'message-99 '));
  const prior = h.samples.length, priorDispatches = h.host.calls.length;
  jumping = true;
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_jump_a_viewport', data: { action: 'activate', expanded: false } }));
  await h.waitNavigation(); await h.draw();
  assert.ok(missing > 0, 'the native key table never admits the new tail marker');
  assert.ok(h.host.calls.slice(priorDispatches).some(call => call.input.data?.action === 'tail'), 'the latest frame acknowledges the jump');
  const samples = h.samples.slice(prior), end = messages(h).length;
  assert.equal(samples.filter(sample => sample.args.to === 'end').length, 7, 'refusal through one second is retried by the same click');
  assert.deepEqual(samples.filter(sample => sample.before !== sample.after).map(sample => sample.after), [end]);
  assert.ok(hasMessage(h, 'message-99 '));
  assert.equal(h.offset, end);
});

test('a delayed read of the newest footer cannot undo the first upward wheel', async t => {
  let armed = false, release;
  const h = await setup({ live: longEntries(), nativeContentRows: 510, onProbeReply({ to }) {
    if (armed && !release && to?.key?.startsWith('codex_tail_')) return new Promise(resolve => { release = resolve; });
    return {};
  } });
  t.after(() => { release?.({}); h.close(); });
  await h.nativeMove(-15);
  armed = true;
  await h.nativeMove(15);
  await waitFor(() => release);
  const end = h.offset;
  await h.nativeMove(-5);
  release({});
  await h.waitNavigation();
  assert.equal(h.offset, end - 5);
  assert.ok(h.samples.at(-1).args.to.key.startsWith('codex_tail_'));
  assert.ok(h.samples.at(-1).deny, 'the footer measurement never writes an absolute position');
});

test('a later upward move releases native following even when the reported row geometry has changed', async t => {
  const h = await setup({ live: longEntries(), vectorControls: true }); t.after(h.close);
  await h.nativeMove(-4); await h.draw();
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_jump_a_viewport', data: { action: 'activate', expanded: false } }));
  await h.waitNavigation();
  const previousEnd = h.offset, bodyRows = 10, contentRows = previousEnd + bodyRows + 26;
  const report = (offset, by) => h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, offset, by, contentRows, bodyRows });
  const layout = await report(previousEnd, 0);
  assert.equal(layout.offset, contentRows - bodyRows, 'layout growth retains end-following');
  const upward = await report(previousEnd - 3, -3);
  assert.equal(upward.offset, previousEnd - 3, 'a later real upward move must escape following despite a mismatched starting row');
});

test('an upward move from the measured viewport cancels an in-flight jump to latest', async t => {
  let mounted = true, probes = 0, signalSample, release;
  const sampling = new Promise(resolve => { signalSample = resolve; });
  const h = await setup({ live: longEntries(), vectorControls: true, autoPost: () => mounted,
    onMeasurement(key) {
      if (mounted || !key.startsWith('codex_tail_a_') || ++probes !== 2) return;
      return new Promise(resolve => { release = resolve; signalSample(); });
    },
  }); t.after(() => { release?.(); h.close(); });
  h.wheel(-1); await h.waitNavigation();
  mounted = false;
  const prior = h.scrolls.length;
  const jump = h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_jump_a_viewport', data: { action: 'activate', expanded: false } }));
  await Promise.race([sampling, pause(1500).then(() => { throw Error('tail measurement did not start'); })]);
  const held = h.offset;
  assert.ok(held > 0);
  await h.nativeMove(-1);
  release(); await jump;
  assert.equal(h.offset, held - 1, 'the cancelled measurement preserves the newer reading position');
  assert.ok(!h.scrolls.slice(prior).some(call => call.to === 'end'));
});

test('short viewport consumes multiple cursors before a native wheel can move', async t => {
  const h = await setup({ nativeContentRows: tree => Math.max(10, 9 + tree.filter(node => node.type === 'Markdown').length), history: args => {
    const index = args.cursor?.index ?? 8;
    return { entries: [entry(index)], next_cursor: index > 0 ? { index: index - 1 } : null };
  } }); t.after(h.close);
  for (let attempt = 0; attempt < 8 && !messages(h).includes('message-5'); attempt++) await h.waitNavigation();
  assert.deepEqual(messages(h), ['message-5', 'message-6', 'message-7', 'message-8']);
  const before = navigations(h);
  await upward(h, 13, 0); await h.waitNavigation();
  assert.equal(navigations(h), before, 'layout-only events do not unlock navigation');
  await h.nativeMove(-10); await h.waitNavigation();
  assert.ok(messages(h).includes('message-4'));
  assert.equal(navigations(h), before + 1);
});

test('one native edge visit advances past many pages containing only folded process records', async t => {
  const h = await setup({ history: ({ cursor }) => {
    if (!cursor) return {
      entries: Array.from({ length: 20 }, (_, i) => ({ ...entry(i), turn_id: i ? `t${i}` : 't', message: { phase: 'final_answer', is_final: true } })),
      turns: [{ id: 't', status: 'completed', duration_ms: 1000, history_start_loaded: false }], next_cursor: { index: 20 },
    };
    if (cursor.index === 0) return { entries: [{ ...entry(-1), turn_id: 'oldest' }], next_cursor: null };
    return {
      entries: [{ type: 'turnProcessPage', turn_id: 't', cursor: String(cursor.index), limit: 50, ids: [`tool-${cursor.index}`] }],
      next_cursor: { index: cursor.index - 1 },
    };
  } }); t.after(h.close);
  const draws = h.invalidations;
  await h.nativeMove(-1000);
  for (let attempt = 0; attempt < 8 && !messages(h).includes('message--1'); attempt++) await h.waitNavigation();
  assert.deepEqual(messages(h), ['message--1', ...Array.from({ length: 20 }, (_, i) => `message-${i}`)]);
  assert.equal(navigations(h), 1);
  assert.ok(h.invalidations - draws < 12, 'twenty invisible cursor pages do not redraw the pane separately');
  assert.deepEqual(h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor).map(call => call.args.cursor.index), Array.from({ length: 21 }, (_, i) => 20 - i));
});

test('an opened 24-hour process reaches uncached earlier steps with ordinary upward navigation', async t => {
  const steps = Array.from({ length: 120 }, (_, i) => ({
    id: `s${i}`, turn_id: 't', type: 'agentMessage', data: { text: `step-${i}` }, message: { phase: 'commentary' },
  }));
  const turn = { id: 't', status: 'completed', duration_ms: 86400000, final_item_id: 'final', history_start_loaded: false };
  const prompt = { id: 'prompt', turn_id: 't', type: 'userMessage', data: { content: [{ type: 'text', text: 'First prompt' }] }, turn_input: 'start' };
  const final = { id: 'final', turn_id: 't', type: 'agentMessage', data: { text: 'Final reply' }, message: { phase: 'final_answer', is_final: true } };
  const page = start => ({ type: 'turnProcessPage', turn_id: 't', cursor: String(start), limit: 30,
    ids: steps.slice(start, start + 30).map(step => step.id) });
  const h = await setup({ nativeContentRows: 100, history: ({ cursor, process_page: locator }) => {
    if (locator) {
      const start = Number(locator.cursor);
      return { entries: steps.slice(start, start + locator.limit) };
    }
    if (!cursor) return { entries: [page(90), final], turns: [turn], next_cursor: { start: 60 } };
    if (cursor.start) return { entries: [page(cursor.start)], next_cursor: { start: cursor.start - 30 } };
    return { entries: [prompt, page(0)], turns: [{ ...turn, history_start_loaded: true }], next_cursor: null };
  } }); t.after(h.close);
  const summary = 'turn_process_a:t';
  const processReads = () => h.calls.filter(({ args }) => args.process_page).map(({ args }) => Number(args.process_page.cursor));
  assert.deepEqual(processReads(), []);
  await h.press(summary);
  await waitFor(() => messages(h).includes('step-90'));
  assert.deepEqual(processReads(), [90]);
  for (const start of [60, 30, 0]) {
    await h.nativeMove(50 - h.offset);
    await h.nativeMove(-100);
    await waitFor(() => messages(h).includes(`step-${start}`) && !settling(h));
  }
  assert.ok(h.painted.some(node => node.props.key === 'message_a:t:prompt'));
  assert.deepEqual([...new Set(processReads())], [90, 60, 30, 0]);
});

for (const growth of [0, 7]) test(`opening and closing a process preserves its summary with ${growth} rows of prefix growth`, async t => {
  const earlier = Array.from({ length: 15 }, (_, i) => ({ ...entry(i), turn_id: 'older' }));
  const turns = [{ id: 't', status: 'completed', duration_ms: 86400000, final_item_id: 'm101' }];
  const live = [...earlier, entry(100), { ...entry(101), message: { phase: 'final_answer', is_final: true } }];
  let prefix = 0;
  const h = await setup({ nativeContentRows: 100, vectorControls: true, revision: () => ({ revision: 1, entries: live, turns }),
    prefixGrowth: () => prefix,
    onRender(tree) {
      prefix = tree.some(node => node.props.key === 'icon_turn_process_a:t' && node.props.alt === '收起过程') ? growth : 0;
    },
  }); t.after(h.close);
  await h.nativeMove(10 - h.offset);
  const before = h.offset, sampleStart = h.samples.length;
  await h.press('turn_process_a:t');
  assert.equal(h.offset, before + growth);
  assert.ok(messages(h).includes('message-100'));
  await h.press('turn_process_a:t');
  assert.equal(h.offset, before);
  assert.ok(!messages(h).includes('message-100'));
  const placement = h.samples.slice(sampleStart).filter(({ args }) => args.to?.key?.startsWith('codex_read_anchor_'));
  assert.ok(placement.some(({ deny }) => deny), 'the new layout was sampled');
  assert.equal(placement.filter(({ deny }) => !deny).length, growth ? 2 : 0, 'a matching row never rewrites the native viewport');
});

function bufferedTurnFixture({ seam = false } = {}) {
  const turns = Array.from({ length: 90 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', duration_ms: 86400000, final_item_id: `final-${i}` }));
  const live = turns.flatMap(({ id: turnId }, i) => [
    { id: `step-${i}`, turn_id: turnId, type: 'agentMessage', data: { text: `process step ${i}` }, message: { phase: 'commentary' } },
    { id: `final-${i}`, turn_id: turnId, type: 'agentMessage',
      // Fill the remaining core budget up to the first reply's header.
      data: { text: `final ${i} ${'text '.repeat(500)}${seam && i === 74 ? 'x'.repeat(2400) : ''}` }, message: { phase: 'final_answer', is_final: true } },
  ]);
  return () => ({ revision: 1, entries: live, turns });
}

test('a process summary clicked farther inside the upper history buffer opens in the main window', async t => {
  const h = await setup({ bodyColumns: 80, nativeContentRows: 200, revision: bufferedTurnFixture() }); t.after(h.close);
  const buffered = tree => tree.filter(node => node.props.key?.startsWith('codex_history_band_')).flatMap(nodes);
  const summary = buffered(h.painted).find(node => node.type === 'Button' && node.props.key.startsWith('turn_process_a:'));
  assert.ok(summary, 'an older summary is initially mounted in a neighbour buffer');
  await h.press(summary.props.key);
  const id = summary.props.key.split('-').at(-1);
  await waitFor(() => messages(h).includes(`process step ${id}`));
  assert.ok(h.painted.some(node => node.props.key === summary.props.key));
  assert.ok(!buffered(h.painted).some(node => node.props.key === summary.props.key));
});

test('the last upper-lane summary stays in that physical lane when its process opens below', async t => {
  const h = await setup({ bodyColumns: 80, nativeContentRows: 200, revision: bufferedTurnFixture({ seam: true }) }); t.after(h.close);
  const upper = () => h.painted.find(node => node.props.key === 'codex_history_band_above_a');
  const oldBand = upper(), groups = oldBand.props.children[0].props.children;
  const summary = nodes(groups.at(-2)).find(node => node.type === 'Button' && node.props.key.startsWith('turn_process_a:'));
  assert.ok(summary, groups.at(-2).props.key);
  const id = summary.props.key.split('-').at(-1);
  const upperNodes = new Set(nodes(oldBand));
  assert.ok(h.painted.find(node => node.type === 'Markdown' && !upperNodes.has(node)).props.text.startsWith(`final ${id} `));
  const height = oldBand.props.height;
  await h.press(summary.props.key);
  await waitFor(() => messages(h).includes(`process step ${id}`));
  assert.equal(upper().props.height, height);
  assert.ok(nodes(upper()).some(node => node.props.key === summary.props.key));
  assert.ok(!nodes(upper()).some(node => node.props.text === `process step ${id}`));
  await h.press(summary.props.key);
  assert.equal(upper().props.height, height);
  assert.ok(nodes(upper()).some(node => node.props.key === summary.props.key));
  assert.ok(!messages(h).includes(`process step ${id}`));
});

test('a deferred final message can collapse during body loading and keeps its reading row', { timeout: 5000 }, async t => {
  const key = 'item_a:t:m100';
  const live = [...Array.from({ length: 25 }, (_, i) => entry(i)), { ...entry(100), message: { is_final: true, truncated: true } }];
  let completePreload, completeBody, reads = 0;
  const h = await setup({ live, nativeContentRows: 100,
    measureOffset: ({ to, block }, offset) => to?.key?.startsWith('codex_body_start_') && block === 'start' ? -2 : offset,
    history({ cursor, expand }) {
      if (expand && ++reads === 1) return new Promise(resolve => { completeBody = resolve; });
      if (expand) return { text: 'Fresh complete body' };
      if (cursor) return new Promise(resolve => { completePreload = resolve; });
      return { entries: [], next_cursor: { older: true } };
    },
  });
  t.after(() => { completePreload?.({ entries: [], next_cursor: null }); completeBody?.({ text: 'Late complete body' }); h.close(); });
  await waitFor(() => completePreload);
  await h.nativeMove(30 - h.offset);
  const before = h.offset, samples = h.samples.length, invalidations = h.invalidations;
  await h.press(key);
  assert.equal(reads, 1);
  assert.equal(h.invalidations, invalidations + 1, 'a pending body requires one repaint');
  assert.equal(h.offset, before);
  assert.ok(h.samples.slice(samples).some(({ args, deny }) => args.to?.key?.startsWith('codex_body_start_') && args.block === 'end' && deny), 'negative start coordinates are retried read-only from the opposite alignment');
  await waitFor(() => h.painted.some(node => node.props.key === key && node.props.label === '收起'));
  await h.nativeMove(5);
  const moved = before + 5;
  assert.equal(h.offset, moved, 'a genuine wheel still owns the viewport while the read is pending');
  await h.press(key);
  assert.equal(h.offset, moved);
  completePreload({ entries: [], next_cursor: null });
  completeBody({ text: 'Late complete body' });
  await pause(30);
  assert.equal(h.invalidations, invalidations + 2, 'collapse repaints once and the discarded response adds no repaint');
  assert.ok(!messages(h).includes('Late complete body'));
  assert.ok(messages(h).includes('message-100'));
  await h.press(key);
  await waitFor(() => messages(h).includes('Fresh complete body'));
  assert.equal(reads, 2);
  assert.equal(h.offset, moved);
});

test('expanding and collapsing a local message each need one repaint', async t => {
  const local = { ...entry(100), id: 'action:send', type: 'directUserMessage', data: { text: `${'text '.repeat(900)}visible end` } };
  const h = await setup({ live: [...Array.from({ length: 25 }, (_, i) => entry(i)), local], nativeContentRows: 100 }); t.after(h.close);
  await h.nativeMove(30 - h.offset);
  const invalidations = h.invalidations;
  await h.press('item_a:t:action:send');
  assert.equal(h.invalidations, invalidations + 1);
  assert.ok(messages(h).at(-1).endsWith('visible end'));
  await h.press('item_a:t:action:send');
  assert.equal(h.invalidations, invalidations + 2);
  assert.ok(!messages(h).at(-1).endsWith('visible end'));
});

test('a scroll during cooldown does not consume the next upward intent', async t => {
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  h.wheel(-1, 0); await h.waitNavigation();
  const first = messages(h)[0], count = navigations(h);
  await upward(h, messages(h).length + 10, -100);
  await pause(300);
  await h.nativeMove(-1000); await h.waitNavigation();
  assert.notEqual(messages(h)[0], first);
  assert.equal(navigations(h), count + 1);
});

test('a failed history fetch can later consume a successful cached retry', async t => {
  let attempts = 0;
  const h = await setup({ history: args => {
    if (!args.cursor) return { entries: Array.from({ length: 20 }, (_, i) => entry(i + 20)), next_cursor: { index: 19 } };
    if (++attempts === 1) throw Error('offline mock history read failed');
    return { entries: Array.from({ length: 20 }, (_, i) => entry(i)), next_cursor: null };
  } }); t.after(h.close);
  await pause(100);
  h.wheel(-1, 0); await h.waitNavigation();
  assert.ok(h.painted.some(n => n.type === 'Button' && n.props.key === 'codex_retry_conversation'));
  await upward(h, 30); await h.waitNavigation();
  // The gesture may initiate the retry; a later gesture consumes the completed cache.
  await upward(h, 30); await h.waitNavigation();
  assert.equal(attempts, 2);
  assert.ok(messages(h).includes('message-0'));
});

test('rapid upward gestures during navigation do not queue another window', async t => {
  let release, entered;
  const started = new Promise(r => { entered = r; });
  let block = false;
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));
  const h = await setup({ live, onMeasurement: async key => {
    if (block && key.startsWith('codex_read_anchor_')) { entered(); await new Promise(r => { release = r; }); }
  } }); t.after(h.close);
  block = true;
  h.wheel(-1, 0); await Promise.race([started, pause(2000).then(() => { throw Error('navigation did not start measurement'); })]);
  assert.ok(!settling(h), 'the old history stays visible during its baseline measurement');
  const count = navigations(h);
  const held = h.offset;
  for (let repeat = 0; repeat < 3; repeat++) assert.equal((await upward(h, 110)).offset, held, 'loading gestures keep the current reading offset');
  block = false; release(); await h.waitNavigation(); await pause(500);
  assert.ok(!h.painted.some(n => n.props.key === 'codex_history_settling_a'), 'the loading layer is removed after positioning');
  assert.equal(navigations(h), count, 'in-flight gestures must not schedule another navigation');
  const first = messages(h)[0];
  await pause(300);
  assert.equal(messages(h)[0], first, 'completion must not automatically advance a second window');
});

test('zero-movement layout event does not cancel a deferred history navigation', async t => {
  let release, requested;
  const started = new Promise(r => { requested = r; });
  const h = await setup({ history: args => {
    if (!args.cursor) return { entries: Array.from({ length: 20 }, (_, i) => entry(i + 20)), next_cursor: { index: 19 } };
    requested();
    return new Promise(r => { release = r; });
  } }); t.after(h.close);
  await Promise.race([started, pause(2000).then(() => { throw Error('history prefetch did not start'); })]);
  h.wheel(-1, 0); await pause(100);
  await upward(h, 30, 0);
  release({ entries: Array.from({ length: 20 }, (_, i) => entry(i)), next_cursor: null });
  await h.waitNavigation();
  assert.ok(navigations(h) >= 1, 'layout event must not cancel navigation');
  assert.ok(messages(h).includes('message-0'));
});

test('failed candidate positioning restores the old history window before removing the loading layer', async t => {
  let h, oldFirst, rejected = 0;
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));
  h = await setup({ live, onMeasurement: async () => {
    if (oldFirst && messages(h)[0] !== oldFirst) {
      rejected++;
      assert.ok(h.painted.some(n => n.props.key === 'codex_history_settling_a'));
      throw Error('candidate anchor is not yet available');
    }
  } }); t.after(h.close);
  oldFirst = messages(h)[0];
  h.wheel(-1, 0); await h.waitNavigation(); await pause(100);
  assert.ok(rejected > 0, 'candidate measurement must exercise the failure path');
  assert.equal(messages(h)[0], oldFirst, 'unpositioned earlier content must not be revealed');
  assert.ok(!h.painted.some(n => n.props.key === 'codex_history_settling_a'), 'failed measurement must release its loading layer');
});

test('successive visits to the physical top consume cached older pages to the first record', async t => {
  const h = await setup({ bodyColumns: 82, nativeContentRows: 96, history({ cursor }) {
    if (!cursor) return { entries: Array.from({ length: 30 }, (_, i) => entry(i + 3)), next_cursor: { index: 2 } };
    return { entries: [entry(cursor.index)], next_cursor: cursor.index ? { index: cursor.index - 1 } : null };
  } });
  t.after(h.close);
  const cursors = () => h.calls.filter(call => call.args.cursor).map(call => call.args.cursor.index);
  const upperMessages = () => nodes(h.painted.find(node => node.props.key === 'codex_history_band_above_a'))
    .filter(node => node.type === 'Markdown').map(node => node.props.text);
  await waitFor(() => cursors().includes(1));
  assert.deepEqual(cursors(), [2, 1]);
  assert.ok(!messages(h).includes('message-2'));
  assert.equal(upperMessages()[0], 'message-3', 'the upper band starts at the first merged record');

  const visitTop = async index => {
    if (h.offset <= 1) await h.nativeMove(8);
    await h.nativeMove(-1000);
    await waitFor(() => upperMessages()[0] === `message-${index}`);
  };
  await visitTop(2);
  await visitTop(1);
  await visitTop(0);
  assert.equal(h.offset, 0);
  assert.deepEqual(cursors(), [2, 1, 0]);
});

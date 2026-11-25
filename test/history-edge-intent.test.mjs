import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';
import navigationSync from '../hooks/navigation-sync.js';
import historySize from '../hooks/history-size.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = i => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', data: { text: `message-${i}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup({ live = [], history = () => ({ entries: [], next_cursor: null }), revision = () => ({ revision: 1, entries: live }), onMeasurement = async () => {}, commitScroll = () => ({}), prefixGrowth = () => 0, autoPost = true, shortViewport = false, nativeContentRows, vectorControls = false, agents = [{ agent_id: 'a', status: 'completed' }] } = {}) {
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
          const precedingRows = nativePainted.slice(0, markerIndex).filter(n => n.type === 'Markdown' || n.type === 'Text' && n.props.key?.startsWith('message_')).length;
          const destination = args.to === 'end' || args.block === 'end' ? contentRows - 10 : args.to.key.startsWith('codex_read_anchor_') ? 3 + precedingRows + prefixGrowth() : 3;
          const e = { origin: { kind: 'plugin' }, offset: destination, by: destination - offset, contentRows, bodyRows: 10 };
          const result = await host.dispatch('ui.scroll', e);
          const commit = await commitScroll(args);
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
    painted = nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows: 10, ...(shortViewport ? { contentRows: 10, offset: 0 } : {}), ...restoredScroll } } }, () => null));
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

const longEntries = () => Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));

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
  historySize(client.props.props, surface);
  historySize(client.props.props, surface); await Promise.all(dispatched);
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
  await h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: 4, offset: rows - 10 - 2, contentRows: rows, bodyRows: 10 });
  await h.waitNavigation();
  assert.notEqual(messages(h).at(-1), last);
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
  assert.equal(h.offset, held, 'even fresh-coordinate packets in this burst retain the committed reading position');
  await pause(210);
  await h.nativeMove(-1);
  assert.equal(h.offset, held - 1, 'a new gesture immediately moves the reader');
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

test('a scroll during cooldown does not consume the next upward intent', async t => {
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  h.wheel(-1, 0); await h.waitNavigation();
  const first = messages(h)[0], count = navigations(h);
  await upward(h, messages(h).length + 10, -100);
  await pause(300);
  await upward(h, messages(h).length + 10); await h.waitNavigation();
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
    if (block && key.startsWith('codex_history_')) { entered(); await new Promise(r => { release = r; }); }
  } }); t.after(h.close);
  block = true;
  h.wheel(-1, 0); await Promise.race([started, pause(2000).then(() => { throw Error('navigation did not start measurement'); })]);
  assert.ok(h.painted.some(n => n.props.key === 'codex_history_settling_a'), 'intermediate layouts stay behind the loading layer');
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';
import navigationSync from '../hooks/navigation-sync.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = i => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', data: { text: `message-${i}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup({ live = [], history = () => ({ entries: [], next_cursor: null }), revision = () => ({ revision: 1, entries: live }), onMeasurement = async () => {}, autoPost = true, shortViewport = false, nativeContentRows, agents = [{ agent_id: 'a', status: 'completed' }] } = {}) {
  closeUI();
  const hooks = [], scrolls = [], calls = [], timers = [];
  let painted = [], nativePainted = [], offset = 0, drawQueued = false, closed = false, constructed = 0, maxConstructed = 0;
  const surfacePending = new Set();
  const surface = { state: 0, setState(value) { this.state = value; }, elements: { Box: props => props }, post(data) {
    const task = new Promise(resolve => setImmediate(resolve)).then(() => { if (!closed) return host.surface(() => host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data })); });
    surfacePending.add(task); task.finally(() => surfacePending.delete(task));
  } };
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Client'].map(type => [type, props => { constructed++; return { type, props }; }])),
      open: async () => { nativePainted = painted; return { isPlaced: true }; }, invalidate() {},
      scroll: async args => {
        scrolls.push(args);
        if (args.to?.key) {
          if (!nativePainted.some(n => n.type === 'Button' && n.props.key === args.to.key)) throw Error('key not painted');
          await onMeasurement(args.to.key);
          const contentRows = nativeContentRows ?? Math.max(20, nativePainted.filter(n => n.type === 'Markdown').length + 10);
          const markerIndex = nativePainted.findIndex(n => n.type === 'Button' && n.props.key === args.to.key);
          const precedingRows = nativePainted.slice(0, markerIndex).filter(n => n.type === 'Markdown' || n.type === 'Text' && n.props.key?.startsWith('message_')).length;
          const destination = args.block === 'end' ? contentRows - 10 : args.to.key.startsWith('codex_read_anchor_') ? 3 + precedingRows : 3;
          const e = { origin: { kind: 'plugin' }, offset: destination, by: destination - offset, contentRows, bodyRows: 10 };
          offset = (await host.dispatch('ui.scroll', e)).offset;
        }
        return {};
      },
    },
    state: { get: async () => ({ value: 0, version: 0 }), set: async () => {
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
  const draw = async () => {
    constructed = 0;
    painted = nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows: 10, ...(shortViewport ? { contentRows: 10, offset: 0 } : {}) } } }, () => null));
    maxConstructed = Math.max(maxConstructed, constructed);
    const sync = painted.find(n => n.type === 'Client' && n.props.module === './navigation-sync.js');
    if (autoPost && sync) navigationSync(sync.props.props, surface);
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
  const waitNavigation = async () => { await pause(300); while (surfacePending.size) await Promise.all([...surfacePending]); };
  const visitEdge = async direction => { wheel(-direction, 5); await pause(200); wheel(direction); await waitNavigation(); };
  return { $, draw, wheel, visitEdge, calls, scrolls, tick: () => timers[0](), waitNavigation, open: id => openAgent($, id), press: key => host.dispatch('ui.press', { requestId: 'codex_subagent_activity', element: key }), resetConstructed: () => { maxConstructed = 0; }, get maxConstructed() { return maxConstructed; }, host, get offset() { return offset; }, get painted() { return painted; }, close: () => { closed = true; closeUI(); } };
}
const messages = h => h.painted.filter(n => n.type === 'Markdown').map(n => n.props.text);
const hasMessage = (h, prefix) => h.painted.some(n => n.type === 'Markdown' && n.props.text?.startsWith(prefix) || n.type === 'Text' && n.props.key?.startsWith('message_') && n.props.children?.some(value => typeof value === 'string' && value.startsWith(prefix)));
const older = h => h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('codex_history_a_'));

const upward = (h, contentRows = 10, by = -1) => h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, by, offset: 0, contentRows, bodyRows: 10 });
const navigations = h => h.host.calls.filter(call => call.event === 'ui.message' && call.input.data?.action === 'navigate').length;

test('short viewport accepts each new upward gesture without an impossible offset', async t => {
  const h = await setup({ nativeContentRows: 10, history: args => {
    const index = args.cursor?.index ?? 4;
    return { entries: [entry(index)], next_cursor: index > 0 ? { index: index - 1 } : null };
  } }); t.after(h.close);
  await pause(700);
  assert.deepEqual(messages(h), ['message-3', 'message-4']);
  const before = navigations(h);
  await upward(h, 10, 0); await h.waitNavigation();
  assert.equal(navigations(h), before, 'layout-only events do not unlock navigation');
  await upward(h); await h.waitNavigation(); await pause(200);
  assert.ok(messages(h).includes('message-2'));
  await upward(h); await h.waitNavigation();
  assert.ok(messages(h).includes('message-1'), JSON.stringify({ messages: messages(h), navigations: navigations(h), calls: h.calls }));
  assert.equal(navigations(h), before + 2);
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

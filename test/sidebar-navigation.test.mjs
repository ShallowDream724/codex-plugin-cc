import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';
import navigationSync from '../hooks/navigation-sync.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = i => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', data: { text: `message-${i}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup({ live = [], history = () => ({ entries: [], next_cursor: null }), revision = () => ({ revision: 1, entries: live }), onMeasurement = async () => {}, autoPost = true, agents = [{ agent_id: 'a', status: 'completed' }] } = {}) {
  closeUI();
  const hooks = [], scrolls = [], calls = [], timers = [];
  let painted = [], offset = 0, drawQueued = false, closed = false;
  const surfacePending = new Set();
  const surface = { state: 0, setState(value) { this.state = value; }, elements: { Box: props => props }, post(data) {
    const task = new Promise(resolve => setImmediate(resolve)).then(() => { if (!closed) return host.surface(() => host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data })); });
    surfacePending.add(task); task.finally(() => surfacePending.delete(task));
  } };
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Client'].map(type => [type, props => ({ type, props })])),
      open: async () => ({ isPlaced: true }), invalidate() {},
      scroll: async args => {
        scrolls.push(args);
        if (args.to?.key) {
          if (!painted.some(n => n.type === 'Button' && n.props.key === args.to.key)) throw Error('key not painted');
          await onMeasurement(args.to.key);
          const contentRows = Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10);
          const destination = 3;
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
    painted = nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows: 10 } } }, () => null));
    const sync = painted.find(n => n.type === 'Client' && n.props.module === './navigation-sync.js');
    if (autoPost && sync) navigationSync(sync.props.props, surface);
    return painted;
  };
  await openAgent($, 'a'); await draw();
  const wheel = (by, at = by < 0 ? 0 : Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10) - 10) => {
    offset = at;
    const e = { origin: { kind: 'person' }, by, offset: at, contentRows: Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10), bodyRows: 10 };
    return host.dispatch('ui.scroll', e);
  };
  return { $, draw, wheel, calls, scrolls, tick: () => timers[0](), waitNavigation: async () => { await pause(50); while (surfacePending.size) await Promise.all([...surfacePending]); }, open: id => openAgent($, id), press: key => host.dispatch('ui.press', { requestId: 'codex_subagent_activity', element: key }), host, get offset() { return offset; }, get painted() { return painted; }, close: () => { closed = true; closeUI(); } };
}
const messages = h => h.painted.filter(n => n.type === 'Markdown').map(n => n.props.text);
const older = h => h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('codex_history_a_'));

test('window navigation reaches earlier and later cached messages over multiple pages', async t => {
  const h = await setup({ live: Array.from({ length: 240 }, (_, i) => entry(i)) }); t.after(h.close);
  assert.equal(messages(h).length, 120); assert.equal(messages(h)[0], 'message-120');
  for (let i = 0; i < 8 && messages(h)[0] !== 'message-0'; i++) { h.wheel(-1); await pause(600); }
  assert.equal(messages(h)[0], 'message-0');
  for (let i = 0; i < 20 && !messages(h).includes('message-239'); i++) { h.wheel(1); await pause(350); }
  assert.ok(messages(h).includes('message-239'));
  assert.ok(h.scrolls.filter(s => s.to?.key?.startsWith('codex_history_a_')).length > 3);
});

test('short list loads earlier history automatically without a visible load button', async t => {
  const h = await setup({ history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  assert.deepEqual(messages(h), ['message-1']);
  assert.ok(!h.painted.some(n => n.type === 'Button' && /加载更早消息|加载后续消息/.test(n.props.label || '')));
  const markerContainer = h.painted.find(n => n.type === 'Box' && n.props.children?.includes(older(h)));
  assert.equal(markerContainer?.props.height, 0);
  assert.equal(markerContainer?.props.overflow, 'hidden', 'the measurement marker cannot be seen or clicked');
  h.wheel(-1); await pause(100);
  assert.deepEqual(messages(h), ['message-0', 'message-1']);
});

test('continued upward scrolling during an unfinished history request completes navigation', async t => {
  let resolveHistory;
  const h = await setup({ history: args => args.cursor ? new Promise(resolve => { resolveHistory = resolve; }) : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  await pause(10);
  const first = h.wheel(-1, 0); assert.equal(first.offset, 0);
  await pause(45);
  const second = h.wheel(-1, 0); assert.equal(second.offset, 0);
  resolveHistory({ entries: [entry(0)], next_cursor: null }); await pause(100);
  assert.deepEqual(messages(h), ['message-0', 'message-1']);
});

test('budget-limited windows preserve access to both sides of the cached conversation', async t => {
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(2000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  const initial = messages(h); assert.ok(initial.length < 100); assert.ok(initial.at(-1).startsWith('message-99 '));
  for (let i = 0; i < 60 && !messages(h).some(x => x.startsWith('message-0 ')); i++) { h.wheel(-1); await pause(75); }
  assert.ok(messages(h).some(x => x.startsWith('message-0 ')));
  for (let i = 0; i < 40 && !messages(h).some(x => x.startsWith('message-99 ')); i++) { h.wheel(1); await pause(100); }
  assert.ok(messages(h).some(x => x.startsWith('message-99 ')));
});

test('empty initial history can load an older page by scrolling', async t => {
  const h = await setup({ history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  assert.deepEqual(messages(h), []);
  h.wheel(-1); await pause(100);
  assert.deepEqual(messages(h), ['message-0']);
});

test('live updates during a navigation measurement retain the range and appear after the snapshot unfreezes', async t => {
  let revision = 1, live = Array.from({ length: 240 }, (_, i) => entry(i));
  let release, started;
  const measuring = new Promise(resolve => { started = resolve; });
  const h = await setup({
    revision: () => ({ revision, entries: live }),
    onMeasurement: key => key.endsWith('_1') && !release ? new Promise(resolve => { release = resolve; started(); }) : undefined,
  }); t.after(h.close);
  h.wheel(-1);
  await measuring;
  h.wheel(-1, 0);
  live = [{ ...entry(130), data: { text: 'message-130 updated with extra height\n'.repeat(30) } }, entry(240)]; revision++;
  await h.tick(); await h.draw();
  assert.ok(messages(h).includes('message-130'), 'the measured frame remains stable during the update');
  assert.ok(!messages(h).some(text => text.includes('extra height')));
  release(); await pause(600); await h.draw();
  assert.equal(messages(h)[0], 'message-90', 'continued upward scrolling does not interrupt the in-flight window change');
  assert.ok(messages(h).some(text => text.startsWith('message-130 updated with extra height')));
  assert.ok(messages(h).includes('message-179'));
  for (let i = 0; i < 12 && !messages(h).includes('message-240'); i++) { h.wheel(1); await pause(120); }
  assert.ok(messages(h).includes('message-240'), 'new cached activity remains reachable');
});

test('wheel navigation uses a fresh surface message frame for measurements', async t => {
  const h = await setup({ live: Array.from({ length: 180 }, (_, i) => entry(i)) }); t.after(h.close);
  const scrollHooks = h.host; // Calls retain the actual registration objects and origin frames.
  h.wheel(-1, 0); await h.waitNavigation();
  const calls = scrollHooks.calls.filter(call => call.event === 'ui.scroll');
  const personCall = calls.find(call => call.input.origin.kind === 'person');
  const probes = calls.filter(call => call.input.origin.kind === 'plugin');
  assert.ok(personCall); assert.ok(probes.length > 0);
  const messageCall = scrollHooks.calls.find(call => call.event === 'ui.message' && call.input.data?.action === 'navigate');
  assert.ok(messageCall); assert.ok(probes.every(call => call.origin.includes(messageCall.hook)));
  assert.ok(probes.some(call => call.hook !== personCall.hook), 'the plugin observer receives the probe');
  assert.equal(messages(h)[0], 'message-30');
  h.wheel(-1, 40); assert.equal(h.offset, 40);
  const before = scrollHooks.calls.length;
  await h.host.callback(() => h.$.ui.scroll({ to: { key: older(h).props.key }, block: 'start' }));
  assert.equal(scrollHooks.calls.length, before, 'a raw native callback origin excludes all own registrations');
  assert.equal(h.offset, 3, 'without an observer the native scroll reaches the target');
  h.wheel(-1, 0); await h.waitNavigation();
  assert.equal(messages(h)[0], 'message-0', 'another wheel event continues navigation');
});

test('a stale surface navigation token cannot move the window', async t => {
  const h = await setup({ live: Array.from({ length: 180 }, (_, i) => entry(i)), autoPost: false }); t.after(h.close);
  const post = token => h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'navigate', token } }));
  h.wheel(-1, 0); await pause(45); await h.draw();
  const token = h.painted.find(n => n.props.module === './navigation-sync.js').props.props.token;
  assert.ok(token > 0);
  await post(token + 1); assert.equal(messages(h)[0], 'message-60');
  await post(token); await pause(35); assert.equal(messages(h)[0], 'message-30');
  await post(token); await pause(25); assert.equal(messages(h)[0], 'message-30');
  h.wheel(-1, 0); await pause(45); await h.draw();
  const stale = h.painted.find(n => n.props.module === './navigation-sync.js').props.props.token;
  assert.ok(stale > token);
  h.wheel(1, 20); await post(stale); await pause(25);
  assert.equal(messages(h)[0], 'message-30', 'opposite user intent cancels the old request');
});

test('a surface token from before switching agents stays stale after returning', async t => {
  const h = await setup({ live: Array.from({ length: 180 }, (_, i) => entry(i)), autoPost: false, agents: [{ agent_id: 'a', status: 'completed' }, { agent_id: 'b', status: 'completed' }] }); t.after(h.close);
  h.wheel(-1, 0); await pause(45); await h.draw();
  const token = h.painted.find(n => n.props.module === './navigation-sync.js').props.props.token;
  assert.ok(token > 0);
  await h.open('b'); await h.open('a'); await h.draw();
  const before = messages(h)[0];
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'navigate', token } }));
  await pause(35);
  assert.equal(messages(h)[0], before);
});

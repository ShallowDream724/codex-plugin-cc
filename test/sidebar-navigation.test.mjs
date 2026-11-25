import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';
import navigationSync from '../hooks/navigation-sync.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = i => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', data: { text: `message-${i}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup({ live = [], history = () => ({ entries: [], next_cursor: null }), revision = () => ({ revision: 1, entries: live }), onMeasurement = async () => {}, autoPost = true, dropPost = () => false, shortViewport = false, nativeContentRows, agents = [{ agent_id: 'a', status: 'completed' }] } = {}) {
  closeUI();
  const hooks = [], scrolls = [], calls = [], timers = [];
  let painted = [], nativePainted = [], offset = 0, drawQueued = false, closed = false, constructed = 0, maxConstructed = 0;
  const rows = tree => nativeContentRows ?? Math.max(20, tree.filter(n => n.type === 'Markdown').length + 10);
  const surfacePending = new Set();
  const surface = { state: 0, setState(value) { this.state = value; }, elements: { Box: props => props }, post(data) {
    if (dropPost(data)) return;
    const task = new Promise(resolve => setImmediate(resolve)).then(() => { if (!closed) return host.surface(() => host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data })); });
    surfacePending.add(task); task.finally(() => surfacePending.delete(task));
  } };
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Client'].map(type => [type, props => { constructed++; return { type, props }; }])),
      open: async () => { nativePainted = painted; return { isPlaced: true }; }, invalidate() {},
      scroll: async args => {
        scrolls.push(args);
        if (args.to?.key || args.to === 'end') {
          if (args.to?.key) {
            if (!nativePainted.some(n => n.type === 'Button' && n.props.key === args.to.key)) throw Error('key not painted');
            await onMeasurement(args.to.key);
          }
          const contentRows = rows(nativePainted);
          const markerIndex = nativePainted.findIndex(n => n.type === 'Button' && n.props.key === args.to.key);
          const precedingRows = nativePainted.slice(0, markerIndex).filter(n => n.type === 'Markdown' || n.type === 'Text' && n.props.key?.startsWith('message_')).length;
          const destination = args.to === 'end' || args.block === 'end' ? contentRows - 10 : args.to.key.startsWith('codex_read_anchor_') ? 3 + precedingRows : 3;
          const e = { origin: { kind: 'plugin' }, offset: destination, by: destination - offset, contentRows, bodyRows: 10 };
          const result = await host.dispatch('ui.scroll', e);
          if (result.deny) return result;
          offset = result.offset;
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
  const wheel = (direction, at = direction < 0 ? 0 : rows(painted) - 10) => {
    const e = { origin: { kind: 'person' }, by: at - offset, offset: at, contentRows: rows(painted), bodyRows: 10 };
    const result = host.dispatch('ui.scroll', e);
    offset = result.offset;
    return result;
  };
  const waitNavigation = async () => { await pause(300); while (surfacePending.size) await Promise.all([...surfacePending]); };
  const visitEdge = async direction => { wheel(-direction, Math.floor((rows(painted) - 10) / 2)); await pause(200); wheel(direction); await waitNavigation(); };
  return { $, draw, wheel, visitEdge, calls, scrolls, tick: () => timers[0](), waitNavigation, open: id => openAgent($, id), press: key => host.dispatch('ui.press', { requestId: 'codex_subagent_activity', element: key }), resetConstructed: () => { maxConstructed = 0; }, get maxConstructed() { return maxConstructed; }, host, get offset() { return offset; }, get painted() { return painted; }, close: () => { closed = true; closeUI(); } };
}
const messages = h => h.painted.filter(n => n.type === 'Markdown').map(n => n.props.text);
const hasMessage = (h, prefix) => h.painted.some(n => n.type === 'Markdown' && n.props.text?.startsWith(prefix) || n.type === 'Text' && n.props.key?.startsWith('message_') && n.props.children?.some(value => typeof value === 'string' && value.startsWith(prefix)));
const older = h => h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('codex_history_a_'));

test('window navigation reaches earlier and later cached messages over multiple pages', async t => {
  const h = await setup({ live: Array.from({ length: 500 }, (_, i) => entry(i)) }); t.after(h.close);
  assert.ok(messages(h).length > 60 && messages(h).length <= 400); assert.ok(!messages(h).includes('message-0'));
  for (let i = 0; i < 12 && messages(h)[0] !== 'message-0'; i++) await h.visitEdge(-1);
  assert.equal(messages(h)[0], 'message-0');
  for (let i = 0; i < 20 && !messages(h).includes('message-499'); i++) await h.visitEdge(1);
  assert.ok(messages(h).includes('message-499'));
  assert.ok(h.scrolls.some(s => s.to?.key?.startsWith('codex_read_anchor_a_')), 'prepend measures the existing reading marker');
});

test('two prefetched history pages stay cached until navigation and are reused', async t => {
  const h = await setup({ history: args => {
    if (!args.cursor) return { entries: Array.from({ length: 90 }, (_, i) => entry(i + 60)), next_cursor: { turns_cursor: 'first' } };
    if (args.cursor.turns_cursor === 'first') return { entries: Array.from({ length: 30 }, (_, i) => entry(i + 30)), next_cursor: { turns_cursor: 'second' } };
    return { entries: Array.from({ length: 30 }, (_, i) => entry(i)), next_cursor: null };
  } }); t.after(h.close);
  await pause(100);
  const cursorCalls = () => h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor);
  assert.deepEqual(cursorCalls().map(call => call.args.cursor.turns_cursor), ['first', 'second']);
  assert.equal(messages(h).length, 90);
  assert.equal(messages(h)[0], 'message-60');
  await h.visitEdge(-1);
  assert.ok(messages(h).includes('message-60'), 'the visible reading anchor remains in the window after the prepend');
  assert.ok(messages(h).includes('message-30'));
  for (let i = 0; i < 3 && !messages(h).includes('message-0'); i++) await h.visitEdge(-1);
  assert.ok(messages(h).includes('message-0'), 'navigation crosses the original cached boundary into the prefetched page');
  assert.ok(messages(h).includes('message-60'), 'the original boundary remains available after the history merge');
  assert.equal(cursorCalls().filter(call => call.args.cursor.turns_cursor === 'first').length, 1, 'navigation reuses the prefetched page');
});

test('a collapsed tool group does not cause visible messages to be trimmed', async t => {
  const live = [
    ...Array.from({ length: 60 }, (_, i) => entry(i)),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `tool-${i}`, turn_id: 't', type: 'commandExecution', data: { command: `cmd-${i}` } })),
    ...Array.from({ length: 50 }, (_, i) => entry(i + 100)),
  ];
  const h = await setup({ live }); t.after(h.close);
  assert.ok(messages(h).includes('message-149'));
  for (let i = 0; i < 3 && !messages(h).includes('message-50'); i++) await h.visitEdge(-1);
  assert.ok(messages(h).includes('message-149'), 'short collapsed rows must not evict visible tail messages');
  assert.ok(messages(h).includes('message-50'), 'earlier messages are still prepended');
});

test('a long tool group stays bounded and both ends remain reachable', async t => {
  const live = Array.from({ length: 300 }, (_, i) => ({ id: `tool-${i}`, turn_id: 't', type: 'commandExecution', data: { command: `command-${i}` } }));
  const h = await setup({ live }); t.after(h.close);
  const group = () => h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('group_a:'));
  for (let i = 0; i < 16 && !group()?.props.key.includes('tool-0:group'); i++) await h.visitEdge(-1);
  assert.ok(group()?.props.key.includes('tool-0:group'), 'the earliest commands are reachable');
  h.resetConstructed();
  await group().props.onPress(); await pause(40); await h.draw();
  assert.ok(h.painted.some(n => n.type === 'Button' && n.props.key?.includes('tool-0') && /command-0/.test(n.props.label)), 'the first command can be opened');
  for (let i = 0; i < 20 && !h.painted.some(n => n.type === 'Button' && n.props.key?.includes('tool-299')); i++) {
    const next = h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('content_next_'));
    if (next) { await next.props.onPress(); await pause(40); await h.draw(); } else await h.visitEdge(1);
  }
  assert.ok(h.painted.some(n => n.type === 'Button' && n.props.key?.includes('tool-299')), 'the latest command remains reachable after opening and navigating the group');
  assert.ok(h.maxConstructed < 3000, `expanding and navigating a long group constructs a bounded window (${h.maxConstructed} nodes)`);
});

test('short list loads earlier history after render without a wheel event', async t => {
  const h = await setup({ shortViewport: true, history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  assert.ok(!h.painted.some(n => n.type === 'Button' && /加载更早消息|加载后续消息/.test(n.props.label || '')));
  const markerContainer = h.painted.find(n => n.type === 'Box' && n.props.children?.includes(older(h)));
  assert.equal(markerContainer?.props.height, 0);
  assert.equal(markerContainer?.props.overflow, 'hidden', 'the measurement marker cannot be seen or clicked');
  assert.ok(older(h).props.label.trim(), 'the hidden native marker has measurable content');
  await pause(150);
  assert.deepEqual(messages(h), ['message-0', 'message-1'], JSON.stringify({ calls: h.calls, sync: h.painted.find(n => n.props.module === './navigation-sync.js')?.props.props }));
  assert.equal(h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor).length, 1);
});

test('desktop short history continues after native scroll geometry is sampled', async t => {
  const h = await setup({ nativeContentRows: 10, history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  await pause(200);
  assert.ok(h.scrolls.some(call => call.to?.key?.startsWith('codex_tail_a')), 'initial positioning samples native scroll geometry');
  assert.deepEqual(messages(h), ['message-0', 'message-1'], 'short history continues without render-provided contentRows or a wheel event');
  assert.equal(h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor).length, 1);
});

test('a short viewport stops automatic history loads after exhausting its cursor', async t => {
  const h = await setup({ nativeContentRows: 10, history: args => {
    const index = args.cursor?.index ?? 3;
    return { entries: [entry(index)], next_cursor: index > 0 ? { index: index - 1 } : null };
  } }); t.after(h.close);
  for (let attempt = 0; attempt < 6 && !messages(h).includes('message-0'); attempt++) await h.waitNavigation();
  assert.deepEqual(messages(h), ['message-0', 'message-1', 'message-2', 'message-3']);
  const snapshot = messages(h);
  await pause(700);
  assert.deepEqual(messages(h), snapshot);
  assert.equal(h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor).length, 3);
});

test('one upward edge visit does not trigger repeated navigation as the window changes', async t => {
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  const anchor = messages(h)[0];
  h.wheel(-1, 0); await h.waitNavigation(); await pause(700);
  assert.notEqual(messages(h)[0], anchor, 'reaching the edge adds earlier messages');
  assert.ok(messages(h).includes(anchor), 'the current reading anchor remains available after the prepend');
  const navigations = () => h.host.calls.filter(call => call.event === 'ui.message' && call.input.data?.action === 'navigate').length;
  assert.equal(navigations(), 1, 'a changed window must not cause another automatic navigation');
  const snapshot = messages(h); await pause(600);
  assert.deepEqual(messages(h), snapshot, 'the visible history remains stable without another user scroll');
});

test('short entries use the available render budget beyond sixty messages', async t => {
  const h = await setup({ live: Array.from({ length: 120 }, (_, i) => entry(i)) }); t.after(h.close);
  assert.ok(messages(h).length > 60, `short messages should use the available budget (${messages(h).length} shown)`);
  assert.ok(messages(h).includes('message-119'));
  assert.ok(messages(h).reduce((n, text) => n + text.length, 0) < 80000);
});

test('long entries fit the render budget and stay reachable in both directions', async t => {
  const live = Array.from({ length: 120 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(4000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  assert.ok(messages(h).length < 60, 'large messages are bounded by their actual cost');
  assert.ok(messages(h).reduce((n, text) => n + text.length, 0) <= 80000);
  assert.ok(hasMessage(h, 'message-119 '));
  for (let i = 0; i < 30 && !hasMessage(h, 'message-0 '); i++) await h.visitEdge(-1);
  assert.ok(hasMessage(h, 'message-0 '), 'the oldest message remains reachable');
  for (let i = 0; i < 30 && !hasMessage(h, 'message-119 '); i++) await h.visitEdge(1);
  assert.ok(hasMessage(h, 'message-119 '), 'the latest message remains reachable');
});

test('automatic edge navigation stops when history makes no progress', async t => {
  const h = await setup({ shortViewport: true, history: () => ({ entries: [entry(1)], next_cursor: { turns_cursor: 'unchanged' } }) }); t.after(h.close);
  await pause(250);
  assert.equal(h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor).length, 1);
  assert.deepEqual(messages(h), ['message-1']);
});

test('continued upward scrolling during an unfinished history request completes navigation', async t => {
  let resolveHistory;
  const h = await setup({ history: args => args.cursor ? new Promise(resolve => { resolveHistory = resolve; }) : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  await pause(10);
  const first = h.wheel(-1, 3); assert.equal(first.offset, 3);
  await pause(45);
  const second = h.wheel(-1, 0); assert.equal(second.offset, 0);
  assert.equal(h.calls.filter(call => call.operation === 'ui_history' && call.args.cursor).length, 1, 'same-direction requests share one history fetch');
  resolveHistory({ entries: [entry(0)], next_cursor: null }); await h.waitNavigation();
  assert.deepEqual(messages(h), ['message-0', 'message-1']);
});

test('jump during a pending navigation measurement owns the final viewport', async t => {
  let release, started;
  const measuring = new Promise(resolve => { started = resolve; });
  const h = await setup({
    live: Array.from({ length: 500 }, (_, i) => entry(i)),
    onMeasurement: key => key.startsWith('codex_read_anchor_a_') && !release ? new Promise(resolve => { release = resolve; started(); }) : undefined,
  }); t.after(() => { release?.(); h.close(); });
  h.wheel(-1, 0);
  await Promise.race([measuring, pause(3000).then(() => { throw Error('navigation measurement did not start'); })]);
  const jump = h.painted.find(node => node.type === 'Button' && node.props.key === 'codex_jump_a_viewport');
  assert.ok(jump);
  await jump.props.onPress();
  await pause(100); await h.draw();
  assert.ok(messages(h).includes('message-499'), 'jump renders the actual latest message');
  release(); await pause(250); await h.draw();
  assert.ok(messages(h).includes('message-499'), 'old measurement cannot restore its navigation snapshot');
  assert.ok(h.scrolls.some(call => call.to?.key?.startsWith('codex_tail_a') && call.block === 'end'));
  assert.equal(h.offset, Math.max(20, messages(h).length + 10) - 10, 'late navigation cannot move the viewport away from the latest message');
});

test('budget-limited windows preserve access to both sides of the cached conversation', async t => {
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(2000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  const initial = messages(h); assert.ok(initial.length < 100); assert.ok(initial.at(-1).startsWith('message-99 '));
  for (let i = 0; i < 60 && !messages(h).some(x => x.startsWith('message-0 ')); i++) await h.visitEdge(-1);
  assert.ok(messages(h).some(x => x.startsWith('message-0 ')));
  for (let i = 0; i < 40 && !messages(h).some(x => x.startsWith('message-99 ')); i++) await h.visitEdge(1);
  assert.ok(messages(h).some(x => x.startsWith('message-99 ')));
});

test('navigation crosses a single near-budget message in both directions', async t => {
  const small = i => ({ ...entry(i), data: { text: `message-${i} ${'s'.repeat(2000)}` } });
  const large = { ...entry(1), data: { text: `message-1 ${'x'.repeat(77000)}` } };
  const h = await setup({ live: [small(0), large] }); t.after(h.close);
  assert.ok(hasMessage(h, 'message-1 '));
  for (let i = 0; i < 8 && !hasMessage(h, 'message-0 '); i++) {
    h.wheel(-1, 0); await pause(100);
  }
  assert.ok(hasMessage(h, 'message-0 '), 'earlier message remains reachable when the current entry nearly fills the render budget');
  for (let i = 0; i < 8 && !hasMessage(h, 'message-1 '); i++) {
    h.wheel(1); await pause(100);
  }
  assert.ok(hasMessage(h, 'message-1 '), 'later message remains reachable after crossing the large entry');
});

test('navigation reaches newly cached messages after a single near-budget message', async t => {
  const small = i => ({ ...entry(i), data: { text: `message-${i} ${'s'.repeat(2000)}` } });
  const large = { ...entry(1), data: { text: `message-1 ${'x'.repeat(77000)}` } };
  let revision = 1, live = [small(0), large];
  const h = await setup({ revision: () => ({ revision, entries: live }) }); t.after(h.close);
  h.wheel(-1, 0); await pause(100);
  live = [small(2)]; revision++; await h.tick(); await h.draw();
  assert.ok(hasMessage(h, 'message-1 '), 'the reading window stays on the large message');
  for (let i = 0; i < 8 && !hasMessage(h, 'message-2 '); i++) {
    h.wheel(1); await pause(100);
  }
  assert.ok(hasMessage(h, 'message-2 '), 'later message remains reachable when the current entry nearly fills the render budget');
});

test('empty initial history can load an older page by scrolling', async t => {
  const h = await setup({ history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  assert.deepEqual(messages(h), []);
  h.wheel(-1); await pause(100);
  assert.deepEqual(messages(h), ['message-0']);
});

test('live updates during a navigation measurement retain the range and appear after the snapshot unfreezes', async t => {
  let revision = 1, live = Array.from({ length: 500 }, (_, i) => entry(i));
  let release, started;
  const measuring = new Promise(resolve => { started = resolve; });
  const h = await setup({
    revision: () => ({ revision, entries: live }),
    onMeasurement: key => key.startsWith('codex_read_anchor_a_') && !release ? new Promise(resolve => { release = resolve; started(); }) : undefined,
  }); t.after(() => { release?.(); h.close(); });
  const anchor = messages(h)[0], index = Number(anchor.split('-')[1]);
  h.wheel(-1);
  await Promise.race([measuring, pause(3000).then(() => { throw Error('navigation measurement did not start'); })]);
  // Keep reading at this edge. A real reversal before staging intentionally
  // releases the frozen snapshot and is exercised in history-edge-intent.
  await h.wheel(-1, 0);
  live = [{ ...entry(index), data: { text: `${anchor} updated with extra height\n`.repeat(30) } }, entry(500)]; revision++;
  await h.tick(); await h.draw();
  assert.ok(messages(h).includes(anchor), 'the measured frame remains stable during the update');
  assert.ok(!messages(h).some(text => text.includes('extra height')));
  release(); await pause(600); await h.draw();
  assert.ok(Number(messages(h)[0].split('-')[1]) < index, 'continued upward scrolling does not interrupt the in-flight window change');
  assert.ok(messages(h).some(text => text.startsWith(`${anchor} updated with extra height`)));
  for (let i = 0; i < 12 && !messages(h).includes('message-500'); i++) await h.visitEdge(1);
  assert.ok(messages(h).includes('message-500'), 'new cached activity remains reachable');
});

test('wheel navigation uses a fresh surface message frame for measurements', async t => {
  const h = await setup({ live: Array.from({ length: 1000 }, (_, i) => entry(i)) }); t.after(h.close);
  const initial = messages(h)[0];
  const scrollHooks = h.host; // Calls retain the actual registration objects and origin frames.
  h.wheel(-1, 0); await h.waitNavigation();
  const calls = scrollHooks.calls.filter(call => call.event === 'ui.scroll');
  const personCall = calls.find(call => call.input.origin.kind === 'person');
  const probes = calls.filter(call => call.input.origin.kind === 'plugin');
  assert.ok(personCall); assert.ok(probes.length > 0);
  const messageCall = scrollHooks.calls.find(call => call.event === 'ui.message' && call.input.data?.action === 'navigate');
  assert.ok(messageCall); assert.ok(probes.every(call => call.origin.includes(messageCall.hook)));
  assert.ok(probes.some(call => call.hook !== personCall.hook), 'the plugin observer receives the probe');
  assert.ok(Number(messages(h)[0].split('-')[1]) < Number(initial.split('-')[1]));
  const first = messages(h)[0];
  await pause(200); h.wheel(1, 40); assert.equal(h.offset, 40);
  const before = scrollHooks.calls.length;
  await h.host.callback(() => h.$.ui.scroll({ to: { key: older(h).props.key }, block: 'start' }));
  assert.equal(scrollHooks.calls.length, before, 'a raw native callback origin excludes all own registrations');
  assert.equal(h.offset, 3, 'without an observer the native scroll reaches the target');
  await pause(200); h.wheel(-1, 0); await h.waitNavigation();
  assert.ok(Number(messages(h)[0].split('-')[1]) < Number(first.split('-')[1]), 'another edge visit continues navigation');
});

test('a dropped surface handoff retries the original edge once without another wheel', async t => {
  const tokens = [];
  const h = await setup({
    live: Array.from({ length: 500 }, (_, i) => entry(i)),
    dropPost(data) {
      if (data.action !== 'navigate') return false;
      tokens.push(data.token);
      return tokens.length === 1;
    },
  });
  t.after(h.close);
  const before = messages(h)[0];
  await h.wheel(-1, 0);
  for (let i = 0; i < 6 && messages(h)[0] === before; i++) await h.waitNavigation();
  assert.notEqual(messages(h)[0], before);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0], tokens[1]);
  const after = messages(h)[0];
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'navigate', token: tokens[0] } }));
  await h.waitNavigation();
  assert.equal(messages(h)[0], after);
});

test('a stale surface navigation token cannot move the window', async t => {
  const h = await setup({ live: Array.from({ length: 1000 }, (_, i) => entry(i)), autoPost: false }); t.after(h.close);
  const initial = messages(h)[0];
  const post = token => h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'navigate', token } }));
  h.wheel(-1, 0); await pause(45); await h.draw();
  const token = h.painted.find(n => n.props.module === './navigation-sync.js').props.props.token;
  assert.ok(token > 0);
  await post(token + 1); assert.equal(messages(h)[0], initial);
  await post(token); await pause(35);
  const first = messages(h)[0]; assert.ok(Number(first.split('-')[1]) < Number(initial.split('-')[1]));
  await post(token); await pause(25); assert.equal(messages(h)[0], first);
  h.wheel(1, 5); await pause(200); h.wheel(-1, 0); await pause(45); await h.draw();
  const stale = h.painted.find(n => n.props.module === './navigation-sync.js').props.props.token;
  assert.ok(stale > token);
  h.wheel(1, 20); await post(stale); await pause(25);
  assert.equal(messages(h)[0], first, 'opposite user intent cancels the old request');
});

test('a surface token from before switching agents stays stale after returning', async t => {
  const h = await setup({ live: Array.from({ length: 500 }, (_, i) => entry(i)), autoPost: false, agents: [{ agent_id: 'a', status: 'completed' }, { agent_id: 'b', status: 'completed' }] }); t.after(h.close);
  h.wheel(-1, 0); await pause(45); await h.draw();
  const token = h.painted.find(n => n.props.module === './navigation-sync.js').props.props.token;
  assert.ok(token > 0);
  await h.open('b'); await h.open('a'); await h.draw();
  const before = messages(h)[0];
  await h.host.surface(() => h.host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data: { action: 'navigate', token } }));
  await pause(35);
  assert.equal(messages(h)[0], before);
});

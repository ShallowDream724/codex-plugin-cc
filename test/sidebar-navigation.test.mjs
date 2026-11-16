import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = i => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', data: { text: `message-${i}` } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup({ live = [], history = () => ({ entries: [], next_cursor: null }), revision = () => ({ revision: 1, entries: live }), onMeasurement = async () => {} } = {}) {
  closeUI();
  const hooks = [], scrolls = [], calls = [], timers = [];
  let painted = [], offset = 0, drawQueued = false;
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])),
      open: async () => ({ isPlaced: true }), invalidate() {},
      scroll: async args => {
        scrolls.push(args);
        if (args.to?.key) {
          if (!painted.some(n => n.type === 'Button' && n.props.key === args.to.key)) throw Error('key not painted');
          await onMeasurement(args.to.key);
          const contentRows = Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10);
          const e = { origin: { kind: 'plugin' }, offset, by: 0, contentRows, bodyRows: 10 };
          offset = (await hooks.find(h => h.event === 'ui.scroll').fn($, e, x => x)).offset;
        }
        return {};
      },
    },
    state: { get: async () => ({ value: 0, version: 0 }), set: async () => {
      if (!drawQueued) { drawQueued = true; setImmediate(async () => { drawQueued = false; await draw(); }); }
      return { isSet: true };
    } },
    clock: { every: (_ms, fn) => { timers.push(fn); return { cancel() {} }; }, after: (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; } },
    session: { id: async () => 'session', cwd: async () => 'C:/work' }, env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin), { operation, args } = request; calls.push({ operation, args });
      const result = operation === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : operation === 'ui_revision' ? revision(args) : await history(args);
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
  };
  registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) }));
  const draw = async () => { painted = nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows: 10 } } }, () => null)); return painted; };
  await openAgent($, 'a'); await draw();
  const wheel = (by, at = by < 0 ? 0 : Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10) - 10) => {
    const e = { origin: { kind: 'person' }, by, offset: at, contentRows: Math.max(20, painted.filter(n => n.type === 'Markdown').length + 10), bodyRows: 10 };
    return hooks.find(h => h.event === 'ui.scroll').fn($, e, x => x);
  };
  return { $, draw, wheel, calls, scrolls, tick: () => timers[0](), get painted() { return painted; }, close: closeUI };
}
const messages = h => h.painted.filter(n => n.type === 'Markdown').map(n => n.props.text);
const older = h => h.painted.find(n => n.type === 'Button' && n.props.key?.startsWith('codex_history_a_'));

test('window navigation reaches earlier and later cached messages over multiple pages', async t => {
  const h = await setup({ live: Array.from({ length: 240 }, (_, i) => entry(i)) }); t.after(h.close);
  assert.equal(messages(h).length, 120); assert.equal(messages(h)[0], 'message-120');
  for (let i = 0; i < 8 && older(h).props.label === '加载更早消息'; i++) { await older(h).props.onPress(); await pause(25); }
  assert.equal(messages(h)[0], 'message-0');
  for (let i = 0; i < 20 && !messages(h).includes('message-239'); i++) { h.wheel(1); await pause(120); }
  assert.ok(messages(h).includes('message-239'));
  assert.ok(h.scrolls.filter(s => s.to?.key?.startsWith('codex_history_a_')).length > 3);
});

test('short list can load earlier history by its button without a wheel event', async t => {
  const h = await setup({ history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  assert.deepEqual(messages(h), ['message-1']);
  await older(h).props.onPress(); await pause(30);
  assert.deepEqual(messages(h), ['message-0', 'message-1']);
});

test('wheel returns immediately while a history request is unfinished and late history does not move the view', async t => {
  let resolveHistory;
  const h = await setup({ history: args => args.cursor ? new Promise(resolve => { resolveHistory = resolve; }) : { entries: [entry(1)], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  await pause(10);
  const first = h.wheel(-1, 0); assert.equal(first.offset, 0);
  await pause(45);
  const second = h.wheel(1, 7); assert.equal(second.offset, 7);
  resolveHistory({ entries: [entry(0)], next_cursor: null }); await pause(35);
  assert.deepEqual(messages(h), ['message-1']);
  await older(h).props.onPress(); await pause(25);
  assert.deepEqual(messages(h), ['message-0', 'message-1']);
});

test('budget-limited windows preserve access to both sides of the cached conversation', async t => {
  const live = Array.from({ length: 100 }, (_, i) => ({ ...entry(i), data: { text: `message-${i} ${'x'.repeat(2000)}` } }));
  const h = await setup({ live }); t.after(h.close);
  const initial = messages(h); assert.ok(initial.length < 100); assert.ok(initial.at(-1).startsWith('message-99 '));
  for (let i = 0; i < 30 && !messages(h).some(x => x.startsWith('message-0 ')); i++) { await older(h).props.onPress(); await pause(25); }
  assert.ok(messages(h).some(x => x.startsWith('message-0 ')));
  for (let i = 0; i < 40 && !messages(h).some(x => x.startsWith('message-99 ')); i++) { h.wheel(1); await pause(100); }
  assert.ok(messages(h).some(x => x.startsWith('message-99 ')));
});

test('empty initial history can load an older page by clicking', async t => {
  const h = await setup({ history: args => args.cursor ? { entries: [entry(0)], next_cursor: null } : { entries: [], next_cursor: { turns_cursor: 'older' } } }); t.after(h.close);
  assert.deepEqual(messages(h), []);
  await older(h).props.onPress(); await pause(30);
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
  const navigation = older(h).props.onPress();
  await measuring;
  live = [{ ...entry(130), data: { text: 'message-130 updated with extra height\n'.repeat(30) } }, entry(240)]; revision++;
  await h.tick(); await h.draw();
  assert.ok(messages(h).includes('message-130'), 'the measured frame remains stable during the update');
  assert.ok(!messages(h).some(text => text.includes('extra height')));
  release(); await navigation; await pause(35); await h.draw();
  assert.equal(messages(h)[0], 'message-90');
  assert.ok(messages(h).some(text => text.startsWith('message-130 updated with extra height')));
  assert.ok(messages(h).includes('message-179'));
  for (let i = 0; i < 12 && !messages(h).includes('message-240'); i++) { h.wheel(1); await pause(120); }
  assert.ok(messages(h).includes('message-240'), 'new cached activity remains reachable');
});

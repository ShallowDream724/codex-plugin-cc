import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';

const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = (id, type, text) => ({ id, turn_id: 'turn', type, data: { text } });

async function setup(handler) {
  const hooks = [], timers = [], afters = [], scrolls = [], calls = [];
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Svg', 'Client', 'Image'].map((type) => [type, (props) => ({ type, props })])),
      invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async (args) => { scrolls.push(args); },
    },
    clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; }, after(_ms, fn) { const timer = { fn, cancelled: false, cancel() { this.cancelled = true; } }; afters.push(timer); return timer; } },
    state: { get: async () => ({}), set: async () => ({ isSet: true }) },
    session: { id: async () => 'session', cwd: async () => 'C:/work' },
    env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); calls.push(request);
      const result = await handler(request.operation, request.args);
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
  };
  closeUI();
  registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) }));
  await openAgent($, 'a');
  const draw = (options = {}) => hooks.find((hook) => hook.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', ...options }, () => null);
  const item = async (key) => nodes(await draw()).find((node) => node.props.key?.startsWith(key));
  const scroll = (by = -1, offset = 0) => hooks.find((hook) => hook.event === 'ui.scroll').fn($, { origin: { kind: 'person' }, by, offset }, async (e) => e);
  const scrollEvent = (event) => hooks.find((hook) => hook.event === 'ui.scroll').fn($, event, async (e) => e);
  return { draw, item, tick: () => timers[0](), scroll, scrollEvent, scrolls, calls, afters, open: (id) => openAgent($, id), close: () => hooks.find((hook) => hook.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e), message: (e) => hooks.find((hook) => hook.event === 'ui.message').fn($, e, async () => ({})) };
}

test('first open starts at the end and reopening restores the saved reading position', async (t) => {
  t.after(closeUI);
  const ui = await setup(async (op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: [entry('saved', 'agentMessage', 'saved')], next_cursor: null } : { revision: 1, entries: [] });
  assert.deepEqual(ui.scrolls, [{ in: 'codex_subagent_activity', to: 'end' }]);
  await ui.scroll(1, 42);
  await ui.close();
  await ui.open('a');
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: 'start' });
  const restored = await ui.scrollEvent({ origin: { kind: 'plugin' }, offset: 0 });
  assert.equal(restored.offset, 42);
});

test('live messages continue while an MCP group and cached tool output remain expanded', async (t) => {
  t.after(closeUI);
  const tool = { id: 'tool', turn_id: 'turn', type: 'mcpToolCall', deferred: true, data: { server: 'fastctx', tool: 'grep' } };
  let revision = 1, entries = [tool]; const details = [];
  const ui = await setup(async (op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision, entries };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    if (op === 'ui_detail') { details.push(args.view); return args.view === 'media' ? { images: [{ path: 'C:/tmp/image.png', previewable: true, index: 0 }], next_offset: null } : { text: 'cached tool output', next_offset: null }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  const group = await ui.item('group_');
  await group.props.onPress();
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: { key: `row_${group.props.key}` }, block: 'nearest' });
  await (await ui.item('item_a:turn:tool')).props.onPress();
  for (const timer of ui.afters.splice(0)) if (!timer.cancelled) await timer.fn();
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: { key: 'row_item_a:turn:tool' }, block: 'nearest' });
  assert.match(JSON.stringify(await ui.draw()), /cached tool output/);
  assert.ok(nodes(await ui.draw()).some(node => node.type === 'Image' && node.props.source.file === 'C:/tmp/image.png'));
  const scrollCount = ui.scrolls.length;
  entries = [tool, entry('user', 'directUserMessage', 'continue please'), entry('progress', 'agentMessage', 'working now')]; revision++;
  await ui.tick();
  let rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /continue please/); assert.match(rendered, /working now/);
  assert.match(rendered, /cached tool output/);
  entries = [...entries, entry('final', 'agentMessage', 'finished answer')]; revision++;
  await ui.tick(); rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /finished answer/); assert.match(rendered, /cached tool output/);
  assert.match((await ui.item('group_')).props.label, /⌄/);
  assert.doesNotMatch((await ui.item('item_a:turn:tool')).props.label, /[▸▾›⌄]/);
  assert.deepEqual(details.sort(), ['media', 'output']); assert.equal(ui.scrolls.length, scrollCount);
  await (await ui.item('item_a:turn:tool')).props.onPress();
  await (await ui.item('item_a:turn:tool')).props.onPress();
  await ui.tick();
  assert.deepEqual(details.sort(), ['media', 'output'], 'reopen and polling reuse both caches');
});

test('sending while reading history keeps the conversation and shows the subsequent answer', async (t) => {
  t.after(closeUI);
  let revision = 1, entries = [entry('old-live', 'agentMessage', 'live before send')];
  const ui = await setup(async (op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision, entries };
    if (op === 'ui_history') return { entries: [entry('old', 'agentMessage', 'older history')], next_cursor: null };
    if (op === 'ui_send') { entries = [...entries, entry('sent', 'directUserMessage', 'new question')]; revision++; return { agent_id: 'a', status: 'steered' }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  assert.match(JSON.stringify(await ui.draw()), /older history/);
  const scrollCount = ui.scrolls.length;
  await (await ui.item('codex_message_a')).props.onSubmit('new question');
  let rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /new question/); assert.match(rendered, /live before send/); assert.match(rendered, /older history/);
  assert.doesNotMatch(rendered, /消息已发送/);
  assert.deepEqual(ui.scrolls.slice(scrollCount), [{ in: 'codex_subagent_activity', to: 'end' }]);
  entries = [...entries, entry('answer', 'agentMessage', 'subsequent answer')]; revision++;
  await ui.tick(); rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /new question/); assert.match(rendered, /subsequent answer/);
});

test('a send during an in-flight poll triggers a follow-up refresh', async (t) => {
  t.after(closeUI);
  let revision = 1, entries = [], block = false, release;
  const ui = await setup(async (op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') {
      if (block) { block = false; return new Promise((resolve) => { release = resolve; }); }
      return { revision, entries };
    }
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    if (op === 'ui_send') { revision++; entries = [entry('sent', 'directUserMessage', 'sent during poll')]; return { agent_id: 'a', status: 'steered' }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  block = true;
  const polling = ui.tick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const scrollCount = ui.scrolls.length;
  await (await ui.item('codex_message_a')).props.onSubmit('sent during poll');
  assert.equal(ui.scrolls.length, scrollCount);
  release({ revision: 1, entries: [] });
  await polling;
  assert.match(JSON.stringify(await ui.draw()), /sent during poll/);
  assert.equal(ui.calls.filter((call) => call.operation === 'ui_revision').length, 3);
  assert.deepEqual(ui.scrolls.slice(scrollCount), [{ in: 'codex_subagent_activity', to: 'end' }]);
});

const flushTimers = async (ui) => {
  while (ui.afters.length) {
    const timers = ui.afters.splice(0);
    for (const timer of timers) if (!timer.cancelled) await timer.fn();
  }
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const messages = async (ui) => nodes(await ui.draw()).filter(node => node.type === 'Markdown').map(node => node.props.text);

test('desktop jump control follows viewport metrics and returns to the latest message', async (t) => {
  t.after(closeUI);
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: [entry('saved', 'agentMessage', 'saved')], next_cursor: null } : { revision: 1, entries: [] });
  await ui.scrollEvent({ origin: { kind: 'person' }, by: -1, offset: 30, contentRows: 100, bodyRows: 10 });
  const drawAt = offset => ui.draw({ surface: 'desktop', props: { scroll: { offset, bodyRows: 10 } } });
  let tree = nodes(await drawAt(30));
  assert.equal(tree.find(node => node.props.key === 'codex_jump_position_a').props.top, 37);
  assert.equal(tree.find(node => node.props.key === 'codex_jump_a').type, 'Client');
  tree = nodes(await drawAt(45));
  assert.equal(tree.find(node => node.props.key === 'codex_jump_position_a').props.top, 52);
  const before = ui.scrolls.length;
  await ui.message({ element: 'codex_jump_a', data: { action: 'activate', expanded: false } });
  await flushTimers(ui);
  assert.deepEqual(ui.scrolls.slice(before), [{ in: 'codex_subagent_activity', to: 'end' }]);
  assert.equal(nodes(await drawAt(45)).find(node => node.props.key === 'codex_jump_a'), undefined);
});

test('prefetch leaves the view and scroll unchanged until the reader reaches the edge', async (t) => {
  t.after(closeUI);
  const ui = await setup(async (op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [entry('live', 'agentMessage', 'live')] };
    if (op === 'ui_history') return args.cursor
      ? { entries: [entry('older', 'agentMessage', 'older')], next_cursor: null }
      : { entries: [entry('recent', 'agentMessage', 'recent')], next_cursor: { turns_cursor: 'older' } };
  });
  const before = await messages(ui), scrollCount = ui.scrolls.length;
  await flushTimers(ui); await settle();
  assert.deepEqual(await messages(ui), before);
  assert.equal(ui.scrolls.length, scrollCount);
  assert.equal(ui.calls.filter(call => call.operation === 'ui_history').length, 2);
  await ui.scroll(); await flushTimers(ui);
  assert.deepEqual(await messages(ui), ['older', 'recent', 'live']);
  assert.equal(ui.calls.filter(call => call.operation === 'ui_history').length, 2);
  await ui.scroll(1, 1); await ui.scroll(); await flushTimers(ui);
  assert.equal(ui.calls.filter(call => call.operation === 'ui_history').length, 2);
});

test('scroll returns while history is slow, and switch or close discards late results', async (t) => {
  t.after(closeUI);
  for (const action of ['switch', 'close']) {
    let release;
    const ui = await setup(async (op, args) => {
      if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }, { agent_id: 'b', status: 'completed' }] };
      if (op === 'ui_revision') return { revision: 1, entries: [] };
      if (op === 'ui_history' && args.cursor) return new Promise(resolve => { release = resolve; });
      if (op === 'ui_history') return { entries: [entry(args.target, 'agentMessage', `${args.target} recent`)], next_cursor: args.target === 'a' ? { turns_cursor: 'older' } : null };
    });
    await ui.scroll();
    await settle();
    assert.equal(typeof release, 'function');
    const pendingTimers = ui.afters.splice(0).filter(timer => !timer.cancelled).map(timer => timer.fn());
    await settle();
    if (action === 'switch') await ui.open('b'); else await ui.close();
    const scrollCount = ui.scrolls.length;
    release({ entries: [entry('late', 'agentMessage', 'a late')], next_cursor: null });
    await Promise.all(pendingTimers); await flushTimers(ui);
    assert.equal(ui.scrolls.length, scrollCount);
    if (action === 'switch') {
      assert.match(JSON.stringify(await ui.draw()), /b recent/);
      assert.doesNotMatch(JSON.stringify(await ui.draw()), /a late/);
    } else {
      await ui.open('b');
      assert.doesNotMatch(JSON.stringify(await ui.draw()), /a late/);
    }
  }
});

test('10,000 cached records remain reachable while moving through render windows', async (t) => {
  t.after(closeUI);
  const saved = Array.from({ length: 10000 }, (_, i) => entry(`m${i}`, 'agentMessage', `message ${i}`));
  const ui = await setup(async op => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [] };
    if (op === 'ui_history') return { entries: saved, next_cursor: null };
  });
  const seen = new Set();
  const read = async () => {
    const visible = await messages(ui);
    assert.ok(visible.length > 0 && visible.length <= 500);
    visible.forEach(value => seen.add(value));
    return visible;
  };
  let visible = await read();
  assert.equal(visible.at(-1), 'message 9999');
  for (let i = 0; visible[0] !== 'message 0' && i < 200; i++) {
    const previous = visible[0];
    await ui.scroll(); await flushTimers(ui); visible = await read();
    assert.notEqual(visible[0], previous, 'scrolling up must advance the window');
  }
  assert.equal(visible[0], 'message 0');
  for (let i = 0; visible.at(-1) !== 'message 9999' && i < 200; i++) {
    const previous = visible.at(-1);
    await ui.scrollEvent({ origin: { kind: 'person' }, by: 1, offset: 90, contentRows: 100, bodyRows: 10 });
    await flushTimers(ui); visible = await read();
    assert.notEqual(visible.at(-1), previous, 'scrolling down must advance the window');
  }
  assert.equal(visible.at(-1), 'message 9999');
  for (let i = 0; i < saved.length; i++) assert.ok(seen.has(`message ${i}`), `message ${i} remains reachable`);
  assert.equal(ui.calls.filter(call => call.operation === 'ui_history').length, 1);
});

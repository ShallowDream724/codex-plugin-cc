import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';

const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = (id, type, text) => ({ id, turn_id: 'turn', type, data: { text } });

async function setup(handler) {
  const hooks = [], timers = [], afters = [], scrolls = [], calls = [];
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])),
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
  const draw = () => hooks.find((hook) => hook.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = async (key) => nodes(await draw()).find((node) => node.props.key?.startsWith(key));
  const scroll = (by = -1, offset = 0) => hooks.find((hook) => hook.event === 'ui.scroll').fn($, { origin: { kind: 'person' }, by, offset }, async (e) => e);
  const scrollEvent = (event) => hooks.find((hook) => hook.event === 'ui.scroll').fn($, event, async (e) => e);
  return { draw, item, tick: () => timers[0](), scroll, scrollEvent, scrolls, calls, afters, open: (id) => openAgent($, id), close: () => hooks.find((hook) => hook.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e) };
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
  let revision = 1, entries = [tool], details = 0;
  const ui = await setup(async (op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision, entries };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    if (op === 'ui_detail') { details++; return { text: 'cached tool output', next_offset: null }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  const group = await ui.item('group_');
  await group.props.onPress();
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: { key: `row_${group.props.key}` }, block: 'nearest' });
  await (await ui.item('item_a:turn:tool')).props.onPress();
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: { key: 'row_item_a:turn:tool' }, block: 'nearest' });
  assert.match(JSON.stringify(await ui.draw()), /cached tool output/);
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
  assert.equal(details, 1); assert.equal(ui.scrolls.length, scrollCount);
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

test('top scrolling deduplicates an in-flight cursor and anchors the old first group', async (t) => {
  t.after(closeUI);
  let release;
  const ui = await setup(async (op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [entry('live', 'agentMessage', 'live')] };
    if (op === 'ui_history' && !args.cursor) return { entries: [entry('recent', 'agentMessage', 'recent')], next_cursor: { turns_cursor: 'older' } };
    if (op === 'ui_history' && args.cursor.turns_cursor === 'older') return new Promise((resolve) => { release = resolve; });
    if (op === 'ui_history') return { entries: [entry('oldest', 'agentMessage', 'oldest')], next_cursor: null };
  });
  const first = ui.scroll();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = ui.scroll();
  release({ entries: [entry('older', 'agentMessage', 'older')], next_cursor: { turns_cursor: 'oldest' } });
  await Promise.all([first, second]);
  assert.equal(ui.calls.filter((call) => call.operation === 'ui_history' && call.args.cursor).length, 1);
  assert.deepEqual(nodes(await ui.draw()).filter((node) => node.type === 'Markdown').map((node) => node.props.text), ['older', 'recent', 'live']);
  for (const timer of ui.afters.splice(0)) if (!timer.cancelled) await timer.fn();
  await ui.scroll();
  const before = ui.scrolls.length;
  for (const timer of ui.afters) if (!timer.cancelled) await timer.fn();
  assert.deepEqual(ui.scrolls.slice(before), [{ in: 'codex_subagent_activity', to: { key: 'activity_group_a:turn:older' }, block: 'start' }]);
});

test('late history cannot move a reader who scrolled or switched agents', async (t) => {
  t.after(closeUI);
  let release;
  const ui = await setup(async (op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }, { agent_id: 'b', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [] };
    if (op === 'ui_history' && args.cursor) return new Promise((resolve) => { release = resolve; });
    if (op === 'ui_history') return { entries: [entry(args.target, 'agentMessage', `${args.target} recent`)], next_cursor: args.target === 'a' ? { turns_cursor: 'older' } : null };
  });
  let loading = ui.scroll();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await ui.scroll(1, 5);
  release({ entries: [entry('old', 'agentMessage', 'a old')], next_cursor: { turns_cursor: 'older2' } });
  await loading;
  let before = ui.scrolls.length;
  for (const timer of ui.afters.splice(0)) if (!timer.cancelled) await timer.fn();
  assert.equal(ui.scrolls.length, before);
  assert.match(JSON.stringify(await ui.draw()), /a old/);
  release = undefined; loading = ui.scroll();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await ui.open('b'); before = ui.scrolls.length;
  release({ entries: [entry('late', 'agentMessage', 'a late')], next_cursor: null });
  await loading;
  for (const timer of ui.afters.splice(0)) if (!timer.cancelled) await timer.fn();
  assert.equal(ui.scrolls.length, before);
  assert.match(JSON.stringify(await ui.draw()), /b recent/);
  assert.doesNotMatch(JSON.stringify(await ui.draw()), /a late/);
});

test('long conversations keep loaded messages across a moving scroll window', async (t) => {
  t.after(closeUI);
  let revision = 1, live = [];
  const saved = Array.from({ length: 1200 }, (_, i) => entry(`m${i}`, 'agentMessage', `message ${i}`));
  const ui = await setup(async (op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_revision') return { revision, entries: live };
    if (op === 'ui_history') return args.cursor
      ? { entries: [entry('oldest', 'agentMessage', 'earliest saved')], next_cursor: null }
      : { entries: saved, next_cursor: { turns_cursor: 'earlier' } };
  });
  const seen = new Set();
  const messages = async () => {
    const tree = await ui.draw();
    assert.equal(nodes(tree).find((node) => ['codex_older', 'codex_latest'].includes(node.props.key)), undefined);
    const items = nodes(tree).filter((node) => node.type === 'Markdown').map((node) => node.props.text);
    assert.ok(items.length <= 500);
    items.forEach((item) => seen.add(item));
    return items;
  };
  const flushAnchor = async (id, block) => {
    const before = ui.scrolls.length;
    for (const timer of ui.afters.splice(0)) if (!timer.cancelled) await timer.fn();
    assert.deepEqual(ui.scrolls.slice(before), [{ in: 'codex_subagent_activity', to: { key: `activity_group_a:turn:${id}` }, block }]);
  };
  let visible = await messages();
  assert.equal(visible[0], 'message 700'); assert.equal(visible.at(-1), 'message 1199');
  for (const oldFirst of ['m700', 'm450', 'm200']) {
    await ui.scroll(); await flushAnchor(oldFirst, 'start'); visible = await messages();
  }
  assert.equal(visible[0], 'message 0');
  assert.equal(ui.calls.filter((call) => call.operation === 'ui_history').length, 1);
  live = [entry('new', 'agentMessage', 'new live message')]; revision++;
  await ui.tick(); assert.deepEqual(await messages(), visible);
  await ui.scroll(); await flushAnchor('m0', 'start'); visible = await messages();
  assert.equal(visible[0], 'earliest saved');
  assert.equal(ui.calls.filter((call) => call.operation === 'ui_history').length, 2);
  for (const oldLast of ['m498', 'm748', 'm998']) {
    await ui.scrollEvent({ origin: { kind: 'person' }, by: 1, offset: 90, contentRows: 100, bodyRows: 10 });
    await flushAnchor(oldLast, 'end'); visible = await messages();
  }
  assert.equal(visible.at(-1), 'new live message');
  for (let i = 0; i < 1200; i++) assert.ok(seen.has(`message ${i}`), `message ${i} remains reachable`);
});

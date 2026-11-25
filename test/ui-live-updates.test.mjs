import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';
import navigationSync from '../hooks/navigation-sync.js';

const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = (id, type, text) => ({ id, turn_id: 'turn', type, data: { text } });

async function setup(handler, { acceptScroll = () => true, autoPaint = false } = {}) {
  const hooks = [], timers = [], afters = [], scrolls = [], calls = []; let painted = [], draw, rendering = false, afterPaint, renderCount = 0; const surfacePending = new Set(), subscriptions = new Set();
  const surface = { state: 0, setState(value) { this.state = value; }, elements: { Box: props => props }, post(data) {
    const promise = new Promise(resolve => setImmediate(resolve)).then(() => host.surface(() => host.dispatch('ui.message', { element: 'codex_navigation_sync_a', data })));
    surfacePending.add(promise); promise.finally(() => surfacePending.delete(promise));
  } };
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Svg', 'Client', 'Image'].map((type) => [type, (props) => ({ type, props })])),
      invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async (args) => {
        if (args.to?.key && (!painted.some(node => node.type === 'Button' && node.props.key === args.to.key) || !acceptScroll(args))) throw Error('key not painted');
        scrolls.push(args);
        if (args.to?.key) return host.dispatch('ui.scroll', { origin: { kind: 'plugin' }, offset: 0, by: 0, contentRows: 100, bodyRows: 10 });
      },
    },
    clock: { every(_ms, fn) { timers.push(() => autoPaint ? host.callback(fn) : fn()); return { cancel() {} }; }, after(_ms, fn) { const timer = { fn: () => host.callback(fn), cancelled: false, cancel() { this.cancelled = true; } }; afters.push(timer); return timer; } },
    state: { get: async key => { if (rendering) subscriptions.add(JSON.stringify(key)); return {}; }, set: async key => { if (autoPaint && subscriptions.has(JSON.stringify(key))) { await host.surface(() => draw()); if (afterPaint) { const callback = afterPaint; afterPaint = null; await host.surface(callback); } } return { isSet: true }; } },
    session: { id: async () => 'session', cwd: async () => 'C:/work' },
    env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); calls.push(request);
      const result = await handler(request.operation, request.args);
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
  };
  closeUI();
  const host = nativeHooks(hooks, $); registerUI(host.on);
  await openAgent($, 'a');
  draw = async (options = {}) => {
    renderCount++;
    rendering = true;
    let tree;
    try { tree = await hooks.find((hook) => hook.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', ...options }, () => null); } finally { rendering = false; }
    painted = nodes(tree);
    const sync = painted.find(node => node.type === 'Client' && node.props.module === './navigation-sync.js');
    if (sync) navigationSync(sync.props.props, surface);
    return tree;
  };
  const item = async (key) => nodes(await draw()).find((node) => node.props.key?.startsWith(key));
  const scroll = (by = -1, offset = 0) => host.dispatch('ui.scroll', { origin: { kind: 'person' }, by, offset, contentRows: 100, bodyRows: 10 });
  const scrollEvent = (event) => host.dispatch('ui.scroll', event);
  return { draw, item, surfacePending, tick: async () => { await timers[0](); if (!autoPaint) await draw(); }, painted: () => painted, renderCount: () => renderCount, afterNextPaint: callback => { afterPaint = callback; }, scroll, scrollEvent, scrolls, calls, afters, open: (id) => openAgent($, id), close: () => hooks.find((hook) => hook.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e), message: (e) => hooks.find((hook) => hook.event === 'ui.message').fn($, e, async () => ({})) };
}

const tailCalls = scrolls => scrolls.filter(s => /^codex_tail_a_\d+$/.test(s.to?.key || '') && s.block === 'end');
const tailCount = scrolls => new Set(tailCalls(scrolls).map(s => s.to.key)).size;
const assertTailReveal = scrolls => {
  assert.ok(scrolls.length >= 2, 'the painted tail is confirmed after geometry settles');
  assert.equal(tailCalls(scrolls).length, scrolls.length);
  assert.ok(scrolls.every(call => call.to.key === scrolls[0].to.key));
};

test('first open and explicit reopening both reveal the end', async (t) => {
  t.after(closeUI);
  const ui = await setup(async (op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: [entry('saved', 'agentMessage', 'saved')], next_cursor: null } : { revision: 1, entries: [] });
  await flushTimers(ui);
  assertTailReveal(ui.scrolls);
  await ui.scroll(-48, 42);
  await ui.close();
  const before = ui.scrolls.length, originalTail = tailCalls(ui.scrolls).at(-1).to.key;
  await ui.open('a');
  await flushTimers(ui);
  assertTailReveal(ui.scrolls.slice(before));
  assert.notEqual(tailCalls(ui.scrolls).at(-1).to.key, originalTail);
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
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: { key: group.props.key }, block: 'nearest' });
  await (await ui.item('item_a:turn:tool')).props.onPress();
  for (const timer of ui.afters.splice(0)) if (!timer.cancelled) await timer.fn();
  assert.deepEqual(ui.scrolls.at(-1), { in: 'codex_subagent_activity', to: { key: 'item_a:turn:tool' }, block: 'nearest' });
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
  await flushTimers(ui);
  assert.match(JSON.stringify(await ui.draw()), /older history/);
  const scrollCount = ui.scrolls.length;
  await (await ui.item('codex_message_a')).props.onSubmit('new question');
  await flushTimers(ui);
  let rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /new question/); assert.match(rendered, /live before send/); assert.match(rendered, /older history/);
  assert.doesNotMatch(rendered, /消息已发送/);
  assertTailReveal(ui.scrolls.slice(scrollCount));
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
  await flushTimers(ui);
  block = true;
  const polling = ui.tick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const scrollCount = ui.scrolls.length;
  await (await ui.item('codex_message_a')).props.onSubmit('sent during poll');
  assert.equal(ui.scrolls.length, scrollCount);
  release({ revision: 1, entries: [] });
  await polling;
  await flushTimers(ui);
  assert.match(JSON.stringify(await ui.draw()), /sent during poll/);
  assert.equal(ui.calls.filter((call) => call.operation === 'ui_revision').length, 3);
  assertTailReveal(ui.scrolls.slice(scrollCount));
});

const flushTimers = async (ui) => {
  const pending = new Set();
  for (let round = 0; round < 100; round++) {
    await ui.draw();
    for (const timer of ui.afters.splice(0)) if (!timer.cancelled) {
      const promise = Promise.resolve().then(timer.fn);
      pending.add(promise); promise.finally(() => pending.delete(promise));
    }
    await new Promise(resolve => setImmediate(resolve));
    if (!pending.size && !ui.afters.length && !ui.surfacePending.size) { await ui.draw(); if (!ui.surfacePending.size) return; }
  }
  throw Error('timers did not settle');
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const messages = async (ui) => nodes(await ui.draw()).filter(node => node.type === 'Markdown').map(node => node.props.text);

for (const { name, by, offset, shouldFollow } of [
  { name: 'layout growth', by: 0, offset: 90, shouldFollow: true },
  { name: 'upward scrolling', by: -1, offset: 89, shouldFollow: false },
]) test(`automatic live repaint handles ${name} during invalidation`, async t => {
  t.after(closeUI);
  let revision = 1, entries = [entry('initial', 'agentMessage', 'initial message')];
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'running' }] } : op === 'ui_history' ? { entries: [], next_cursor: null } : { revision, entries }, { autoPaint: true });
  await flushTimers(ui);
  const beforeUnchanged = ui.renderCount();
  await ui.tick();
  assert.equal(ui.renderCount(), beforeUnchanged, 'an unchanged revision does not repaint');
  const before = tailCount(ui.scrolls), beforeCalls = ui.scrolls.length;
  ui.afterNextPaint(() => ui.scrollEvent({ origin: { kind: 'person' }, by, offset, contentRows: 120, bodyRows: 10 }));
  entries = [...entries, entry('new', 'agentMessage', 'new live message')]; revision++;
  await ui.tick();
  const pending = new Set();
  for (let round = 0; round < 100; round++) {
    for (const timer of ui.afters.splice(0)) if (!timer.cancelled) {
      const promise = Promise.resolve().then(timer.fn);
      pending.add(promise); promise.finally(() => pending.delete(promise));
    }
    await settle();
    if (!pending.size && !ui.afters.length && !ui.surfacePending.size) break;
    if (round === 99) throw Error('automatic painting did not settle');
  }
  assert.match(JSON.stringify(ui.painted()), /new live message/, 'the subscription paints the new message');
  if (shouldFollow) assertTailReveal(ui.scrolls.slice(beforeCalls));
  else assert.equal(tailCount(ui.scrolls), before, 'a real upward scroll cancels following');
});

test('initial layout scroll cannot cancel placement, but reading after reveal can', async t => {
  t.after(closeUI);
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: [entry('saved', 'agentMessage', 'saved')], next_cursor: null } : { revision: 1, entries: [] });
  await ui.scroll(-1, 0);
  await flushTimers(ui);
  assertTailReveal(ui.scrolls);
  await ui.scroll(-1, 10);
  assert.ok(nodes(await ui.draw()).some(node => node.type === 'Button' && node.props.key === 'codex_jump_a_viewport'));
});

test('jump control returns to the latest message', async (t) => {
  t.after(closeUI);
  const saved = Array.from({ length: 150 }, (_, i) => entry(String(i), 'agentMessage', 'message ' + i));
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: saved, next_cursor: null } : { revision: 1, entries: [] });
  await flushTimers(ui);
  await ui.scrollEvent({ origin: { kind: 'person' }, by: -1, offset: 30, contentRows: 130, bodyRows: 10 });
  const before = ui.scrolls.length;
  const jump = nodes(await ui.draw()).find(node => node.type === 'Button' && node.props.key === 'codex_jump_a_viewport');
  assert.ok(jump); await jump.props.onPress(); await flushTimers(ui);
  assertTailReveal(ui.scrolls.slice(before));
  assert.match(JSON.stringify(await ui.draw()), /message 149/);
});

test('jump waits for its new tail marker even when an older marker was painted', async t => {
  t.after(closeUI);
  let allowNew = true; const attempted = [];
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: [], next_cursor: null } : { revision: 1, entries: [entry('latest', 'agentMessage', 'latest')] }, {
    acceptScroll: args => { if (args.to?.key?.startsWith('codex_tail_a_')) { attempted.push(args.to.key); return allowNew; } return true; },
  });
  await flushTimers(ui);
  const oldKey = tailCalls(ui.scrolls).at(-1).to.key;
  await ui.scroll(-1, 10);
  allowNew = false;
  await (await ui.item('codex_jump_a_viewport')).props.onPress();
  const before = ui.scrolls.length;
  await ui.draw(); await settle(); await settle();
  assert.ok(attempted.length >= 3);
  assert.notEqual(attempted.at(-1), oldKey, 'the old painted marker cannot satisfy the new request');
  assert.equal(ui.scrolls.length, before, 'the jump remains pending while its marker is absent');
  allowNew = true;
  await flushTimers(ui);
  assertTailReveal(ui.scrolls.slice(before));
  assert.equal(ui.scrolls.at(-1).to.key, attempted.at(-1));
});
test('new activity pauses for reading and resumes after a real scroll to the bottom', async (t) => {
  t.after(closeUI);
  const tool = { id: 'tool', turn_id: 'turn', type: 'commandExecution', data: { command: 'test', aggregatedOutput: 'output' } };
  let revision = 1, entries = [tool];
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'running' }] } : op === 'ui_revision' ? { revision, entries } : op === 'ui_history' ? { entries: [], next_cursor: null } : { text: '', next_offset: null });
  await (await ui.item('item_a:turn:tool')).props.onPress();
  const countEnd = () => tailCount(ui.scrolls);
  let count = countEnd();
  entries = [...entries, entry('one', 'agentMessage', 'first')]; revision++; await ui.tick(); await flushTimers(ui);
  assert.equal(countEnd(), ++count, 'opening a tool at the bottom does not disable following');
  entries = [...entries, entry('two', 'agentMessage', 'second')]; revision++; await ui.tick();
  await ui.scrollEvent({ origin: { kind: 'person' }, by: -78, offset: 12, contentRows: 100, bodyRows: 10 }); await flushTimers(ui);
  assert.equal(countEnd(), count, 'a pending follow is cancelled by a user scroll');
  entries = [tool, entry('one', 'agentMessage', 'first'), entry('two', 'agentMessage', 'second is still streaming')]; revision++; await ui.tick(); await flushTimers(ui);
  assert.equal(countEnd(), count, 'new activity does not interrupt reading');
  assert.ok(ui.scrolls.every(s => s.to !== 'end'), 'tail positioning never enables native follow-end');
  await ui.scrollEvent({ origin: { kind: 'person' }, by: 0, offset: 12, contentRows: 22, bodyRows: 10 }); await flushTimers(ui);
  entries = [tool, entry('one', 'agentMessage', 'first'), entry('two', 'agentMessage', 'second now complete')]; revision++; await ui.tick(); await flushTimers(ui);
  assert.equal(countEnd(), count, 'a bottom-position layout event does not resume following');
  await ui.scrollEvent({ origin: { kind: 'person' }, by: 0, offset: 12, contentRows: 100, bodyRows: 10 });
  await ui.scrollEvent({ origin: { kind: 'person' }, by: 78, offset: 90, contentRows: 100, bodyRows: 10 }); await flushTimers(ui);
  assert.equal(countEnd(), count, 'scrolling to the end requires no additional jump');
  entries = [...entries, entry('four', 'agentMessage', 'fourth')]; revision++; await ui.tick(); await flushTimers(ui);
  assert.equal(countEnd(), count + 1, 'reaching the bottom resumes following');
});

test('a user scroll during an in-flight send refresh cancels the pending jump', async (t) => {
  t.after(closeUI); let release, block = false, revision = 1;
  const ui = await setup(async op => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    if (op === 'ui_send') { block = true; return { agent_id: 'a', status: 'steered' }; }
    if (op === 'ui_revision') { if (block) return new Promise(resolve => { release = resolve; }); return { revision, entries: [] }; }
  });
  await flushTimers(ui);
  const before = tailCount(ui.scrolls);
  const sending = (await ui.item('codex_message_a')).props.onSubmit('hello');
  while (!release) await new Promise(setImmediate);
  await ui.scrollEvent({ origin: { kind: 'person' }, by: -1, offset: 10, contentRows: 100, bodyRows: 20 });
  revision++; release({ revision, entries: [entry('sent', 'directUserMessage', 'hello')] }); await sending; await flushTimers(ui);
  assert.equal(tailCount(ui.scrolls), before);
});

test('switching or closing discards a delayed history result', async t => {
  t.after(closeUI);
  for (const action of ['switch', 'close']) {
    let release;
    const ui = await setup(async (op, args) => {
      if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }, { agent_id: 'b', status: 'completed' }] };
      if (op === 'ui_revision') return { revision: 1, entries: [] };
      if (args.cursor) return new Promise(resolve => { release = resolve; });
      return { entries: [entry(args.target, 'agentMessage', `${args.target} recent`)], next_cursor: args.target === 'a' ? { turns_cursor: 'older' } : null };
    });
    await ui.draw();
    for (const timer of ui.afters.splice(0)) if (!timer.cancelled) void timer.fn();
    await settle(); assert.equal(typeof release, 'function');
    if (action === 'switch') await ui.open('b'); else await ui.close();
    const count = ui.scrolls.length;
    release({ entries: [entry('late', 'agentMessage', 'a late')], next_cursor: null });
    await settle(); await settle();
    assert.equal(ui.scrolls.length, count);
    if (action === 'close') await ui.open('b');
    const rendered = JSON.stringify(await ui.draw());
    assert.match(rendered, /b recent/); assert.doesNotMatch(rendered, /a late/);
  }
});

test('viewport jump remains one stable hover target while scroll frames reuse the transcript', async t => {
  t.after(closeUI);
  const saved = Array.from({ length: 150 }, (_, i) => entry(String(i), 'agentMessage', 'message ' + i));
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: saved, next_cursor: null } : { revision: 1, entries: [] });
  const frame = offset => ui.draw({ surface: 'desktop', props: { bodyColumns: 80, scroll: { offset, bodyRows: 10, contentRows: 160 } } });
  const one = nodes(await frame(30)), timerCount = ui.afters.length;
  const two = nodes(await frame(45));
  const overlay = tree => tree.find(node => node.props.key === 'codex_jump_overlay_a');
  const jump = tree => tree.filter(node => node.props.key === 'codex_jump_a_viewport');
  assert.equal(overlay(one).props.top, 37); assert.equal(overlay(two).props.top, 52);
  assert.equal(jump(one).length, 1); assert.equal(jump(two).length, 1);
  assert.strictEqual(jump(one)[0], jump(two)[0], 'the hover target survives the scroll frame');
  assert.strictEqual(one.find(node => node.type === 'Markdown'), two.find(node => node.type === 'Markdown'), 'transcript nodes are reused');
  assert.equal(ui.afters.length, timerCount, 'scroll rendering schedules no new timers');
  const resized = nodes(await ui.draw({ surface: 'desktop', props: { bodyColumns: 90, scroll: { offset: 45, bodyRows: 10, contentRows: 160 } } }));
  assert.notStrictEqual(one.find(node => node.type === 'Markdown'), resized.find(node => node.type === 'Markdown'), 'a changed width rebuilds the transcript');
});

test('scroll frames preserve a draft edited between nonempty values', async t => {
  t.after(closeUI);
  const ui = await setup(async op => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'running' }] } : op === 'ui_history' ? { entries: [], next_cursor: null } : { revision: 1, entries: [] });
  const draw = offset => ui.draw({ surface: 'desktop', props: { bodyColumns: 80, scroll: { offset, bodyRows: 10, contentRows: 100 } } });
  let tree = nodes(await draw(10));
  await tree.find(node => node.type === 'Input').props.onInput('first');
  tree = nodes(await draw(10));
  await tree.find(node => node.type === 'Input').props.onInput('second');
  tree = nodes(await draw(20));
  assert.equal(tree.find(node => node.type === 'Input').props.value, 'second');
});

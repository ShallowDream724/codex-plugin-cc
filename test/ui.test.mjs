import test from 'node:test';
import assert from 'node:assert/strict';
import { groupEntries, registerUI, openAgent, observeUI, closeUI } from '../hooks/ui.js';

function connect($, handler) {
  $.session = { id: async () => 'session', cwd: async () => 'C:/work' };
  $.env = { get: async () => undefined }; $.plugin = { root: 'C:/plugin' };
  $.process = { run: async (_argv, options) => {
    const request = JSON.parse(options.stdin);
    return { stdout: JSON.stringify(await handler($, request.operation, request.args)), exitCode: 0 };
  } };
}

test('keyboard command opens an agent without submitting a prompt or mutating work', async () => {
  const hooks = [], calls = [], notices = []; let agents = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { toast: (s) => notices.push(s), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  connect($, async (_$, op) => {
    calls.push(op);
    if (op === 'ui_list') return { agents };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    return { revision: 0, entries: [] };
  });
  closeUI(); registerUI(on);
  const command = hooks.find((h) => h.event === 'command.run' && h.matcher.command === 'codex-agents').fn;
  assert.deepEqual(await command($, {}, () => { throw new Error('must not call next'); }), {});
  assert.match(notices[0], /No Codex agents/);
  agents = [{ agent_id: 'a', name: 'Agent', status: 'running' }];
  assert.deepEqual(await command($, {}, () => { throw new Error('must not call next'); }), {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('ui_revision'));
  assert.ok(calls.every((op) => ['ui_list', 'ui_history', 'ui_revision'].includes(op)));
  assert.equal($.prompt, undefined);
  closeUI();
});

test('only adjacent same-type calls within a turn group and retain items', () => {
  const entries = [
    { id: '1', type: 'commandExecution', turn_id: 't' }, { id: '2', type: 'commandExecution', turn_id: 't' },
    { id: '3', type: 'agentMessage', turn_id: 't' }, { id: '4', type: 'commandExecution', turn_id: 't' },
    { id: '5', type: 'commandExecution', turn_id: 'u' },
  ];
  assert.deepEqual(groupEntries(entries).map((g) => g.items.map((i) => i.id)), [['1', '2'], ['3'], ['4'], ['5']]);
});

test('history stays reachable after live rollover and past fifty pages; closed observation never redraws', async () => {
  const hooks = [], timers = []; let invalidations = 0, live = 'live-100';
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button'].map((type) => [type, (props) => ({ type, props })])), invalidate() { invalidations++; }, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(ms, fn) { const t = { fn, cancel() {} }; timers.push(t); return t; } } };
  const entry = (id) => ({ id, turn_id: 't', type: 'agentMessage', data: { text: id } });
  const agents = [{ agent_id: 'a', name: 'A', status: 'running', pending_requests: [{ payload: 'private' }] }];
  const bridge = async (_$, op, args) => {
    if (op === 'ui_list') return { agents };
    if (op === 'ui_revision') return { revision: live === 'live-100' ? 1 : 2, entries: [entry(live)] };
    const n = args.cursor ? Number(args.cursor.turns_cursor) : 0;
    return { entries: [entry(`history-${n}`)], next_cursor: { turns_cursor: String(n + 1) } };
  };
  closeUI(); connect($, bridge); registerUI(on);
  observeUI($, { agents }); assert.equal(invalidations, 0);
  await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  live = 'live-200'; timers[0].fn(); await new Promise((r) => setImmediate(r));
  let tree = draw(); assert.ok(JSON.stringify(tree).includes('live-200')); assert.ok(!JSON.stringify(tree).includes('live-100'));
  await tree.props.children.find((x) => x.props.key === 'codex_history').props.onPress();
  for (let i = 0; i < 56; i++) { tree = draw(); await tree.props.children.find((x) => x.props.key === 'codex_older').props.onPress(); }
  tree = draw(); assert.ok(JSON.stringify(tree).includes('history-56')); assert.ok(tree.props.children.some((x) => x.props.key === 'codex_older'));
  assert.ok(tree.props.children.some((x) => x.props.key === 'codex_latest'));
  await tree.props.children.find((x) => x.props.key === 'codex_latest').props.onPress();
  tree = draw(); assert.ok(JSON.stringify(tree).includes('history-0'));
  await tree.props.children.find((x) => x.props.key === 'codex_live').props.onPress();
  await hooks.find((h) => h.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e);
  const count = invalidations; observeUI($, { agents: [{ ...agents[0], status: 'completed', name: 'Changed' }] }); assert.equal(invalidations, count);
});

test('older pages stay visible during live updates and newer returns to latest', async () => {
  const hooks = [], timers = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(ms, fn) { const t = { fn, cancel() {} }; timers.push(t); return t; } } };
  const entry = (id) => ({ id, turn_id: 't', type: 'agentMessage', data: { text: id } });
  const bridge = async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', name: 'The full agent name' }] };
    if (op === 'ui_history') return args.cursor ? { entries: [entry('old')], next_cursor: null } : { entries: [entry('new')], next_cursor: { turns_cursor: 'old' } };
    return { revision: 1, entries: [entry('live')] };
  };
  closeUI(); connect($, bridge); registerUI(on);
  await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = draw();
  assert.ok(tree.props.children.some((x) => x.type === 'Text' && x.props.children[0] === 'The full agent name'));
  await tree.props.children.find((x) => x.props.key === 'codex_history').props.onPress();
  tree = draw();
  await tree.props.children.find((x) => x.props.key === 'codex_older').props.onPress();
  tree = draw(); assert.ok(tree.props.children.some((x) => x.props.key?.includes('t:old')));
  timers[0].fn(); await new Promise((r) => setImmediate(r));
  tree = draw(); assert.ok(tree.props.children.some((x) => x.props.key?.includes('t:old'))); assert.ok(!tree.props.children.some((x) => x.props.key?.includes('t:live')));
  await tree.props.children.find((x) => x.props.key === 'codex_newer').props.onPress();
  tree = draw(); assert.ok(tree.props.children.some((x) => x.props.key?.includes('t:new')));
});

test('late details from a previous selection are discarded', async () => {
  const hooks = [], deferred = {};
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const bridge = async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', name: 'A' }, { agent_id: 'b', name: 'B' }] };
    if (op === 'ui_history') return { entries: [{ id: args.target, turn_id: 't', type: 'commandExecution', data: { command: args.target } }] };
    if (op === 'ui_detail') return new Promise((resolve) => { deferred.resolve = resolve; });
    return { revision: 1, entries: [] };
  };
  closeUI(); connect($, bridge); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = draw(); await tree.props.children.find((x) => x.props.key === 'codex_history').props.onPress();
  tree = draw(); tree.props.children.find((x) => x.props.key?.includes('item_a:t:a')).props.onPress();
  tree = draw(); const pending = tree.props.children.find((x) => x.props.label === 'Load full item').props.onPress();
  await tree.props.children[0].props.children[1].props.onPress(); await new Promise((r) => setImmediate(r));
  deferred.resolve({ text: 'old response', next_offset: null }); await pending;
  tree = draw(); assert.ok(!JSON.stringify(tree).includes('old response'));
});

test('large detail pages can be navigated in both directions', async () => {
  const hooks = [], offsets = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const bridge = async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', name: 'A' }] };
    if (op === 'ui_history') return { entries: [{ id: 'cmd', turn_id: 't', type: 'commandExecution', data: { command: 'run' } }] };
    if (op === 'ui_detail') { offsets.push(args.offset); return { text: `Page ${args.offset}`, next_offset: args.offset ? null : 16000 }; }
    return { revision: 1, entries: [] };
  };
  closeUI(); connect($, bridge); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = draw(); await tree.props.children.find((x) => x.props.key === 'codex_history').props.onPress();
  tree = draw(); tree.props.children.find((x) => x.props.key?.includes('item_a:t:cmd')).props.onPress();
  tree = draw(); await tree.props.children.find((x) => x.props.label === 'Load full item').props.onPress();
  tree = draw(); await tree.props.children.find((x) => x.props.label === 'Next output page').props.onPress();
  tree = draw(); assert.ok(tree.props.children.some((x) => x.props.children?.[0] === 'Page 16000'));
  await tree.props.children.find((x) => x.props.label === 'Previous output page').props.onPress();
  assert.deepEqual(offsets, [0, 16000, 0]);
});

test('agents have independent entries and polling ends when pane closes', async () => {
  const hooks = [], calls = [], timers = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const component = (type) => (props) => ({ type, props });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Markdown'].map((n) => [n, component(n)])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(ms, fn) { const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; } } };
  const bridge = async (_$, op, args) => { calls.push({ op, args }); if (op === 'ui_revision') return { revision: 1, entries: [{ id: args.target, turn_id: 't', type: 'agentMessage', data: { text: args.target } }] }; return {}; };
  closeUI(); connect($, bridge); registerUI(on);
  observeUI($, { agents: [{ agent_id: 'a', name: 'a very long name '.repeat(10), status: 'running' }, { agent_id: 'b', name: 'b', status: 'completed' }] });
  const render = (componentName) => hooks.find((h) => h.event === 'ui.render' && h.matcher.component === componentName).fn;
  assert.equal(hooks.some((h) => h.matcher.component === 'AbovePrompt'), false);
  await openAgent($, 'a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[0].ms, 1000);
  let pane = render('Pane')($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.equal(pane.props.children[0].props.flexWrap, 'wrap');
  assert.equal(pane.props.children[0].props.children.length, 2);
  assert.notEqual(pane.props.children[0].props.children[0].props.key, pane.props.children[0].props.children[1].props.key);
  assert.ok(pane.props.children.some((c) => c.props.key?.includes('t:a')));
  await pane.props.children[0].props.children[1].props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  pane = render('Pane')($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.ok(pane.props.children.some((c) => c.props.key?.includes('t:b')));
  await hooks.find((h) => h.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e);
  assert.equal(timers[0].cancelled, true);
  const before = calls.length; await timers[0].fn(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls.length, before);
});

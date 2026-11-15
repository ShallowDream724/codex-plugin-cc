import test from 'node:test';
import assert from 'node:assert/strict';
import { groupEntries, registerUI, openAgent, observeUI, closeUI } from '../hooks/ui.js';
const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];

function connect($, handler) {
  $.session = { id: async () => 'session', cwd: async () => 'C:/work' };
  $.env = { get: async () => undefined }; $.plugin = { root: 'C:/plugin' };
  $.process = { run: async (_argv, options) => {
    const request = JSON.parse(options.stdin);
    return { stdout: JSON.stringify(await handler($, request.operation, request.args, request)), exitCode: 0 };
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
  assert.match(notices[0], /没有 Codex 代理/);
  agents = [{ agent_id: 'a', name: 'Agent', status: 'running' }];
  assert.deepEqual(await command($, {}, () => { throw new Error('must not call next'); }), {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('ui_revision'));
  assert.ok(calls.every((op) => ['ui_list', 'ui_history', 'ui_revision'].includes(op)));
  assert.equal($.prompt, undefined);
  closeUI();
});

test('direct controls preserve per-agent drafts and scope late results', async () => {
  const hooks = [], requests = [], pending = {};
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const agents = [{ agent_id: 'a', name: 'A', status: 'running' }, { agent_id: 'b', name: 'B', status: 'completed' }];
  connect($, async (_$, op, args, request) => {
    if (op === 'ui_list') return { agents };
    if (op === 'ui_revision') return { entries: [] };
    requests.push(request);
    return new Promise((resolve) => { pending[op] = resolve; });
  });
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = (tree, key) => nodes(tree).find((node) => node.props.key === key || (key !== 'codex_stop_a' && node.props.key?.startsWith(key)));
  let tree = draw(); item(tree, 'codex_message_').props.onInput('first draft');
  const send = item(tree, 'codex_message_').props.onSubmit('first draft');
  item(draw(), 'codex_message_').props.onInput('edited while sending');
  const stop = item(draw(), 'codex_stop_a').props.onPress();
  assert.equal(item(draw(), 'codex_message_').props.submitLabel, '发送中…');
  assert.equal(item(draw(), 'codex_stop_a'), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests.map((r) => r.args.target), ['a', 'a']);
  await openAgent($, 'b');
  tree = draw(); assert.equal(item(tree, 'codex_message_').props.value, '');
  assert.equal(item(tree, 'codex_message_').props.submitLabel, '发送并继续');
  item(tree, 'codex_message_').props.onInput('other draft');
  pending.ui_interrupt({ agent_id: 'a', status: 'stopped' }); await stop;
  pending.ui_send({ agent_id: 'a', status: 'steered', user_paused: false, user_control_status: null }); await send;
  assert.equal(item(draw(), 'codex_message_').props.value, 'other draft');
  Object.assign(agents[0], { user_paused: true, user_control_status: 'stopped' });
  await openAgent($, 'a');
  tree = draw(); assert.equal(item(tree, 'codex_message_').props.value, 'edited while sending');
  assert.ok(JSON.stringify(tree).includes('已停止'));
  assert.equal(item(tree, 'codex_message_').props.submitLabel, '发送并继续');
  closeUI();
});

test('uncertain send retains draft and stop distinguishes unconfirmed from stopped', async () => {
  const hooks = [], calls = [];
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  connect($, async (_$, op, args) => {
    calls.push(op);
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { entries: [] };
    if (op === 'ui_interrupt') return { agent_id: 'a', status: 'unconfirmed', error: 'timeout' };
    if (op === 'ui_send') return { offline: true };
  });
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = (key) => nodes(draw()).find((node) => node.props.key === key || (key !== 'codex_stop_a' && node.props.key?.startsWith(key)));
  item('codex_message_').props.onInput('retain this');
  await item('codex_message_').props.onSubmit('retain this');
  assert.equal(item('codex_message_').props.value, 'retain this');
  assert.match(JSON.stringify(draw()), /发送状态未知/);
  await item('codex_stop_a').props.onPress();
  assert.match(JSON.stringify(draw()), /停止状态未确认/);
  assert.equal(item('codex_stop_a').props.label, '■ 重试停止');
  assert.equal(calls.filter((op) => op === 'ui_send').length, 1);
  closeUI();
});

test('attachments stay scoped to drafts and uncertain or edited sends preserve them', async () => {
  const hooks = [], requests = []; let resolveSend, pickerCount = 0;
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const agents = [{ agent_id: 'a', status: 'running', permissions_mode: 'full-access', context_used_tokens: 500, context_limit_tokens: 1000 }, { agent_id: 'b', status: 'running' }];
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents };
    if (op === 'ui_revision') return { revision: 1, entries: [] };
    if (op === 'ui_send') { requests.push(args); return new Promise((resolve) => { resolveSend = resolve; }); }
  });
  const run = $.process.run;
  $.process.run = async (argv, options) => argv[1].endsWith('/runtime/picker.mjs') ? (pickerCount++, { stdout: '{"unsupported":true}', exitCode: 0 }) : run(argv, options);
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = (key) => nodes(draw()).find((node) => node.props.key?.startsWith(key));
  assert.equal(pickerCount, 0); assert.match(JSON.stringify(draw()), /上下文 50%/);
  await item('codex_attach_a').props.onPress();
  item('attachment_path_a').props.onSubmit('C:/docs/a.png');
  await openAgent($, 'b'); assert.ok(!JSON.stringify(draw()).includes('a.png'));
  await openAgent($, 'a'); assert.ok(JSON.stringify(draw()).includes('a.png'));
  let send = item('codex_message_a').props.onSubmit('');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(requests[0], { target: 'a', message: '', attachments: [{ path: 'C:/docs/a.png' }] });
  resolveSend({ error: { code: 'action_status_unknown' } }); await send;
  assert.ok(JSON.stringify(draw()).includes('a.png'));
  send = item('codex_message_a').props.onSubmit(''); await new Promise((r) => setImmediate(r));
  await item('codex_attach_a').props.onPress(); item('attachment_path_a').props.onSubmit('C:/docs/b.txt');
  resolveSend({ agent_id: 'a', status: 'steered' }); await send;
  assert.ok(JSON.stringify(draw()).includes('a.png')); assert.ok(JSON.stringify(draw()).includes('b.txt'));
  closeUI();
});

test('unchanged revision does not redraw and stopping blocks submit while allowing retry', async () => {
  const hooks = [], timers = []; let invalidations = 0, sends = 0;
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() { invalidations++; }, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } } };
  const agent = { agent_id: 'a', status: 'running', user_paused: false, user_control_status: null };
  connect($, async (_$, op) => {
    if (op === 'ui_list') return { agents: [agent] };
    if (op === 'ui_revision') return { revision: 1, entries: [], agent: { user_paused: false, user_control_status: null } };
    if (op === 'ui_interrupt') return { agent_id: 'a', status: 'stopping', user_paused: true, user_control_status: 'stopping' };
    if (op === 'ui_send') sends++;
  });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = (key) => nodes(draw()).find((node) => node.props.key === key || (key !== 'codex_stop_a' && node.props.key?.startsWith(key)));
  item('codex_message_').props.onInput('draft');
  const before = invalidations; timers[0](); await new Promise((r) => setImmediate(r));
  assert.equal(invalidations, before);
  assert.equal(item('codex_message_').props.value, 'draft');
  await item('codex_stop_a').props.onPress();
  assert.equal(item('codex_stop_a').props.label, '■ 重试停止');
  assert.equal(item('codex_message_').props.submitLabel, '等待停止');
  await item('codex_message_').props.onSubmit('draft');
  assert.equal(sends, 0);
  assert.equal(item('codex_message_').props.value, 'draft');
  closeUI();
});

test('activity deduplication respects message origin', async () => {
  const hooks = [];
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entry = (id, type, data) => ({ id, type, data, turn_id: 't' });
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : { revision: 1, entries: [entry('native', 'userMessage', { content: [{ text: 'same' }] }), entry('action:send:1', 'directUserMessage', { text: 'same' }), entry('action:send:2', 'parentMessage', { text: 'same' })] });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const tree = hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.ok(tree.props.children.some((node) => node.props.key?.includes('action:send:1')));
  assert.ok(!tree.props.children.some((node) => node.props.key?.includes('action:send:2')));
  closeUI();
});

test('conversation shows prose and expandable file changes with authoritative counts', async () => {
  const hooks = [];
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const diff = '@@ -1,1 +1,1 @@\n-old\n+one\n';
  const entries = [{ id: 'm', type: 'agentMessage', turn_id: 't', data: { text: '正文直接显示' } }, { id: 'f', type: 'fileChange', turn_id: 't', data: { fileSummary: [{ path: 'test.js', added: 5, removed: 1 }], changes: [{ path: 'test.js', diff }] } }];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', name: '代理', model: 'model', reasoning_effort: 'high' }] } : op === 'ui_detail' ? { text: diff, next_offset: 16000, format: 'source' } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = draw(); assert.ok(tree.props.children.some(node => node.type === 'Markdown' && node.props.text === '正文直接显示'));
  const file = tree.props.children.find(node => node.props.key?.startsWith('file_'));
  assert.match(file.props.label, /test\.js \+5 -1/); file.props.onPress();
  tree = draw(); const code = tree.props.children.find(node => node.type === 'Code');
  assert.deepEqual(code.props, { source: diff, path: 'test.js', format: 'diff', wrap: 'wrap' });
  await tree.props.children.find((node) => node.props.key?.startsWith('file_detail_')).props.onPress();
  assert.equal(draw().props.children.find((node) => node.type === 'Code').props.format, 'source');
  assert.equal(tree.props.children.at(-2).type, 'Input');
  closeUI();
});

test('long messages and file output support next and previous pages', async () => {
  const hooks = [], requests = [];
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entries = [{ id: 'm', type: 'agentMessage', turn_id: 't', preview: '摘要', deferred: true }, { id: 'f', type: 'fileChange', turn_id: 't', data: { changes: [{ path: 'test.js', diff: '+preview' }] } }];
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] };
    if (op === 'ui_revision') return { revision: 1, entries };
    if (op === 'ui_detail') { requests.push([args.item_id, args.offset, args.file_path ?? null]); return { text: `${args.item_id} page ${args.offset}`, next_offset: args.offset === 0 ? 16000 : null }; }
  });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = (prefix) => draw().props.children.find((node) => node.props.key?.startsWith(prefix));
  await item('item_a:t:m').props.onPress();
  await item('item_a:t:m').props.onPress();
  assert.ok(JSON.stringify(draw()).includes('m page 16000'));
  await item('message_prev_a:t:m').props.onPress();
  assert.ok(JSON.stringify(draw()).includes('m page 0'));
  item('file_a:t:f:file:0').props.onPress();
  await item('file_detail_a:t:f:file:0').props.onPress();
  await item('file_detail_a:t:f:file:0').props.onPress();
  assert.ok(JSON.stringify(draw()).includes('f page 16000'));
  await item('file_prev_a:t:f:file:0').props.onPress();
  assert.deepEqual(requests, [['m', 0, null], ['m', 16000, null], ['m', 0, null], ['f', 0, 'test.js'], ['f', 16000, 'test.js'], ['f', 0, 'test.js']]);
  closeUI();
});

test('open file holds live entries through refresh and collapsing releases them', async () => {
  const hooks = [], timers = []; let revision = 1;
  const on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } } };
  connect($, async (_$, op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] };
    if (op === 'ui_detail') return { text: '完整输出', next_offset: null };
    return revision === 1 ? { revision, entries: [{ id: 'f', type: 'fileChange', turn_id: 't', data: { changes: [{ path: 'old.js', diff: '+old' }] } }] } : { revision, entries: [{ id: 'new', type: 'agentMessage', turn_id: 't', data: { text: '新活动' } }] };
  });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = (prefix) => draw().props.children.find((node) => node.props.key?.startsWith(prefix));
  item('file_a:t:f:file:0').props.onPress();
  await item('file_detail_a:t:f:file:0').props.onPress();
  revision = 2; timers[0](); await new Promise((r) => setImmediate(r));
  assert.match(JSON.stringify(draw()), /old\.js/); assert.ok(!JSON.stringify(draw()).includes('新活动'));
  item('file_a:t:f:file:0').props.onPress();
  timers[0](); await new Promise((r) => setImmediate(r));
  assert.ok(JSON.stringify(draw()).includes('新活动'));
  closeUI();
});

test('native activity types render readable tool, search, plan and lifecycle details', async () => {
  const hooks = [], on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entry = (id, type, data) => ({ id, type, turn_id: 't', data });
  const entries = [entry('a', 'mcpToolCall', { server: 'fastctx', tool: 'inspect_local_file' }), entry('a2', 'mcpToolCall', { server: 'fastctx', tool: 'inspect_local_file' }), entry('b', 'mcpToolCall', { server: 'fastctx', tool: 'grep' }), entry('search', 'webSearch', { action: { query: '中文查询', url: 'https://example.com/' } }), entry('plan', 'plan', { text: '检查结果' }), entry('compact', 'contextCompaction', { stage: 'started' }), entry('child', 'subAgentActivity', { name: '研究', kind: 'completed', agentThreadId: 'child' }), entry('spawn', 'collabAgentToolCall', { name: '撰写', tool: 'spawnAgent', stage: 'completed', agents: [{ id: 'child2', status: 'running' }] }), entry('future', 'futureItem', { opaque: 4 })];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = draw();
  assert.ok(JSON.stringify(tree).includes('上下文正在压缩'));
  assert.ok(JSON.stringify(tree).includes('研究已完成'));
  assert.ok(JSON.stringify(tree).includes('撰写开始工作'));
  assert.ok(tree.props.children.some((node) => node.type === 'Markdown' && node.props.text.includes('检查结果')));
  tree.props.children.find((node) => node.props.key?.startsWith('group_')).props.onPress();
  tree = draw(); assert.ok(JSON.stringify(tree).includes('读取本地文件')); assert.ok(JSON.stringify(tree).includes('搜索文件内容'));
  tree.props.children.find((node) => node.props.key?.startsWith('item_a:t:search')).props.onPress();
  tree = draw(); assert.ok(JSON.stringify(tree).includes('中文查询')); assert.ok(JSON.stringify(tree).includes('https://example.com/'));
  tree.props.children.find((node) => node.props.key?.startsWith('item_a:t:future')).props.onPress();
  assert.ok(JSON.stringify(draw()).includes('opaque'));
  closeUI();
});

test('expanded local PNG uses native image; other paths never load as files', async () => {
  const hooks = [], on = (...args) => hooks.push({ event: args[0], fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Image'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entries = [{ id: 'png', type: 'imageView', turn_id: 't', data: { path: 'C:\\images\\plot.png' } }, { id: 'web', type: 'imageView', turn_id: 't', data: { path: 'https://example.com/a.png' } }, { id: 'unc', type: 'imageView', turn_id: 't', data: { path: '//server/share/a.png' } }, { id: 'jpg', type: 'imageView', turn_id: 't', data: { path: '/tmp/a.jpg' } }];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.equal(draw().props.children.filter((node) => node.type === 'Image').length, 0);
  for (const id of ['png', 'web', 'unc', 'jpg']) draw().props.children.find((node) => node.props.key?.startsWith(`item_a:t:${id}`)).props.onPress();
  const images = draw().props.children.filter((node) => node.type === 'Image');
  assert.equal(images.length, 1); assert.deepEqual(images[0].props.source, { file: 'C:\\images\\plot.png', format: 'png' });
  assert.ok(draw().props.children.some((node) => node.props.key?.startsWith('copy_a:t:jpg')));
  closeUI();
});

test('only adjacent same-type calls within a turn group and retain items', () => {
  const entries = [
    { id: '1', type: 'commandExecution', turn_id: 't' }, { id: '2', type: 'commandExecution', turn_id: 't' },
    { id: '3', type: 'agentMessage', turn_id: 't' }, { id: '4', type: 'commandExecution', turn_id: 't' },
    { id: '5', type: 'commandExecution', turn_id: 'u' },
  ];
  assert.deepEqual(groupEntries(entries).map((g) => g.items.map((i) => i.id)), [['1', '2'], ['3'], ['4'], ['5']]);
  const calls = ['grep', 'grep', 'glob'].map((tool, index) => ({ id: String(index), type: 'mcpToolCall', turn_id: 't', data: { server: 'fastctx', tool } }));
  assert.deepEqual(groupEntries(calls).map((g) => g.items.length), [2, 1]);
});

test('history stays reachable after live rollover and past fifty pages; closed observation never redraws', async () => {
  const hooks = [], timers = []; let invalidations = 0, live = 'live-100';
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() { invalidations++; }, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(ms, fn) { const t = { fn, cancel() {} }; timers.push(t); return t; } } };
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
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(ms, fn) { const t = { fn, cancel() {} }; timers.push(t); return t; } } };
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
  assert.ok(JSON.stringify(tree).includes('The full agent name'));
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
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
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
  tree = draw(); const pending = tree.props.children.find((x) => x.props.label === '查看完整内容').props.onPress();
  await openAgent($, 'b'); await new Promise((r) => setImmediate(r));
  deferred.resolve({ text: 'old response', next_offset: null }); await pending;
  tree = draw(); assert.ok(!JSON.stringify(tree).includes('old response'));
});

test('large detail pages can be navigated in both directions', async () => {
  const hooks = [], offsets = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
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
  tree = draw(); await tree.props.children.find((x) => x.props.label === '查看完整内容').props.onPress();
  tree = draw(); await tree.props.children.find((x) => x.props.label === '下一页输出').props.onPress();
  tree = draw(); assert.ok(JSON.stringify(tree).includes('Page 16000'));
  await tree.props.children.find((x) => x.props.label === '上一页输出').props.onPress();
  assert.deepEqual(offsets, [0, 16000, 0]);
});

test('agents have independent entries and polling ends when pane closes', async () => {
  const hooks = [], calls = [], timers = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const component = (type) => (props) => ({ type, props });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((n) => [n, component(n)])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(ms, fn) { const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; } } };
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
  assert.ok(JSON.stringify(pane).includes('a very long name'));
  assert.ok(pane.props.children.some((c) => c.props.key?.includes('t:a')));
  await openAgent($, 'b');
  await new Promise((resolve) => setImmediate(resolve));
  pane = render('Pane')($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.ok(pane.props.children.some((c) => c.props.key?.includes('t:b')));
  await hooks.find((h) => h.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e);
  assert.equal(timers[0].cancelled, true);
  const before = calls.length; await timers[0].fn(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls.length, before);
});

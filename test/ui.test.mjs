import test from 'node:test';
import assert from 'node:assert/strict';
import { groupEntries, registerUI, openAgent, observeUI, closeUI } from '../hooks/ui.js';
import { fileChangePage } from '../shared/file-changes.mjs';
import { nativeHooks } from './native-hooks.mjs';
const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];

// Native Box dimensions accept cells or percentages, not CSS unit strings.
function assertNativeDimensions(tree) {
  for (const node of nodes(tree).filter(node => node.type === 'Box')) {
    for (const prop of ['width', 'height', 'minWidth', 'minHeight']) {
      const value = node.props[prop];
      if (value === undefined) continue;
      assert.ok(typeof value === 'number' ? Number.isFinite(value) && value >= 0 && value <= 10000 : typeof value === 'string' && /^\d{1,3}%$/.test(value), `${node.props.key}.${prop}: unsupported native dimension ${value}`);
    }
  }
}

function connect($, handler) {
  $.clock.after ??= (_ms, fn) => { const timer = setImmediate(fn); return { cancel() { clearImmediate(timer); } }; };
  $.state ??= { get: async () => { await new Promise(setImmediate); return { value: undefined, version: 0 }; }, set: async () => { $.ui.invalidate(); return { isSet: true }; } };
  $.session = { id: async () => 'session', cwd: async () => 'C:/work' };
  $.env = { get: async () => undefined }; $.plugin = { root: 'C:/plugin' };
  $.process = { run: async (_argv, options) => {
    const request = JSON.parse(options.stdin);
    return { stdout: JSON.stringify(await handler($, request.operation, request.args, request)), exitCode: 0 };
  } };
}

test('desktop Enter submits without a native button and the footer control routes only the selected agent', async () => {
  const hooks = [], calls = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Client'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [] };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    calls.push({ op, args });
    return op === 'ui_interrupt' ? { agent_id: 'a', user_control_status: 'stopped', user_paused: true } : { agent_id: 'a', status: 'steered' };
  });
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = (bodyRows) => hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows } } }, () => null);
  for (const rows of [24, 40]) {
    const tree = await draw(rows);
    assert.equal(tree.props.minHeight, rows);
    assert.equal(nodes(tree).find(node => node.props.key === 'codex_timeline_a').props.flexGrow, 1);
  }
  assert.equal((await draw()).props.minHeight, undefined);
  const input = async () => nodes(await draw()).find(node => node.type === 'Input');
  assert.equal(Object.hasOwn((await input()).props, 'submitLabel'), false);
  await (await input()).props.onSubmit(''); assert.equal(calls.length, 0);
  await (await input()).props.onSubmit('继续检查'); assert.equal(calls[0].op, 'ui_send');
  const message = hooks.find(h => h.event === 'ui.message').fn;
  let ignored = false;
  await message($, { element: 'codex_action_old', data: { action: 'activate' } }, () => { ignored = true; return {}; });
  assert.equal(ignored, true); assert.equal(calls.length, 1);
  await message($, { element: 'codex_action_a', data: { action: 'activate' } }, () => { throw new Error('matched action'); });
  assert.equal(calls[1].op, 'ui_interrupt'); assert.equal(calls[1].args.target, 'a');
  closeUI();
});

test('mixed rich text keeps native Markdown structure and fenced language labels intact', async (t) => {
  const fence = String.fromCharCode(96).repeat(3);
  const rich = [
    '# Report', '', '**bold** _emphasis_ ~~deleted~~ and `inline code`', '',
    '> A quotation', '', '- [x] Checked', '- Parent', '  - Child', '', '1. First', '2. Second', '',
    '| Name | Value |', '| --- | ---: |', '| Example | 3 |', '',
    '[link](https://example.com)', '![plot](https://example.com/plot.png)', '', '---', '',
    fence + 'cpp', 'int main() { return 0; }', fence, '',
    fence + 'md', '# Literal heading', '\\[literal delimiter inside code\\]', fence, '',
    fence + 'txt', '<not markup>', fence, '',
    fence + 'json', '{"key": true}', fence, '',
    fence + 'mermaid', 'graph TD; A --> B', fence, '',
    fence + 'future-language', 'preserve unfamiliar syntax', fence,
  ].join('\n');
  const hooks = [], calls = [];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op) => {
    calls.push(op);
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    return { revision: 1, entries: [{ id: 'rich', turn_id: 't', type: 'agentMessage', data: { text: rich } }], next_cursor: null };
  });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = surface => hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface }, () => null);
  for (const surface of ['desktop', 'terminal']) {
    const blocks = nodes(await draw(surface)).filter(node => node.type === 'Markdown');
    assert.deepEqual(blocks.map(node => node.props.text), [rich]);
  }
  assert.ok(!calls.includes('ui_detail'), 'ordinary rich text requires no per-format detail fetch');
});

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
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const agents = [{ agent_id: 'a', name: 'A', status: 'running' }, { agent_id: 'b', name: 'B', status: 'completed' }];
  connect($, async (_$, op, args, request) => {
    if (op === 'ui_list') return { agents };
    if (op === 'ui_revision') return { entries: [] };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    requests.push(request);
    return new Promise((resolve) => { pending[op] = resolve; });
  });
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = async (tree, key) => nodes(tree).find((node) => node.props.key === key || (key !== 'codex_stop_a' && node.props.key?.startsWith(key)));
  let tree = await draw(); (await item(tree, 'codex_message_')).props.onInput('first draft');
  const send = (await item(tree, 'codex_message_')).props.onSubmit('first draft');
  (await item(await draw(), 'codex_message_')).props.onInput('edited while sending');
  (await item(await draw(), 'codex_message_')).props.onInput('');
  const stop = (await item(await draw(), 'codex_action_a')).props.onPress();
  (await item(await draw(), 'codex_message_')).props.onInput('edited while sending');
  assert.equal((await item(await draw(), 'codex_action_a')).props.label, '…');
  assert.equal((await item(await draw(), 'codex_stop_a')), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests.map((r) => r.args.target), ['a', 'a']);
  await openAgent($, 'b');
  tree = await draw(); assert.equal((await item(tree, 'codex_message_')).props.value, '');
  assert.equal((await item(tree, 'codex_action_b')).props.label, '↑');
  (await item(tree, 'codex_message_')).props.onInput('other draft');
  pending.ui_interrupt({ agent_id: 'a', status: 'stopped' }); await stop;
  pending.ui_send({ agent_id: 'a', status: 'steered', user_paused: false, user_control_status: null }); await send;
  assert.equal((await item(await draw(), 'codex_message_')).props.value, 'other draft');
  Object.assign(agents[0], { user_paused: true, user_control_status: 'stopped' });
  await openAgent($, 'a');
  tree = await draw(); assert.equal((await item(tree, 'codex_message_')).props.value, 'edited while sending');
  assert.ok(JSON.stringify(tree).includes('已停止'));
  assert.equal((await item(tree, 'codex_action_a')).props.label, '↑');
  closeUI();
});

test('uncertain send retains draft and stop distinguishes unconfirmed from stopped', async () => {
  const hooks = [], calls = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
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
  const item = async (key) => nodes(await draw()).find((node) => node.props.key === key || (key !== 'codex_stop_a' && node.props.key?.startsWith(key)));
  (await item('codex_message_')).props.onInput('retain this');
  await (await item('codex_message_')).props.onSubmit('retain this');
  assert.equal((await item('codex_message_')).props.value, 'retain this');
  assert.match(JSON.stringify(await draw()), /发送状态未知/);
  (await item('codex_message_')).props.onInput('');
  await (await item('codex_action_a')).props.onPress();
  assert.match(JSON.stringify(await draw()), /停止状态未确认/);
  assert.equal((await item('codex_action_a')).props.label, '■');
  assert.equal(calls.filter((op) => op === 'ui_send').length, 1);
  closeUI();
});

test('attachments stay scoped to drafts and uncertain or edited sends preserve them', async () => {
  const hooks = [], requests = []; let resolveSend, pickerCount = 0;
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
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
  const item = async (key) => nodes(await draw()).find((node) => node.props.key?.startsWith(key));
  assert.equal(pickerCount, 0); assert.match(JSON.stringify(await draw()), /◔ 50%/);
  await (await item('codex_attach_a')).props.onPress();
  (await item('attachment_path_a')).props.onSubmit('C:/docs/a.png');
  await openAgent($, 'b'); assert.ok(!JSON.stringify(await draw()).includes('a.png'));
  await openAgent($, 'a'); assert.ok(JSON.stringify(await draw()).includes('a.png'));
  let send = (await item('codex_message_a')).props.onSubmit('');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(requests[0], { target: 'a', message: '', attachments: [{ path: 'C:/docs/a.png' }] });
  resolveSend({ error: { code: 'action_status_unknown' } }); await send;
  assert.ok(JSON.stringify(await draw()).includes('a.png'));
  send = (await item('codex_message_a')).props.onSubmit(''); await new Promise((r) => setImmediate(r));
  await (await item('codex_attach_a')).props.onPress(); (await item('attachment_path_a')).props.onSubmit('C:/docs/b.txt');
  resolveSend({ agent_id: 'a', status: 'steered' }); await send;
  assert.ok(JSON.stringify(await draw()).includes('a.png')); assert.ok(JSON.stringify(await draw()).includes('b.txt'));
  closeUI();
});

test('unchanged revision does not redraw and stopping blocks submit while allowing retry', async () => {
  const hooks = [], timers = []; let invalidations = 0, sends = 0;
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
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
  const item = async (key) => nodes(await draw()).find((node) => node.props.key === key || (key !== 'codex_stop_a' && node.props.key?.startsWith(key)));
  (await item('codex_message_')).props.onInput('draft');
  const before = invalidations; timers[0](); await new Promise((r) => setImmediate(r));
  assert.equal(invalidations, before);
  assert.equal((await item('codex_message_')).props.value, 'draft');
  (await item('codex_message_')).props.onInput('');
  await (await item('codex_action_a')).props.onPress();
  assert.equal((await item('codex_action_a')).props.label, '…');
  await (await item('codex_message_')).props.onSubmit('draft');
  assert.equal(sends, 0);
  assert.equal((await item('codex_message_')).props.value, 'draft');
  closeUI();
});

test('activity deduplication matches origin, turn and exact content one-to-one', async () => {
  const hooks = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entry = (id, type, data) => ({ id, type, data, turn_id: 't' });
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : { revision: 1, entries: [
    entry('native', 'userMessage', { content: [{ text: 'same' }] }),
    entry('action:send:1', 'directUserMessage', { text: 'same' }),
    entry('action:send:2', 'parentMessage', { text: 'same' }),
    entry('action:send:repeat', 'parentMessage', { text: 'same' }),
    { ...entry('action:send:next-turn', 'parentMessage', { text: 'same' }), turn_id: 'next' },
    entry('action:send:substring', 'parentMessage', { text: 'sam' }),
    entry('native-image', 'directUserMessage', { text: '', attachments: [{ path: 'C:/a.png' }] }),
    entry('action:send:image-a', 'directUserMessage', { text: '', attachments: [{ path: 'C:/a.png' }] }),
    entry('action:send:image-b', 'directUserMessage', { text: '', attachments: [{ path: 'C:/b.png' }] }),
  ] });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const tree = await hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.ok(nodes(tree).some((node) => node.props.key?.includes('action:send:1')));
  assert.ok(!nodes(tree).some((node) => node.props.key?.includes('action:send:2')));
  for (const key of ['repeat', 'next-turn', 'substring', 'image-b']) assert.ok(nodes(tree).some(node => node.props.key?.includes(`action:send:${key}`)));
  assert.ok(!nodes(tree).some(node => node.props.key?.includes('action:send:image-a')));
  closeUI();
});

test('conversation shows prose and expandable file changes with authoritative counts', async () => {
  const hooks = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const diff = '@@ -1,1 +1,1 @@\n-old\n+one\n';
  const entries = [{ id: 'm', type: 'agentMessage', turn_id: 't', data: { text: '正文直接显示' } }, { id: 'f', type: 'fileChange', turn_id: 't', deferred: true, data: { fileSummary: [{ path: 'test.js', added: 5, removed: 1 }], changes: [{ path: 'test.js', diff }] } }];
  connect($, async (_$, op, args) => op === 'ui_list' ? { agents: [{ agent_id: 'a', name: '代理', model: 'model', reasoning_effort: 'high' }] } : op === 'ui_detail' ? { text: diff, next_offset: args.offset ? null : 16000, format: 'source' } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = await draw(); assert.ok(nodes(tree).some(node => node.type === 'Markdown' && node.props.text === '正文直接显示'));
  const file = nodes(tree).find(node => node.props.key?.startsWith('file_'));
  assert.match(file.props.label, /test\.js \+5 -1/); await file.props.onPress(); await new Promise(setImmediate);
  tree = await draw(); const code = nodes(tree).find(node => node.type === 'Code');
  assert.deepEqual(code.props, { key: 'file_code_a:t:f:file:0', source: diff, path: 'test.js', format: 'source', wrap: 'wrap' }, 'a partial detail page is source, not a complete patch');
  await nodes(tree).find((node) => node.props.key?.startsWith('file_detail_')).props.onPress();
  assert.equal(nodes(await draw()).find((node) => node.type === 'Code').props.format, 'source');
  assert.equal(nodes(tree).find((node) => node.props.key?.startsWith('codex_message_')).type, 'Input');
  closeUI();
});

test('desktop file changes show a basename and diff rows with one icon copy action', async (t) => {
  const hooks = [], copied = [], calls = [];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Svg', 'Client'].map(type => [type, props => ({ type, props })])), invalidate() {}, copy: async value => { copied.push(value); return { isCopied: true }; }, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  const source = '@@ -4,2 +4,3 @@\n one\n+<literal html>\n two\n';
  const entry = { id: 'file', turn_id: 't', type: 'fileChange', data: { changes: [{ path: 'C:/project/src/example.cpp', diff: source }] } };
  connect($, async (_$, op) => { calls.push(op); return op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : { entries: [], next_cursor: null }; });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = () => hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop' }, () => null);
  const file = nodes(await draw()).find(node => node.props.key === 'file_a:t:file:file:0');
  assert.equal(file.props.label, '已更改 example.cpp +1 -0');
  await file.props.onPress();
  const tree = await draw(), all = nodes(tree);
  assertNativeDimensions(tree);
  assert.ok(all.some(node => node.props.key === 'file_diff_a:t:file:file:0'));
  assert.ok(all.some(node => node.type === 'Text' && node.props.children.includes('<literal html>')));
  assert.ok(all.some(node => node.props.backgroundColor === 'rgba(46,160,67,0.16)'));
  assert.ok(!JSON.stringify(tree).includes('复制文件路径'));
  assert.ok(!JSON.stringify(tree).includes('复制当前差异'));
  assert.equal(all.filter(node => node.type === 'Client' && node.props.key === 'diff_copy_a:t:file:file:0').length, 1);
  await hooks.find(h => h.event === 'ui.message').fn($, { surface: 'desktop', element: 'diff_copy_a:t:file:file:0', data: { action: 'activate', expanded: false } }, () => { throw new Error('unmatched copy'); });
  assert.deepEqual(copied, [{ text: source, surface: 'desktop' }]);
  assert.ok(!calls.includes('ui_detail'), 'complete local diff needs no extra read');
});

test('long message expands once and caches across collapse', async (t) => {
  const hooks = [], requests = [];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  const entry = { id: 'm', type: 'agentMessage', turn_id: 't', preview: '摘要', deferred: true };
  connect($, async (_$, op, args) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : op === 'ui_detail' ? (requests.push(args), { text: '**全文**', format: 'markdown', external: false }) : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  const click = async () => (await draw()).find(n => n.props.key === 'item_a:t:m').props.onPress();
  await click(); assert.equal((await draw()).find(n => n.props.key === 'message_a:t:m').props.text, '**全文**');
  await click(); assert.equal((await draw()).find(n => n.props.key === 'message_a:t:m').props.text, '摘要');
  await click(); assert.equal(requests.length, 1); assert.equal(requests[0].view, 'message'); assert.equal(requests[0].expand, true);
});

test('open file retains its detail while new live entries continue to appear', async () => {
  const hooks = [], timers = []; let revision = 1;
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } } };
  connect($, async (_$, op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] };
    if (op === 'ui_detail') return { text: '完整输出', next_offset: null };
    return revision === 1 ? { revision, entries: [{ id: 'f', type: 'fileChange', turn_id: 't', deferred: true, data: { changes: [{ path: 'old.js', diff: '+old' }] } }] } : { revision, entries: [{ id: 'new', type: 'agentMessage', turn_id: 't', data: { text: '新活动' } }] };
  });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = async (prefix) => nodes(await draw()).find((node) => node.props.key?.startsWith(prefix));
  await (await item('file_a:t:f:file:0')).props.onPress();
  await draw();
  revision = 2; timers[0](); await new Promise((r) => setImmediate(r));
  assert.match(JSON.stringify(await draw()), /old\.js/);
  assert.match(JSON.stringify(await draw()), /完整输出/);
  assert.match(JSON.stringify(await draw()), /新活动/);
  await (await item('file_a:t:f:file:0')).props.onPress();
  timers[0](); await new Promise((r) => setImmediate(r));
  assert.ok(JSON.stringify(await draw()).includes('新活动'));
  closeUI();
});

test('native activity types render readable tool, search, plan and lifecycle details', async () => {
  const hooks = [], on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entry = (id, type, data) => ({ id, type, turn_id: 't', data });
  const entries = [entry('a', 'mcpToolCall', { server: 'fastctx', tool: 'inspect_local_file' }), entry('a2', 'mcpToolCall', { server: 'fastctx', tool: 'inspect_local_file' }), entry('b', 'mcpToolCall', { server: 'fastctx', tool: 'grep' }), entry('search', 'webSearch', { action: { query: '中文查询', url: 'https://example.com/' } }), entry('plan', 'plan', { text: '检查结果' }), entry('compact', 'contextCompaction', { stage: 'started' }), entry('child', 'subAgentActivity', { name: '研究', kind: 'completed', agentThreadId: 'child' }), entry('spawn', 'collabAgentToolCall', { name: '撰写', tool: 'spawnAgent', stage: 'completed', agents: [{ id: 'child2', status: 'running' }] }), entry('future', 'futureItem', { opaque: 4 })];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = await draw();
  assert.ok(JSON.stringify(tree).includes('正在压缩上下文 · 可能需要几分钟'));
  assert.ok(JSON.stringify(tree).includes('研究 已完成'));
  assert.ok(JSON.stringify(tree).includes('撰写开始工作'));
  assert.ok(nodes(tree).some((node) => node.type === 'Markdown' && node.props.text.includes('检查结果')));
  await nodes(tree).find((node) => node.props.key?.startsWith('group_')).props.onPress();
  tree = await draw(); assert.ok(JSON.stringify(tree).includes('读取本地文件')); assert.ok(JSON.stringify(tree).includes('搜索文件内容'));
  await nodes(tree).find((node) => node.props.key?.startsWith('item_a:t:search')).props.onPress();
  tree = await draw(); assert.ok(JSON.stringify(tree).includes('中文查询')); assert.ok(JSON.stringify(tree).includes('https://example.com/'));
  await nodes(tree).find((node) => node.props.key?.startsWith('item_a:t:future')).props.onPress();
  assert.ok(JSON.stringify(await draw()).includes('opaque'));
  closeUI();
});

test('expanded local PNG uses native image; other paths never load as files', async () => {
  const hooks = [], on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Image'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entries = [{ id: 'png', type: 'imageView', turn_id: 't', data: { path: 'C:\\images\\plot.png' } }, { id: 'web', type: 'imageView', turn_id: 't', data: { path: 'https://example.com/a.png' } }, { id: 'unc', type: 'imageView', turn_id: 't', data: { path: '//server/share/a.png' } }, { id: 'jpg', type: 'imageView', turn_id: 't', data: { path: '/tmp/a.jpg' } }];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.equal(nodes(await draw()).filter((node) => node.type === 'Image').length, 0);
  for (const id of ['png', 'web', 'unc', 'jpg']) await nodes(await draw()).find((node) => node.props.key?.startsWith(`item_a:t:${id}`)).props.onPress();
  const images = nodes(await draw()).filter((node) => node.type === 'Image');
  assert.equal(images.length, 1); assert.deepEqual(images[0].props.source, { file: 'C:\\images\\plot.png', format: 'png' });
  assert.ok(nodes(await draw()).some((node) => node.props.key?.startsWith('copy_a:t:jpg')));
  closeUI();
});

test('desktop tool expansion keeps the pane valid through output and raw-call disclosure', async (t) => {
  const hooks = [], on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Svg', 'Client'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entries = [
    { id: 'task', turn_id: 't', type: 'parentMessage', data: { text: '创建并核对文件' } },
    ...['run', 'inspect_local_file'].map(tool => ({ id: tool, turn_id: 't', type: 'mcpToolCall', deferred: true, data: { server: 'fastctx', tool, arguments: tool === 'run' ? { command: 'printf test' } : { file_path: 'C:/work/test.txt' } } })),
    { id: 'answer', turn_id: 't', type: 'agentMessage', data: { text: '已完成。' } },
  ];
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', name: 'terra-test', context_source: 'claude', status: 'completed', model: 'gpt-6.1-terra', reasoning_effort: 'high', permissions_mode: 'full-access', context_used_tokens: 7, context_limit_tokens: 100 }] };
    if (op === 'ui_revision') return { revision: 1, entries };
    if (op === 'ui_detail') return { text: `output: ${args.item_id}`, offset: 0, next_offset: null, format: 'source' };
    return { entries: [], next_cursor: null };
  });
  closeUI(); t.after(closeUI); registerUI(on); await openAgent($, 'a');
  const draw = async () => {
    const tree = await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows: 40 } } }, () => null);
    assertNativeDimensions(tree);
    assert.ok(nodes(tree).some(node => node.type === 'Input'), 'the composer remains mounted');
    assert.ok(nodes(tree).some(node => node.props.key === 'message_a:t:answer'), 'the answer remains in the conversation');
    return tree;
  };
  const click = async key => (nodes(await draw()).find(node => node.props.key === key).props.onPress());
  const groupKey = nodes(await draw()).find(node => node.props.key?.startsWith('group_')).props.key;
  assert.deepEqual(nodes(await draw()).find(node => node.props.key === 'codex_origin_a').props.children, ['继承 Claude']);
  assert.equal(nodes(await draw()).find(node => node.props.key === groupKey).props.label, '已使用 FastCtx 集成');
  assert.ok(nodes(await draw()).some(node => node.type === 'Svg' && node.props.key === `icon_chevron_${groupKey}`));
  await click(groupKey);
  for (const tool of ['run', 'inspect_local_file']) {
    await click(`item_a:t:${tool}`);
    assert.ok(nodes(await draw()).some(node => node.type === 'Code' && node.props.source === `output: ${tool}`));
    await click(`tool_raw_a:t:${tool}`);
    await draw();
  }
  await click(groupKey); await draw();
  await click(groupKey); await draw();
  const message = hooks.find(h => h.event === 'ui.message').fn;
  await message($, { element: `chevron_${groupKey}`, data: { action: 'toggle', expanded: false } }, () => { throw new Error('own disclosure'); });
  assert.ok(nodes(await draw()).some(node => node.props.key === 'item_a:t:run'), 'a stale arrow click does not reverse a new state');
  await message($, { element: `chevron_${groupKey}`, data: { action: 'toggle', expanded: true } }, () => { throw new Error('own disclosure'); });
  assert.ok(!nodes(await draw()).some(node => node.props.key === 'item_a:t:run'));
});

test('final response copy retrieves raw pages and ignores commentary and stale requests', async (t) => {
  const hooks = [], copied = [], calls = []; let deferred;
  const entries = [
    { id: 'comment', turn_id: 't', type: 'agentMessage', data: { text: 'thinking' }, message: { is_final: false } },
    { id: 'tool', turn_id: 't', type: 'commandExecution', data: { command: 'test' } },
    { id: 'final', turn_id: 't', type: 'agentMessage', data: { text: 'preview' }, message: { is_final: true, truncated: true } },
  ];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), copy: async value => { copied.push(value.text); return { isCopied: true }; }, invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }, { agent_id: 'b', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: args.target === 'a' ? entries : [] };
    if (op === 'ui_detail') { calls.push(args); if (deferred) return new Promise(resolve => { deferred.resolve = resolve; }); return args.offset ? { text: '\\[raw\\]', next_offset: null } : { text: '**full**\r\n', next_offset: 524288 }; }
    return { entries: [], next_cursor: null };
  });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = () => hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'terminal' }, () => null);
  let tree = nodes(await draw());
  assert.deepEqual(tree.filter(n => n.props.key?.startsWith('message_copy_')).map(n => n.props.key), ['message_copy_a:t:final']);
  await tree.find(n => n.props.key === 'message_copy_a:t:final').props.onPress();
  assert.deepEqual(copied, ['**full**\r\n\\[raw\\]']);
  assert.deepEqual(calls.map(c => [c.view, c.offset, c.bulk]), [['message', 0, true], ['message', 524288, true]]);
  deferred = {}; const pending = tree.find(n => n.props.key === 'message_copy_a:t:final').props.onPress();
  await new Promise(setImmediate); await openAgent($, 'b'); deferred.resolve({ text: 'stale', next_offset: null }); await pending;
  assert.equal(copied.length, 1);
});

test('copy reports stalled cursors without writing to clipboard', async (t) => {
  const hooks = [], copied = [];
  const entry = { id: 'final', turn_id: 't', type: 'agentMessage', data: { text: 'preview' }, message: { is_final: true, truncated: true } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), copy: async value => copied.push(value), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : op === 'ui_detail' ? { text: 'part', next_offset: 0 } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'terminal' }, () => null));
  (await draw()).find(n => n.props.key === 'message_copy_a:t:final').props.onPress();
  await new Promise(setImmediate);
  assert.equal(copied.length, 0);
  assert.match((await draw()).find(n => n.props.key === 'message_copy_error_a:t:final').props.children[0], /复制失败.*未推进/);
});

test('copy reports a rejected clipboard result', async (t) => {
  const hooks = [];
  const entry = { id: 'final', turn_id: 't', type: 'agentMessage', data: { text: 'answer' }, message: { is_final: true, truncated: false } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), copy: async () => ({ isCopied: false, reason: 'clipboard unavailable' }), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'terminal' }, () => null));
  await (await draw()).find(n => n.props.key === 'message_copy_a:t:final').props.onPress();
  assert.match((await draw()).find(n => n.props.key === 'message_copy_error_a:t:final').props.children[0], /复制失败.*clipboard unavailable/);
});

test('copy immediately preserves short raw text and stops an unending sequence', async (t) => {
  const hooks = [], copied = []; let reads = 0;
  const entries = [{ id: 'short', turn_id: 't', type: 'agentMessage', data: { text: '**raw**\r\n\\[x\\]' }, message: { is_final: true, truncated: false } }, { id: 'long', turn_id: 't', type: 'agentMessage', data: { text: 'preview' }, message: { is_final: true, truncated: true } }];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), copy: async value => { copied.push(value.text); return { isCopied: true }; }, invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_revision' ? { revision: 1, entries } : op === 'ui_detail' ? (reads++, { text: 'x', next_offset: args.offset + 1 }) : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'terminal' }, () => null));
  let tree = await draw(); await tree.find(n => n.props.key === 'message_copy_a:t:short').props.onPress();
  assert.deepEqual(copied, ['**raw**\r\n\\[x\\]']); assert.equal(reads, 0);
  assert.equal(tree.find(n => n.props.key === 'message_actions_a:t:short').props.justifyContent, 'flex-start');
  await tree.find(n => n.props.key === 'message_copy_a:t:long').props.onPress();
  tree = await draw(); assert.equal(reads, 1100); assert.equal(copied.length, 1);
  assert.match(tree.find(n => n.props.key === 'message_copy_error_a:t:long').props.children[0], /复制大小限制/);
});

test('communication cancels late reads and external files arrive in one request', async (t) => {
  const hooks = [], calls = []; let resolveDetail;
  const entry = { id: 'comm', turn_id: 't', type: 'collabToolCall', communication: { title: '发送', text: 'preview', truncated: true }, data: { tool: 'sendMessage' } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [entry] };
    if (op === 'ui_detail') { calls.push(args); return new Promise(resolve => { resolveDetail = resolve; }); }
    return { entries: [], next_cursor: null };
  });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'terminal' }, () => null));
  const click = async key => (await draw()).find(n => n.props.key === key).props.onPress();
  await click('item_a:t:comm');
  const pending = click('communication_detail_a:t:comm'); await new Promise(setImmediate);
  await click('communication_detail_a:t:comm'); resolveDetail({ text: 'stale', external: false }); await pending;
  assert.equal((await draw()).find(n => n.props.key === 'communication_a:t:comm').props.text, 'preview');
  const pending2 = click('communication_detail_a:t:comm'); await new Promise(setImmediate);
  resolveDetail({ text: 'bounded', external: true, file_url: 'file:///C:/full.md' }); await pending2;
  assert.ok((await draw()).some(n => n.props.key === 'communication_link_a:t:comm' && n.props.text.includes('file:///C:/full.md')));
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.expand && c.offset === 0 && !c.export));
});

test('expanding a tool paints existing output without waiting for scrolling or a cold detail read', async (t) => {
  const hooks = [], afters = [];
  let resolveDetail, detailCalls = 0;
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }), after: (_ms, fn) => { afters.push(fn); return { cancel() {} }; } } };
  const tool = { id: 'run', turn_id: 't', type: 'commandExecution', deferred: true, data: { command: 'test', aggregatedOutput: 'available output' } };
  connect($, async (_$, op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_revision') return { revision: 1, entries: [tool] };
    if (op === 'ui_detail') { detailCalls++; return new Promise(resolve => { resolveDetail = resolve; }); }
    return { entries: [], next_cursor: null };
  });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  let releaseScroll;
  $.ui.scroll = () => new Promise(resolve => { releaseScroll = resolve; });
  const draw = () => hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop' }, () => null);
  const button = () => draw().then(tree => nodes(tree).find(node => node.props.key === 'item_a:t:run'));
  let settled = false;
  (await button()).props.onPress().then(() => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, true, 'native click completes before slow scroll or read');
  $.ui.scroll = async () => ({}); releaseScroll?.({});
  assert.equal(detailCalls, 0, 'cold read starts after the click returns');
  assert.ok(nodes(await draw()).some(node => node.type === 'Code' && node.props.source === 'available output'));
  const fetching = afters.shift()();
  await new Promise(setImmediate);
  assert.equal(detailCalls, 1);
  resolveDetail({ text: 'full output', next_offset: null }); await fetching;
  assert.ok(nodes(await draw()).some(node => node.type === 'Code' && node.props.source === 'full output'));
  await (await button()).props.onPress(); await (await button()).props.onPress();
  assert.equal(detailCalls, 1, 'reopening uses the cached result');
  assert.equal(afters.length, 0);
});

test('merged lifecycle entries use recorded wait starts, short names and independent math presentation', async (t) => {
  const hooks = [];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Svg', 'Client'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  const entries = [
    { id: 'start', turn_id: 't', type: 'subAgentActivity', started_at_ms: 100, data: { kind: 'started', agentThreadId: 'child', agentPath: '/root/nested_file_edit', display_name: 'nested_file_edit' } },
    { id: 'end', turn_id: 't', type: 'subAgentActivity', started_at_ms: 300, data: { kind: 'completed', agentThreadId: 'child', agentPath: '/root/nested_file_edit', display_name: 'nested_file_edit' } },
    { id: 'wait', turn_id: 't', type: 'collabAgentToolCall', started_at_ms: 200, data: { tool: 'wait' } },
    { id: 'math', turn_id: 't', type: 'agentMessage', data: { text: '\\[\nE=mc^2\n\\]' } },
  ];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_revision' ? { revision: 1, entries } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = surface => hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface }, () => null);
  const tree = await draw('desktop'), all = nodes(tree);
  assert.deepEqual(all.filter(node => node.props.key?.startsWith('activity_group_')).map(node => node.props.key), ['activity_group_a:t:start', 'activity_group_a:t:wait', 'activity_group_a:t:end', 'activity_group_a:t:math']);
  assert.equal(all.find(node => node.props.key === 'activity_label_a:t:start').props.children[0], 'Nested file edit 开始工作');
  assert.equal(all.find(node => node.props.key === 'activity_label_a:t:wait').props.children[0], '等待子代理');
  assert.equal(all.find(node => node.props.key === 'agent_icon_a:t:start').props.source, all.find(node => node.props.key === 'agent_icon_a:t:end').props.source);
  assert.equal(all.find(node => node.props.key === 'wait_icon_a:t:wait').props.alt, '等待');
  assert.equal(all.find(node => node.props.key === 'message_a:t:math').props.text, '$$\nE=mc^2\n$$');
  assert.equal(nodes(await draw('terminal')).find(node => node.props.key === 'message_a:t:math').props.text, entries[3].data.text);
  assert.equal(entries[3].data.text, '\\[\nE=mc^2\n\\]', 'native history stays unchanged');
});

test('only adjacent same-type calls within a turn group and retain items', () => {
  const entries = [
    { id: '1', type: 'commandExecution', turn_id: 't' }, { id: '2', type: 'commandExecution', turn_id: 't' },
    { id: '3', type: 'agentMessage', turn_id: 't' }, { id: '4', type: 'commandExecution', turn_id: 't' },
    { id: '5', type: 'commandExecution', turn_id: 'u' },
  ];
  assert.deepEqual(groupEntries(entries).map((g) => g.items.map((i) => i.id)), [['1', '2'], ['3'], ['4'], ['5']]);
  const calls = ['grep', 'grep', 'glob'].map((tool, index) => ({ id: String(index), type: 'mcpToolCall', turn_id: 't', data: { server: 'fastctx', tool } }));
  assert.deepEqual(groupEntries(calls).map((g) => g.items.length), [3]);
});

test('late details from a previous selection are discarded', async () => {
  const hooks = [], deferred = {};
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const bridge = async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', name: 'A' }, { agent_id: 'b', name: 'B' }] };
    if (op === 'ui_history') return { entries: [{ id: args.target, turn_id: 't', type: 'commandExecution', deferred: true, data: { command: args.target } }] };
    if (op === 'ui_detail') return new Promise((resolve) => { deferred.resolve = resolve; });
    return { revision: 1, entries: [] };
  };
  closeUI(); connect($, bridge); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = await draw();
  tree = await draw(); const pending = nodes(tree).find((x) => x.props.key === 'item_a:t:a').props.onPress();
  await new Promise((r) => setImmediate(r));
  await openAgent($, 'b'); await new Promise((r) => setImmediate(r));
  deferred.resolve({ text: 'old response', next_offset: null }); await pending;
  tree = await draw(); assert.ok(!JSON.stringify(tree).includes('old response'));
});

test('large detail pages can be navigated in both directions', async () => {
  const hooks = [], offsets = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const bridge = async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', name: 'A' }] };
    if (op === 'ui_history') return { entries: [{ id: 'cmd', turn_id: 't', type: 'commandExecution', deferred: true, data: { command: 'run' } }] };
    if (op === 'ui_detail') { offsets.push(args.offset); return { text: `Page ${args.offset}`, next_offset: args.offset ? null : 16000 }; }
    return { revision: 1, entries: [] };
  };
  closeUI(); connect($, bridge); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  let tree = await draw();
  tree = await draw(); await nodes(tree).find((x) => x.props.key === 'item_a:t:cmd').props.onPress();
  tree = await draw(); await nodes(tree).find((x) => x.props.label === '更多输出').props.onPress();
  tree = await draw(); assert.ok(JSON.stringify(tree).includes('Page 16000'));
  await nodes(tree).find((x) => x.props.label === '上一页输出').props.onPress();
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
  let pane = await render('Pane')($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.equal(nodes(pane).find((node) => node.props.key === 'codex_navigation').type, 'Box');
  assert.ok(JSON.stringify(pane).includes('a very long name'));
  assert.ok(nodes(pane).some((c) => c.props.key?.includes('t:a')));
  await openAgent($, 'b');
  await new Promise((resolve) => setImmediate(resolve));
  pane = await render('Pane')($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.ok(nodes(pane).some((c) => c.props.key?.includes('t:b')));
  await hooks.find((h) => h.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, async (e) => e);
  assert.equal(timers[0].cancelled, true);
  const before = calls.length; await timers[0].fn(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls.length, before);
});

test('tool details separate protocol commands and output into wrapped source panels', async () => {
  const hooks = [], on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entries = [{ id: 'run', turn_id: 't', type: 'mcpToolCall', preview: 'Tool: fastctx/run Input: shortened preview [truncated]', data: { server: 'fastctx', tool: 'run', arguments: { command: 'printf "one\\ntwo"', cwd: 'C:/work', timeout_ms: 1000 }, result: { content: [{ type: 'text', text: 'one\ntwo\n<html>literal</html>' }], structuredContent: { exit_code: 0 } } } }];
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_detail' ? { text: 'full raw page\nnext line', next_offset: null } : { revision: 1, entries });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  await nodes(await draw()).find((node) => node.props.key?.startsWith('group_')).props.onPress();
  await nodes(await draw()).find((node) => node.props.key === 'item_a:t:run').props.onPress();
  let panels = nodes(await draw()).filter((node) => node.type === 'Code');
  assert.equal(panels.length, 1);
  assert.match(panels[0].props.source, /one\ntwo\n<html>literal<\/html>/);
  assert.match(panels[0].props.source, /"exit_code": 0/);
  await nodes(await draw()).find((node) => node.props.key === 'tool_raw_a:t:run').props.onPress();
  panels = nodes(await draw()).filter((node) => node.type === 'Code');
  assert.deepEqual(panels.slice(1).map((node) => node.props.source), ['printf "one\\ntwo"', 'C:/work', '{\n  "timeout_ms": 1000\n}']);
  assert.ok(panels.every((node) => node.props.format === 'source' && node.props.wrap === 'wrap'));
  assert.ok(!panels.some((node) => node.props.source.includes('shortened preview')));
  assert.equal(nodes(await draw()).filter((node) => node.props.key?.startsWith('codex_stop_')).length, 0);
  await nodes(await draw()).find((node) => node.props.key === 'detail_a:t:run').props.onPress();
  panels = nodes(await draw()).filter((node) => node.type === 'Code');
  assert.deepEqual(panels.map((node) => node.props.source), ['full raw page\nnext line', 'printf "one\\ntwo"', 'C:/work', '{\n  "timeout_ms": 1000\n}']);
  closeUI();
});

test('unchanged completed polling and observations never refresh; changes target only the pane', async () => {
  const hooks = [], timers = [], writes = [], reads = [], scrolls = []; let globalRefresh = 0, revision = 1;
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { state: { get: async (ref) => { reads.push(ref); return { value: 0, version: 0 }; }, set: async (ref, value) => { writes.push({ ref, value }); return { isSet: true }; } }, ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() { globalRefresh++; }, open: async () => ({ isPlaced: true }), scroll: async (args) => { scrolls.push(args); return {}; } }, clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } } };
  const agents = [{ agent_id: 'a', status: 'completed', model: 'model' }];
  const uiAgent = { ...agents[0], permissions_mode: 'full-access', context_used_tokens: 500, context_limit_tokens: 1000 };
  connect($, async (_$, op) => op === 'ui_list' ? { agents } : { revision, entries: revision > 1 ? [{ id: 'new', turn_id: 't', type: 'agentMessage', data: { text: 'new activity' } }] : [], agent: uiAgent });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const render = hooks.find((h) => h.event === 'ui.render');
  assert.deepEqual(render.matcher, { component: 'Pane', requestId: 'codex_subagent_activity' });
  const draw = () => render.fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const first = await draw(), second = await draw();
  assert.deepEqual(reads[0], { plugin: 'codex-subagents', key: 'paneRevision' });
  assert.equal(nodes(first).find((node) => node.type === 'Input').props.onInput, nodes(second).find((node) => node.type === 'Input').props.onInput);
  writes.length = 0;
  for (let i = 0; i < 12; i++) { timers[0](); observeUI($, { agents }); await new Promise((r) => setImmediate(r)); }
  assert.equal(writes.length, 0); assert.equal(globalRefresh, 0);
  assert.match(JSON.stringify(await draw()), /◔ 50%/); assert.match(JSON.stringify(await draw()), /完全访问/);
  revision = 2; timers[0](); await new Promise((r) => setImmediate(r));
  assert.ok(writes.length > 0); assert.ok(writes.every(write => JSON.stringify(write.ref) === JSON.stringify(reads[0]))); assert.equal(globalRefresh, 0);
  await observeUI($, { agents: [{ ...agents[0], context_used_tokens: null }] });
  assert.ok(!JSON.stringify(await draw()).includes('◔ 50%'));
  closeUI();
});

test('clipboard attachments are read only by the explicit action and preserve useful failures', async () => {
  const hooks = []; let reads = 0, clipboard = { paths: ['C:/screenshots/capture.png'] };
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : { revision: 1, entries: [] });
  const run = $.process.run;
  $.process.run = async (argv, options) => argv.includes('--clipboard') ? (reads++, { stdout: JSON.stringify(clipboard), exitCode: 0 }) : run(argv, options);
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const paste = async () => nodes(await draw()).find((node) => node.props.key === 'codex_paste_a').props.onPress();
  assert.equal(reads, 0);
  await paste(); assert.equal(reads, 1); assert.match(JSON.stringify(await draw()), /capture\.png/);
  clipboard = { paths: [], error: 'Permission denied' }; await paste();
  assert.match(JSON.stringify(await draw()), /Permission denied/);
  clipboard = { paths: [], unsupported: true }; await paste();
  assert.match(JSON.stringify(await draw()), /当前平台不支持/);
  clipboard = { paths: [] }; await paste();
  assert.match(JSON.stringify(await draw()), /没有可添加的截图或文件/);
  assert.match(JSON.stringify(await draw()), /capture\.png/);
  closeUI();
});

test('conversation keeps incoming line breaks in right bubbles and composer refreshes only at empty boundaries', async () => {
  const hooks = [], writes = [], requests = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { state: { get: async () => ({ value: 0, version: 0 }), set: async (ref, value) => { writes.push({ ref, value }); return { isSet: true }; } }, ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])), invalidate() { throw new Error('global invalidation'); }, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entries = [{ id: 'parent', type: 'parentMessage', turn_id: 't', data: { text: 'line one\r\nline two' } }, { id: 'direct', type: 'directUserMessage', turn_id: 't', data: { text: 'user\nmessage' } }, { id: 'reply', type: 'agentMessage', turn_id: 't', data: { text: '**reply**' } }, { id: 'tool', type: 'mcpToolCall', turn_id: 't', data: { server: 'fastctx', tool: 'run', arguments: { command: 'test' }, result: { content: [{ type: 'text', text: 'complete short output' }] } } }];
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision: 1, entries };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    requests.push({ op, args });
    return op === 'ui_interrupt' ? { agent_id: 'a', user_control_status: 'stopped', user_paused: true } : { agent_id: 'a', status: 'steered' };
  });
  closeUI(); registerUI(on); await openAgent($, 'a'); await new Promise((r) => setImmediate(r));
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const input = async () => nodes(await draw()).find((node) => node.type === 'Input');
  let tree = await draw();
  for (const id of ['parent', 'direct']) {
    const row = nodes(tree).find((node) => node.props.key === `message_container_a:t:${id}`);
    assert.equal(row.props.justifyContent, 'flex-end');
    assert.equal(row.props.children[0].props.width, '85%');
    const bubble = nodes(row).find(node => node.props.key === `message_content_a:t:${id}`);
    assert.equal(bubble.props.width, undefined, 'short messages size to content');
    assert.equal(bubble.props.alignSelf, 'flex-end');
    assert.equal(nodes(row).find((node) => node.props.key === `message_a:t:${id}`).type, 'Markdown');
  }
  assert.equal(nodes(tree).find((node) => node.props.key === 'message_a:t:parent').props.text, 'line one\nline two');
  assert.equal(nodes(tree).find((node) => node.props.key === 'message_container_a:t:reply').props.justifyContent, 'flex-start');
  assert.equal(nodes(tree).find((node) => node.props.key === 'message_a:t:reply').type, 'Markdown');
  assert.deepEqual(nodes(tree).filter((node) => node.props.key?.startsWith('author_')).map(node => node.props.children[0]), ['Claude', 'User']);
  assert.equal(nodes(tree).find((node) => node.props.key === 'codex_back'), undefined);
  assert.equal(nodes(await draw()).find((node) => node.props.key === 'codex_action_a').props.label, '■');
  writes.length = 0;
  (await input()).props.onInput('a'); assert.equal(writes.length, 1);
  (await input()).props.onInput('ab'); assert.equal(writes.length, 1);
  assert.equal(nodes(await draw()).find((node) => node.props.key === 'codex_action_a').props.label, '↑');
  await (await input()).props.onSubmit('ab');
  assert.equal(requests[0].op, 'ui_send'); assert.equal(requests[0].args.message, 'ab');
  writes.length = 0;
  (await input()).props.onInput('x'); (await input()).props.onInput('');
  assert.equal(writes.length, 2);
  await (await input()).props.onSubmit(''); assert.equal(requests.length, 1, 'empty Enter never stops the agent');
  await nodes(await draw()).find((node) => node.props.key === 'codex_action_a').props.onPress(); assert.equal(requests[1].op, 'ui_interrupt');
  assert.equal(nodes(await draw()).some((node) => node.props.key?.startsWith('codex_stop_') && node.type === 'Button'), false);
  await nodes(await draw()).find((node) => node.props.key?.startsWith('group_')).props.onPress();
  await nodes(await draw()).find((node) => node.props.key === 'item_a:t:tool').props.onPress();
  tree = await draw();
  assert.equal(nodes(tree).find((node) => node.props.key === 'detail_a:t:tool'), undefined);
  assert.deepEqual(nodes(tree).filter((node) => node.type === 'Code').map((node) => node.props.source), ['complete short output']);
  closeUI();
});

test('cold history merges with live deltas, updates duplicates and retains more than 200 messages', async () => {
  const hooks = [], timers = []; let revision = 1, recent = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } } };
  const entry = (id, text = id) => ({ id, type: 'agentMessage', turn_id: 't', data: { text } });
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : op === 'ui_history' ? { entries: [entry('cold-one'), entry('cold-two')], next_cursor: null } : { revision, entries: recent });
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  assert.equal(nodes(await draw()).find((node) => node.props.key === 'codex_older'), undefined);
  recent = [entry('new-one')]; revision++; await timers[0]();
  let messages = nodes(await draw()).filter((node) => node.type === 'Markdown').map((node) => node.props.text);
  assert.deepEqual(messages, ['cold-one', 'cold-two', 'new-one']);
  recent = [entry('new-one', 'new-one updated')]; revision++; await timers[0]();
  messages = nodes(await draw()).filter((node) => node.type === 'Markdown').map((node) => node.props.text);
  assert.deepEqual(messages, ['cold-one', 'cold-two', 'new-one updated']);
  recent = Array.from({ length: 260 }, (_, i) => entry(`new-${i + 2}`)); revision++; await timers[0]();
  messages = nodes(await draw()).filter((node) => node.type === 'Markdown').map((node) => node.props.text);
  assert.equal(messages.length, 120); assert.equal(messages.at(-1), 'new-261');
  assert.equal(nodes(await draw()).find((node) => node.props.key === 'codex_older'), undefined);
  closeUI();
});

test('failed discovery has a recovery action without an untargeted composer and read failures keep visible messages', async () => {
  const hooks = [], timers = [], afters = [], panes = []; let discoveryFails = true, historyFails = true, pollFails = false;

  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async (options) => { panes.push(options); return { isPlaced: true }; }, scroll: async () => ({}) }, clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } } };
  const entry = (id) => ({ id, type: 'agentMessage', turn_id: 't', data: { text: id } });
  connect($, async (_$, op) => {
    if (op === 'ui_list') return discoveryFails ? { error: { message: 'helper version mismatch' } } : { agents: [{ agent_id: 'a', name: 'Saved agent', status: 'completed' }] };
    if (op === 'ui_revision') return pollFails ? { error: { message: 'broker offline' } } : { revision: 1, entries: [entry('live reply')] };
    return historyFails ? { error: { message: 'saved history unavailable' } } : { entries: [entry('saved reply')], next_cursor: { turns_cursor: 'older' } };
  });
  $.clock.after = (_ms, fn) => { afters.push(fn); return { cancel() {} }; };
  closeUI(); const host = nativeHooks(hooks, $); registerUI(host.on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop' }, () => null);
  let tree = await draw(); assert.equal(panes[0].title, 'Codex'); assert.match(JSON.stringify(tree), /helper version mismatch/);
  assert.equal(nodes(tree).find((node) => node.type === 'Input'), undefined); assert.equal(nodes(tree).find((node) => node.props.key === 'codex_older'), undefined);
  discoveryFails = false; await nodes(tree).find((node) => node.props.key === 'codex_retry').props.onPress();
  tree = await draw(); assert.match(JSON.stringify(tree), /saved history unavailable/); assert.match(JSON.stringify(tree), /live reply/);
  assert.equal(nodes(tree).find((node) => node.props.key === 'codex_older'), undefined);
  const composer = nodes(tree).find((node) => node.props.key === 'codex_composer_a');
  assert.equal(composer.props.borderStyle, undefined); assert.equal(composer.props.gap, 0);
  historyFails = false; await nodes(tree).find((node) => node.props.key === 'codex_retry_conversation').props.onPress();
  tree = await draw(); assert.match(JSON.stringify(tree), /saved reply/); assert.match(JSON.stringify(tree), /live reply/);
  historyFails = true; while (afters.length) await afters.shift()();
  await host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: -1, offset: 0, contentRows: 100, bodyRows: 10 });
  while (afters.length) await afters.shift()();
  tree = await draw(); assert.match(JSON.stringify(tree), /saved history unavailable/); assert.match(JSON.stringify(tree), /saved reply/);
  pollFails = true; await timers[0](); tree = await draw(); assert.match(JSON.stringify(tree), /broker offline/); assert.match(JSON.stringify(tree), /live reply/);
  closeUI();
});

test('deferred tools load output automatically, retain raw inputs and expose a readable retry', async () => {
  const hooks = [], details = []; let fails = true;
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const entry = { id: 'tool', turn_id: 't', type: 'mcpToolCall', deferred: true, data: { server: 'fastctx', tool: 'run', arguments: { command: 'read-file' }, result: { content: null, structuredContent: null, isError: null } } };
  connect($, async (_$, op, args) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
    if (op === 'ui_detail' && args.view === 'media') return { images: [], next_offset: null };
    if (op === 'ui_detail') { details.push(args); return fails ? { error: { message: 'connection lost' } } : { text: `output page ${args.offset}`, next_offset: args.offset ? null : 16000, format: 'source' }; }
    return { revision: 1, entries: [entry], next_cursor: null };
  });
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  await nodes(await draw()).find((node) => node.props.key?.startsWith('group_')).props.onPress();
  await nodes(await draw()).find((node) => node.props.key === 'item_a:t:tool').props.onPress();
  await new Promise(setImmediate);
  assert.equal(details.length, 1); assert.equal(details[0].view, 'output');
  let tree = await draw(); assert.match(JSON.stringify(tree), /connection lost/); assert.equal(nodes(tree).filter((node) => node.type === 'Code').length, 0);
  await nodes(tree).find((node) => node.props.key === 'tool_raw_a:t:tool').props.onPress();
  assert.deepEqual(nodes(await draw()).filter((node) => node.type === 'Code').map((node) => node.props.source), ['read-file']);
  fails = false; await nodes(await draw()).find((node) => node.props.label === '重试').props.onPress();
  tree = await draw(); assert.deepEqual(nodes(tree).filter((node) => node.type === 'Code').map((node) => node.props.source), ['output page 0', 'read-file']);
  await nodes(tree).find((node) => node.props.label === '更多输出').props.onPress();
  assert.deepEqual(details.map((args) => args.offset), [0, 0, 16000]);
  assert.ok(details.every((args) => args.view === 'output'));
  closeUI();
});

test('attachment chips shorten UUID images and long names while preserving full names and send paths', async () => {
  const hooks = [], sends = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
  const paths = ['C:/tmp/codex-clipboard-12345678-1234-1234-1234-123456789abc.png', 'C:/docs/这是一个很长的中文文件名称用于布局检查和后缀保留.docx'];
  connect($, async (_$, op, args) => { if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] }; if (op === 'ui_send') { sends.push(args); return { agent_id: 'a', status: 'steered' }; } return { revision: 1, entries: [], next_cursor: null }; });
  const run = $.process.run;
  $.process.run = async (argv, options) => argv.includes('--clipboard') ? { stdout: JSON.stringify({ paths }), exitCode: 0 } : run(argv, options);
  closeUI(); registerUI(on); await openAgent($, 'a');
  const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  await nodes(await draw()).find((node) => node.props.key === 'codex_paste_a').props.onPress();
  const tree = await draw(), chips = nodes(tree).filter((node) => node.type === 'Button' && node.props.key?.startsWith('attachment_'));
  assert.equal(chips[0].props.label, '图片 1.png ×'); assert.match(chips[1].props.label, /…\.docx ×$/);
  assert.ok(chips[1].props.label.length < paths[1].split('/').at(-1).length);
  assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children.includes(paths[1].split('/').at(-1))));
  assert.equal(nodes(tree).find((node) => node.props.key === 'codex_attachments_a').props.flexWrap, 'wrap');
  await nodes(tree).find((node) => node.type === 'Input').props.onSubmit('');
  assert.deepEqual(sends[0].attachments, paths.map((path) => ({ path })));
  closeUI();
});

test('independent deferred tool details retain both results in either completion order and reuse cached pages', async () => {
  for (const order of [['run', 'inspect'], ['inspect', 'run']]) {
    const hooks = [], requests = [], pending = new Map();
    const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
    const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every() { return { cancel() {} }; } } };
    const entries = ['run', 'inspect'].map((id) => ({ id, turn_id: 't', type: 'mcpToolCall', deferred: true, data: { server: 'fastctx', tool: id === 'run' ? 'run' : 'inspect_local_file', arguments: id === 'run' ? { command: 'test' } : { file_path: '/tmp/result.txt' } } }));
    connect($, async (_$, op, args) => {
      if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'completed' }] };
      if (op === 'ui_detail' && args.view === 'media') return { images: [], next_offset: null };
      if (op === 'ui_detail') { requests.push(args); return new Promise((resolve) => pending.set(args.item_id, resolve)); }
      return { revision: 1, entries, next_cursor: null };
    });
    closeUI(); registerUI(on); await openAgent($, 'a');
    const draw = () => hooks.find((h) => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
    const press = async (key) => nodes(await draw()).find((node) => node.props.key === key).props.onPress();
    await nodes(await draw()).find((node) => node.props.key?.startsWith('group_')).props.onPress();
    const first = press('item_a:t:run'), second = press('item_a:t:inspect');
    await Promise.all([first, second]);
    await new Promise((r) => setImmediate(r));
    assert.equal(requests.length, 2);
    pending.get(order[0])({ text: `${order[0]} output`, next_offset: null, format: 'source' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(nodes(await draw()).filter((node) => node.type === 'Code').map((node) => node.props.source), [`${order[0]} output`]);
    pending.get(order[1])({ text: `${order[1]} output`, next_offset: null, format: 'source' });
    await Promise.all([first, second]);
    assert.deepEqual(nodes(await draw()).filter((node) => node.type === 'Code').map((node) => node.props.source), ['run output', 'inspect output']);
    for (const id of ['run', 'inspect']) { await press(`item_a:t:${id}`); await press(`item_a:t:${id}`); }
    assert.equal(requests.length, 2);
    assert.deepEqual(nodes(await draw()).filter((node) => node.type === 'Code').map((node) => node.props.source), ['run output', 'inspect output']);
    closeUI();
  }
});

test('tool images load on expansion and attachment PNGs have compact previews', async (t) => {
  const hooks = [], calls = [], path = 'C:/tmp/screenshot.png';
  const entry = { id: 'image', turn_id: 't', type: 'mcpToolCall', media: { count: 1, has_images: true }, data: { tool: 'image', result: { content: [{ type: 'image', data: 'secret', mimeType: 'image/png' }] } } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Image'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => { if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] }; if (op === 'ui_revision') return { revision: 1, entries: [entry] }; if (op === 'ui_detail') { calls.push(args); return { images: [{ path, previewable: true, index: 0 }], next_offset: null }; } return { entries: [], next_cursor: null }; });
  const run = $.process.run; $.process.run = async (argv, options) => argv.includes('--clipboard') ? { stdout: JSON.stringify({ paths: [path] }), exitCode: 0 } : run(argv, options);
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  assert.equal(calls.length, 0); await (await draw()).find(n => n.props.key === 'item_a:t:image').props.onPress(); await new Promise(setImmediate);
  let tree = await draw(); assert.equal(calls[0].view, 'media'); assert.ok(tree.some(n => n.type === 'Image' && n.props.source.file === path)); assert.ok(!JSON.stringify(tree).includes('secret'));
  await (await draw()).find(n => n.props.key === 'item_a:t:image').props.onPress(); await (await draw()).find(n => n.props.key === 'item_a:t:image').props.onPress(); assert.equal(calls.length, 1);
  await (await draw()).find(n => n.props.key === 'codex_paste_a').props.onPress(); tree = await draw(); assert.ok(tree.some(n => n.props.key === 'attachment_image_a_0' && n.props.columns === 12));
});

test('failed image read offers retry without exposing image data', async (t) => {
  const hooks = []; let fail = true;
  const entry = { id: 'imagefail', turn_id: 't', type: 'dynamicToolCall', media: { count: 1, has_images: true }, data: { tool: 'image', result: { content: [{ type: 'image', data: 'secret', mimeType: 'image/png' }] } } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Image'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : op === 'ui_detail' ? (fail ? { error: { message: 'offline' } } : { images: [{ path: 'C:/tmp/a.png', previewable: true, index: 0 }], next_offset: null }) : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  await (await draw()).find(n => n.props.key === 'item_a:t:imagefail').props.onPress(); await new Promise(setImmediate);
  let tree = await draw(); assert.ok(tree.some(n => n.props.label === '重试读取图片')); assert.ok(!tree.some(n => n.type === 'Code' && !n.props.source)); assert.ok(!JSON.stringify(tree).includes('secret'));
  fail = false; await tree.find(n => n.props.label === '重试读取图片').props.onPress(); tree = await draw(); assert.ok(tree.some(n => n.type === 'Image' && n.props.source.file === 'C:/tmp/a.png'));
});

test('body read errors retry and evicted expanded bodies can be loaded again', async (t) => {
  const hooks = [], calls = []; let fail = true;
  const entries = Array.from({ length: 17 }, (_, i) => ({ id: `m${i}`, turn_id: 't', type: 'agentMessage', preview: `preview${i}`, deferred: true }));
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => { if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] }; if (op === 'ui_revision') return { revision: 1, entries }; if (op === 'ui_detail') { calls.push(args.item_id); return fail ? { error: { message: 'offline' } } : { text: `full${args.item_id}`, format: 'markdown', external: false }; } return { entries: [], next_cursor: null }; });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  const click = async id => (await draw()).find(n => n.props.key === `item_a:t:${id}`).props.onPress();
  await click('m0'); assert.ok((await draw()).some(n => n.props.key === 'message_error_a:t:m0')); fail = false; await click('m0');
  for (let i = 1; i < 17; i++) await click(`m${i}`);
  assert.equal((await draw()).find(n => n.props.key === 'message_a:t:m0').props.text, 'preview0');
  await click('m0'); assert.equal((await draw()).find(n => n.props.key === 'message_a:t:m0').props.text, 'fullm0'); assert.equal(calls.filter(id => id === 'm0').length, 3);
});

test('communication renders Markdown and keeps raw details separately disclosed', async (t) => {
  const hooks = [], entry = { id: 'short', turn_id: 't', type: 'collabToolCall', communication: { title: '发送', text: '**正文**', truncated: false }, data: { tool: 'sendMessage', arguments: { message: 'raw argument' }, result: 'receipt', error: { message: 'offline' } } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  await (await draw()).find(n => n.props.key === 'item_a:t:short').props.onPress(); let tree = await draw();
  assert.ok(tree.some(n => n.type === 'Markdown' && n.props.text === '**正文**')); assert.ok(tree.some(n => n.props.key === 'communication_failure_a:t:short')); assert.ok(!tree.some(n => n.props.key === 'communication_detail_a:t:short')); assert.ok(!tree.some(n => n.type === 'Code'));
  await tree.find(n => n.props.key === 'tool_raw_a:t:short').props.onPress(); tree = await draw(); assert.ok(tree.some(n => n.type === 'Code' && n.props.source.includes('raw argument')));
});

test('tool gallery wraps bounded images without duplication or filtering literal output', async (t) => {
  const hooks = [], entries = [
    { id: 'view', turn_id: 't', type: 'imageView', media: { count: 2, has_images: true }, data: { path: 'C:/tmp/a.png' } },
    { id: 'text', turn_id: 't', type: 'mcpToolCall', media: { count: 1, has_images: true }, data: { tool: 'read', result: '[image: valid omitted from text]' } },
  ];
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Image'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : op === 'ui_revision' ? { revision: 1, entries } : op === 'ui_detail' ? { images: [{ path: 'C:/tmp/a.png', previewable: true, index: 0, width: 100, height: 100 }, { path: 'C:/tmp/b.png', previewable: true, index: 1, width: 100, height: 400 }], next_offset: null } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', props: { bodyColumns: 16 } }, () => null));
  await (await draw()).find(n => n.props.key === 'item_a:t:view').props.onPress(); await new Promise(setImmediate); let tree = await draw();
  const gallery = tree.find(n => n.props.key === 'tool_media_gallery_a:t:view'); assert.equal(gallery.props.flexDirection, 'row'); assert.equal(gallery.props.flexWrap, 'wrap');
  const images = tree.filter(n => n.type === 'Image'); assert.equal(images.length, 2); assert.ok(images.every(n => n.props.columns <= 12 && n.props.rows <= 10)); assert.ok(images[1].props.columns < images[0].props.columns);
  await (await draw()).find(n => n.props.key === 'item_a:t:text').props.onPress(); await new Promise(setImmediate); tree = await draw(); assert.ok(tree.some(n => n.type === 'Code' && n.props.source === '[image: valid omitted from text]'));
});

test('image preview routes the rendered image, restores the tool, and rejects stale agent events', async (t) => {
  const hooks = [], scrolls = [], restored = []; let painted = [], draw; const entry = { id: 'img', turn_id: 't', type: 'imageView', media: { count: 1, has_images: true }, data: { path: 'C:/tmp/original.jpg' } };
  const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXsAAAAASUVORK5CYII=', preview = thumbnail;
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Image', 'Client'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async args => { scrolls.push(args); if (args.to?.key?.startsWith('codex_history_')) { await draw(); const event = await host.dispatch('ui.scroll', { origin: { kind: 'plugin' }, offset: 0, by: 0, contentRows: 100, bodyRows: 20 }); restored.push(event.offset); } return {}; } }, clock: { every: () => ({ cancel() {} }), after: (_ms, fn) => { setImmediate(fn); return { cancel() {} }; } } };
  connect($, async (_$, op, args) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }, { agent_id: 'b' }] } : op === 'ui_revision' ? { revision: 1, entries: args.target === 'a' ? [entry] : [] } : op === 'ui_detail' ? { images: [{ index: 0, path: 'C:/tmp/preview.png', previewable: true, width: 400, height: 200, desktop_thumbnail: thumbnail, desktop_preview: preview, file_url: 'file:///C:/tmp/original.jpg' }], next_offset: null } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); const host = nativeHooks(hooks, $); registerUI(host.on); await openAgent($, 'a');
  draw = async () => painted = nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { bodyColumns: 50, scroll: { bodyRows: 20 } } }, () => null));
  const message = hooks.find(h => h.event === 'ui.message').fn;
  await (await draw()).find(n => n.props.key === 'item_a:t:img').props.onPress(); await new Promise(setImmediate);
  let tree = await draw(); const action = tree.find(n => n.type === 'Client' && n.props.module === './image-control.js'); assert.ok(action); assert.equal(JSON.stringify(action.props).includes('C:/'), false);
  assert.ok(tree.some(n => n.type === 'Markdown' && n.props.text === `![图片](${thumbnail})`)); assert.ok(!tree.some(n => n.type === 'Image'));
  await host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: -1, offset: 37, contentRows: 100, bodyRows: 20 });
  await message($, { element: action.props.key, data: { action: 'preview', path: 'C:/evil.png' } }, () => ({})); tree = await draw();
  const image = tree.find(n => n.props.key === 'codex_image_preview_image'); assert.equal(image.type, 'Markdown'); assert.equal(image.props.text, `![图片](${preview})`); assert.ok(!tree.some(n => n.type === 'Image')); assert.ok(tree.some(n => n.props.key === 'codex_image_preview_original' && n.props.text.includes('original.jpg')));
  await host.dispatch('ui.scroll', { origin: { kind: 'person' }, by: 1, offset: 4, contentRows: 20, bodyRows: 10 });
  assert.equal(tree.find(n => n.props.key === 'codex_image_preview_close').props.label, '×');
  const beforeClose = scrolls.length;
  await host.dispatch('ui.press', { element: 'codex_image_preview_close' }); tree = await draw(); assert.ok(tree.some(n => n.props.key === 'tool_media_gallery_a:t:img')); assert.deepEqual(restored, [37]); assert.ok(!scrolls.slice(beforeClose).some(s => s.to?.key === 'item_a:t:img'));
  await openAgent($, 'b'); await message($, { element: action.props.key, data: { action: 'preview' } }, () => ({})); assert.ok(!(await draw()).some(n => n.props.key === 'codex_image_preview_image'));
});

test('image click region posts only for an in-bounds press or unmodified keyboard activation', async () => {
  const { default: imageControl } = await import('../hooks/image-control.js'); let pointer, keyboard; const posted = [];
  const surface = { columns: 10, rows: 5, state: {}, elements: { Box: props => ({ type: 'Box', props }) }, onPointer: fn => { pointer = fn; }, onKey: fn => { keyboard = fn; }, setState(value) { this.state = value; }, post(value) { posted.push(value); } };
  imageControl({ rows: 5 }, surface);
  pointer({ type: 'down', button: 'left', x: 1, y: 1 }); pointer({ type: 'up', button: 'left', x: 11, y: 1 }); assert.equal(posted.length, 0);
  pointer({ type: 'down', button: 'left', x: 1, y: 1 }); pointer({ type: 'move', button: 'left', x: 4, y: 1 }); pointer({ type: 'up', button: 'left', x: 1, y: 1 }); assert.equal(posted.length, 0);
  pointer({ type: 'down', button: 'left', x: 1, y: 1 }); pointer({ type: 'up', button: 'left', x: 1, y: 1 }); keyboard({ key: 'return' }); keyboard({ key: 'return', ctrl: true });
  assert.deepEqual(posted, [{ action: 'preview' }, { action: 'preview' }]);
});

test('complete text-only tool output does not request media', async (t) => {
  const hooks = [], calls = [], entry = { id: 'textonly', turn_id: 't', type: 'mcpToolCall', data: { tool: 'read', result: 'ordinary output' } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => { if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] }; if (op === 'ui_revision') return { revision: 1, entries: [entry] }; if (op === 'ui_detail') calls.push(args); return { entries: [], next_cursor: null }; });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  await (await draw()).find(n => n.props.key === 'item_a:t:textonly').props.onPress(); await new Promise(setImmediate);
  assert.ok((await draw()).some(n => n.type === 'Code' && n.props.source === 'ordinary output')); assert.deepEqual(calls, []);
});

test('media traversal limit notice remains visible when no images were found', async (t) => {
  const hooks = [], entry = { id: 'limited', turn_id: 't', type: 'mcpToolCall', media: { count: 0, has_images: false, omitted: true }, data: { tool: 'read' } };
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }), after: (_ms, fn) => fn() } };
  connect($, async (_$, op, args) => op === 'ui_list' ? { agents: [{ agent_id: 'a' }] } : op === 'ui_revision' ? { revision: 1, entries: [entry] } : op === 'ui_detail' ? args.view === 'media' ? { images: [], next_offset: null, omitted: true, notice: 'More media was not scanned.' } : { text: 'output', next_offset: null } : { entries: [], next_cursor: null });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null));
  await (await draw()).find(n => n.props.key === 'item_a:t:limited').props.onPress(); await new Promise(setImmediate);
  assert.ok((await draw()).some(n => n.props.key === 'tool_media_scan_notice_a:t:limited' && n.props.children[0] === 'More media was not scanned.'));
});

test('file changes present native kinds, source additions, moves and paged diff rows', async (t) => {
  const hooks = [], copies = [], requests = [];
  const changes = [
    { path: 'C:/p/new.md', kind: 'add', content: `# List
- one
- two
` },
    { path: 'C:/p/old.txt', kind: 'delete', content: `gone
` },
    { path: 'C:/p/oldname.txt', kind: { type: 'update', move_path: 'C:/p/newname.txt' }, unified_diff: `@@ -1 +1 @@
-a
+b
` },
    { path: 'C:/p/large.txt', kind: 'add', content: Array.from({ length: 250 }, (_, i) => `line ${i}
`).join('') },
    { path: 'C:/p/unknown.txt', diff: 'opaque content' },
  ];
  const entries = changes.map((change, i) => ({ id: `file${i}`, turn_id: 't', type: 'fileChange', ...(i === 3 ? { deferred: true } : {}), data: { changes: [change] } }));
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map(type => [type, props => ({ type, props })])), copy: async value => { copies.push(value.text); return { isCopied: true }; }, invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  connect($, async (_$, op, args) => { if (op === 'ui_list') return { agents: [{ agent_id: 'a' }] }; if (op === 'ui_revision') return { revision: 1, entries }; if (op === 'ui_detail') { requests.push(args); return fileChangePage(changes[3], args.offset); } return { entries: [], next_cursor: null }; });
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop' }, () => null));
  const click = async key => (await draw()).find(n => n.props.key === key).props.onPress();
  let tree = await draw(); assert.equal(tree.find(n => n.props.key === 'file_a:t:file0:file:0').props.label.replace(/ ›$/, ''), '已创建 new.md +3 -0'); assert.equal(tree.find(n => n.props.key === 'file_a:t:file1:file:0').props.label.replace(/ ›$/, ''), '已删除 old.txt +0 -1'); assert.equal(tree.find(n => n.props.key === 'file_a:t:file2:file:0').props.label.replace(/ ›$/, ''), '已编辑 oldname.txt → newname.txt +1 -1'); assert.equal(tree.find(n => n.props.key === 'file_a:t:file4:file:0').props.label.replace(/ ›$/, ''), '已更改 unknown.txt');
  await click('file_a:t:file0:file:0'); tree = await draw(); const added = tree.filter(n => n.type === 'Box' && n.props.backgroundColor?.includes('46,160,67')); assert.equal(added.length, 3); assert.ok(!tree.some(n => n.type === 'Box' && n.props.backgroundColor?.includes('248,81,73')));
  await click('file_a:t:file1:file:0'); tree = await draw(); assert.ok(tree.some(n => n.type === 'Box' && n.props.backgroundColor?.includes('248,81,73')));
  await click('file_a:t:file4:file:0'); assert.ok((await draw()).some(n => n.props.key === 'file_code_a:t:file4:file:0' && n.props.format === 'source'));
  await click('file_a:t:file3:file:0'); await new Promise(setImmediate); tree = await draw(); assert.ok(tree.some(n => n.props.key === 'file_diff_a:t:file3:file:0')); assert.ok(tree.some(n => n.props.label === '复制当前页差异'));
  await tree.find(n => n.props.key === 'diff_copy_a:t:file3:file:0').props.onPress(); assert.equal(copies[0], fileChangePage(changes[3], 0).text);
  await click('file_detail_a:t:file3:file:0'); tree = await draw(); assert.ok(tree.some(n => n.props.key === 'file_diff_a:t:file3:file:0')); assert.ok(tree.some(n => n.props.key === 'file_prev_a:t:file3:file:0'));
  await click('file_prev_a:t:file3:file:0'); assert.equal(requests.at(-1).offset, 0);
});

test('closed observation never redraws and starting agents do not read saved history', async () => {
  const hooks = [], calls = []; let invalidations = 0;
  const $ = { ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), invalidate() { invalidations++; }, open: async () => ({ isPlaced: true }), scroll: async () => ({}) }, clock: { every: () => ({ cancel() {} }) } };
  const agents = [{ agent_id: 'new', status: 'starting' }];
  connect($, async (_$, op) => { calls.push(op); return op === 'ui_list' ? { agents } : op === 'ui_revision' ? { revision: 1, entries: [] } : { entries: [], next_cursor: null }; });
  closeUI(); registerUI((...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) }));
  await openAgent($, 'new'); assert.ok(!calls.includes('ui_history'));
  await hooks.find(h => h.event === 'ui.close').fn($, { id: 'codex_subagent_activity' }, e => e);
  const count = invalidations; await observeUI($, { agents: [{ ...agents[0], status: 'completed' }] }); assert.equal(invalidations, count);
});

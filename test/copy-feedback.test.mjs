import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { fileChangePage } from '../shared/file-changes.mjs';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
async function fixture(t, entries, copy, detail) {
  const hooks = [], timers = [], requests = [];
  const $ = {
    ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Svg', 'Client'].map(type => [type, props => ({ type, props })])), invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}), copy },
    clock: { every: () => ({ cancel() {} }), after(ms, fn) { if (ms === 1600) timers.push(fn); else setImmediate(fn); return { cancel() {} }; } },
    state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true }) },
    session: { id: async () => 'session', cwd: async () => 'C:/work' }, env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const { operation, args } = JSON.parse(options.stdin); requests.push({ operation, args });
      const value = operation === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] }
        : operation === 'ui_revision' ? { revision: 1, entries }
        : operation === 'ui_detail' ? await detail(args) : { entries: [], next_cursor: null };
      return { stdout: JSON.stringify(value), exitCode: 0 };
    } },
  };
  closeUI(); t.after(closeUI); registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) })); await openAgent($, 'a');
  const draw = async () => nodes(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop' }, () => null));
  const press = async key => { const all = await draw(), button = all.find(n => n.type === 'Button' && n.props.key === key); if (button) return button.props.onPress({ surface: 'desktop' }); return hooks.find(h => h.event === 'ui.message').fn($, { element: key, surface: 'desktop', data: { action: 'activate', expanded: false } }, () => { throw new Error(`Unmatched ${key}`); }); };
  return { draw, press, timers, requests };
}
const final = id => ({ id, turn_id: 't', type: 'agentMessage', data: { text: `raw ${id}` }, message: { is_final: true } });
const hasText = (all, value) => all.some(n => n.type === 'Text' && n.props.children.includes(value));

test('copy feedback is immediate, reports actual success, and old timers do not erase newer feedback', async t => {
  let finish; const copied = [];
  const f = await fixture(t, [final('one'), final('two')], value => { copied.push(value.text); return new Promise(resolve => { finish = resolve; }); });
  const control = (await f.draw()).find(n => n.props.key === 'message_copy_a:t:one');
  assert.equal(control.type, 'Button');
  assert.equal(control.props.onPress({ surface: 'desktop' }), undefined);
  assert.deepEqual(copied, ['raw one']);
  assert.ok(hasText(await f.draw(), '正在复制…'));
  await f.press('message_copy_a:t:one');
  assert.deepEqual(copied, ['raw one']);
  finish({ isCopied: true });
  assert.ok(hasText(await f.draw(), '已复制'));
  await f.press('message_copy_a:t:two');
  finish({ isCopied: true });
  await f.timers[0]();
  assert.ok(hasText(await f.draw(), '已复制'));
  await f.timers[1]();
  assert.ok(!hasText(await f.draw(), '已复制'));
  assert.deepEqual(copied, ['raw one', 'raw two']);
});

test('a clipped final reply reads once and copies the exact original from the desktop press', async t => {
  const entry = { ...final('long'), data: { text: 'abc…' }, message: { is_final: true, truncated: true } };
  const raw = '**markdown**\r\n' + '你好😀'.repeat(18000) + '\r\n';
  let finish;
  const copied = [];
  const f = await fixture(t, [entry], async call => { copied.push(call); return { isCopied: true }; },
    () => new Promise(resolve => { finish = resolve; }));
  assert.equal(await f.press('message_copy_a:t:long'), undefined);
  assert.ok(hasText(await f.draw(), '正在复制…'));
  assert.deepEqual(copied, []);
  finish({ text: raw });
  await new Promise(setImmediate);
  assert.deepEqual(copied, [{ text: raw, surface: 'desktop' }]);
  assert.deepEqual(f.requests.filter(r => r.operation === 'ui_detail').map(r => r.args),
    [{ target: 'a', turn_id: 't', item_id: 'long', view: 'message', copy: true }]);
  assert.ok(hasText(await f.draw(), '已复制'));
});

test('long final and unavailable clipboard offer the full file and a missing helper never copies a preview', async t => {
  const entry = { ...final('final'), message: { is_final: true, truncated: true } };
  const file_url = 'file:///C:/Temp/complete.md';
  let response = { file_url }, clipboardCalls = 0;
  const f = await fixture(t, [entry], async () => { clipboardCalls++; return { isCopied: false, reason: 'no-clipboard' }; },
    async ({ copy }) => copy === 'file' ? { file_url } : response);
  const press = async () => { await f.press('message_copy_a:t:final'); await new Promise(setImmediate); return f.draw(); };
  const link = all => all.some(n => n.type === 'Markdown' && n.props.text.includes(file_url));
  assert.ok(link(await press()));
  assert.equal(clipboardCalls, 0);
  response = { text: 'exact source' };
  assert.ok(link(await press()));
  assert.equal(clipboardCalls, 1);
  response = { error: { message: 'content unavailable' } };
  assert.ok(hasText(await press(), '复制失败：content unavailable'));
  assert.equal(clipboardCalls, 1);
  assert.deepEqual(f.requests.filter(r => r.operation === 'ui_detail').map(r => r.args.copy), [true, true, 'file', true]);
});

test('diff copy preserves raw CRLF and surfaces refusal and thrown errors at the clicked record', async t => {
  const raw = '@@ -1 +1 @@\r\n-old\r\n+new\r\n';
  const entry = { id: 'file', turn_id: 't', type: 'fileChange', data: { changes: [{ path: 'x.py', kind: 'update', diff: raw }] } };
  let count = 0;
  const f = await fixture(t, [entry], async ({ text }) => { assert.equal(text, raw); if (++count === 1) return { isCopied: false, reason: 'refused' }; throw new Error('clipboard failed'); });
  await f.press('file_a:t:file:file:0');
  await f.press('diff_copy_a:t:file:file:0');
  let all = await f.draw();
  assert.ok(hasText(all, '复制失败，请重试'));
  assert.match(all.find(n => n.props.key === 'diff_copy_error_a:t:file:file:0').props.children[0], /refused/);
  await f.press('diff_copy_a:t:file:file:0'); all = await f.draw();
  assert.match(all.find(n => n.props.key === 'diff_copy_error_a:t:file:file:0').props.children[0], /clipboard failed/);
  assert.ok(!all.some(n => n.type === 'Text' && n.props.children.some(x => /^@@|^[+-](?:old|new)/.test(x))));
});

test('clipped short diff previews fetch exact detail and never paint partial patches as source', async t => {
  const full = '@@ -1 +1 @@\n-old\n+new\n'; let finish;
  const change = { path: 'x.py', kind: 'update', diff: full };
  const entry = { id: 'file', turn_id: 't', type: 'fileChange', file_preview: { complete: false }, data: { fileSummary: [{ path: 'x.py', kind: 'update', added: 1, removed: 1 }], changes: [{ ...change, diff: '@@ -1 +1 @@\n-old\n+ne…' }] } };
  const f = await fixture(t, [entry], async () => ({ isCopied: true }), () => new Promise(resolve => { finish = resolve; }));
  const reading = f.press('file_a:t:file:file:0'); await new Promise(setImmediate);
  assert.ok(!(await f.draw()).some(n => n.type === 'Code'));
  finish(fileChangePage(change)); await reading;
  const all = await f.draw();
  assert.ok(all.some(n => n.props.key === 'file_diff_a:t:file:file:0:0'));
  assert.ok(hasText(all, 'new'));
  assert.equal(f.requests.filter(r => r.operation === 'ui_detail').length, 1);
});

test('incoming author labels distinguish known user, parent and unknown historical origins', async t => {
  const entries = [
    { id: 'user', turn_id: 't', type: 'directUserMessage', data: { text: 'same' } },
    { id: 'parent', turn_id: 't', type: 'parentMessage', data: { text: 'same' } },
    { id: 'old', turn_id: 'before', type: 'userMessage', data: { content: [{ type: 'text', text: 'old original message' }] } },
    { id: 'known', turn_id: 'later', type: 'userMessage', data: { message_origin: 'parent', content: [{ type: 'text', text: 'parent task' }] } },
    { id: 'echo', turn_id: 'steer', type: 'userMessage', data: { content: [{ type: 'text', text: 'again' }] } },
    { id: 'action:send:echo', turn_id: 'steer', type: 'parentMessage', data: { text: 'again' } },
    { id: 'unmatched', turn_id: 'before', type: 'userMessage', data: { content: [{ type: 'text', text: 'again' }] } },
  ];
  const f = await fixture(t, entries, async () => ({ isCopied: true }));
  assert.deepEqual((await f.draw()).filter(n => n.props.key?.startsWith('author_')).map(n => n.props.children[0]), ['User', 'Claude', '消息', 'Claude', 'Claude', '消息']);
});

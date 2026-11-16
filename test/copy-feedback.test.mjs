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
  const first = f.press('message_copy_a:t:one'); await new Promise(setImmediate);
  assert.ok(hasText(await f.draw(), '正在复制…'));
  finish({ isCopied: true }); await first;
  assert.ok(hasText(await f.draw(), '已复制'));
  const second = f.press('message_copy_a:t:two'); await new Promise(setImmediate);
  finish({ isCopied: true }); await second;
  await f.timers[0]();
  assert.ok(hasText(await f.draw(), '已复制'));
  await f.timers[1]();
  assert.ok(!hasText(await f.draw(), '已复制'));
  assert.deepEqual(copied, ['raw one', 'raw two']);
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
  await f.press('file_a:t:file:file:0'); await new Promise(setImmediate);
  assert.ok(!(await f.draw()).some(n => n.type === 'Code'));
  finish(fileChangePage(change)); await new Promise(setImmediate); await new Promise(setImmediate);
  const all = await f.draw();
  assert.ok(all.some(n => n.props.key === 'file_diff_a:t:file:file:0'));
  assert.ok(hasText(all, 'new'));
  assert.equal(f.requests.filter(r => r.operation === 'ui_detail').length, 1);
});

test('incoming author labels distinguish known user, parent and unknown historical origins', async t => {
  const entries = [
    { id: 'user', turn_id: 't', type: 'directUserMessage', data: { text: 'same' } },
    { id: 'parent', turn_id: 't', type: 'parentMessage', data: { text: 'same' } },
    { id: 'old', turn_id: 'before', type: 'userMessage', data: { content: [{ type: 'text', text: 'old original message' }] } },
    { id: 'known', turn_id: 'later', type: 'userMessage', data: { message_origin: 'parent', content: [{ type: 'text', text: 'parent task' }] } },
  ];
  const f = await fixture(t, entries, async () => ({ isCopied: true }));
  assert.deepEqual((await f.draw()).filter(n => n.props.key?.startsWith('author_')).map(n => n.props.children[0]), ['User', 'Claude', '消息', 'Claude']);
});

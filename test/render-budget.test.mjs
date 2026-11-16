import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRenderBudget, RENDER_LIMIT } from '../hooks/render-budget.js';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';

const types = ['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'];
const constructors = Object.fromEntries(types.map(type => [type, props => ({ type, props })]));
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props.children ?? []).flatMap(nodes)] : [];
const allStrings = value => typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + allStrings(child), 0) : 0;
const audit = tree => { assert.ok(allStrings(tree) < RENDER_LIMIT.chars, 'render fits the shared text allowance'); assert.ok(nodes(tree).length < RENDER_LIMIT.nodes, 'render fits the native node allowance'); };

async function setup(entries, detail = { text: '', next_offset: null }, agent = {}) {
  const hooks = [], afters = [], calls = [], timers = []; let revision = 1, currentEntries = entries;
  const $ = {
    ui: { resolve: () => constructors, invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => {}, copy: async () => {} },
    clock: { every: (_ms, fn) => { timers.push(fn); return { cancel() {} }; }, after: (_ms, fn) => { afters.push(fn); return { cancel() {} }; } },
    state: { get: async () => ({}), set: async () => ({ isSet: true }) },
    session: { id: async () => 'session', cwd: async () => 'C:/work' },
    env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); calls.push(request.operation);
      const result = request.operation === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed', ...agent }] } : request.operation === 'ui_revision' ? { revision, entries: currentEntries } : request.operation === 'ui_detail' ? detail : { entries: [], next_cursor: null };
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
  };
  closeUI(); registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) })); await openAgent($, 'a');
  const draw = () => hooks.find(hook => hook.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  return { draw, calls, update: async next => { currentEntries = next; revision++; await timers[0](); }, flush: async () => { for (const fn of afters.splice(0)) await fn(); } };
}

test('unexpectedly long shell metadata leaves the composer and message usable', async () => {
  const name = '超长名称'.repeat(50000);
  const { draw } = await setup([{ id: 'm', turn_id: 't', type: 'agentMessage', data: { text: 'Saved answer' } }], undefined, { name, model: 'gpt-6.1-' + 'model-'.repeat(30000), reasoning_effort: 'high'.repeat(40000) });
  const tree = await draw();
  audit(tree);
  assert.ok(nodes(tree).some(node => node.type === 'Input'));
  assert.ok(nodes(tree).some(node => node.type === 'Markdown' && node.props.text === 'Saved answer'));
  assert.ok(nodes(tree).find(node => node.props.key === 'codex_title_a').props.children[0].length < 600);
  closeUI();
});

test('opaque native constructors retain accounting without reading returned node shapes', () => {
  const budget = nativeRenderBudget({ Box: () => Object.freeze({}), Text: () => Object.freeze({}) });
  const text = budget.ui.Text({ children: ['x'.repeat(60000)] });
  const tree = budget.ui.Box({ key: 'root', children: [text, text] });
  assert.equal(budget.fits(tree), false);
  assert.ok(budget.pages(tree).length >= 2);
  for (const page of budget.pages(tree)) assert.equal(budget.fits(page), true);
});

test('many short native rows also page before the host node limit', () => {
  const budget = nativeRenderBudget(constructors), { Box, Text } = budget.ui;
  const rows = Array.from({ length: 15000 }, () => Text({ children: ['x'] }));
  const tree = Box({ children: rows });
  assert.equal(budget.fits(tree), false);
  const pages = budget.pages(tree);
  assert.ok(pages.length > 1);
  assert.equal(pages.flatMap(page => nodes(page).filter(node => node.type === 'Text')).length, rows.length);
  for (const page of pages) assert.equal(budget.fits(page), true);
});

test('single children and independent input values follow the native constructor contract', () => {
  const budget = nativeRenderBudget(constructors), { Box, Text, Input } = budget.ui;
  const tree = Box({ children: Text({ children: 'readable' }) });
  assert.equal(budget.fits(tree), true);
  const draft = 'draft'.repeat(30000), input = Input({ value: draft, placeholder: 'Write' });
  assert.equal(input.props.value, draft);
  assert.ok(budget.cost(input).chars < 100, 'Input.value uses the separate host field allowance');
});

test('source pages preserve Unicode and provide one complete copy without partial-code actions', async () => {
  let copied;
  const budget = nativeRenderBudget(constructors, { copy: text => { copied = text; } }), { Code, Markdown } = budget.ui;
  const source = ('😀'.repeat(17) + '\n').repeat(100);
  const limit = { chars: 177, nodes: 30, depth: 10 };
  const pages = budget.pages(Code({ key: 'source', source, format: 'diff', startLine: 57 }), limit);
  const pageText = page => nodes(page).filter(node => node.type === 'Text' && node.props.mono).map(node => node.props.children.join('')).join('');
  assert.equal(pages.map(pageText).join(''), source);
  for (const page of pages) {
    assert.ok(!nodes(page).some(node => node.type === 'Code'));
    assert.equal(nodes(page).filter(node => node.type === 'Button').length, 1);
    assert.ok([...pageText(page)].every(char => char.length === 2 || !/[\uD800-\uDFFF]/.test(char)));
    await nodes(page).find(node => node.type === 'Button').props.onPress(); assert.equal(copied, source);
  }
  const markup = '```math\n' + source + '\n```';
  const markdown = budget.pages(Markdown({ text: markup }), limit);
  assert.ok(markdown.every(page => !nodes(page).some(node => node.type === 'Code' || node.type === 'Markdown')));
  assert.equal(markdown.map(pageText).join(''), markup);
});

test('oversized labels remain paged while native metadata keys stay bounded and stable', () => {
  const budget = nativeRenderBudget(constructors), label = 'file label '.repeat(20000), key = 'id'.repeat(60000);
  const button = budget.ui.Button({ key, label, onPress() {} });
  const second = budget.ui.Button({ key, label: 'again' });
  assert.equal(button.props.key, second.props.key); assert.ok(button.props.key.length < 256);
  const pages = budget.pages(button);
  assert.equal(pages.map(page => page.props.label).join(''), label);
  assert.ok(pages.every(page => budget.fits(page)));
});

test('large displayed messages remain completely accessible through bounded local pages', async t => {
  t.after(closeUI);
  const text = 'A long paragraph.\n'.repeat(14000);
  const ui = await setup([{ id: 'large', turn_id: 'turn', type: 'agentMessage', data: { text } }]);
  const visible = [];
  for (let page = 0; page < 20; page++) {
    const tree = await ui.draw(); audit(tree);
    visible.push(...nodes(tree).filter(node => node.type === 'Markdown' || node.type === 'Code' || node.type === 'Text' && node.props.mono).map(node => node.props.text ?? node.props.source ?? node.props.children.join('')));
    const next = nodes(tree).find(node => node.props.key?.startsWith('content_next_'));
    if (!next) break;
    await next.props.onPress();
  }
  assert.equal(visible.join(''), text);
  assert.equal(ui.calls.includes('ui_detail'), false, 'local display pages do not reread history or detail');
});

test('combined expanded files page every subtree and preserve complete copy callbacks', async () => {
  let copied;
  const budget = nativeRenderBudget(constructors), { Box, Button, Code } = budget.ui;
  const sources = Array.from({ length: 35 }, (_, index) => `${index}:` + 'changed line\n'.repeat(300));
  const files = sources.map((source, index) => Box({ key: `file_${index}`, children: [Button({ key: `copy_${index}`, label: '复制差异', onPress: () => { copied = source; } }), Code({ source, format: 'source' })] }));
  const pages = budget.pages(Box({ children: files }));
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.flatMap(page => nodes(page).filter(node => node.type === 'Code').map(node => node.props.source)), sources);
  for (const page of pages) { assert.equal(budget.fits(page), true); audit(page); }
  await nodes(pages.at(-1)).find(node => node.type === 'Button').props.onPress();
  assert.ok(sources.includes(copied));
});

test('loading a detail keeps its clicked entry when the continuous window shrinks', async t => {
  t.after(closeUI);
  const tool = { id: 'tool', turn_id: 'turn', type: 'commandExecution', deferred: true, data: { command: 'echo result' } };
  const entries = [tool, ...Array.from({ length: 28 }, (_, index) => ({ id: `m${index}`, turn_id: 'turn', type: 'agentMessage', data: { text: 'm'.repeat(2450) } }))];
  const ui = await setup(entries, { text: 'output\n'.repeat(2300), offset: 0, next_offset: null });
  const before = await ui.draw(), item = nodes(before).find(node => node.props.key === 'item_a:turn:tool');
  assert.ok(item, 'the clicked entry starts in the visible window');
  await item.props.onPress(); await ui.flush();
  const after = await ui.draw(); audit(after);
  assert.ok(nodes(after).find(node => node.props.key === 'item_a:turn:tool'), 'the expanded anchor remains visible');
  assert.ok(nodes(after).some(node => node.type === 'Code' && node.props.source.includes('output')));
  assert.ok(nodes(after).filter(node => node.type === 'Markdown').length < nodes(before).filter(node => node.type === 'Markdown').length);
  assert.ok(nodes(await ui.draw()).some(node => node.props.key === 'item_a:turn:tool'), 'the anchor survives another redraw');
  await ui.update([...entries, { id: 'new', turn_id: 'turn', type: 'agentMessage', data: { text: 'latest activity' } }]);
  assert.ok(nodes(await ui.draw()).some(node => node.type === 'Markdown' && node.props.text === 'latest activity'), 'new activity restores the tail window');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryWindow, historyWindowCost, historyWindowFits } from '../hooks/history-window.js';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';

const descriptors = costs => costs.map((cost, start) => ({ start, end: start + 1, key: `g${start}`, cost }));
const simpleCost = chars => ({ chars, nodes: 4, depth: 3 });
const render = group => ({ node: group.key, cost: group.cost });
const shellCost = { chars: 2000, nodes: 80, depth: 7 };

test('tail fills its actual character allowance beyond sixty short records', () => {
  const groups = descriptors(Array.from({ length: 10000 }, () => simpleCost(100)));
  const calls = new Map();
  const result = planHistoryWindow({ groups, shellCost, renderGroup: group => { calls.set(group.key, (calls.get(group.key) ?? 0) + 1); return render(group); } });
  assert.equal(result.start, 9600);
  assert.equal(result.end, 10000);
  assert.equal(result.evaluated, 400);
  assert.ok([...calls.values()].every(count => count === 1));
  assert.ok(historyWindowFits(result.cost));
});

test('variable messages select the largest continuous tail without binary count retries', () => {
  const groups = descriptors([simpleCost(100), simpleCost(32000), ...Array.from({ length: 90 }, () => simpleCost(1000))]);
  const result = planHistoryWindow({ groups, shellCost, renderGroup: render });
  assert.equal(result.end, 92);
  assert.equal(result.start, 14);
  assert.equal(result.evaluated, 79, 'one rejected boundary is measured only once');
  assert.deepEqual(result.groups.map(group => group.start), Array.from({ length: 78 }, (_, index) => index + 14));
});

test('a large paged group leaves space for its immediate shorter neighbours', () => {
  const groups = descriptors([simpleCost(2000), simpleCost(32000), simpleCost(32000), simpleCost(100)]);
  const result = planHistoryWindow({ groups, shellCost, renderGroup: render });
  assert.equal(result.start, 0);
  assert.equal(result.end, 4);
  assert.equal(result.cost.chars, 68100);
});

test('prepend and append preserve every retained boundary and never skip a full neighbour', () => {
  const groups = descriptors([simpleCost(100), simpleCost(50000), simpleCost(32000), simpleCost(32000), simpleCost(100), simpleCost(20000)]);
  const before = planHistoryWindow({ groups: groups.slice(0, 4), retained: { start: 2, end: 4 }, direction: -1, shellCost, renderGroup: render });
  assert.deepEqual([before.start, before.end], [2, 4]);
  const after = planHistoryWindow({ groups: groups.slice(2), retained: { start: 2, end: 4 }, direction: 1, shellCost, renderGroup: render });
  assert.deepEqual([after.start, after.end], [2, 5]);
  assert.ok(after.groups.some(group => group.start === 2));
  assert.ok(after.groups.some(group => group.end === 4));
});

test('native node and depth costs constrain selection independently of text length', () => {
  const groups = descriptors(Array.from({ length: 100 }, () => ({ chars: 10, nodes: 1000, depth: 4 })));
  const result = planHistoryWindow({ groups, shellCost, renderGroup: render });
  assert.equal(result.groups.length, 11);
  assert.ok(historyWindowFits(result.cost));
  assert.equal(historyWindowFits(historyWindowCost(shellCost, [{ cost: { chars: 1, nodes: 1, depth: 27 } }])), false);
});

test('oversize retained ranges are returned intact for content pagination', () => {
  const groups = descriptors(Array.from({ length: 5 }, () => simpleCost(32000)));
  const result = planHistoryWindow({ groups, retained: { start: 1, end: 4 }, direction: -1, shellCost, renderGroup: render });
  assert.equal(result.overflow, true);
  assert.deepEqual([result.start, result.end], [1, 4]);
  assert.equal(result.evaluated, 3);
});

const walk = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children ?? []).flatMap(walk)] : [];
async function open(entries) {
  const hooks = [], built = new Map();
  const constructors = Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code', 'Svg', 'Client'].map(type => [type, props => {
    if (type === 'Markdown' && props.key?.startsWith('message_')) built.set(props.key, (built.get(props.key) ?? 0) + 1);
    return { type, props };
  }]));
  const $ = {
    ui: { resolve: () => constructors, invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async () => ({}) },
    clock: { every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) },
    state: { get: async () => ({}), set: async () => ({ isSet: true }) },
    session: { id: async () => 'session', cwd: async () => 'C:/work' }, env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const { operation } = JSON.parse(options.stdin);
      return { stdout: JSON.stringify(operation === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'completed' }] } : { revision: 1, entries, next_cursor: null }), exitCode: 0 };
    } },
  };
  closeUI(); registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) })); await openAgent($, 'a');
  return {
    built,
    draw: () => hooks.find(hook => hook.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface: 'desktop', props: { scroll: { bodyRows: 30, contentRows: 2000 } } }, () => null),
    hold: () => hooks.find(hook => hook.event === 'ui.scroll').fn($, { requestId: 'codex_subagent_activity', origin: { kind: 'person' }, by: -1, offset: 100, contentRows: 2000, bodyRows: 30 }, async event => event),
  };
}

test('pane renders more than sixty short messages and constructs each candidate once', async t => {
  t.after(closeUI);
  const entries = Array.from({ length: 2000 }, (_, index) => ({ id: `m${index}`, turn_id: `t${index}`, type: 'agentMessage', data: { text: `answer ${index}` } }));
  const { draw, built } = await open(entries);
  const tree = await draw();
  const shown = walk(tree).filter(node => node.type === 'Markdown' && node.props.key?.startsWith('message_'));
  assert.ok(shown.length > 60);
  assert.ok(shown.length <= 400);
  assert.ok(shown.at(-1).props.text.endsWith('1999'));
  assert.ok([...built.values()].every(count => count === 1));
  assert.ok(built.size <= 400);
  assert.ok(walk(tree).some(node => node.type === 'Input'));
});

const strings = value => typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + strings(child), 0) : 0;
function renderedCost(tree) {
  if (typeof tree === 'string') return { chars: tree.length, nodes: 1, depth: 1 };
  if (!tree || typeof tree !== 'object') return { chars: 0, nodes: 0, depth: 0 };
  const { children = [], ...fields } = tree.props;
  const own = ['Svg', 'Image'].includes(tree.type) ? { key: fields.key, alt: fields.alt } : tree.type === 'Input' ? { ...fields, value: undefined } : fields;
  const nested = children.map(renderedCost);
  return {
    chars: (tree.type === 'Client' ? strings({ ...own, props: undefined }) + JSON.stringify(fields.props ?? null).length : strings(own)) + nested.reduce((sum, child) => sum + child.chars, 0),
    nodes: 1 + nested.reduce((sum, child) => sum + child.nodes, 0),
    depth: 1 + Math.max(0, ...nested.map(child => child.depth)),
  };
}

test('opening large groups keeps the clicked anchor and a bounded rendered tree', async t => {
  t.after(closeUI);
  const entries = Array.from({ length: 3 }, (_, index) => ({ id: `c${index}`, turn_id: `t${index}`, type: 'commandExecution', data: { command: `run ${index}`, aggregatedOutput: `${index}:` + 'output\n'.repeat(8000) } }));
  const ui = await open(entries);
  await ui.draw(); await ui.hold();
  for (let index = 0; index < 3; index++) {
    const button = walk(await ui.draw()).find(node => node.props.key === `item_a:t${index}:c${index}`);
    assert.ok(button, `the next nearby command ${index} remains reachable`);
    await button.props.onPress();
  }
  const tree = await ui.draw(), cost = renderedCost(tree);
  assert.ok(historyWindowFits(cost), JSON.stringify(cost));
  assert.ok(walk(tree).some(node => node.props.key === 'activity_paged_a:t2:c2'), 'the last clicked group remains visible while distant groups can leave the window');
  assert.ok(walk(tree).some(node => node.props.key?.startsWith('content_next_')), 'complete output remains reachable through the existing content pager');
});

test('pane spends the full available render budget on a continuous tail without rebuilding rejected groups', async t => {
  t.after(closeUI);
  const entries = Array.from({ length: 10000 }, (_, index) => ({ id: `m${index}`, turn_id: `t${index}`, type: 'agentMessage', data: { text: `${index}:` + 'x'.repeat(2500) } }));
  const { draw, built } = await open(entries);
  const tree = await draw(), cost = renderedCost(tree);
  const shown = walk(tree).filter(node => node.type === 'Markdown' && node.props.key?.startsWith('message_'));
  assert.ok(historyWindowFits(cost), JSON.stringify(cost));
  assert.ok(cost.chars > 74000, 'most of the real allowance is used');
  assert.ok(shown.length > 20 && shown.length < 40);
  assert.ok(built.size <= shown.length + 1, 'only the selected groups plus the first rejected boundary are constructed');
  assert.ok([...built.values()].every(count => count === 1));
  const ids = shown.map(node => Number(node.props.text.split(':')[0]));
  assert.deepEqual(ids, Array.from({ length: shown.length }, (_, index) => 10000 - shown.length + index));
});

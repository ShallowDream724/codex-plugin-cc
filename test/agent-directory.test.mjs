import test from 'node:test';
import assert from 'node:assert/strict';
import { agentDirectoryModel, renderAgentDirectory } from '../hooks/agent-directory.js';
import { nativeRenderBudget, RENDER_LIMIT } from '../hooks/render-budget.js';

const ui = Object.fromEntries(['Box', 'Text', 'Button', 'Svg', 'Client'].map(type => [type, props => ({ type, props })]));
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children;
  return [node, ...[].concat(children || []).flatMap(nodes)];
}

test('groups by lifecycle and sorts by recorded activity, with stable ID ties and missing times last', () => {
  const agents = [
    { id: 'z', status: 'running' },
    { id: 'b', status: 'unknown', created_at_ms: 2000 },
    { id: 'a', status: 'waiting', created_at_ms: 2000 },
    { id: 'c', status: 'compacting', created_at_ms: 1000, last_activity_at_ms: 3000 },
    { id: 'd', status: 'failed', created_at_ms: 3000 },
    { id: 'e', status: 'interrupted' },
    { id: 'f', status: 'completed', last_activity_at_ms: 4000 },
  ];
  const result = agentDirectoryModel(agents, { now: 5000 });
  assert.deepEqual(result.open.map(row => row.id), ['c', 'a', 'b', 'z']);
  assert.deepEqual(result.completed.map(row => row.id), ['f', 'd', 'e']);
  assert.equal(result.open.at(-1).time, null);
  assert.equal(result.open.at(-1).relativeTime, '时间未记录');
  assert.deepEqual(agentDirectoryModel([...agents].reverse(), { now: 90000 }).open.map(row => row.id), ['c', 'a', 'b', 'z']);
});

test('limits completed rows while preserving the total and exposing the next page action', () => {
  const agents = Array.from({ length: 103 }, (_, i) => ({ id: `agent-${i}`, name: `name ${i}`, status: 'completed', created_at_ms: i + 1 }));
  let target;
  const tree = renderAgentDirectory(ui, { agents, now: 1000, onPage: (group, offset) => { target = [group, offset]; } });
  const all = nodes(tree);
  assert.equal(all.filter(node => node.props.key?.startsWith('directory_open_')).length, 50);
  assert.ok(all.some(node => node.props.children?.includes?.('完成 · 103')));
  all.find(node => node.props.key === 'directory_next_completed').props.onPress();
  assert.deepEqual(target, ['completed', 50]);
  const second = agentDirectoryModel(agents, { completedOffset: 50 });
  assert.equal(second.completed.length, 50);
  assert.equal(second.completed[0].id, 'agent-52');
  const last = agentDirectoryModel(agents, { completedOffset: 100 });
  assert.equal(last.completed.length, 3);
  assert.equal(last.hasMore, false);
  const lastTree = nodes(renderAgentDirectory(ui, { agents, completedOffset: 100, onPage: (group, offset) => { target = [group, offset]; } }));
  assert.ok(lastTree.some(node => node.props.children?.includes?.('完成 · 103 · 101–103')));
  lastTree.find(node => node.props.key === 'directory_prev_completed').props.onPress();
  assert.deepEqual(target, ['completed', 50]);
});

test('long Unicode names remain bounded and clicking the row selects the original ID', () => {
  const id = '0b26c986-0cbb-4ff0-84df-d2423796f001';
  const name = '😀长名字'.repeat(300);
  let selected;
  const tree = renderAgentDirectory(ui, { columns: 24, agents: [{ id, name, status: 'running' }, { id: 'missing', status: 'starting' }], onOpen: value => { selected = value; } });
  const all = nodes(tree), button = all.find(node => node.props.key === `directory_open_${id}`);
  assert.ok(button.props.label.length < 24);
  assert.ok(button.props.label.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(button.props.label));
  assert.equal(button.props.children, undefined);
  const row = all.find(node => node.props.key === `directory_row_${id}`);
  assert.ok(nodes(row).some(node => node.type === 'Svg'));
  assert.ok(nodes(row).some(node => node.props.key === `directory_time_${id}`));
  assert.equal(nodes(row).find(node => node.props.key === `directory_hit_${id}`).props.props.action, 'open-agent');
  assert.equal(all.find(node => node.props.key === 'directory_open_missing').props.label, '子代理');
  button.props.onPress();
  assert.equal(selected, id);
  const wide = nodes(renderAgentDirectory(ui, { columns: 1000, agents: [{ id, name: 'Long name '.repeat(100), status: 'completed' }] }));
  assert.ok(wide.find(node => node.props.key === `directory_open_${id}`).props.label.length <= 48);
});

test('bounds open agents, preserves both totals, and labels exceptional states', () => {
  const agents = Array.from({ length: 103 }, (_, i) => ({ id: `open-${i}`, name: `开放 ${i}`, status: i === 102 ? 'unknown' : 'waiting', created_at_ms: i + 1 }));
  agents.push({ id: 'failed', name: '任务', status: 'failed' }, { id: 'done', name: '正常', status: 'completed' });
  let target;
  const tree = renderAgentDirectory(ui, { agents, now: 1000, onPage: (group, offset) => { target = [group, offset]; } });
  const all = nodes(tree);
  assert.equal(all.filter(node => node.type === 'Button' && node.props.key?.startsWith('directory_open_')).length, 52);
  assert.ok(all.some(node => node.props.children?.includes?.('已开启 · 103')));
  assert.ok(all.some(node => node.props.children?.includes?.('完成 · 2')));
  assert.ok(all.some(node => node.props.key === 'directory_status_open-102' && node.props.children.includes('状态未知')));
  assert.ok(all.some(node => node.props.key === 'directory_status_failed' && node.props.children.includes('失败')));
  assert.ok(!all.some(node => node.props.key === 'directory_status_done'));
  all.find(node => node.props.key === 'directory_next_open').props.onPress();
  assert.deepEqual(target, ['open', 50]);
  const model = agentDirectoryModel(agents, { openOffset: 50 });
  assert.equal(model.open.length, 50);
  assert.equal(model.openTotal, 103);
  assert.equal(model.hasMoreOpen, true);
  assert.equal(model.hasPrevOpen, true);
  const page = nodes(renderAgentDirectory(ui, { agents, openOffset: 50, onPage: (group, offset) => { target = [group, offset]; } }));
  assert.ok(page.some(node => node.props.children?.includes?.('已开启 · 103 · 51–100')));
  page.find(node => node.props.key === 'directory_prev_open').props.onPress();
  assert.deepEqual(target, ['open', 0]);
});

test('loading and retry state remain actionable without inventing agents', () => {
  let retried = 0;
  const all = nodes(renderAgentDirectory(ui, { error: 'offline', onRetry: () => retried++ }));
  all.find(node => node.props.key === 'directory_retry').props.onPress();
  assert.equal(retried, 1);
  assert.equal(all.filter(node => node.props.key?.startsWith('directory_open_')).length, 0);
  assert.ok(nodes(renderAgentDirectory(ui, { loading: true })).some(node => node.props.key === 'directory_loading'));
});

test('thousands of registered agents remain accessible within the native render budget', () => {
  const agents = Array.from({ length: 5000 }, (_, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, name: '长名字 with emoji 😀 '.repeat(100), status: i % 2 ? 'completed' : 'unknown' }));
  const budget = nativeRenderBudget(ui);
  for (const [offset, columns] of [[0, 40], [50, 1000], [2450, 40], [999999, 1000]]) {
    const tree = renderAgentDirectory(budget.ui, { agents, columns, openOffset: offset, completedOffset: offset });
    const cost = budget.cost(tree);
    assert.ok(cost.chars < RENDER_LIMIT.chars, JSON.stringify(cost));
    assert.ok(cost.nodes < RENDER_LIMIT.nodes);
    assert.ok(cost.depth < RENDER_LIMIT.depth);
    assert.equal(nodes(tree).filter(node => node.props.key?.startsWith('directory_open_')).length, 100);
  }
});

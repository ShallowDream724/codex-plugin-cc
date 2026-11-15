import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, parseDisplayResult, registerRows } from '../hooks/rows.js';
import { EVENT_PREFIX } from '../hooks/delivery.js';
import { closeUI } from '../hooks/ui.js';

const full = name => 'mcp__codex-subagents__' + name;
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
function setup() {
  closeUI();
  const hooks = new Map(), opened = [];
  registerRows((event, match, handler) => hooks.set(match.component, handler));
  const $ = {
    session: { id: async () => 'owner', cwd: async () => '/work' }, env: { get: async () => undefined }, plugin: { root: '/plugin' },
    clock: { every: () => ({ cancel() {} }) },
    process: { run: async (_, options) => {
      const body = JSON.parse(options.stdin);
      if (body.operation === 'ui_revision') opened.push(body.args.target);
      return { stdout: JSON.stringify(body.operation === 'ui_list' ? { agents: Array.from({ length: 5 }, (_, i) => ({ agent_id: `id-${i}` })) } : { entries: [], revision: 0 }), exitCode: 0 };
    } },
    ui: { open: async () => ({ isPlaced: true }), invalidate() {}, resolve: () => Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({ type, props })])) },
  };
  return { opened, render: (component, props) => hooks.get(component)($, { component, requestId: 'call', props }, () => 'native') };
}
test('five long bilingual agent names retain five independent clickable entries without changing output', async () => {
  const h = setup();
  const events = Array.from({ length: 5 }, (_, i) => ({ agent_id: `id-${i}`, name: '长名字Long name '.repeat(30), kind: 'completed', result: 'private result' }));
  const output = { result: JSON.stringify({ events }) }, original = structuredClone(output);
  const tree = h.render('ToolUse', { tool: full('wait_agent'), output });
  const buttons = nodes(tree).filter(node => node.type === 'Button');
  assert.equal(buttons.length, 5);
  for (const button of buttons) await button.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.opened, events.map(event => event.agent_id));
  assert.deepEqual(output, original);
  assert.equal(h.render('ToolResult', { tool: full('wait_agent'), output }).props.children.length, 0);
  assert.equal(h.render('ToolUse', { tool: full('wait_agent'), output, isExpanded: true }), 'native');
  assert.equal(h.render('ToolResult', { tool: full('wait_agent'), output }), 'native');
});
test('only this plugin notification origin is compacted, and mixed tool groups retain native rendering', () => {
  const h = setup(), text = EVENT_PREFIX + JSON.stringify({ events: [{ agent_id: 'a', kind: 'question' }] });
  assert.equal(h.render('UserMessage', { origin: { kind: 'user' }, text }), 'native');
  assert.equal(h.render('UserMessage', { origin: { kind: 'plugin', name: 'another-plugin' }, text }), 'native');
  assert.equal(nodes(h.render('UserMessage', { origin: { kind: 'plugin', name: 'codex-subagents' }, text })).filter(node => node.type === 'Button').length, 1);
  assert.equal(h.render('ToolGroup', { calls: [{ tool: full('spawn_agent') }, { tool: 'Bash' }] }), 'native');
});
test('wrapped MCP results decode; oversized or invalid results preserve native fallback', () => {
  assert.deepEqual(parseDisplayResult({ content: [{ type: 'text', text: '{"agent_id":"a"}' }] }), { agent_id: 'a' });
  assert.equal(describeCall(full('wait_agent'), {}, 'not JSON'), null);
  assert.equal(describeCall(full('wait_agent'), {}, 'x'.repeat(524289)), null);
});

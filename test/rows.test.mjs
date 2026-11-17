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
    state: { get: async () => ({ value: 0, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
    process: { run: async (_, options) => {
      const body = JSON.parse(options.stdin);
      if (body.operation === 'ui_revision') opened.push(body.args.target);
      return { stdout: JSON.stringify(body.operation === 'ui_list' ? { agents: Array.from({ length: 5 }, (_, i) => ({ agent_id: `id-${i}` })) } : { entries: [], revision: 0 }), exitCode: 0 };
    } },
    ui: { open: async () => ({ isPlaced: true }), scroll: async () => ({}), invalidate() {}, resolve: () => Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({ type, props })])) },
  };
  return { opened, render: (component, props) => hooks.get(component)($, { component, requestId: 'call', props }, () => 'native') };
}
test('five long bilingual agent names retain five independent clickable entries without changing output', async () => {
  const h = setup();
  const events = Array.from({ length: 5 }, (_, i) => ({ agent_id: `id-${i}`, name: '长名字Long name '.repeat(30), kind: 'completed', result: 'private result' }));
  events[0].name = 'terra-test';
  const output = { result: JSON.stringify({ events }) }, original = structuredClone(output);
  const tree = h.render('ToolUse', { tool: full('wait_agent'), output });
  const buttons = nodes(tree).filter(node => node.type === 'Button');
  assert.equal(buttons.length, 5);
  assert.equal(buttons[0].props.label, 'Terra-test');
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

test('wait labels distinguish parent idle from all agents idle', () => {
  const label = (result, running = false) => describeCall(full('wait_agent'), {}, result, running)[0].text;
  assert.equal(label({ idle: false, parent_idle: true, active: true, events: [] }), '有代理继续工作');
  assert.equal(label({ idle: true, parent_idle: true, active: false, events: [] }), 'Codex 空闲');
  assert.equal(label({ idle: true, events: [] }), 'Codex 空闲');
  assert.equal(label({ idle: false, parent_idle: true, active: true, events: [] }, true), '正在等待 Codex');
});

test('native framed plugin prompts retain compact rows and expanded or unrelated messages stay native', () => {
  const h = setup(), origin = { kind: 'plugin', name: 'codex-subagents' };
  const text = 'The codex-subagents plugin sent a message:\n' + EVENT_PREFIX + JSON.stringify({ events: [{ agent_id: 'a', name: 'worker', kind: 'user_action_receipt', origin: 'user', action: 'send', phase: 'delivered', quoted_user_message: 'OFFLINE_QUOTED_ACTION' }] }) + "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
  const tree = h.render('UserMessage', { origin, text });
  assert.equal(nodes(tree).filter(node => node.type === 'Button').length, 1);
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.props.children[0] === '已收到你的消息'));
  assert.equal(h.render('UserMessage', { origin, text, isExpanded: true }), 'native');
  assert.equal(h.render('UserMessage', { origin: { kind: 'plugin', name: 'other' }, text }), 'native');
  assert.equal(h.render('UserMessage', { origin, text: 'Quoted: ' + text }), 'native');
});

test('compact error rows retain the cause without repeating the plugin name', () => {
  assert.match(describeCall(full('followup_task'), {}, { error: { code: 'helper_restart_required' } })[0].text, /重启 Claude/);
  const h = setup();
  const output = { error: { code: 'plugin_error', message: 'Connection refused' } };
  const tree = h.render('ToolUse', { tool: full('followup_task'), output });
  const visible = nodes(tree).filter(node => node.type === 'Text').flatMap(node => node.props.children).join('');
  assert.equal(visible, 'Codex 请求失败：Connection refused');
});

test('user interruption and message events have accurate distinct timeline labels', () => {
  const events = [
    { agent_id: 'a', kind: 'interrupted' },
    ...['requested', 'confirmed', 'unconfirmed'].map(phase => ({ agent_id: 'a', kind: 'message', origin: 'user', action: 'interrupt', phase })),
    { agent_id: 'a', kind: 'message', origin: 'user', action: 'send', phase: 'delivered' },
  ];
  const labels = describeCall(full('wait_agent'), {}, { events }).map(entry => entry.text);
  assert.deepEqual(labels, ['本轮已停止', '你已请求停止', '已按你的要求停止', '停止状态未确认', '已收到你的消息']);
  const h = setup();
  const tree = h.render('UserMessage', { origin: { kind: 'plugin', name: 'codex-subagents' }, text: EVENT_PREFIX + JSON.stringify({ events }) });
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.props.children[0] === '停止状态未确认'));
});

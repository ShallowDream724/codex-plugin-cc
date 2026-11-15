import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';

const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const entry = (id, type, text) => ({ id, turn_id: 'turn', type, data: { text } });

async function setup(handler) {
  const hooks = [], timers = [], scrolls = [], calls = [];
  const $ = {
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Code'].map((type) => [type, (props) => ({ type, props })])),
      invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async (args) => { scrolls.push(args); },
    },
    clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; } },
    state: { get: async () => ({}), set: async () => ({ isSet: true }) },
    session: { id: async () => 'session', cwd: async () => 'C:/work' },
    env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); calls.push(request);
      const result = await handler(request.operation, request.args);
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
  };
  closeUI();
  registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) }));
  await openAgent($, 'a');
  const draw = () => hooks.find((hook) => hook.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity' }, () => null);
  const item = async (key) => nodes(await draw()).find((node) => node.props.key?.startsWith(key));
  return { draw, item, tick: () => timers[0](), scrolls, calls };
}

test('live messages continue while an MCP group and cached tool output remain expanded', async (t) => {
  t.after(closeUI);
  const tool = { id: 'tool', turn_id: 'turn', type: 'mcpToolCall', deferred: true, data: { server: 'fastctx', tool: 'grep' } };
  let revision = 1, entries = [tool], details = 0;
  const ui = await setup(async (op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision, entries };
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    if (op === 'ui_detail') { details++; return { text: 'cached tool output', next_offset: null }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  await (await ui.item('group_')).props.onPress();
  await (await ui.item('item_a:turn:tool')).props.onPress();
  assert.match(JSON.stringify(await ui.draw()), /cached tool output/);
  const scrollCount = ui.scrolls.length;
  entries = [tool, entry('user', 'directUserMessage', 'continue please'), entry('progress', 'agentMessage', 'working now')]; revision++;
  await ui.tick();
  let rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /continue please/); assert.match(rendered, /working now/);
  assert.match(rendered, /cached tool output/);
  entries = [...entries, entry('final', 'agentMessage', 'finished answer')]; revision++;
  await ui.tick(); rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /finished answer/); assert.match(rendered, /cached tool output/);
  assert.match((await ui.item('group_')).props.label, /▾/);
  assert.match((await ui.item('item_a:turn:tool')).props.label, /▾/);
  assert.equal(details, 1); assert.equal(ui.scrolls.length, scrollCount);
});

test('sending from history returns to live and shows the sent message and subsequent answer', async (t) => {
  t.after(closeUI);
  let revision = 1, entries = [entry('old-live', 'agentMessage', 'live before send')];
  const ui = await setup(async (op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') return { revision, entries };
    if (op === 'ui_history') return { entries: [entry('old', 'agentMessage', 'older history')], next_cursor: 'older' };
    if (op === 'ui_send') { entries = [...entries, entry('sent', 'directUserMessage', 'new question')]; revision++; return { agent_id: 'a', status: 'steered' }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  await (await ui.item('codex_older')).props.onPress();
  assert.match(JSON.stringify(await ui.draw()), /older history/);
  const scrollCount = ui.scrolls.length;
  await (await ui.item('codex_message_a')).props.onSubmit('new question');
  let rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /new question/); assert.match(rendered, /live before send/);
  assert.doesNotMatch(rendered, /消息已发送/);
  assert.deepEqual(ui.scrolls.slice(scrollCount), [{ in: 'codex_subagent_activity', to: 'end' }]);
  entries = [...entries, entry('answer', 'agentMessage', 'subsequent answer')]; revision++;
  await ui.tick(); rendered = JSON.stringify(await ui.draw());
  assert.match(rendered, /new question/); assert.match(rendered, /subsequent answer/);
});

test('a send during an in-flight poll triggers a follow-up refresh', async (t) => {
  t.after(closeUI);
  let revision = 1, entries = [], block = false, release;
  const ui = await setup(async (op) => {
    if (op === 'ui_list') return { agents: [{ agent_id: 'a', status: 'running' }] };
    if (op === 'ui_revision') {
      if (block) { block = false; return new Promise((resolve) => { release = resolve; }); }
      return { revision, entries };
    }
    if (op === 'ui_history') return { entries: [], next_cursor: null };
    if (op === 'ui_send') { revision++; entries = [entry('sent', 'directUserMessage', 'sent during poll')]; return { agent_id: 'a', status: 'steered' }; }
    throw new Error(`Unexpected operation: ${op}`);
  });
  block = true;
  const polling = ui.tick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const scrollCount = ui.scrolls.length;
  await (await ui.item('codex_message_a')).props.onSubmit('sent during poll');
  assert.equal(ui.scrolls.length, scrollCount);
  release({ revision: 1, entries: [] });
  await polling;
  assert.match(JSON.stringify(await ui.draw()), /sent during poll/);
  assert.equal(ui.calls.filter((call) => call.operation === 'ui_revision').length, 3);
  assert.deepEqual(ui.scrolls.slice(scrollCount), [{ in: 'codex_subagent_activity', to: 'end' }]);
});

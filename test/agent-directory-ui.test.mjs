import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, observeUI, openAgent, openDirectory, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';

const PANE = 'codex_subagent_activity';
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const settle = async () => { for (let n = 0; n < 5; n++) await new Promise(setImmediate); };
function harness(t) {
  closeUI(); t.after(closeUI);
  const writes = [], calls = [], panes = new Map(), timers = [], scrolls = [];
  const fixture = { agents: [], list: null };
  const $ = {
    state: { get: async () => undefined, set: async (key, value) => { writes.push({ key: key.key, value }); } },
    session: { id: async () => 'session', cwd: async () => 'C:/work' }, env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    clock: {
      every(ms, fn) { const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
      after(_ms, fn) { const timer = setImmediate(fn); return { cancel() { clearImmediate(timer); } }; },
    },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); calls.push(request);
      const op = request.operation;
      const result = op === 'ui_list' ? await (fixture.list ? fixture.list() : { agents: fixture.agents })
        : op === 'ui_revision' ? { revision: 1, entries: [{ id: 'answer', turn_id: 'turn', type: 'agentMessage', data: { text: 'Finished.' } }] }
          : op === 'ui_history' ? { entries: [], next_cursor: null } : {};
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
    ui: {
      resolve: () => Object.fromEntries(['Box', 'Button', 'Text', 'Svg', 'Client', 'Input', 'Markdown', 'Code', 'Image'].map(type => [type, props => ({ type, props })])),
      toast() {}, panes: async () => [...panes.values()],
      open: async args => { panes.set(args.id, args); return { isPlaced: true }; },
      close: async args => { await host.dispatch('ui.close', { id: args.id }, () => { panes.delete(args.id); }); },
      scroll: async args => {
        const e = await host.dispatch('ui.scroll', { origin: { kind: 'plugin' }, by: -100, offset: 0, contentRows: 500, bodyRows: 24 }, e => e);
        scrolls.push(e.offset); return {};
      },
    },
  };
  const host = nativeHooks([], $); registerUI(host.on);
  const draw = (component = 'Pane', props = {}) => host.dispatch('ui.render', { component, requestId: component === 'Pane' ? PANE : 'above-prompt', surface: 'desktop', props: { bodyColumns: 64, scroll: { offset: 0, bodyRows: 24, contentRows: 500 }, ...props } }, () => null);
  const press = async key => {
    const tree = await draw(key === 'codex_directory_toggle' ? 'AbovePrompt' : 'Pane');
    const node = nodes(tree).find(node => node.type === 'Button' && node.props.key === key);
    assert.ok(node, `missing action ${key}`);
    return host.dispatch('ui.press', { requestId: key === 'codex_directory_toggle' ? 'above-prompt' : PANE, element: key }, e => node.props.onPress(e));
  };
  const syncDirectory = async () => {
    const node = nodes(await draw()).find(node => node.props.key === 'codex_directory_sync');
    if (node) await host.dispatch('ui.message', { element: node.props.key, data: { action: 'navigate', token: node.props.props.token } });
  };
  return { $, host, draw, press, fixture, calls, writes, panes, timers, scrolls, syncDirectory };
}

test('entry composes AbovePrompt, respects survey, updates count independently, and toggles the actual pane', async t => {
  const h = harness(t), inherited = { type: 'Text', props: { children: ['Other plugin'] } };
  const render = props => h.host.dispatch('ui.render', { component: 'AbovePrompt', requestId: 'above-prompt', surface: 'desktop', props }, () => inherited);
  assert.equal(await render({ hasSurvey: true }), inherited);
  assert.ok(nodes(await render({})).includes(inherited));
  h.fixture.agents = [{ agent_id: 'a', status: 'running' }, { agent_id: 'b', status: 'completed' }];
  await observeUI(h.$, { agents: h.fixture.agents });
  assert.equal(nodes(await render({})).find(n => n.props.key === 'codex_directory_toggle').props.label, 'Codex·2');
  assert.deepEqual(h.writes.map(w => w.key), ['entryRevision']);
  await h.press('codex_directory_toggle'); await settle();
  assert.ok(h.panes.has(PANE));
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'agent_directory'));
  assert.ok(h.calls.every(c => c.operation === 'ui_list'), 'listing never reads transcripts or calls a model');
  await h.press('codex_directory_toggle');
  assert.equal(h.panes.has(PANE), false);
  assert.ok(h.timers.every(timer => timer.cancelled));
  // A retained native pane after module reload must still close on the first click.
  h.panes.set(PANE, { id: PANE, isShown: false, isPlaced: false });
  await h.press('codex_directory_toggle'); assert.equal(h.panes.has(PANE), false);
});

test('rapid repeated toggles remain ordered and closing ignores a late directory response', async t => {
  const h = harness(t); let resolve;
  h.fixture.list = () => new Promise(r => { resolve = r; });
  await h.press('codex_directory_toggle'); await settle();
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'directory_loading'));
  await h.press('codex_directory_toggle');
  resolve({ agents: [{ agent_id: 'stale', status: 'running' }] }); await settle();
  assert.equal(nodes(await h.draw('AbovePrompt')).find(n => n.props.key === 'codex_directory_toggle').props.label, 'Codex·0');
  h.fixture.list = null;
  await Promise.all([h.press('codex_directory_toggle'), h.press('codex_directory_toggle')]);
  assert.equal(h.panes.has(PANE), false);
});

test('directory has empty/error recovery and unchanged refresh does not repaint', async t => {
  const h = harness(t);
  await openDirectory(h.$); await settle(); await h.syncDirectory();
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'directory_empty'));
  const count = h.writes.length;
  await h.timers[0].fn();
  assert.equal(h.writes.length, count);
  h.fixture.list = () => ({ offline: true }); await h.timers[0].fn();
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'directory_retry'));
  h.fixture.list = null; h.fixture.agents = [{ agent_id: 'recovered', status: 'completed' }];
  await h.press('directory_retry');
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'directory_open_recovered'));
});

test('directory to agent and back preserve drafts and independent reading offsets', async t => {
  const h = harness(t);
  h.fixture.agents = [{ agent_id: 'a', name: 'Agent', status: 'completed', last_activity_at_ms: Date.now() }];
  await openDirectory(h.$); await settle(); await h.syncDirectory();
  await h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, offset: 23, by: 23 });
  await h.press('directory_open_a');
  let tree = await h.draw();
  await nodes(tree).find(n => n.type === 'Input').props.onInput('Unsent draft');
  // Complete the normal initial tail reveal, then read upwards.
  const tail = nodes(tree).find(n => n.props.key === 'codex_navigation_sync_a');
  if (tail?.props.props.tailToken) await h.host.dispatch('ui.message', { element: tail.props.key, data: { action: 'tail', token: tail.props.props.tailToken } });
  await h.host.dispatch('ui.scroll', { origin: { kind: 'person' }, offset: 37, by: -5, contentRows: 500, bodyRows: 24 });
  await h.press('codex_back_directory_footer'); await settle(); await h.syncDirectory();
  assert.equal(h.scrolls.at(-1), 23);
  await h.press('directory_open_a');
  assert.equal(h.scrolls.at(-1), 37);
  tree = await h.draw();
  assert.equal(nodes(tree).find(n => n.type === 'Input').props.value, 'Unsent draft');
  assert.ok(h.calls.every(c => ['ui_list', 'ui_revision', 'ui_history'].includes(c.operation)));
});

test('selected agent ignores a late list response and remains reachable from directory after completion', async t => {
  const h = harness(t);
  h.fixture.agents = [{ agent_id: 'a', status: 'running' }]; await observeUI(h.$, { agents: h.fixture.agents });
  let resolve; h.fixture.list = () => new Promise(r => { resolve = r; });
  await openDirectory(h.$); await settle();
  h.fixture.list = null; await openAgent(h.$, 'a');
  resolve({ agents: [] }); await settle();
  assert.ok(nodes(await h.draw()).some(n => n.type === 'Input'));
  h.fixture.agents = [{ agent_id: 'a', status: 'completed', last_activity_at_ms: Date.now() }];
  await observeUI(h.$, { agents: h.fixture.agents });
  await h.press('codex_back_directory'); await settle();
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'directory_open_a'));
  assert.equal(nodes(await h.draw('AbovePrompt')).find(n => n.props.key === 'codex_directory_toggle').props.label, 'Codex·1');
});

test('page navigation follows the displayed page after cleanup and row hit regions open the right agent', async t => {
  const h = harness(t);
  h.fixture.agents = Array.from({ length: 125 }, (_, i) => ({ agent_id: `a${i}`, name: `Agent ${i}`, status: 'completed', last_activity_at_ms: 1000 + i }));
  await openDirectory(h.$); await settle(); await h.syncDirectory();
  await h.press('directory_next_completed'); await h.press('directory_next_completed');
  assert.ok(nodes(await h.draw()).some(n => n.props.children?.includes?.('完成 · 125 · 101–125')));
  h.fixture.agents = h.fixture.agents.slice(0, 75);
  await observeUI(h.$, { agents: h.fixture.agents });
  assert.ok(nodes(await h.draw()).some(n => n.props.children?.includes?.('完成 · 75 · 51–75')));
  await h.press('directory_prev_completed');
  assert.ok(nodes(await h.draw()).some(n => n.props.children?.includes?.('完成 · 75')));
  await h.host.dispatch('ui.message', { element: 'directory_hit_a74', data: { action: 'open-agent' } });
  assert.ok(nodes(await h.draw()).some(n => n.props.key === 'codex_title_a74'));
});

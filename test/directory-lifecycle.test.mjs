import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../hooks/register.js';
import { nativeHooks } from './native-hooks.mjs';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flatMap(nodes)] : [];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('tool summaries automatically repaint subscribed entry and supersede stale observations', async t => {
  let host, currentFrame, recording = false, queued = false, nextSetFailure;
  const subscribers = new Set(), frames = [], requests = [], timers = [];
  let agents = [], observeResponse;
  const render = async () => {
    recording = true;
    try {
      currentFrame = await host.dispatch('ui.render', { component: 'SessionMode', requestId: 'entry', surface: 'desktop', props: {} }, () => null);
      frames.push(nodes(currentFrame).find(n => n.props.key === 'codex_directory_toggle')?.props.label);
    } finally { recording = false; }
  };
  const $ = {
    state: {
      get: async key => { if (recording) subscribers.add(key.key); },
      set: async key => {
        if (key.key === 'entryRevision' && nextSetFailure) {
          const failure = nextSetFailure; nextSetFailure = undefined;
          if (failure === 'reject') throw new Error('state unavailable');
          return { isSet: false };
        }
        if (subscribers.has(key.key) && !queued) { queued = true; setImmediate(() => { queued = false; void host.surface(render); }); }
        return { isSet: true };
      },
    },
    session: { id: async () => 'session', cwd: async () => 'C:/work', messages: async () => [] },
    env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    tool: { register: async () => {} }, command: { register: async () => {} },
    clock: { every: (ms, fn) => { const timer = { ms, fn, cancel() {} }; timers.push(timer); return timer; }, after: (_ms, fn) => { const id = setImmediate(fn); return { cancel: () => clearImmediate(id) }; } },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); requests.push(request);
      let result = {};
      if (request.operation === 'observe') result = observeResponse ? await observeResponse() : { agents };
      else if (request.operation === 'spawn_agent') { agents = [...agents, { agent_id: request.args.name, status: 'running' }]; result = { agent_id: request.args.name, ui_summary: { agents } }; }
      else if (request.operation === 'followup_task') { if (!agents.some(a => a.agent_id === request.args.target)) agents = [...agents, { agent_id: request.args.target, status: 'running' }]; result = { agent_id: request.args.target, ui_summary: { agents } }; }
      else if (request.operation === 'close_agent') { agents = agents.filter(a => !request.args.targets.includes(a.agent_id)); result = { closed_ids: request.args.targets, ui_summary: { agents } }; }
      else if (request.operation === 'list_agents') result = { agents, ui_summary: { agents } };
      return { stdout: JSON.stringify(result), exitCode: 0 };
    } },
    ui: { resolve: () => Object.fromEntries(['Box', 'Button'].map(type => [type, props => ({ type, props })])) },
    prompt: { submit: async () => ({}) },
  };
  host = nativeHooks([], $); register(host.on);
  await host.dispatch('session.start', {});
  t.after(async () => { await host.dispatch('session.end', {}); });
  await host.surface(render);
  const call = async (operation, args = {}) => {
    const response = await host.dispatch('tool.call', { tool: `mcp__codex-subagents__${operation}`, tool_use_id: `id-${requests.length}`, ...args });
    const visible = JSON.parse(response.result);
    assert.equal(visible.ui_summary, undefined);
    assert.equal(requests.at(-1).ui_summary, true);
    await settle();
    return visible;
  };
  const label = () => frames.at(-1);
  assert.equal(label(), 'Codex·0');
  await call('spawn_agent', { message: 'x', name: 'a', context_mode: 'none' }); assert.equal(label(), 'Codex·1');
  await call('followup_task', { target: 'b', message: 'adopt' }); assert.equal(label(), 'Codex·2');
  await call('followup_task', { target: 'b', message: 'continue' }); assert.equal(label(), 'Codex·2');
  await call('close_agent', { targets: ['a'] }); assert.equal(label(), 'Codex·1');
  const timer = timers.find(item => item.ms === 10000);
  const lateOffline = deferred(); observeResponse = () => lateOffline.promise;
  const pendingOffline = timer.fn(); await settle();
  await call('spawn_agent', { message: 'x', name: 'c', context_mode: 'none' });
  lateOffline.resolve({ offline: true }); await pendingOffline;
  observeResponse = () => ({ agents });
  const before = requests.filter(r => r.operation === 'observe').length;
  await timer.fn();
  assert.equal(requests.filter(r => r.operation === 'observe').length, before + 1, 'stale offline must not stop future observation');
  const lateSnapshot = deferred(); observeResponse = () => lateSnapshot.promise;
  const pendingSnapshot = timer.fn(); await settle();
  await call('spawn_agent', { message: 'x', name: 'd', context_mode: 'none' });
  assert.equal(label(), 'Codex·3');
  lateSnapshot.resolve({ agents: [{ agent_id: 'b', status: 'running' }] }); await pendingSnapshot; await settle();
  assert.equal(label(), 'Codex·3', 'stale snapshot must not replace newer catalog');
  for (const failure of ['reject', 'isSet:false']) {
    nextSetFailure = failure;
    await call('spawn_agent', { message: 'x', name: failure, context_mode: 'none' });
    const expected = `Codex·${agents.length}`;
    assert.notEqual(label(), expected);
    await call('list_agents');
    assert.equal(label(), expected, `${failure} must retry the same count`);
  }
});

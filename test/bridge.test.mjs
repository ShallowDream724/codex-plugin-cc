import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { configureBridge, requestBridge } from '../hooks/bridge.js';
import { call } from '../runtime/bridge.mjs';
import { createBroker } from '../runtime/broker.mjs';

const names = ['id', 'cwd', 'CODEX_SUBAGENTS_NODE_COMMAND', 'CODEX_SUBAGENTS_STATE_DIR', 'CODEX_SUBAGENTS_CODEX_COMMAND', 'CODEX_SUBAGENTS_SETTINGS'];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('bridge reads independently and starts the process only when every value is ready', async () => {
  const pending = Object.fromEntries(names.map(name => [name, deferred()]));
  const reads = [], calls = [];
  const read = name => { reads.push(name); return pending[name].promise; };
  const $ = {
    session: { id: () => read('id'), cwd: () => read('cwd') },
    env: { get: read }, plugin: { root: '/plugin' },
    process: { run: async (...args) => { calls.push(args); return { stdout: '{"ok":true}', exitCode: 0 }; } },
  };
  configureBridge({ maxActiveAgents: 3, permissionsMode: 'ask' });
  const request = requestBridge($, 'wait', { timeout_ms: 5 }, { extra: true });
  assert.deepEqual(reads, names);
  for (const [name, value] of Object.entries({ id: 'owner', cwd: '/work', CODEX_SUBAGENTS_NODE_COMMAND: 'custom-node', CODEX_SUBAGENTS_STATE_DIR: '/state', CODEX_SUBAGENTS_CODEX_COMMAND: 'custom-codex' })) pending[name].resolve(value);
  await Promise.resolve();
  assert.equal(calls.length, 0);
  pending.CODEX_SUBAGENTS_SETTINGS.resolve('{"override":true}');
  assert.deepEqual(await request, { ok: true });
  assert.deepEqual(calls, [[['custom-node', '/plugin/runtime/bridge.mjs'], {
    cwd: '/work', env: { CODEX_SUBAGENTS_STATE_DIR: '/state', CODEX_SUBAGENTS_CODEX_COMMAND: 'custom-codex', CODEX_SUBAGENTS_SETTINGS: '{"override":true}' },
    timeoutMs: 45000, stdin: JSON.stringify({ owner: 'owner', cwd: '/work', operation: 'wait', args: { timeout_ms: 5 }, extra: true }),
  }]]);
});

test('each request reads current settings and uses configured defaults when overrides are absent', async () => {
  let values = { id: 'first', cwd: '/one', CODEX_SUBAGENTS_NODE_COMMAND: 'node-one', CODEX_SUBAGENTS_SETTINGS: 'override' };
  const calls = [];
  const $ = {
    session: { id: async () => values.id, cwd: async () => values.cwd },
    env: { get: async name => values[name] }, plugin: { root: '/plugin' },
    process: { run: async (...args) => { calls.push(args); return { stdout: '{}', exitCode: 0 }; } },
  };
  configureBridge({ maxActiveAgents: 2, permissionsMode: 'auto-review' });
  await requestBridge($, 'list');
  values = { id: 'second', cwd: '/two', CODEX_SUBAGENTS_STATE_DIR: '/new-state' };
  await requestBridge($, 'list', { active: true });
  assert.deepEqual(calls[0], [['node-one', '/plugin/runtime/bridge.mjs'], {
    cwd: '/one', env: { CODEX_SUBAGENTS_SETTINGS: 'override' }, timeoutMs: 240000,
    stdin: JSON.stringify({ owner: 'first', cwd: '/one', operation: 'list', args: {} }),
  }]);
  assert.deepEqual(calls[1], [['node', '/plugin/runtime/bridge.mjs'], {
    cwd: '/two', env: { CODEX_SUBAGENTS_STATE_DIR: '/new-state', CODEX_SUBAGENTS_SETTINGS: JSON.stringify({ maxActiveAgents: 2, permissionsMode: 'auto-review' }) }, timeoutMs: 240000,
    stdin: JSON.stringify({ owner: 'second', cwd: '/two', operation: 'list', args: { active: true } }),
  }]);
});

test('failed setting reads do not start the process', async () => {
  let processStarted = false;
  const failure = new Error('settings unavailable');
  const $ = {
    session: { id: async () => 'owner', cwd: async () => '/work' },
    env: { get: async name => { if (name === 'CODEX_SUBAGENTS_SETTINGS') throw failure; } },
    plugin: { root: '/plugin' }, process: { run: async () => { processStarted = true; } },
  };
  await assert.rejects(requestBridge($, 'list'), error => error === failure);
  assert.equal(processStarted, false);
});

test('the runtime bridge preserves broker errors on a port blocked by fetch', async t => {
  const port = 10080;
  const token = 'test-auth';
  const error = { code: 'model_catalog_unavailable', message: 'Catalog unavailable.' };
  const controller = { async dispatch() { throw Object.assign(new Error(error.message), error); } };
  const server = createBroker({ controller, token, requiredProtocol: 2 });
  t.after(() => server.close());
  try { await once(server.listen(port, '127.0.0.1'), 'listening'); }
  catch (err) {
    if (['EADDRINUSE', 'EACCES'].includes(err.code)) return t.skip(`Port ${port} is unavailable.`);
    throw err;
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`), err => err.cause?.message === 'bad port');
  assert.deepEqual(await call({ port, token }, { operation: 'list_models' }), { error });
});

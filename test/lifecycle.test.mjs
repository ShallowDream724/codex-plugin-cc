import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acquireOwnedLock, ownerDirectory, readJson, writeJson } from '../runtime/storage.mjs';
import { call, createIdleLease, ensureBroker, runtimeSignature, serve } from '../runtime/bridge.mjs';
import { createBroker } from '../runtime/broker.mjs';

const helperPath = fileURLToPath(new URL('./fixtures/lifecycle-helper.mjs', import.meta.url));
const bridgePath = fileURLToPath(new URL('../runtime/bridge.mjs', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('offline stop all does not start a helper and treats existing ownership as unconfirmed', async t => {
  const directory = await temporary(t), owner = 'offline-test';
  const invoke = () => {
    const child = spawnSync(process.execPath, [bridgePath], { input: JSON.stringify({ owner, operation: 'ui_interrupt_all', requestId: 'stop' }), encoding: 'utf8', env: { ...process.env, CODEX_SUBAGENTS_STATE_DIR: directory }, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(invoke(), { offline: true, results: [] });
  assert.deepEqual(await readdir(directory), []);
  await mkdir(join(ownerDirectory(owner, directory), 'service'), { recursive: true });
  assert.equal(invoke().error.code, 'action_status_unknown');
});

test('owner locks preserve live owners and late release cannot delete a replacement', async t => {
  const directory = await temporary(t), path = join(directory, 'service');
  const original = await acquireOwnedLock(path, { pid: 1234567 });
  assert.equal(await acquireOwnedLock(path, { isAlive: () => true }), null);
  const replacement = await acquireOwnedLock(path, { isAlive: () => false });
  assert.ok(replacement);
  await original.release();
  assert.deepEqual(await readdir(path), [`${replacement.pid}-${replacement.token}.json`]);
  await replacement.release();
  assert.equal((await readdir(directory)).length, 0);
});

test('a contender retries a denied directory scan while the starting lock is released', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'starting');
  const owner = await acquireOwnedLock(path);
  let scans = 0;
  const next = await acquireOwnedLock(path, { readEntries: async lockPath => {
    if (++scans === 1) {
      await owner.release();
      throw Object.assign(new Error('Lock deletion pending'), { code: 'EPERM' });
    }
    return readdir(lockPath);
  } });
  assert.ok(next);
  assert.notEqual(next.token, owner.token);
  await next.release();
  assert.deepEqual(await readdir(directory), []);
});

test('a persistent lock scan error reaches the caller and preserves the live owner', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'starting');
  const owner = await acquireOwnedLock(path);
  const denied = Object.assign(new Error('Access denied'), { code: 'EPERM' });
  await assert.rejects(acquireOwnedLock(path, { readEntries: async () => { throw denied; } }),
    error => error === denied);
  assert.deepEqual(await readdir(path), [`${owner.pid}-${owner.token}.json`]);
  await owner.release();
  assert.deepEqual(await readdir(directory), []);
});

test('concurrent startup creates one fixture helper and shutdown permits a fresh helper', async t => {
  const directory = await temporary(t), children = [];
  let launches = 0;
  const spawnHelper = () => {
    launches++;
    const child = spawn(process.execPath, [helperPath, directory], { stdio: 'ignore', windowsHide: true });
    children.push(child);
  };
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });
  const options = { directory, spawnHelper, pollMs: 5, timeoutMs: 6000 };
  const endpoints = await Promise.all(Array.from({ length: 12 }, () => ensureBroker('fixture', process.cwd(), options)));
  assert.equal(launches, 1);
  assert.ok(endpoints.every(endpoint => endpoint.token === endpoints[0].token));
  const health = await call(endpoints[0], { operation: 'health' });
  assert.deepEqual(health, { ready: true, ...await runtimeSignature(), active: false, capabilities: ['idle_shutdown'] });
  const exited = once(children[0], 'exit');
  await call(endpoints[0], { operation: 'shutdown' });
  await exited;
  assert.equal(await readJson(join(directory, 'endpoint.json'), null), null);
  const restarted = await ensureBroker('fixture', process.cwd(), options);
  assert.equal(launches, 2);
  assert.notEqual(restarted.token, endpoints[0].token);
  const exitedAgain = once(children[1], 'exit');
  await call(restarted, { operation: 'shutdown' });
  await exitedAgain;
});

class FixtureClient extends EventEmitter {
  ready = false;
  closed = false;
  async start() { this.ready = true; }
  async close() {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.emit('closed');
  }
}
class FixtureController extends EventEmitter {
  agents = new Map();
  closed = false;
  async init() {}
  async close() { this.closed = true; }
}

test('competing helpers acquire service ownership before creating a transport', async t => {
  const directory = await temporary(t);
  let transports = 0;
  const helpers = await Promise.all(Array.from({ length: 8 }, () => serve('fixture', {
    directory, clientFactory: () => { transports++; return new FixtureClient(); },
    controllerFactory: () => new FixtureController(),
  })));
  assert.equal(transports, 1);
  assert.equal(helpers.filter(Boolean).length, 1);
  await helpers.find(Boolean).shutdown();
});

for (const stage of ['start', 'controller-init', 'listen']) {
  test(`disconnect during ${stage} does not publish an endpoint and releases ownership`, async t => {
    const directory = await temporary(t), client = new FixtureClient();
    if (stage === 'start') client.start = async () => { await client.close(); };
    const controller = new FixtureController();
    if (stage === 'controller-init') controller.init = async () => { await client.close(); };
    const codes = [];
    const helper = await serve('fixture', { directory, clientFactory: () => client,
      controllerFactory: () => controller, exit: code => codes.push(code),
      brokerFactory: options => {
        const server = createBroker(options);
        if (stage === 'listen') server.once('listening', () => { void client.close(); });
        return server;
      } });
    assert.equal(helper, null);
    assert.equal(await readJson(join(directory, 'endpoint.json'), null), null);
    assert.ok(client.closed);
    assert.deepEqual(codes, [1]);
    const recovered = await acquireOwnedLock(join(directory, 'service'));
    assert.ok(recovered);
    await recovered.release();
  });
}

test('closed ready transport immediately makes health unready and allows recovery', async t => {
  const directory = await temporary(t), client = new FixtureClient(), controller = new FixtureController();
  const helper = await serve('fixture', { directory, clientFactory: () => client, controllerFactory: () => controller });
  assert.equal(helper.ready(), true);
  await client.close();
  assert.equal(helper.ready(), false);
  await helper.shutdown();
  assert.equal(await readJson(join(directory, 'endpoint.json'), null), null);
  const replacement = await serve('fixture', { directory, clientFactory: () => new FixtureClient(), controllerFactory: () => new FixtureController() });
  assert.ok(replacement.ready());
  await replacement.shutdown();
});

test('an incompatible active helper is reported without shutdown or another launch', async t => {
  const directory = await temporary(t), controller = new FixtureController();
  controller.agents.set('working', { status: 'running' });
  const helper = await serve('fixture', { directory, clientFactory: () => new FixtureClient(), controllerFactory: () => controller,
    signature: { protocol: 1, version: 'old', build: 'old-build' } });
  let launched = false;
  try {
    await assert.rejects(ensureBroker('fixture', process.cwd(), { directory, spawnHelper: () => { launched = true; } }), { code: 'helper_restart_required' });
    assert.equal(launched, false);
    assert.equal(helper.ready(), true);
    assert.equal(controller.closed, false);
  } finally { await helper.shutdown(); }
});

test('parallel callers upgrade an idle helper only after its endpoint and service ownership are released', async t => {
  const directory = await temporary(t), client = new FixtureClient();
  let releaseClose, enteredClose;
  const closing = new Promise(resolve => { enteredClose = resolve; });
  client.close = async () => { enteredClose(); await new Promise(resolve => { releaseClose = resolve; }); client.closed = true; };
  const old = await serve('fixture', { directory, clientFactory: () => client, controllerFactory: () => new FixtureController(),
    signature: { protocol: 2, version: 'old', build: 'old-build' } });
  let launches = 0, replacement;
  t.after(async () => { releaseClose?.(); await old.shutdown(); await replacement?.shutdown(); });
  const options = { directory, pollMs: 5, timeoutMs: 6000, spawnHelper: async () => {
    launches++;
    assert.equal(await readJson(join(directory, 'endpoint.json'), null), null);
    replacement = await serve('fixture', { directory, clientFactory: () => new FixtureClient(), controllerFactory: () => new FixtureController() });
  } };
  const upgrading = Promise.all(Array.from({ length: 12 }, () => ensureBroker('fixture', process.cwd(), options)));
  await closing;
  assert.equal(launches, 0);
  assert.equal((await readJson(join(directory, 'endpoint.json'), null)).token, old.endpoint.token);
  assert.equal(await acquireOwnedLock(join(directory, 'service')), null);
  releaseClose();
  const endpoints = await upgrading;
  assert.equal(launches, 1);
  assert.ok(endpoints.every(endpoint => endpoint.token === replacement.endpoint.token));
  assert.notEqual(endpoints[0].token, old.endpoint.token);
});

test('same-protocol upgrade refuses active work even when no agent status exposes it', async t => {
  const directory = await temporary(t), controller = new FixtureController();
  controller.hasActiveWork = () => true;
  const helper = await serve('fixture', { directory, clientFactory: () => new FixtureClient(), controllerFactory: () => controller,
    signature: { protocol: 2, version: 'old', build: 'old-build' } });
  let launches = 0;
  try {
    await assert.rejects(ensureBroker('fixture', process.cwd(), { directory, spawnHelper: () => { launches++; } }),
      { code: 'helper_restart_required', message: /active tasks/ });
    assert.equal(launches, 0);
    assert.equal(controller.closed, false);
    assert.equal(helper.ready(), true);
  } finally { await helper.shutdown(); }
});

test('an idle legacy protocol-2 helper requires manual shutdown without attempting an unsafe operation', async t => {
  const directory = await temporary(t), operations = [];
  const legacy = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    operations.push(JSON.parse(input).operation);
    res.end(JSON.stringify({ ready: true, protocol: 2, version: 'old', build: 'old-build', active: false }));
  });
  await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
  t.after(() => { legacy.closeAllConnections(); legacy.close(); });
  await writeJson(join(directory, 'endpoint.json'), { port: legacy.address().port, token: 'legacy' });
  let launched = false;
  await assert.rejects(ensureBroker('fixture', process.cwd(), { directory, spawnHelper: () => { launched = true; } }),
    { code: 'helper_restart_required', message: /cannot safely upgrade itself/ });
  assert.equal(launched, false);
  assert.ok(operations.length > 0);
  assert.ok(operations.every(operation => operation === 'health'));
});

test('a caller waits for a nonresponsive closing helper to release service ownership before launch', async t => {
  const directory = await temporary(t), closing = await acquireOwnedLock(join(directory, 'service'));
  let launches = 0, replacement;
  t.after(async () => { await closing.release(); await replacement?.shutdown(); });
  const upgrading = ensureBroker('fixture', process.cwd(), { directory, pollMs: 5, timeoutMs: 6000, spawnHelper: async () => {
    launches++;
    replacement = await serve('fixture', { directory, clientFactory: () => new FixtureClient(), controllerFactory: () => new FixtureController() });
  } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(launches, 0);
  await closing.release();
  assert.equal((await upgrading).token, replacement.endpoint.token);
  assert.equal(launches, 1);
});

test('idle lease is monotonic and gives resumed callers time to renew', () => {
  let time = 0;
  const lease = createIdleLease({ now: () => time, idleMs: 90, tickMs: 10, resumeGraceMs: 30 });
  for (time = 10; time < 100; time += 10) assert.equal(lease.expired(), false);
  assert.equal(lease.expired(), true);
  lease.touch();
  time = 10000;
  assert.equal(lease.expired(), false);
  time = 10010;
  lease.touch();
  assert.equal(lease.expired(), false);
  for (time = 10020; time <= 10100; time += 10) assert.equal(lease.expired(), false);
  assert.equal(lease.expired(), true);
});

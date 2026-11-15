#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AppServerClient } from './appserver-client.mjs';
import { AgentController } from './agents.mjs';
import { createBroker } from './broker.mjs';
import { DiskReceipts } from './receipts.mjs';
import { DeliveryStore } from './delivery.mjs';
import { ActivityStore } from './activity.mjs';
import { loadSettings } from './settings.mjs';
import { ownerDirectory, ensureDirectory, readJson, writeJson, acquireOwnedLock } from './storage.mjs';

const entry = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const PROTOCOL = 2;
let signaturePromise;
export function runtimeSignature() {
  return signaturePromise ||= (async () => {
    const runtime = dirname(entry);
    const pkg = JSON.parse(await readFile(join(runtime, '..', 'package.json'), 'utf8'));
    const hash = createHash('sha256');
    for (const name of (await readdir(runtime)).filter(name => name.endsWith('.mjs')).sort()) {
      hash.update(name).update(await readFile(join(runtime, name)));
    }
    hash.update(await readFile(join(runtime, '..', 'config', 'guidance.json')));
    hash.update(await readFile(join(runtime, '..', 'config', 'default-agent.toml')));
    hash.update(JSON.stringify(loadSettings()));
    return { protocol: PROTOCOL, version: pkg.version, build: hash.digest('hex') };
  })();
}

export async function call(endpoint, body, timeout = 35000) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
    method: 'POST', headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, protocolVersion: PROTOCOL }), signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok && !result.error) throw new Error('Local bridge refused the request.');
  return result;
}

async function probe(path) {
  const endpoint = await readJson(path, null);
  if (!endpoint) return null;
  try { return { endpoint, health: await call(endpoint, { operation: 'health' }, 1500) }; }
  catch { return null; }
}

function compatible(probed, signature) {
  if (!probed) return null;
  const metadata = probed.health;
  if (metadata.protocol !== signature.protocol || metadata.version !== signature.version || metadata.build !== signature.build) {
    const error = new Error('This session has a helper from a different plugin build. Let its active tasks finish, then shut down or restart the session helper before retrying.');
    error.code = 'helper_restart_required';
    throw error;
  }
  return metadata.ready ? probed.endpoint : null;
}

export async function ensureBroker(owner, cwd, { directory = ownerDirectory(owner), signature, spawnHelper, timeoutMs = 40000, pollMs = 150 } = {}) {
  signature ||= await runtimeSignature();
  await ensureDirectory(directory);
  const endpointPath = join(directory, 'endpoint.json');
  const existing = compatible(await probe(endpointPath), signature);
  if (existing) return existing;
  const startedAt = Date.now();
  const deadline = performance.now() + timeoutMs;
  let starter;
  try {
    while (performance.now() < deadline) {
      // The starter lock serializes launch requests; the helper's service lock
      // independently prevents duplicate Codex processes if a starter crashes.
      starter ||= await acquireOwnedLock(join(directory, 'starting'));
      if (starter) {
        const rechecked = compatible(await probe(endpointPath), signature);
        if (rechecked) return rechecked;
        if (spawnHelper) await spawnHelper();
        else {
          const child = spawn(process.execPath, [entry, 'serve', owner], {
            cwd, detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
          });
          child.on('error', () => {});
          child.unref();
        }
        // A timeout cannot release another starter or the service lock.
        while (performance.now() < deadline) {
          const endpoint = compatible(await probe(endpointPath), signature);
          if (endpoint) return endpoint;
          const failure = await readJson(join(directory, 'startup-error.json'), null);
          if (failure && failure.at >= startedAt) throw new Error(failure.message);
          await sleep(pollMs);
        }
        break;
      }
      const endpoint = compatible(await probe(endpointPath), signature);
      if (endpoint) return endpoint;
      await sleep(pollMs);
    }
    throw new Error('Codex bridge did not start. Check that Node and Codex CLI are available.');
  } finally { await starter?.release(); }
}

/** A monotonic idle lease grants a fresh interval after a long scheduler pause. */
export function createIdleLease({ now = () => performance.now(), idleMs = 90000, tickMs = 10000, resumeGraceMs = 30000 } = {}) {
  let lastActivity = now(), lastTick = lastActivity, resumeUntil = 0;
  return {
    touch() { lastActivity = now(); },
    expired() {
      const current = now();
      if (current - lastTick > Math.max(tickMs * 3, resumeGraceMs)) resumeUntil = current + resumeGraceMs;
      lastTick = current;
      return current >= resumeUntil && current - lastActivity > idleMs;
    },
  };
}

export async function serve(owner, { directory = ownerDirectory(owner), clientFactory, controllerFactory,
  brokerFactory = createBroker, signature, exit = code => { process.exitCode = code; } } = {}) {
  await ensureDirectory(directory);
  const ownership = await acquireOwnedLock(join(directory, 'service'));
  if (!ownership) return null;
  let shuttingDown = false, shutdownPromise, server, controller, client, activity, lease, listening = false;
  let finishStartup;
  const startupFinished = new Promise(done => { finishStartup = done; });
  const endpointPath = join(directory, 'endpoint.json');
  const token = randomBytes(32).toString('hex');
  const idle = createIdleLease();
  const ready = () => !shuttingDown && listening && client?.ready === true && !controller?.closed && !controller?.closing;
  const assertConnected = () => { if (shuttingDown || !client?.ready) throw new Error('App-server closed during helper initialization.'); };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    clearInterval(lease);
    server?.close();
    shutdownPromise = (async () => {
      // Keep service ownership until initialization stops publishing state.
      await startupFinished;
      server?.close();
      activity?.close();
      try { await controller?.close(); }
      finally {
        try { await client?.close(); }
        finally {
          server?.closeAllConnections?.();
          await server?.drain?.();
          const existing = await readJson(endpointPath, null);
          if (existing?.token === token) await rm(endpointPath, { force: true });
          await ownership.release();
          process.off('SIGTERM', onSignal);
          process.off('SIGINT', onSignal);
        }
      }
    })();
    return shutdownPromise;
  };
  const onSignal = () => { void shutdown().catch(() => exit(1)); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let failure;
  try {
    signature ||= await runtimeSignature();
    client = clientFactory ? clientFactory() : new AppServerClient({ command: process.env.CODEX_SUBAGENTS_CODEX_COMMAND || 'codex', cwd: process.cwd() });
    // Register before start: transport closure can happen in any await gap.
    client.on('closed', () => { if (!shuttingDown) void shutdown().catch(() => exit(1)); });
    await client.start();
    assertConnected();
    controller = controllerFactory ? controllerFactory(client) : new AgentController({ client, statePath: join(directory, 'agents.json') });
    controller.on('controllerError', error => {
      void writeJson(join(directory, 'startup-error.json'), { at: Date.now(), message: `Agent state could not be saved: ${error.message}` })
        .finally(() => shutdown()).catch(() => exit(1));
    });
    await controller.init();
    activity = ActivityStore.attach(client, controller);
    assertConnected();
    const receiptStore = await DiskReceipts.open(join(directory, 'receipts'), { legacyPath: join(directory, 'receipts.json') });
    const deliveryStore = await DeliveryStore.open({ directory: join(directory, 'deliveries'), controller });
    assertConnected();
    server = brokerFactory({ controller, token, receiptStore, deliveryStore, activity, requiredProtocol: PROTOCOL,
      getHealth: () => ({ ready: ready(), ...signature,
        active: controller.hasActiveWork?.() ?? [...(controller.agents?.values() || [])].some(agent => ['starting', 'running', 'waiting', 'compacting', 'recovering', 'unknown'].includes(agent.status)) }),
      onActivity: () => { idle.touch(); }, onShutdown: shutdown });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    listening = true;
    assertConnected();
    await writeJson(endpointPath, { port: server.address().port, token, pid: process.pid, ...signature });
    assertConnected();
    lease = setInterval(() => { if (idle.expired()) void shutdown().catch(() => exit(1)); }, 10000);
  } catch (error) {
    failure = error;
    await writeJson(join(directory, 'startup-error.json'), { at: Date.now(), message: error.message }).catch(() => {});
  } finally { finishStartup(); }
  if (failure || shuttingDown) {
    await shutdown();
    if (failure) exit(1);
    return null;
  }
  return { shutdown, ready, endpoint: await readJson(endpointPath, null) };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'serve') { await serve(argv[1]); return; }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const body = JSON.parse(input);
  const dir = ownerDirectory(body.owner);
  const existing = await probe(join(dir, 'endpoint.json'));
  let endpoint = body.operation === 'shutdown' ? existing?.endpoint : compatible(existing, await runtimeSignature());
  if (!endpoint && ['observe', 'ack', 'confirm', 'release', 'shutdown'].includes(body.operation)) return { offline: true, agents: [], events: [] };
  endpoint ||= await ensureBroker(body.owner, body.cwd || process.cwd());
  try { return await call(endpoint, body, body.operation === 'wait' ? 35000 : 150000); }
  catch (error) {
    if (['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'close_agent', 'answer_agent', 'ui_interrupt', 'ui_send'].includes(body.operation)) {
      return { error: { code: 'action_status_unknown', message: 'The local connection ended before confirmation. The action may already have been submitted. Use list_agents before issuing another action.' } };
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  main().then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch(error => { process.stdout.write(JSON.stringify({ error: { code: error.code || 'bridge_error', message: error.message } }) + '\n'); process.exitCode = 1; });
}

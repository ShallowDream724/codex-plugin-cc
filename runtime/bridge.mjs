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
import { postLoopbackJson } from './loopback-http.mjs';

const entry = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const PROTOCOL = 2;
let signaturePromise;
export function runtimeSignature() {
  return signaturePromise ||= (async () => {
    const runtime = dirname(entry);
    const pkg = JSON.parse(await readFile(join(runtime, '..', 'package.json'), 'utf8'));
    const hash = createHash('sha256');
    for (const folder of ['runtime', 'shared']) {
      const directory = join(runtime, '..', folder);
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort()) {
        hash.update(`${folder}/${name}`).update(await readFile(join(directory, name)));
      }
    }
    hash.update(await readFile(join(runtime, '..', 'config', 'guidance.json')));
    hash.update(await readFile(join(runtime, '..', 'config', 'default-agent.toml')));
    hash.update(JSON.stringify(loadSettings()));
    return { protocol: PROTOCOL, version: pkg.version, build: hash.digest('hex') };
  })();
}

export async function call(endpoint, body, timeout = 35000) {
  const { status, text } = await postLoopbackJson(endpoint.port, { ...body, protocolVersion: PROTOCOL }, {
    token: endpoint.token, signal: AbortSignal.timeout(timeout),
  });
  const result = JSON.parse(text);
  if ((status < 200 || status >= 300) && !result.error) throw new Error('Local bridge refused the request.');
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
  if (metadata.protocol !== signature.protocol || metadata.version !== signature.version || metadata.build !== signature.build) return null;
  return metadata.ready ? probed.endpoint : null;
}

const restartRequired = message => Object.assign(new Error(message), { code: 'helper_restart_required' });

async function retireIdleBroker(probed, signature, { directory, deadline, pollMs }) {
  if (probed.health.protocol !== signature.protocol || !probed.health.capabilities?.includes('idle_shutdown')) {
    throw restartRequired('This session has an older helper that cannot safely upgrade itself. Let its active tasks finish, then shut down the session helper and retry.');
  }
  let stopped = false;
  while (performance.now() < deadline) {
    if (!stopped) {
      const result = await call(probed.endpoint, { operation: 'idle_shutdown' });
      if (result.reason === 'active') throw restartRequired('This session helper is running active tasks. Let them finish, then retry to upgrade the helper automatically.');
      if (!result.stopped && result.reason !== 'busy') throw restartRequired('The session helper refused an idle upgrade. Let its active tasks finish, then shut down the session helper and retry.');
      stopped = result.stopped;
    } else {
      // Endpoint deletion alone is insufficient: the old helper may still be
      // draining a handler. Wait for its independently owned service lock too.
      const endpoint = await readJson(join(directory, 'endpoint.json'), null);
      if (endpoint?.token !== probed.endpoint.token) {
        const released = await acquireOwnedLock(join(directory, 'service'));
        if (released) { await released.release(); return; }
      }
    }
    await sleep(pollMs);
  }
  throw restartRequired('The session helper is still busy or shutting down. Retry after its work finishes.');
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
        const probed = await probe(endpointPath);
        const rechecked = compatible(probed, signature);
        if (rechecked) return rechecked;
        if (probed && (probed.health.protocol !== signature.protocol || probed.health.version !== signature.version || probed.health.build !== signature.build)) {
          await retireIdleBroker(probed, signature, { directory, deadline, pollMs });
        }
        // A closing helper can stop answering before deleting its endpoint.
        // Never launch into its still-owned service slot in that gap.
        const available = await acquireOwnedLock(join(directory, 'service'));
        if (!available) { await sleep(pollMs); continue; }
        await available.release();
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
    // Host-lease expiry intentionally cleans up owned work after the host is
    // gone. Build upgrades use the separate, active-work-safe idle_shutdown.
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
  if (body.operation === 'reserve_context' && !directContextRoute(process.env)) {
    return { error: { code: 'context_export_failed', message: 'Claude uses an HTTP proxy. Include 127.0.0.1 in NO_PROXY for local context export, or use context_mode none with a task summary.' } };
  }
  const dir = ownerDirectory(body.owner);
  const endpointPath = join(dir, 'endpoint.json');
  const existing = await probe(endpointPath);
  if (body.operation === 'ui_interrupt_all' && !existing) {
    const lockExists = async name => { try { await readdir(join(dir, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
    if (await readJson(endpointPath, null) || await lockExists('service') || await lockExists('starting')) return { error: { code: 'action_status_unknown', message: 'The session helper cannot be reached; agent status is unconfirmed.' } };
    return { offline: true, results: [] };
  }
  let endpoint = body.operation === 'shutdown' ? existing?.endpoint : compatible(existing, await runtimeSignature());
  if (body.operation === 'ui_detail' && body.args?.copy !== undefined && !endpoint) {
    return { error: { code: 'copy_source_unavailable', message: 'The session helper is unavailable for reading the full content.' } };
  }
  if (body.operation === 'ui_interrupt_all' && !endpoint) return { error: { code: 'helper_restart_required', message: 'The running session helper is incompatible; agent status is unconfirmed.' } };
  if (!existing && ['observe', 'ack', 'confirm', 'release', 'shutdown'].includes(body.operation)) return { offline: true, agents: [], events: [] };
  endpoint ||= await ensureBroker(body.owner, body.cwd || process.cwd());
  try {
    const result = await call(endpoint, body, body.operation === 'wait' ? 35000 : 150000);
    if (body.operation === 'reserve_context' && !result.error) return { port: endpoint.port, ticket: result.ticket };
    return result;
  }
  catch (error) {
    if (['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'close_agent', 'answer_agent', 'ui_interrupt', 'ui_interrupt_all', 'ui_send'].includes(body.operation)) {
      return { error: { code: 'action_status_unknown', message: 'The local connection ended before confirmation. The action may already have been submitted. Use list_agents before issuing another action.' } };
    }
    throw error;
  }
}

// Host fetch follows the host's proxy configuration. Only allow a proxy when
// its bypass list explicitly covers the exact loopback address used here.
export function directContextRoute(env) {
  if (!['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some(name => env[name])) return true;
  const lists = [env.no_proxy, env.NO_PROXY].filter(Boolean);
  return lists.length > 0 && lists.every(list => list === '*' || list.split(',').some(host => host.trim() === '127.0.0.1'));
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  main().then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch(error => { process.stdout.write(JSON.stringify({ error: { code: error.code || 'bridge_error', message: error.message } }) + '\n'); process.exitCode = 1; });
}

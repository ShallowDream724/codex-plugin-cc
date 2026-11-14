#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from './appserver-client.mjs';
import { AgentController } from './agents.mjs';
import { createBroker } from './broker.mjs';
import { ownerDirectory, ensureDirectory, readJson, writeJson } from './storage.mjs';

const entry = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const removeLock = path => rmdir(path).catch(error => { if (error.code !== 'ENOENT') throw error; });

async function call(endpoint, body, timeout = 35000) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
    method: 'POST', headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok && !result.error) throw new Error('Local bridge refused the request.');
  return result;
}

async function alive(path) {
  const endpoint = await readJson(path, null);
  if (!endpoint) return null;
  try { const result = await call(endpoint, { operation: 'health' }, 1500); return result.ready ? endpoint : null; }
  catch { return null; }
}

async function ensureBroker(owner, cwd) {
  const dir = ownerDirectory(owner);
  await ensureDirectory(dir);
  const endpointPath = join(dir, 'endpoint.json');
  const existing = await alive(endpointPath);
  if (existing) return existing;
  const lockPath = join(dir, 'starting');
  let locked = false;
  try { await mkdir(lockPath); locked = true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crashed starter leaves an empty directory. Never recursively delete it.
    const info = await stat(lockPath).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 60000) {
      await removeLock(lockPath);
      try { await mkdir(lockPath); locked = true; }
      catch (retryError) { if (retryError.code !== 'EEXIST') throw retryError; }
    }
  }
  if (locked) {
    // This detached helper is scoped to this Claude session and stops when its lease expires.
    const child = spawn(process.execPath, [entry, 'serve', owner], { cwd, detached: true, windowsHide: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {});
    child.unref();
  }
  const startedAt = Date.now();
  const deadline = startedAt + 40000;
  while (Date.now() < deadline) {
    await sleep(150);
    const endpoint = await alive(endpointPath);
    if (endpoint) return endpoint;
    const failure = await readJson(join(dir, 'startup-error.json'), null);
    if (failure && failure.at > startedAt) throw new Error(failure.message);
  }
  // Only the starter removes its own lock. A later caller may start again after this bounded failure.
  if (locked) await removeLock(lockPath);
  throw new Error('Codex bridge did not start. Check that Node and Codex CLI are available.');
}

async function serve(owner) {
  const dir = ownerDirectory(owner);
  await ensureDirectory(dir);
  let lastActivity = Date.now(), shuttingDown = false;
  let server, controller, client, lease;
  const endpointPath = join(dir, 'endpoint.json');
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(lease);
    server?.close();
    await controller?.close();
    await client?.close();
    const existing = await readJson(endpointPath, null);
    if (existing?.pid === process.pid) await rm(endpointPath, { force: true });
    setTimeout(() => process.exit(0), 30).unref();
  };
  try {
    client = new AppServerClient({ command: process.env.CODEX_SUBAGENTS_CODEX_COMMAND || 'codex', cwd: process.cwd() });
    await client.start();
    controller = new AgentController({ client, statePath: join(dir, 'agents.json') });
    await controller.init();
    controller.on('controllerError', error => {
      writeJson(join(dir, 'startup-error.json'), { at: Date.now(), message: `Agent state could not be saved: ${error.message}` })
        .finally(() => shutdown()).catch(() => process.exit(1));
    });
    const token = randomBytes(32).toString('hex');
    server = createBroker({ controller, token, receipts: await readJson(join(dir, 'receipts.json'), {}),
      saveReceipts: value => writeJson(join(dir, 'receipts.json'), value),
      onActivity: () => { lastActivity = Date.now(); }, onShutdown: shutdown });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    await writeJson(endpointPath, { port: server.address().port, token, pid: process.pid, version: 1 });
    await removeLock(join(dir, 'starting'));
    lease = setInterval(() => { if (Date.now() - lastActivity > 90000) shutdown().catch(() => process.exit(1)); }, 10000);
    client.on('closed', () => { if (!shuttingDown) shutdown().catch(() => process.exit(1)); });
    process.on('SIGTERM', () => shutdown());
    process.on('SIGINT', () => shutdown());
  } catch (error) {
    await writeJson(join(dir, 'startup-error.json'), { at: Date.now(), message: error.message });
    await removeLock(join(dir, 'starting'));
    await shutdown();
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'serve') return serve(argv[1]);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const body = JSON.parse(input);
  const dir = ownerDirectory(body.owner);
  // Observation after a host restart must not restart a stopped worker without a tool call.
  let endpoint = await alive(join(dir, 'endpoint.json'));
  if (!endpoint && ['observe', 'ack', 'shutdown'].includes(body.operation)) return { offline: true, agents: [], events: [] };
  endpoint ||= await ensureBroker(body.owner, body.cwd || process.cwd());
  try { return await call(endpoint, body, body.operation === 'wait' ? 35000 : 150000); }
  catch (error) {
    if (['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'answer_agent'].includes(body.operation)) {
      return { error: { code: 'action_status_unknown', message: 'The local connection ended before confirmation. The action may already have been submitted. Use list_agents before issuing another action.' } };
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  main().then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch(error => { process.stdout.write(JSON.stringify({ error: { code: error.code || 'bridge_error', message: error.message } }) + '\n'); process.exitCode = 1; });
}

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { AppServerClient } from '../runtime/appserver-client.mjs';

function fixture({ handle, initialize = true, delayedWrites = false } = {}) {
  const child = new EventEmitter();
  const frames = [];
  const calls = [];
  const kills = [];
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let exited = false;
  child.exit = (code = 0, signal = null) => {
    if (exited) return;
    exited = true;
    child.emit('exit', code, signal);
    child.stdin.destroy();
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, signal);
  };
  child.stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(chunk.toString());
      frames.push(frame);
      if (initialize && frame.method === 'initialize') {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'fake' } })}\n`));
      }
      handle?.(frame, child);
      if (delayedWrites) setTimeout(callback, 3);
      else callback();
    },
    final(callback) { callback(); queueMicrotask(() => child.exit()); },
  });
  child.kill = (signal) => { kills.push(signal); child.exit(null, signal); return true; };
  const client = new AppServerClient({
    command: 'custom-codex', args: ['-c', 'key=literal;$(not-a-shell)'], cwd: '/fake workspace', env: { SAFE: 'value' },
    spawnImpl: (...args) => { calls.push(args); return child; },
  });
  return { client, child, calls, frames, kills };
}

test('initializes once using id 0, opts into experimental API and preserves argv', async () => {
  const { client, calls, frames } = fixture();
  try {
    assert.equal(client.ready, false);
    assert.deepEqual(await client.start(), { userAgent: 'fake' });
    assert.equal(client.ready, true);
    assert.deepEqual(await client.start(), { userAgent: 'fake' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['custom-codex', ['-c', 'key=literal;$(not-a-shell)', 'app-server', '--stdio'], {
      cwd: '/fake workspace', env: { SAFE: 'value' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    }]);
    assert.equal(frames[0].id, 0);
    assert.equal(frames[0].method, 'initialize');
    assert.deepEqual(frames[0].params.capabilities, { experimentalApi: true, requestAttestation: false });
    assert.deepEqual(frames[1], { method: 'initialized', params: {} });
    assert.equal(frames.length, 2);
  } finally { await client.close(); assert.equal(client.ready, false); }
});

test('decodes fragmented UTF-8, CRLF and multiple frames while ignoring plain diagnostics', async () => {
  const { client, child } = fixture();
  await client.start();
  try {
    const notifications = [];
    client.on('notification', (message) => notifications.push(message));
    child.stdout.write('launcher diagnostic with secret-value\n');
    const bytes = Buffer.from('{"method":"thread/started","params":{"text":"你好"}}\r\n{"method":"turn/completed"}\n');
    const split = bytes.indexOf(Buffer.from('你')) + 1;
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split, split + 1));
    child.stdout.write(bytes.subarray(split + 1));
    assert.deepEqual(notifications, [
      { method: 'thread/started', params: { text: '你好' } },
      { method: 'turn/completed', params: {} },
    ]);
  } finally { await client.close(); }
});

test('returns results, RPC error codes and handles server requests including id 0', async () => {
  const { client, child, frames } = fixture({ handle(frame, child) {
    if (frame.method === 'ok') child.stdout.write(`${JSON.stringify({ id: frame.id, result: null })}\n`);
    if (frame.method === 'bad') child.stdout.write(`${JSON.stringify({ id: frame.id, error: { code: -32001, message: 'SECRET PROMPT', data: { token: 'SECRET KEY' } } })}\n`);
  } });
  await client.start();
  try {
    assert.equal(await client.request('ok'), null);
    await assert.rejects(client.request('bad'), (error) => {
      assert.equal(error.rpcCode, -32001);
      assert.equal(error.code, -32001);
      assert.equal(error.rpcMethod, 'bad');
      assert.doesNotMatch(error.message, /SECRET/);
      assert.equal(error.data, undefined);
      return true;
    });
    const requested = once(client, 'request');
    child.stdout.write('{"id":0,"method":"item/commandExecution/requestApproval","params":{"threadId":"t"}}\n');
    assert.deepEqual((await requested)[0], { id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
    await client.respond(0, { decision: 'decline' });
    await client.reject('server-id', -32601, 'Unsupported request');
    assert.deepEqual(frames.slice(-2), [
      { id: 0, result: { decision: 'decline' } },
      { id: 'server-id', error: { code: -32601, message: 'Unsupported request' } },
    ]);
  } finally { await client.close(); }
});

test('writer conflicts identify the rejected RPC and actionable reason without exposing remote payloads', async () => {
  const threadId = '01a1de5d-17da-7630-928e-dc05db8288a1';
  const { client } = fixture({ handle(frame, child) {
    if (frame.method === 'thread/resume') child.stdout.write(`${JSON.stringify({ id: frame.id,
      error: { code: -32600, message: `thread ${threadId} already has an active writer`, data: { token: 'SECRET KEY', input: 'SECRET PROMPT' } } })}\n`);
  } });
  await client.start();
  try {
    await assert.rejects(client.request('thread/resume', { threadId }), error => {
      assert.equal(error.code, -32600); assert.equal(error.rpcMethod, 'thread/resume');
      assert.equal(error.reason, 'thread_writer_conflict');
      assert.match(error.message, /thread\/resume.*RPC -32600/);
      assert.match(error.message, /active native writer.*owning Codex connection/);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /SECRET|token|input/);
      assert.equal(error.data, undefined);
      return true;
    });
  } finally { await client.close(); }
});

test('times out a request without breaking later calls and ignores its late response', async () => {
  const { client, child, frames } = fixture({ handle(frame, child) {
    if (frame.method === 'later') child.stdout.write(`${JSON.stringify({ id: frame.id, result: 'still connected' })}\n`);
  } });
  await client.start();
  try {
    await assert.rejects(client.request('hang', {}, { timeoutMs: 10 }), { code: 'ETIMEDOUT' });
    child.stdout.write(`${JSON.stringify({ id: frames.find((frame) => frame.method === 'hang').id, result: 'late' })}\n`);
    assert.equal(await client.request('later'), 'still connected');
    await assert.rejects(client.request('invalid', {}, { timeoutMs: Infinity }), RangeError);
  } finally { await client.close(); }
});

test('rejects all outstanding requests on exit and never copies stderr into errors', async () => {
  const { client, child } = fixture();
  await client.start();
  const closed = once(client, 'closed');
  const first = assert.rejects(client.request('one'), /code 7/);
  const second = assert.rejects(client.request('two'), /code 7/);
  child.stderr.write('TOKEN=private-secret full prompt'.repeat(1000));
  child.exit(7);
  await Promise.all([first, second]);
  const [{ error }] = await closed;
  assert.doesNotMatch(error.message, /private-secret|full prompt/);
  assert.match(error.message, /stderr \d+ bytes/);
  await assert.rejects(client.request('three'), /code 7/);
  await client.close();
});

test('malformed JSON and invalid response frames fail closed without echoing their contents', async (t) => {
  for (const frame of ['{"secret":"sensitive",broken}\n', '{"id":999}\n', '[]\n']) {
    await t.test(frame.startsWith('[') ? 'array' : frame.includes('broken') ? 'bad JSON' : 'missing result', async () => {
      const { client, child } = fixture();
      await client.start();
      const pending = assert.rejects(client.request('waiting'), /app-server|App-server/);
      const closed = once(client, 'closed');
      child.stdout.write(frame);
      const [{ error }] = await closed;
      assert.doesNotMatch(error.message, /sensitive/);
      await pending;
      await client.close();
    });
  }
});

test('writes remain ordered under stdin backpressure and close is idempotent', async () => {
  const { client, frames } = fixture({ delayedWrites: true });
  await client.start();
  const writes = Array.from({ length: 20 }, (_, index) => client.respond(index, { index }));
  await Promise.all(writes);
  assert.deepEqual(frames.slice(2).map((frame) => frame.id), Array.from({ length: 20 }, (_, index) => index));
  let closedCount = 0;
  client.on('closed', () => { closedCount += 1; });
  await Promise.all([client.close(), client.close()]);
  assert.equal(closedCount, 1);
});

test('spawn errors reject initialization and close without exposing spawn error text', async () => {
  const { client, child } = fixture({ initialize: false });
  const start = assert.rejects(client.start(), (error) => error.code === 'ENOENT' && !error.message.includes('SECRET'));
  child.pid = undefined;
  child.emit('error', Object.assign(new Error('SECRET environment'), { code: 'ENOENT' }));
  await start;
  await client.close();
});

const fakeServerSource = `
  const readline = require('node:readline');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const frame = JSON.parse(line);
    if (frame.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: frame.id, result: { fake: true } }) + '\\n');
    } else if (frame.method === 'echo') {
      process.stdout.write(JSON.stringify({ id: frame.id, result: frame.params }) + '\\n');
    } else if (frame.method && frame.method !== 'initialized') {
      process.exitCode = 88;
      lines.close();
    }
  });
`;

test('spawns and cleanly closes a real Node fake server without invoking Codex', async () => {
  const client = new AppServerClient({ command: process.execPath, args: ['-e', fakeServerSource, '--'] });
  try {
    assert.deepEqual(await client.start(), { fake: true });
    assert.deepEqual(await client.request('echo', { text: 'round trip' }), { text: 'round trip' });
  } finally { await client.close(); }
});

test('Windows npm shim is resolved to Node without executing shell text', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-subagents-'));
  const entryDir = path.join(directory, 'node_modules', '@openai', 'codex', 'bin');
  await mkdir(entryDir, { recursive: true });
  // Both extensionless shell script and .cmd are normally present in npm's bin.
  await writeFile(path.join(directory, 'codex'), 'this must not execute');
  await writeFile(path.join(directory, 'codex.cmd'), '@echo this must not execute');
  await writeFile(path.join(entryDir, 'codex.js'), fakeServerSource);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = directory;
  const client = new AppServerClient({ env });
  try {
    assert.deepEqual(await client.start(), { fake: true });
    assert.equal(await client.request('echo', 'literal $(no-shell); & echo secret'), 'literal $(no-shell); & echo secret');
  } finally {
    await client.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('codex-subagents-'));
    await rm(directory, { recursive: true, force: true });
  }
});

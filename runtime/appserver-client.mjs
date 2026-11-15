import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;
const MAX_TIMER_MS = 2_147_483_647;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));

// npm's Windows .cmd shim cannot be spawned without a shell. Invoke its known
// JavaScript entry point instead, keeping every argument separate from shell code.
export function resolveCommand(command, env, cwd) {
  if (/\.[cm]?js$/i.test(command)) return { command: process.execPath, prefix: [path.resolve(cwd ?? process.cwd(), command)] };
  if (process.platform !== 'win32') return { command, prefix: [] };
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates = /[/\\]/.test(command)
    ? [path.resolve(cwd ?? process.cwd(), command)]
    : envPath.split(path.delimiter).filter(Boolean).flatMap((dir) => [
      path.join(dir, `${command}.exe`), path.join(dir, `${command}.cmd`), path.join(dir, command),
    ]);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (/\.cmd$/i.test(candidate)) {
      const entry = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (/^codex\.cmd$/i.test(path.basename(candidate)) && existsSync(entry)) {
        return { command: process.execPath, prefix: [entry] };
      }
      throw new Error('Use the Codex executable or its JavaScript entry point; command shims require a shell.');
    }
    if (/\.[cm]?js$/i.test(candidate)) return { command: process.execPath, prefix: [candidate] };
    return { command: candidate, prefix: [] };
  }
  return { command, prefix: [] };
}

/** A single-use, newline-delimited Codex app-server stdio connection. */
export class AppServerClient extends EventEmitter {
  #options;
  #child;
  #state = 'new';
  #pending = new Map();
  #nextId = 0;
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #stderrTail = Buffer.alloc(0);
  #stderrBytes = 0;
  #writeTail = Promise.resolve();
  #startPromise;
  #closePromise;
  #exitPromise;
  #resolveExit;
  #error;
  #closedEmitted = false;

  constructor({ command = 'codex', args = [], cwd, env, spawnImpl } = {}) {
    super();
    if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('command must be a nonempty string and args must contain strings.');
    }
    this.#options = { command, args: [...args], cwd, env: env ?? process.env, spawnImpl };
    this.#exitPromise = new Promise((resolve) => { this.#resolveExit = resolve; });
  }

  get ready() { return this.#state === 'ready'; }

  start() {
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== 'new') return Promise.reject(this.#error ?? new Error('App-server client is closed.'));
    this.#state = 'starting';
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start() {
    try {
      const { command, args, cwd, env, spawnImpl } = this.#options;
      const resolved = spawnImpl ? { command, prefix: [] } : resolveCommand(command, env, cwd);
      this.#child = (spawnImpl ?? spawn)(resolved.command, [...resolved.prefix, ...args, 'app-server', '--stdio'], {
        cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
      const child = this.#child;
      child.stdout.on('data', (chunk) => this.#read(chunk));
      child.stdout.on('end', () => {
        this.#read(this.#decoder.end(), true);
        if (this.#state !== 'closing' && this.#state !== 'closed') {
          this.#fail(new Error('App-server stdout ended.'));
        }
      });
      child.stdout.on('error', () => this.#fail(new Error('App-server stdout failed.')));
      child.stderr.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.#stderrBytes += bytes.length;
        this.#stderrTail = Buffer.concat([this.#stderrTail, bytes.subarray(-STDERR_TAIL_BYTES)]).subarray(-STDERR_TAIL_BYTES);
      });
      child.stderr.on('error', () => {});
      child.stdin.on('error', () => this.#fail(new Error('App-server stdin failed.')));
      child.on('error', (error) => {
        const failure = new Error(`Unable to start app-server (${error.code ?? 'spawn error'}).`);
        failure.code = error.code;
        this.#fail(failure);
        if (!child.pid) this.#resolveExit();
      });
      child.on('exit', (code, signal) => {
        const error = this.#state === 'closing' ? undefined : new Error(
          `App-server exited (${signal ? `signal ${signal}` : `code ${code}`}; stderr ${this.#stderrBytes} bytes).`,
        );
        this.#finish(error);
      });
      child.on('close', () => {
        this.#finish(this.#state === 'closing' ? undefined : this.#error ?? new Error('App-server connection closed.'));
        this.#resolveExit();
      });
      const result = await this.request('initialize', {
        clientInfo: { name: 'codex-subagents', title: 'Claude Code Codex Subagents', version: '0.2.0-rc.5' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      await this.#send({ method: 'initialized', params: {} });
      if (this.#state !== 'starting') throw this.#error ?? new Error('App-server client was closed during initialization.');
      this.#state = 'ready';
      return result;
    } catch (error) {
      this.#fail(error);
      await this.close();
      throw error;
    }
  }

  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method must be a nonempty string.'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
      return Promise.reject(new RangeError('timeoutMs must be a positive bounded integer.'));
    }
    if (!['starting', 'ready'].includes(this.#state)) {
      return Promise.reject(this.#error ?? new Error('App-server client is not running.'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error('App-server request timed out.');
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, params }, () => this.#pending.has(id)).catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  respond(id, result) {
    if (!validId(id)) return Promise.reject(new TypeError('Invalid JSON-RPC id.'));
    return this.#send({ id, result: result === undefined ? null : result });
  }

  reject(id, code, message) {
    if (!validId(id) || !Number.isInteger(code) || typeof message !== 'string') {
      return Promise.reject(new TypeError('Invalid JSON-RPC error response.'));
    }
    return this.#send({ id, error: { code, message } });
  }

  #send(message, shouldSend = () => true) {
    let frame;
    try { frame = `${JSON.stringify(message)}\n`; } catch { return Promise.reject(new Error('Unable to encode app-server message.')); }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error('App-server message exceeds frame limit.'));
    const write = this.#writeTail.then(() => {
      if (!shouldSend()) return;
      if (!['starting', 'ready'].includes(this.#state) || !this.#child?.stdin?.writable) {
        throw this.#error ?? new Error('App-server connection is closed.');
      }
      // Wait for the write callback before dispatching another frame. This bounds
      // the stream's own buffering even when write() reports backpressure.
      return new Promise((resolve, reject) => {
        const stream = this.#child.stdin;
        const onClose = () => done(new Error('App-server stdin closed.'));
        const done = (error) => {
          stream.off('close', onClose);
          error ? reject(new Error('Unable to write app-server message.')) : resolve();
        };
        stream.once('close', onClose);
        try { stream.write(frame, done); } catch (error) { done(error); }
      });
    });
    this.#writeTail = write.catch(() => {});
    return write;
  }

  #read(chunk, ended = false) {
    if (this.#state === 'closed') return;
    this.#buffer += Buffer.isBuffer(chunk) ? this.#decoder.write(chunk) : chunk;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return this.#fail(new Error('App-server frame exceeds limit.'));
      if (line) this.#frame(line);
      if (this.#state === 'closed') return;
    }
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME_BYTES) this.#fail(new Error('App-server frame exceeds limit.'));
    if (ended && this.#buffer.trim()) {
      const line = this.#buffer.trim();
      this.#buffer = '';
      this.#frame(line);
    }
  }

  #frame(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      // Some launchers print plain-text diagnostics to stdout. Never retain or
      // echo their contents; JSON-looking invalid frames are protocol failures.
      if (/^[\[{]/.test(line)) this.#fail(new Error('Malformed app-server JSON frame.'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#fail(new Error('Invalid app-server frame.'));
      return;
    }
    const hasId = hasOwn(message, 'id');
    if (hasId && !validId(message.id)) return this.#fail(new Error('Invalid app-server response id.'));
    if (hasOwn(message, 'method') && (typeof message.method !== 'string' || !message.method)) {
      return this.#fail(new Error('Invalid app-server method.'));
    }
    if (typeof message.method === 'string' && message.method) {
      if (hasOwn(message, 'result') || hasOwn(message, 'error')) return this.#fail(new Error('Invalid app-server request frame.'));
      this.emit(hasId ? 'request' : 'notification', {
        ...(hasId ? { id: message.id } : {}), method: message.method, params: message.params ?? {},
      });
      return;
    }
    if (!hasId || hasOwn(message, 'result') === hasOwn(message, 'error')) {
      return this.#fail(new Error('Invalid app-server response frame.'));
    }
    if (hasOwn(message, 'error') && (!Number.isInteger(message.error?.code) || typeof message.error?.message !== 'string')) {
      return this.#fail(new Error('Invalid app-server RPC error frame.'));
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return; // Late responses to timed-out requests are harmless.
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (hasOwn(message, 'error')) {
      const rpc = message.error;
      // Do not echo remote error text/data: either can contain prompt or secrets.
      const error = new Error(`App-server request failed (RPC ${Number.isInteger(rpc?.code) ? rpc.code : 'error'}).`);
      error.code = rpc?.code;
      error.rpcCode = rpc?.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  #fail(error) {
    this.#finish(error);
    if (this.#child) void this.close();
    else this.#resolveExit();
  }

  #finish(error) {
    if (this.#closedEmitted) return;
    this.#error = error;
    this.#state = 'closed';
    this.#buffer = '';
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('App-server connection closed.'));
    }
    this.#pending.clear();
    this.#closedEmitted = true;
    this.emit('closed', error ? { error } : {});
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (!this.#child) {
      this.#finish();
      this.#resolveExit();
      return this.#exitPromise;
    }
    if (this.#state !== 'closed') this.#state = 'closing';
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close() {
    const child = this.#child;
    child.stdin.end();
    const wait = async (ms) => {
      let timer;
      const result = await Promise.race([
        this.#exitPromise.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
      ]);
      clearTimeout(timer);
      return result;
    };
    if (!await wait(1000)) {
      child.kill('SIGTERM');
      if (!await wait(1000)) child.kill('SIGKILL');
    }
    await this.#exitPromise;
    this.#stderrTail = Buffer.alloc(0);
  }
}

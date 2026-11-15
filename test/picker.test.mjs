import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pickLocalFiles, readClipboardAttachments } from '../runtime/picker.mjs';
import { pasteAttachments } from '../hooks/bridge.js';

test('file picker returns selected paths as data and keeps directory text outside commands', async () => {
  const cwd = 'C:/work/$(not-a-command)'; let invocation;
  const launch = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { const bytes = Buffer.from(JSON.stringify({ paths: ['C:/work/测试.png', 'C:/work/report.pdf'] })); for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte])); child.emit('close', 0); });
    return child;
  };
  assert.deepEqual((await pickLocalFiles({ platform: 'win32', cwd, launch })).paths, ['C:/work/测试.png', 'C:/work/report.pdf']);
  const source = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.ok(!source.includes(cwd)); assert.equal(invocation.options.env.CODEX_SUBAGENTS_PICKER_CWD, cwd);
  assert.equal(invocation.options.windowsHide, true);
});

test('unsupported platforms request the path entry fallback without launching a dialog', async () => {
  const result = await pickLocalFiles({ platform: 'linux', launch: () => { throw new Error('must not launch'); } });
  assert.equal(result.unsupported, true); assert.deepEqual(result.paths, []);
});

test('clipboard mode uses a fixed script and returns Unicode paths without interpreting them', async () => {
  const cwd = 'C:/work/$(not-a-command)'; let invocation;
  const expected = ['C:/工作/$(image).png', 'C:/文件/报告.pdf'];
  const launch = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { const bytes = Buffer.from(JSON.stringify({ paths: expected })); for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte])); child.emit('close', 0); });
    return child;
  };
  assert.deepEqual(await readClipboardAttachments({ platform: 'win32', cwd, launch }), { paths: expected });
  const source = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.ok(!source.includes(cwd)); assert.ok(!source.includes(expected[0]));
  assert.match(source, /ContainsFileDropList/); assert.match(source, /ContainsImage/);
  assert.match(source, /NewGuid/); assert.match(source, /\$image\.Dispose\(\)/);
  assert.match(source, /Remove-Item -LiteralPath/);
  assert.equal(invocation.options.stdio[0], 'ignore');
});

test('clipboard empty, unsupported and process errors have clear results', async () => {
  const launch = (output, code = 0) => () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', code); });
    return child;
  };
  const empty = { paths: [], error: '剪贴板中没有文件或图片。' };
  assert.deepEqual(await readClipboardAttachments({ platform: 'win32', launch: launch(JSON.stringify(empty)) }), empty);
  assert.match((await readClipboardAttachments({ platform: 'linux' })).error, /不支持/);
  assert.match((await readClipboardAttachments({ platform: 'win32', launch: launch('', 1) })).error, /无法读取/);
  assert.match((await readClipboardAttachments({ platform: 'win32', launch: launch('bad json') })).error, /无法读取/);
  assert.match((await readClipboardAttachments({ platform: 'win32', launch: () => { throw Error('missing'); } })).error, /无法启动/);
});

test('clipboard bridge invokes only the fixed mode and handles process failure', async () => {
  let invocation;
  const $ = { env: { get: async () => undefined }, plugin: { root: 'C:/plugin' }, session: { cwd: async () => 'C:/工作' }, process: { run: async (args, options) => {
    invocation = { args, options }; return { stdout: JSON.stringify({ paths: ['C:/工作/图.png'] }) };
  } } };
  assert.deepEqual(await pasteAttachments($), { paths: ['C:/工作/图.png'] });
  assert.deepEqual(invocation.args, ['node', 'C:/plugin/runtime/picker.mjs', '--clipboard']);
  assert.equal(invocation.options.timeoutMs, 20000);
  $.process.run = async () => { throw Error('failed'); };
  assert.match((await pasteAttachments($)).error, /无法读取/);
});

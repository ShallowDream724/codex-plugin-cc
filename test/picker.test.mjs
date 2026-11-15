import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pickLocalFiles } from '../runtime/picker.mjs';

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

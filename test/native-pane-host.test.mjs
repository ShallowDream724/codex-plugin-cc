import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = process.env.CODEX_SUBAGENTS_TEST_CLAUDE;
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/native-pane-history.test.ts', import.meta.url));
const guard = fileURLToPath(new URL('./fixtures/offline-network-guard.cjs', import.meta.url));
const run = promisify(execFile);

test('Claude validates native desktop panes when opening saved agent histories', { skip: !cli, timeout: 60000 }, async () => {
  assert.ok(path.isAbsolute(cli), 'CODEX_SUBAGENTS_TEST_CLAUDE must point to an absolute path');
  const source = path.resolve(process.env.CODEX_SUBAGENTS_TEST_PLUGIN_DIR || root);
  const isolation = await mkdtemp(path.join(tmpdir(), 'codex-native-pane-'));
  const plugin = path.join(isolation, 'plugin');
  try {
    await mkdir(plugin);
    await Promise.all([
      ...['.claude-plugin', 'hooks', 'runtime', 'shared', 'skills', 'package.json'].map(name =>
        cp(path.join(source, name), path.join(plugin, name), { recursive: true })),
      copyFile(fixture, path.join(plugin, 'native-pane-history.test.ts')),
    ]);

    const inherited = ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'COMSPEC', 'PATHEXT', 'CLAUDE_CODE_GIT_BASH_PATH'];
    const env = Object.fromEntries(inherited.filter(key => key in process.env).map(key => [key, process.env[key]]));
    Object.assign(env, {
      HOME: isolation, USERPROFILE: isolation, TEMP: isolation, TMP: isolation,
      APPDATA: path.join(isolation, 'appdata'), LOCALAPPDATA: path.join(isolation, 'localappdata'),
      CLAUDE_CONFIG_DIR: path.join(isolation, 'config'),
      ANTHROPIC_API_KEY: 'offline-pane-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      NODE_OPTIONS: `--require="${guard.replaceAll('\\', '/')}"`,
    });
    const args = ['plugin', 'test', plugin];
    const executable = path.extname(cli).toLowerCase() === '.exe' || !path.extname(cli);
    const result = await run(executable ? cli : process.execPath, executable ? args : [cli, ...args], {
      cwd: isolation, env, timeout: 45000, windowsHide: true,
    }).catch(error => assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n')));
    const output = result.stdout + result.stderr;
    assert.match(output, /\b3 pass\b/, output);
  } finally {
    await rm(isolation, { recursive: true, force: true });
  }
});

import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
const marketplace = JSON.parse(await readFile(resolve(root, '.claude-plugin/marketplace.json'), 'utf8'));
if (pkg.version !== plugin.version || pkg.version !== marketplace.plugins[0].version || pkg.name !== plugin.name) throw new Error('Package and plugin metadata disagree.');
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { windowsHide: true, stdio: 'inherit' });
      if (result.status !== 0) throw new Error('Syntax check failed: ' + entry.name);
    }
  }
}
for (const folder of ['runtime', 'hooks', 'scripts', 'test']) await check(resolve(root, folder));
console.log('Metadata and JavaScript syntax checks passed.');

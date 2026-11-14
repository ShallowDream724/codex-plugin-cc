import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function ownerDirectory(owner, base = process.env.CODEX_SUBAGENTS_STATE_DIR || join(homedir(), '.claude', 'codex-subagents')) {
  if (typeof owner !== 'string' || !owner || owner.length > 256) throw new Error('A valid Claude session id is required.');
  return join(base, createHash('sha256').update(owner).digest('hex').slice(0, 32));
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(path, data) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function ensureDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); }

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

const removeEmpty = path => rmdir(path).catch(error => {
  if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
});

/** Publish a populated directory atomically: there is never an ownerless lock.
 * Release/recovery removes only the exact owner's entry, then an empty directory.
 * A concurrent recovery cannot unlink a replacement owner's entry.
 */
export async function acquireOwnedLock(path, { pid = process.pid, isAlive = processAlive } = {}) {
  const token = randomUUID();
  const name = `${pid}-${token}.json`;
  const candidate = `${path}.${token}.candidate`;
  await mkdir(candidate, { mode: 0o700 });
  await writeJson(join(candidate, name), { pid, token });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(candidate, path);
        let released = false;
        return { pid, token, release: async () => {
          if (released) return;
          released = true;
          await unlink(join(path, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await removeEmpty(path);
        } };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      }
      const entries = await readdir(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entries === null) continue;
      if (entries.length === 0) { await removeEmpty(path); continue; }
      if (entries.length !== 1) return null;
      const match = /^(\d+)-[a-f0-9-]+\.json$/.exec(entries[0]);
      if (!match || isAlive(Number(match[1]))) return null;
      // Never use mtime: a suspended but live helper retains its ownership.
      await unlink(join(path, entries[0])).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await removeEmpty(path);
    }
    return null;
  } finally {
    await unlink(join(candidate, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await removeEmpty(candidate);
  }
}

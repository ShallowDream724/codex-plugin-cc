import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  await writeFile(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}

export async function ensureDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); }

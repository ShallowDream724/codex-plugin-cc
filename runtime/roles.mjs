import { readFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadGuidance(file = new URL('../config/guidance.json', import.meta.url)) {
  const guidance = JSON.parse(readFileSync(file, 'utf8'));
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance) || typeof guidance.collaboration !== 'string' || !guidance.collaboration.trim()) throw new TypeError('Invalid collaboration in config/guidance.json.');
  if (!guidance.models || typeof guidance.models !== 'object' || Array.isArray(guidance.models) || Object.values(guidance.models).some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.selection_note !== 'string')) throw new TypeError('Invalid model selection notes in config/guidance.json.');
  return guidance;
}
export function defaultRole(guidance) {
  const preset = guidance.default;
  if (!preset || !['model', 'reasoning_effort', 'instructions'].every((key) => typeof preset[key] === 'string' && preset[key].trim())) throw new TypeError('Invalid default role in config/guidance.json.');
  return preset;
}

// config/read does not include auto-discovered role files. Refuse to override
// anything when metadata or a directory cannot be inspected reliably.
export async function resolveNativeDefault({ readConfig, cwd, guidance, roleFile = fileURLToPath(new URL('../config/default-agent.toml', import.meta.url)), readDirectory = readdir }) {
  let timer;
  try {
    if (!(await stat(roleFile)).isFile()) return undefined;
    const response = await Promise.race([readConfig({ cwd, includeLayers: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('config/read timeout')), 1500); })]);
    if (!response || !response.config || !Array.isArray(response.layers) || !response.origins || response.config.agents?.default != null) return undefined;
    const user = response.layers.find((layer) => layer.name?.type === 'user' && !layer.disabledReason);
    if (!user || typeof user.name.file !== 'string' || !path.isAbsolute(user.name.file) || !path.isAbsolute(cwd)) return undefined;
    const directories = new Set([path.join(path.dirname(user.name.file), 'agents')]);
    for (const layer of response.layers) {
      if (typeof layer.name?.file === 'string') {
        if (!path.isAbsolute(layer.name.file)) return undefined;
        directories.add(path.join(path.dirname(layer.name.file), 'agents'));
      }
      if (layer.name?.type === 'project') {
        if (!path.isAbsolute(layer.name.dotCodexFolder ?? '')) return undefined;
        directories.add(path.join(layer.name.dotCodexFolder, 'agents'));
      }
    }
    for (let current = path.resolve(cwd);;) {
      directories.add(path.join(current, '.codex', 'agents'));
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    for (const dir of directories) {
      try { if ((await readDirectory(dir, { withFileTypes: true })).some((entry) => entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile() || entry.name.toLowerCase().endsWith('.toml'))) return undefined; }
      catch (error) { if (error.code !== 'ENOENT') return undefined; }
    }
    const preset = defaultRole(guidance);
    return { 'agents.default.description': preset.description, 'agents.default.config_file': roleFile };
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

// Inspect only the first rollout record, never the conversation history.
export async function externalClientTools(thread) {
  const unknown = { status: 'unknown', tools: [] };
  if (typeof thread.path !== 'string' || !path.isAbsolute(thread.path)) return unknown;
  let file;
  try {
    file = await open(thread.path, 'r');
    const buffer = Buffer.alloc(1024 * 1024); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8'); const newline = text.indexOf('\n');
    if (newline < 0) return unknown;
    const record = JSON.parse(text.slice(0, newline));
    if (record.type !== 'session_meta' || record.payload?.id !== thread.id || !Array.isArray(record.payload.dynamic_tools)) return unknown;
    const names = [];
    for (const tool of record.payload.dynamic_tools) {
      if (typeof tool?.name !== 'string') return unknown;
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        for (const nested of tool.tools) { if (typeof nested?.name !== 'string') return unknown; names.push(`${tool.name}.${nested.name}`); }
      } else names.push(tool.name);
    }
    return { status: 'known', tools: names };
  } catch { return unknown; }
  finally { await file?.close().catch(() => {}); }
}

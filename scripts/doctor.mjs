import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppServerClient, resolveCommand } from '../runtime/appserver-client.mjs';

const execFileAsync = promisify(execFile);
const safeName = (value) => typeof value === 'string' && /^[\w.:-]{1,160}$/.test(value) ? value : null;
const connectionStates = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled']);

async function cliVersion(configuredCommand) {
  const { command, prefix } = resolveCommand(configuredCommand, process.env, process.cwd());
  const { stdout } = await execFileAsync(command, [...prefix, '--version'], { timeout: 10000, maxBuffer: 16384, windowsHide: true });
  // Do not echo arbitrary launcher output.
  const match = stdout.trim().match(/^codex-cli\s+([\w.+-]+)$/i);
  if (!match) throw new Error('Could not identify Codex CLI version.');
  return match[1];
}

async function listAll(client, method, params = {}) {
  const data = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await client.request(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.data)) throw new Error('Unexpected app-server list response.');
    data.push(...page.data);
    cursor = page.nextCursor;
    if (cursor != null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw new Error('Invalid app-server pagination.');
    if (cursor) seen.add(cursor);
    if (seen.size > 1000) throw new Error('App-server pagination limit exceeded.');
  } while (cursor);
  return data;
}

function summarizeModel(model) {
  const id = safeName(model?.model) ?? safeName(model?.id);
  if (!id) return null;
  return {
    id,
    default: model.isDefault === true,
    efforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((entry) => safeName(entry?.reasoningEffort)).filter(Boolean) : [],
    defaultEffort: safeName(model.defaultReasoningEffort),
  };
}

function summarizeTools(servers) {
  const result = { computerUse: [], browser: [] };
  for (const server of servers) {
    const name = safeName(server?.name);
    if (!name || !server.tools || typeof server.tools !== 'object' || Array.isArray(server.tools)) continue;
    const tools = Object.keys(server.tools).map(safeName).filter(Boolean);
    for (const [category, pattern] of [['computerUse', /(?:cua[_-]?repl|computer[_-]?use)/i], ['browser', /(?:cua[_-]?repl|browser)/i]]) {
      const matching = tools.filter((tool) => pattern.test(tool) || (pattern.test(name) && !/(?:cua[_-]?repl|computer[_-]?use|browser)/i.test(tool)));
      if (!matching.length) continue;
      result[category].push({ server: name, tools: matching, initialized: server.serverInfo != null ? true : null, runtimeStatus: connectionStates.has(server.runtimeStatus) ? server.runtimeStatus : null });
    }
  }
  return result;
}

export async function runDoctor({ command = process.env.CODEX_SUBAGENTS_CODEX_COMMAND || 'codex', createClient = (options) => new AppServerClient(options), getVersion = cliVersion } = {}) {
  const version = await getVersion(command);
  const client = createClient({ command, cwd: process.cwd() });
  try {
    await client.start();
    const models = await listAll(client, 'model/list');
    const servers = await listAll(client, 'mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
    return {
      cliVersion: version,
      models: models.map(summarizeModel).filter(Boolean),
      tools: summarizeTools(servers),
      hostConnectionVerified: false,
      notes: [
        'Tool registration and server initialization do not verify browser or computer surfaces or the host connection.',
        'Native computer use requires the official plugin to be enabled and the Codex app to remain running.',
        'The default agent disables image generation; native agents depend on provider support. Image generation and resolution were not tested.',
      ],
    };
  } finally {
    await client.close();
  }
}

export function formatReport(report) {
  const lines = [`Codex CLI: ${report.cliVersion}`, 'Visible models:'];
  if (!report.models.length) lines.push('  None reported.');
  for (const model of report.models) lines.push(`  ${model.id}${model.default ? ' (default)' : ''}: ${model.efforts.join(', ') || 'no efforts reported'}${model.defaultEffort ? ` (default: ${model.defaultEffort})` : ''}`);
  for (const [key, label] of [['computerUse', 'Computer use'], ['browser', 'Browser']]) {
    const entries = report.tools[key];
    lines.push(`${label}: ${entries.length ? 'registered' : 'no matching registered tools reported'}`);
    for (const entry of entries) lines.push(`  ${entry.server}: ${entry.tools.join(', ')}; initialized: ${entry.initialized ? 'yes' : 'not reported'}; runtime: ${entry.runtimeStatus ?? 'unknown'}`);
  }
  lines.push(...report.notes);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  if (args.some((arg) => arg !== '--json') || args.length > 1) {
    process.stderr.write('Usage: node scripts/doctor.mjs [--json]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await runDoctor();
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);
  } catch (error) {
    // Do not expose child process output or error objects that might contain configuration.
    const message = error?.code === 'ENOENT' ? 'Codex CLI not found. Install it and ensure it is on PATH.' : 'Unable to complete diagnosis. Check that the Codex CLI is installed and can start app-server.';
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

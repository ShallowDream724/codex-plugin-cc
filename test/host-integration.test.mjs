import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, copyFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.CODEX_SUBAGENTS_TEST_CLAUDE;
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const guard = fileURLToPath(new URL('./fixtures/offline-network-guard.cjs', import.meta.url));
const toolName = (name) => `mcp__codex-subagents__${name}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function installedHostHashes() {
  const hashes = {};
  // Read-only evidence for the entry point and the locally audited API modules.
  for (const file of [path.basename(cli), 'chunk-nw686kdq.js', 'chunk-rhpppw15.js', 'chunk-9grc6xh0.js']) {
    try { hashes[file] = createHash('sha256').update(await readFile(path.join(path.dirname(cli), file))).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return hashes;
}

function isolatedEnv(directory, port) {
  const env = {};
  // Deliberately exclude all credentials, OAuth/provider selections and proxies.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'COMSPEC', 'PATHEXT', 'CLAUDE_CODE_GIT_BASH_PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, 'appdata'), LOCALAPPDATA: path.join(directory, 'localappdata'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'config'), ANTHROPIC_API_KEY: 'offline-integration-dummy-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    NODE_OPTIONS: `--require="${guard.replaceAll('\\', '/')}"`, CODEX_SUBAGENTS_NODE_COMMAND: process.execPath,
    CODEX_SUBAGENTS_CODEX_COMMAND: fixture, CODEX_SUBAGENTS_STATE_DIR: path.join(directory, 'state'),
    ENABLE_TOOL_SEARCH: 'false',
  };
}

function results(messages) {
  return messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result').map((block) => {
      const text = typeof block.content === 'string' ? block.content : (block.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      try { return JSON.parse(text); } catch {
        try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; }
      }
    }).filter(Boolean);
}

function sse(res, index, call) {
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  write('message_start', { type: 'message_start', message: { id: `offline-msg-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  if (call) {
    write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `offline-tool-${index}`, name: toolName(call.name), input: {} } });
    write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
  } else {
    write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OFFLINE_HOST_COMPLETED' } });
  }
  write('content_block_stop', { type: 'content_block_stop', index: 0 });
  write('message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  write('message_stop', { type: 'message_stop' });
  res.end();
}

async function startProvider(contextMode) {
  let count = 0, failure;
  const names = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const values = results(body.messages || []);
      assert.ok(!values.some((value) => value.error), 'native plugin tools must not return an error');
      const agent = values.find((value) => value.agent_id && value.thread_id);
      const events = values.flatMap((value) => value.events || []);
      const question = events.find((event) => event.kind === 'question');
      const complete = events.find((event) => event.kind === 'completed');
      let call;
      if (count === 0) call = { name: 'spawn_agent', input: { name: 'offline-worker', message: 'OFFLINE_DELEGATED_TASK', context_mode: contextMode } };
      else if (count === 1) {
        const shapes = (body.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result').map((block) => ({ is_error: block.is_error, contentType: typeof block.content, blockTypes: Array.isArray(block.content) ? block.content.map((part) => part.type) : undefined }));
        assert.ok(agent, `spawn result must traverse the native host (parsed keys: ${JSON.stringify(values.map((value) => Object.keys(value)))}; shapes: ${JSON.stringify(shapes)}; registered plugin tool count: ${(body.tools || []).filter((tool) => tool.name?.includes('codex')).length})`);
        call = { name: 'wait_agent', input: {} };
      }
      else if (count === 2) { assert.ok(question, 'wait must return the synthetic Codex question'); call = { name: 'answer_agent', input: { target: question.agent_id, request_id: question.request_id, answer: { answers: { choice: { answers: ['Proceed'] } } } } }; }
      else if (count === 3) call = { name: 'wait_agent', input: {} };
      else { assert.ok(complete, 'wait must return synthetic completion'); assert.equal(complete.result, 'OFFLINE_CODEX_COMPLETED'); }
      names.push(call?.name || 'final');
      sse(res, count++, call);
    } catch (error) {
      failure = error;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Offline fixture assertion failed.' } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, names, check: () => { if (failure) throw failure; } };
}

async function runChild(args, options, timeoutMs = 60000) {
  const child = spawn(process.execPath, args, { ...options, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderrBytes = 0, stderrTail = '';
  child.stdout.on('data', (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; stderrTail = (stderrTail + chunk).slice(-3000); });
  child.stdin.end();
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Offline Claude integration timed out (${stderrBytes} stderr bytes).`)); }, timeoutMs);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderrBytes, diagnostic: stderrTail.match(/(?:Error|error):[^\r\n]{0,300}/)?.[0] || '' }));
    });
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

async function cleanupBrokers(base) {
  const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter((item) => item.isDirectory() && /^[a-f0-9]{32}$/.test(item.name))) {
    const endpoint = await readFile(path.join(base, dir.name, 'endpoint.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!endpoint) continue;
    await fetch(`http://127.0.0.1:${endpoint.port}/`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: '{"operation":"shutdown"}', signal: AbortSignal.timeout(2000) }).catch(() => {});
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(endpoint.pid, 0); } catch { break; }
      await pause(50);
    }
  }
  const frames = await readFile(path.join(base, 'fake-codex.jsonl'), 'utf8').then((text) => text.trim().split('\n').map(JSON.parse)).catch(() => []);
  for (const pid of frames.filter((frame) => frame.kind === 'started').map((frame) => frame.pid)) {
    let exited = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(pid, 0); } catch { exited = true; break; }
      await pause(50);
    }
    assert.ok(exited, 'the test-owned fake Codex process must stop after broker shutdown');
  }
}

function syntheticTranscript(sessionId, cwd, large = false) {
  const rows = [];
  let parentUuid = null, tick = 0;
  const add = (type, fields) => {
    const row = { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.303', uuid: randomUUID(), timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(), type, ...fields };
    rows.push(row); parentUuid = row.uuid; return row.uuid;
  };
  if (large) {
    for (let index = 0; index < 4202; index++) {
      const role = index % 2 ? 'assistant' : 'user';
      const text = `OFFLINE_WINDOW_MESSAGE_${index}`;
      add(role, { message: role === 'user' ? { role, content: text } : { id: `window-${index}`, type: 'message', role, content: [{ type: 'text', text }], model: 'offline', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    }
    return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  }
  add('user', { message: { role: 'user', content: 'OFFLINE_ORIGINAL_DISCARDED' } });
  const retained = add('assistant', { message: { id: 'retained', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OFFLINE_EXPLICIT_PRESERVED' }], model: 'offline', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  for (let index = 1; index <= 5; index++) {
    const boundary = randomUUID();
    add('system', { uuid: boundary, subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 100, preservedMessages: { anchorUuid: boundary, uuids: [retained] } } });
    add('user', { isCompactSummary: true, isMeta: false, message: { role: 'user', content: `OFFLINE_SUMMARY_${index}` } });
    add('assistant', { message: { id: `old-${index}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: index === 5 ? 'OFFLINE_CURRENT_RESPONSE' : `OFFLINE_DISCARDED_RESPONSE_${index}` }], model: 'offline', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  }
  add('user', { message: { role: 'user', content: 'OFFLINE_NEW_MESSAGE' } });
  add('assistant', { message: { id: 'historical-tool', type: 'message', role: 'assistant', content: [
    { type: 'tool_use', id: 'offline-read', name: 'Read', input: { file_path: 'OFFLINE_TOOL_INPUT_MARKER' } },
    { type: 'tool_use', id: 'offline-second-read', name: 'Read', input: { file_path: 'OFFLINE_SECOND_TOOL_INPUT' } },
  ], model: 'offline', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } });
  add('user', { message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'offline-read', content: 'x'.repeat(16000) + 'OFFLINE_LONG_TOOL_RESULT_TAIL' },
    { type: 'tool_result', tool_use_id: 'offline-second-read', content: 'OFFLINE_SECOND_TOOL_RESULT' },
  ] } });
  add('assistant', { message: { id: 'pre-resume-final', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OFFLINE_READY_TO_RESUME' }], model: 'offline', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

test('real Claude host runs native hook capture and local Codex question lifecycle offline', { skip: !cli, timeout: 180000 }, async (t) => {
  assert.ok(path.isAbsolute(cli), 'CODEX_SUBAGENTS_TEST_CLAUDE must be an absolute cli.js path');
  const installationBefore = await installedHostHashes();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-host-offline-'));
  const transportOnly = process.env.CODEX_SUBAGENTS_TEST_TRANSPORT_ONLY === '1';
  try {
    for (const scenario of transportOnly ? ['plain'] : ['plain', 'compacted', 'large']) {
      const compacted = scenario === 'compacted', inheritedContext = scenario !== 'plain';
      let succeeded = false;
      await t.test(compacted ? 'five compaction boundaries retain available effective context' : inheritedContext ? '4202 historical messages respect the host 4096 record cap' : 'plain native hook round trip', { timeout: 75000 }, async (scenarioTest) => {
      const directory = path.join(temporary, scenario);
      await mkdir(directory, { recursive: true });
      const provider = await startProvider(inheritedContext ? 'available' : 'none');
      const env = isolatedEnv(directory, provider.port);
      env.CODEX_SUBAGENTS_CODEX_COMMAND = path.join(directory, 'fake-codex.mjs');
      await copyFile(fixture, env.CODEX_SUBAGENTS_CODEX_COMMAND);
      await chmod(env.CODEX_SUBAGENTS_CODEX_COMMAND, 0o700);
      const sessionId = randomUUID();
      const args = [cli, '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--plugin-dir', root, '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--system-prompt', 'Run the local offline integration fixture.'];
      let transcriptRows = [];
      if (inheritedContext) {
        const transcript = path.join(directory, `${sessionId}.jsonl`);
        const content = syntheticTranscript(sessionId, directory, scenario === 'large');
        transcriptRows = content.trim().split('\n').map(JSON.parse);
        await writeFile(transcript, content);
        args.push('--resume', transcript, '--fork-session');
      } else args.push('--session-id', sessionId);
      args.push('OFFLINE_HOST_USER_REQUEST');
      try {
        const result = await runChild(args, { cwd: directory, env });
        provider.check();
        assert.equal(result.code, 0, `isolated Claude must exit successfully (${result.stderrBytes} stderr bytes; ${result.diagnostic})`);
        assert.ok(result.stdout.includes('OFFLINE_HOST_COMPLETED'), 'host must reach the final synthetic response');
        assert.deepEqual(provider.names, ['spawn_agent', 'wait_agent', 'answer_agent', 'wait_agent', 'final']);
        const frames = (await readFile(path.join(env.CODEX_SUBAGENTS_STATE_DIR, 'fake-codex.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        const history = frames.find((frame) => frame.method === 'thread/inject_items')?.params.items;
        assert.ok(frames.some((frame) => frame.id === 1000 && frame.result?.answers?.choice?.answers?.[0] === 'Proceed'), 'answer_agent must reply to the Codex server request');
        if (inheritedContext) {
          assert.ok(Array.isArray(history), 'native session.messages snapshot must reach Codex thread/inject_items');
          const inherited = JSON.stringify(history);
          const stateDirs = (await readdir(env.CODEX_SUBAGENTS_STATE_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name));
          assert.equal(stateDirs.length, 1, 'one isolated Claude session must own this scenario');
          const saved = JSON.parse(await readFile(path.join(env.CODEX_SUBAGENTS_STATE_DIR, stateDirs[0].name, 'agents.json'), 'utf8'));
          const stats = saved.agents[0].snapshot.stats;
          assert.equal(stats.inputMessages, history.length - 1, 'each fixture API message must remain one history item plus the notice');
          assert.ok(stats.inputMessages <= 4096, 'inheritance must stay within the public host API limit');
          assert.equal(stats.scope, 'host_available');
          assert.equal(stats.hostMessageLimit, 4096);
          assert.equal(saved.agents[0].snapshot.complete, undefined, 'available context must not claim complete inheritance');
          const hostRoles = history.slice(1).reduce((counts, item) => { counts[item.role]++; return counts; }, { user: 0, assistant: 0 });
          const synthetic = transcriptRows.reduce((counts, row) => { if (row.type === 'user' || row.type === 'assistant') counts[row.type]++; else if (row.subtype === 'compact_boundary') counts.system_boundary++; return counts; }, { user: 0, assistant: 0, system_boundary: 0 });
          scenarioTest.diagnostic(JSON.stringify({ scenario, synthetic, hostApi: { messages: stats.inputMessages, ...hostRoles }, injectedHistoryItems: history.length, noticeItems: 1, toolUses: stats.toolUses, toolResults: stats.toolResults }));
          assert.ok(inherited.includes('OFFLINE_HOST_USER_REQUEST'), 'current user message must be inherited');
          if (compacted) {
            for (const marker of ['OFFLINE_SUMMARY_5', 'OFFLINE_EXPLICIT_PRESERVED', 'OFFLINE_NEW_MESSAGE', 'OFFLINE_TOOL_INPUT_MARKER', 'OFFLINE_LONG_TOOL_RESULT_TAIL', 'OFFLINE_SECOND_TOOL_INPUT', 'OFFLINE_SECOND_TOOL_RESULT']) assert.ok(inherited.includes(marker), `effective snapshot must preserve ${marker}`);
            for (const marker of ['OFFLINE_ORIGINAL_DISCARDED', ...[1, 2, 3, 4].map((index) => `OFFLINE_SUMMARY_${index}`), ...[1, 2, 3, 4].map((index) => `OFFLINE_DISCARDED_RESPONSE_${index}`)]) assert.ok(!inherited.includes(marker), `effective snapshot must exclude ${marker}`);
            assert.equal(stats.toolResults, 2, 'two results in one user message remain two result blocks');
            assert.ok(stats.toolUses >= 2, 'two calls in one assistant message remain separate tool blocks');
          } else {
            assert.ok(!inherited.includes('OFFLINE_WINDOW_MESSAGE_0"'), 'the host-limited earliest message must be absent');
            for (const index of [2100, 4201]) assert.ok(inherited.includes(`OFFLINE_WINDOW_MESSAGE_${index}`), `available snapshot must retain message ${index}`);
          }
        } else assert.equal(history, undefined, 'context_mode none must not inject context');
        succeeded = true;
      } finally {
        await cleanupBrokers(env.CODEX_SUBAGENTS_STATE_DIR);
        provider.server.closeAllConnections();
        await new Promise((resolve) => provider.server.close(resolve));
      }
      });
      if (!succeeded) break; // Diagnose plain startup before spending time on recovery.
    }
  } finally {
    assert.deepEqual(await installedHostHashes(), installationBefore, 'installed host file hashes must remain unchanged');
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('codex-host-offline-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

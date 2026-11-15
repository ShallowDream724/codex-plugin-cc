import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReport, runDoctor } from '../scripts/doctor.mjs';

test('reports paginated catalog and registered tools without exposing unrelated fields', async () => {
  const calls = [];
  let closed = false;
  const client = {
    async start() { calls.push('initialize'); },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'model/list') return params.cursor
        ? { data: [{ model: 'model-b', supportedReasoningEfforts: [] }], nextCursor: null }
        : { data: [{ model: 'model-a', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'SECRET' }], defaultReasoningEffort: 'high' }], nextCursor: 'next' };
      return { data: [{ name: 'unified-computer-use', tools: { mcp__cua_repl__js: { inputSchema: { secret: 'SECRET' } }, mcp__browser__open: {} }, serverInfo: { name: 'server' }, runtimeStatus: null, toolsError: 'SECRET', resources: [{ uri: 'SECRET' }] }], nextCursor: null };
    },
    async close() { closed = true; },
  };
  const report = await runDoctor({ createClient: () => client, getVersion: async () => '0.169.0' });
  assert.equal(closed, true);
  assert.deepEqual(calls, ['initialize', ['model/list', {}], ['model/list', { cursor: 'next' }], ['mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }]]);
  assert.deepEqual(report.models, [
    { id: 'model-a', default: true, efforts: ['high'], defaultEffort: 'high' },
    { id: 'model-b', default: false, efforts: [], defaultEffort: null },
  ]);
  assert.equal(report.tools.computerUse[0].initialized, true);
  assert.equal(report.tools.browser[0].initialized, true);
  assert.equal(report.hostConnectionVerified, false);
  assert.doesNotMatch(JSON.stringify(report) + formatReport(report), /SECRET/);
  assert.match(formatReport(report), /host connection/);
});

test('closes client when initialization or discovery fails', async () => {
  for (const failedStage of ['start', 'request']) {
    let closed = false;
    const client = {
      async start() { if (failedStage === 'start') throw new Error('failure'); },
      async request() { throw new Error('failure'); },
      async close() { closed = true; },
    };
    await assert.rejects(runDoctor({ createClient: () => client, getVersion: async () => '0.169.0' }));
    assert.equal(closed, true);
  }
});

test('rejects repeated pagination cursors and reports missing tools without claiming connection', async () => {
  let closed = false;
  const client = { async start() {}, async request() { return { data: [], nextCursor: 'same' }; }, async close() { closed = true; } };
  await assert.rejects(runDoctor({ createClient: () => client, getVersion: async () => '0.169.0' }), /pagination/);
  assert.equal(closed, true);
  const emptyClient = { async start() {}, async request() { return { data: [] }; }, async close() {} };
  const report = await runDoctor({ createClient: () => emptyClient, getVersion: async () => '0.169.0' });
  assert.match(formatReport(report), /no matching registered tools reported/);
  assert.equal(report.hostConnectionVerified, false);
});

test('uses configured command for version and app-server and recognizes the unified CUA entry', async () => {
  const previous = process.env.CODEX_SUBAGENTS_CODEX_COMMAND;
  process.env.CODEX_SUBAGENTS_CODEX_COMMAND = '/fake/custom-codex';
  const seen = [];
  const client = {
    async start() {},
    async request(method) {
      return method === 'model/list' ? { data: [] } : { data: [{ name: 'unified-computer-use', tools: { mcp__cua_repl__js: {} }, serverInfo: null }] };
    },
    async close() {},
  };
  try {
    const report = await runDoctor({
      getVersion: async (command) => { seen.push(command); return '0.169.0'; },
      createClient: (options) => { seen.push(options.command); return client; },
    });
    assert.deepEqual(seen, ['/fake/custom-codex', '/fake/custom-codex']);
    assert.deepEqual(report.tools.computerUse[0].tools, ['mcp__cua_repl__js']);
    assert.deepEqual(report.tools.browser[0].tools, ['mcp__cua_repl__js']);
    assert.equal(report.tools.browser[0].initialized, null);
    assert.equal(report.hostConnectionVerified, false);
    assert.match(formatReport(report), /surfaces or the host connection/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_SUBAGENTS_CODEX_COMMAND;
    else process.env.CODEX_SUBAGENTS_CODEX_COMMAND = previous;
  }
});

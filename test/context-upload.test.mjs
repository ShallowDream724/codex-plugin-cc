import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { call, directContextRoute } from '../runtime/bridge.mjs';
import { createBroker } from '../runtime/broker.mjs';
import { ContextUploads, MAX_CONTEXT_BYTES } from '../runtime/context-uploads.mjs';
import { requestBridge } from '../hooks/bridge.js';

async function setup(t) {
  const actions = [], controls = [], pages = [];
  const controller = { async dispatch(operation, args) {
    actions.push({ operation, args });
    return { agent_id: 'new' };
  } };
  const token = 'control-only';
  const server = createBroker({ controller, token, requiredProtocol: 2 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const host = {
    plugin: { root: '/plugin' }, env: { get: async () => undefined },
    session: { cwd: async () => '/work', id: async () => 'owner' },
    process: { run: async (_argv, options) => {
      const body = JSON.parse(options.stdin);
      controls.push(body);
      const response = await call({ token, port }, body);
      if (body.operation === 'reserve_context') response.port = port;
      return { stdout: JSON.stringify(response), exitCode: 0 };
    } },
    http: { fetch: async (url, options) => {
      const response = await fetch(url, options);
      pages.push({ url, options });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } },
  };
  const spawn = messages => requestBridge(host, 'spawn_agent', { message: 'task', context_mode: 'available' },
    { requestId: 'call', context: { source: 'claude_api_available', messages } });
  return { host, actions, controls, pages, token, port, spawn };
}

test('available context posts complete messages to the host HTTP API and starts only with the full snapshot', async t => {
  const { actions, controls, pages, token, port, spawn } = await setup(t);
  const marker = 'Synthetic file reference: .claude/settings.json';
  const messages = [
    { role: 'user', content: marker + 'a'.repeat(2_500_000) },
    { role: 'assistant', content: 'b'.repeat(2_500_000) },
  ];
  assert.deepEqual(await spawn(messages), { agent_id: 'new' });
  assert.deepEqual(controls.map(item => item.operation), ['reserve_context', 'spawn_agent']);
  assert.ok(!JSON.stringify(controls).includes(marker));
  assert.equal(pages.length, 2);
  assert.deepEqual(JSON.parse(pages.map(page => page.options.body).join('')), messages);
  assert.deepEqual(pages.map(page => page.options.headers['x-context-offset']), ['0', String(pages[0].options.body.length)]);
  assert.equal(pages[0].url, `http://127.0.0.1:${port}/context`);
  assert.notEqual(pages[0].options.headers.authorization, 'Bearer ' + token);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].args.snapshot.history.slice(1).map(item => item.content[0].text), messages.map(item => item.content));
  assert.equal((await fetch(pages[0].url, pages[0].options)).status, 403, 'consumed upload ticket expires');
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, pages[0].options)).status, 403, 'upload ticket cannot issue broker controls');
});

test('an interrupted upload never starts a task or replays the context over process stdin', async t => {
  const { host, actions, controls, spawn } = await setup(t);
  const original = host.http.fetch;
  let attempts = 0;
  host.http.fetch = (...args) => {
    if (++attempts === 2) throw new Error('organization policy refused this request');
    return original(...args);
  };
  const first = 'first page'.repeat(400_000), second = 'second page'.repeat(300_000);
  const result = await spawn([{ role: 'user', content: first }, { role: 'assistant', content: second }]);
  assert.equal(result.error.code, 'context_export_failed');
  assert.match(result.error.message, /organization policy refused/);
  assert.deepEqual(controls.map(item => item.operation), ['reserve_context', 'discard_context']);
  assert.ok(!JSON.stringify(controls).includes('first page'));
  assert.equal(actions.length, 0);
});

test('a rejected upload reports the broker reason and releases the reservation', async t => {
  const { host, controls, actions, spawn } = await setup(t);
  const message = 'The Claude context exceeds the 64 MiB transport limit.';
  host.http.fetch = async () => ({ ok: false, status: 400, text: JSON.stringify({ error: { code: 'context_export_failed', message } }) });
  const result = await spawn([{ role: 'user', content: 'Task background' }]);
  assert.equal(result.error.code, 'context_export_failed');
  assert.ok(result.error.message.includes(message));
  assert.deepEqual(controls.map(control => control.operation), ['reserve_context', 'discard_context']);
  assert.equal(actions.length, 0);
});

test('a single large tool result retains Unicode characters on a transport boundary', async t => {
  const { pages, actions, spawn } = await setup(t);
  const toolResult = { type: 'tool_result', tool_use_id: 'old-tool-id', content: '' };
  const messages = [{ role: 'user', content: [toolResult] }];
  const limit = 4 * 1024 * 1024;
  const contentStart = JSON.stringify(messages).lastIndexOf('""') + 1;
  toolResult.content = 'x'.repeat(limit - contentStart - 1) + '🌏' + 'y'.repeat(1_000_000);
  assert.deepEqual(await spawn(messages), { agent_id: 'new' });
  assert.equal(pages[0].options.body.length, limit - 1);
  assert.ok(pages[1].options.body.startsWith('🌏'));
  const evidence = actions[0].args.snapshot.history[1].content[0].text;
  assert.deepEqual(JSON.parse(evidence.slice(evidence.indexOf('\n') + 1)), toolResult);
});

test('only an unproxied host or an explicit bypass of the loopback upload address is accepted', () => {
  assert.equal(directContextRoute({}), true);
  for (const key of ['HTTP_PROXY', 'https_proxy', 'ALL_PROXY']) {
    const proxy = { [key]: 'http://proxy.invalid' };
    for (const bypass of ['', 'localhost', ' * ', '.127.0.0.1.example', '127.0.0.1:80']) {
      assert.equal(directContextRoute({ ...proxy, NO_PROXY: bypass }), false);
    }
    assert.equal(directContextRoute({ ...proxy, no_proxy: 'localhost,127.0.0.1' }), true);
    assert.equal(directContextRoute({ ...proxy, NO_PROXY: '*' }), true);
    assert.equal(directContextRoute({ ...proxy, NO_PROXY: '*', no_proxy: 'localhost' }), false);
  }
});

test('a ticket accepts an ordered, size-bounded stream and belongs to one tool call', () => {
  const uploads = new ContextUploads();
  const ticket = uploads.reserve('call', 0, 2);
  assert.throws(() => uploads.reserve('other', 1, MAX_CONTEXT_BYTES + 1), /64 MiB/);
  assert.throws(() => uploads.append(ticket, '1', ']', 1), /out-of-order/);
  assert.throws(() => uploads.append(ticket, '0', '[]', MAX_CONTEXT_BYTES + 1), /64 MiB/);
  assert.deepEqual(uploads.append(ticket, '0', '[', 1), { received: 1 });
  assert.throws(() => uploads.take(ticket, 'call'), /full Claude context/);
  assert.deepEqual(uploads.append(ticket, '1', ']', 1), { received: 2 });
  assert.throws(() => uploads.take(ticket, 'other'), /full Claude context/);
  assert.deepEqual(uploads.take(ticket, 'call').messages, []);
  assert.throws(() => uploads.take(ticket, 'call'), /full Claude context/);
  assert.equal(uploads.pending, 0);
});

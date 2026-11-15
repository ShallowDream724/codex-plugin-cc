import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../hooks/register.js';
import { closeUI } from '../hooks/ui.js';

async function setup(respond) {
  closeUI();
  const hooks = [], commands = [], tools = [], calls = [];
  register((...args) => hooks.push({ event: args[0], filter: args.length === 3 ? args[1] : {}, fn: args.at(-1) }));
  const $ = {
    session: { id: async () => 'owner', cwd: async () => 'C:/work', messages: async () => [] },
    plugin: { root: 'C:/plugin' }, env: { get: async () => undefined },
    tool: { register: async spec => tools.push(spec) }, command: { register: async spec => commands.push(spec) },
    clock: { every: () => ({ cancel() {} }) },
    prompt: { submit() { throw new Error('Stop must never invoke the model'); } },
    process: { run: async (_argv, options) => {
      const request = JSON.parse(options.stdin); calls.push(request);
      return { stdout: JSON.stringify(await respond(request)), exitCode: 0 };
    } },
  };
  await hooks.find(h => h.event === 'session.start').fn($, {}, async e => e);
  const run = () => hooks.find(h => h.event === 'command.run' && h.filter.command === 'codex-stop').fn($, {}, () => { throw new Error('Command must be handled locally'); });
  return { run, commands, tools, calls };
}

test('stop command runs immediately without a model and reports confirmed and pending outcomes', async () => {
  const h = await setup(async ({ operation }) => operation === 'ui_list' ? { agents: [] } : { results: [
    { agent_id: 'a', user_control_status: 'stopped' },
    { agent_id: 'b', user_control_status: 'stopping' },
    { agent_id: 'c', user_control_status: 'unconfirmed' },
  ] });
  assert.equal(h.commands.find(c => c.name === 'codex-stop').immediate, true);
  assert.equal(h.tools.length, 9);
  const result = await h.run();
  assert.match(result.text, /已停止 1 个/);
  assert.match(result.text, /正在停止 1 个/);
  assert.match(result.text, /停止未确认 1 个/);
  assert.equal(result.context, undefined);
  assert.deepEqual(h.calls.map(c => c.operation), ['ui_interrupt_all', 'ui_list']);
  assert.ok(h.calls[0].requestId);
});

test('offline and unconfirmed stop commands do not start a helper to refresh the sidebar', async () => {
  for (const result of [{ offline: true, results: [] }, { error: { code: 'action_status_unknown', message: 'unreachable' } }]) {
    const h = await setup(async () => result);
    const answer = await h.run();
    assert.match(answer.text, result.offline ? /助手未运行/ : /未确认.*unreachable/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].operation, 'ui_interrupt_all');
  }
});

test('concurrent stop command invocations share one pending operation', async () => {
  let release;
  const h = await setup(async ({ operation }) => operation === 'ui_list' ? { agents: [] } : new Promise(resolve => { release = resolve; }));
  const first = h.run(), second = h.run();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release({ results: [{ agent_id: 'a', status: 'stopped' }] });
  assert.deepEqual(await first, await second);
  assert.equal(h.calls.filter(c => c.operation === 'ui_interrupt_all').length, 1);
});

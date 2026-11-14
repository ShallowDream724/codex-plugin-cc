import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../runtime/agents.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
class MockClient extends EventEmitter {
  calls = []; replies = []; rejected = []; threadCount = 0; turnCount = 0;
  async request(method, params, options) {
    this.calls.push({ method, params: structuredClone(params) });
    if (this.handler) {
      const response = this.handler(method, params, options);
      if (response !== undefined) return response;
    }
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threadCount}` } };
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.turnCount}`, status: 'inProgress' };
      this.note('turn/started', { threadId: params.threadId, turn });
      return { turn };
    }
    return {};
  }
  async respond(id, result) { this.replies.push({ id, result: structuredClone(result) }); }
  async reject(id, code, message) { this.rejected.push({ id, code, message }); }
  note(method, params) { this.emit('notification', { method, params }); }
  ask(id, method, params) { this.emit('request', { id, method, params }); }
  complete(threadId = 'thread-1', turnId = 'turn-1', status = 'completed', error) {
    this.note('turn/completed', { threadId, turn: { id: turnId, status, error } });
  }
}
async function setup(t, options = {}) {
  const client = new MockClient();
  const controller = new AgentController({ client, ...options });
  await controller.init();
  t.after(() => controller.close());
  return { client, controller, spawn: (args = {}) => controller.dispatch('spawn_agent', { message: 'Solve task', cwd: '/workspace', context_mode: 'none', ...args }) };
}
const pendingQuestion = (threadId = 'thread-1', turnId = 'turn-1') => ({ threadId, turnId, itemId: 'q-item', questions: [{ id: 'choice', header: 'Choose', question: 'Which?' }], isBlocking: true });

test('default available context requires a validated snapshot and returns its summary only', async (t) => {
  const { client, controller } = await setup(t);
  const args = { message: 'Work', cwd: '/workspace' };
  await assert.rejects(controller.dispatch('spawn_agent', args), /validated snapshot/);
  await assert.rejects(controller.dispatch('spawn_agent', { ...args, context_mode: 'all' }), /context_mode/);
  await assert.rejects(controller.dispatch('spawn_agent', { ...args, snapshot: { history: [] } }), /validated snapshot/);
  assert.equal(client.calls.length, 0);
  const snapshot = { history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE AVAILABLE HISTORY' }] }], digest: 'digest', stats: { messages: 1 } };
  const agent = await controller.dispatch('spawn_agent', { ...args, snapshot });
  assert.equal(client.calls.filter((call) => call.method === 'thread/inject_items').length, 1);
  assert.deepEqual(agent.context_snapshot, { digest: 'digest', stats: { messages: 1 } });
  assert.doesNotMatch(JSON.stringify(agent), /PRIVATE AVAILABLE HISTORY/);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE AVAILABLE HISTORY/);
});

test('none context skips injection and cwd accepts absolute POSIX and Windows paths only', async (t) => {
  const { client, controller, spawn } = await setup(t);
  for (const cwd of ['relative/path', 'C:relative', './workspace']) await assert.rejects(spawn({ cwd }), /absolute path/);
  assert.equal(client.calls.length, 0);
  for (const cwd of ['/nonexistent/workspace', 'C:\\nonexistent\\workspace', '\\\\server\\share\\workspace']) {
    const agent = await spawn({ cwd });
    assert.equal(agent.context_snapshot, null);
  }
  assert.equal(client.calls.filter((call) => call.method === 'thread/inject_items').length, 0);
  assert.equal(controller.snapshot().agents[0].context_snapshot, null);
});

test('spawn uses user sandbox defaults, injects snapshot once, queues mailbox, and resumes same thread', async (t) => {
  const { client, controller, spawn } = await setup(t);
  const snapshot = { history: [{ type: 'message', role: 'user', content: [] }], digest: 'hash', stats: { count: 1 } };
  const agent = await spawn({ model: 'dynamic-model', reasoning_effort: 'high', context_mode: 'available', snapshot });
  assert.deepEqual(agent.context_snapshot, { digest: snapshot.digest, stats: snapshot.stats });
  assert.deepEqual(controller.snapshot().agents[0].context_snapshot, agent.context_snapshot);
  assert.equal(Object.hasOwn((await controller.dispatch('list_agents')).agents[0], 'context_snapshot'), false);
  const start = client.calls[0].params;
  assert.equal(start.serviceTier, 'default'); assert.equal(start.ephemeral, false);
  assert.equal(start.model, 'dynamic-model'); assert.equal(start.config['features.default_mode_request_user_input'], true);
  assert.equal(start.dynamicTools[0].type, 'function'); assert.equal(start.dynamicTools[0].name, 'notify_parent');
  for (const key of ['sandbox', 'approvalPolicy', 'baseInstructions', 'developerInstructions', 'multiAgentMode']) assert.equal(Object.hasOwn(start, key), false);
  assert.deepEqual(client.calls[1], { method: 'thread/inject_items', params: { threadId: 'thread-1', items: snapshot.history } });
  assert.equal(client.calls[2].params.effort, 'high'); assert.equal(client.calls[2].params.serviceTierForTurn, 'default');
  assert.match(client.calls[2].params.input[0].text, /Claude is your parent/);
  client.complete(); await tick();
  assert.equal((await controller.dispatch('send_message', { target: agent.id, message: 'hello' })).status, 'queued');
  assert.deepEqual(client.calls.at(-1), { method: 'thread/inject_items', params: { threadId: 'thread-1',
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] } });
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  await controller.dispatch('followup_task', { target: agent.id, message: 'second task' });
  assert.equal(client.calls.filter((c) => c.method === 'thread/start').length, 1);
  assert.equal(client.calls.filter((c) => c.method === 'thread/inject_items').length, 2);
  assert.deepEqual(client.calls.find((c) => c.method === 'thread/resume').params, { threadId: 'thread-1', excludeTurns: true });
  assert.equal(client.calls.at(-1).params.input[0].text, 'second task');
});

test('completed final messages and requests before RPC replies are not lost', async (t) => {
  const { client, controller, spawn } = await setup(t);
  client.handler = (method, params) => {
    if (method === 'thread/start') {
      client.ask('early-q', 'item/tool/requestUserInput', pendingQuestion());
      return { thread: { id: 'thread-1' } };
    }
    if (method === 'turn/start') {
      client.note('turn/started', { threadId: params.threadId, turn: { id: 'turn-1' } });
      client.note('item/completed', { threadId: params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Done early' } });
      client.complete();
      return { turn: { id: 'turn-1' } };
    }
  };
  const agent = await spawn(); await tick();
  assert.equal(agent.status, 'completed');
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'question').length, 1);
  assert.deepEqual(controller.eventsAfter(0).filter((e) => e.kind === 'completed').map((e) => e.result), ['Done early']);
  client.complete(); assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'completed').length, 1);
});

test('nested threads and normal tool output never become parent events', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('item/completed', { threadId: 'nested', turnId: 'nested-turn', item: { type: 'agentMessage', phase: 'finalAnswer', text: 'SECRET CHILD RESULT' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', aggregatedOutput: 'SECRET TOOL OUTPUT' } });
  client.note('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'collabAgentToolCall', prompt: 'SECRET NESTED PROMPT' } });
  client.ask('nested-request', 'item/tool/requestUserInput', pendingQuestion('nested', 'nested-turn'));
  await tick();
  assert.equal(controller.eventsAfter(0).length, 0);
  assert.equal(controller.snapshot().agents[0].activity, 'delegated to subagent');
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /SECRET/);
  assert.equal(client.rejected[0].id, 'nested-request');
});

test('native questions need exact IDs, answer once, and continue original turn', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.ask(7, 'item/tool/requestUserInput', pendingQuestion()); await tick();
  assert.equal(controller.snapshot().agents[0].status, 'waiting');
  assert.deepEqual(controller.eventsAfter(0)[0].reply_format, { answers: { choice: { answers: ['<text>'] } } });
  assert.deepEqual((await controller.dispatch('list_agents')).agents[0].pending_requests[0].reply_format, controller.eventsAfter(0)[0].reply_format);
  await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'bypass question' }), /answer_agent/);
  await assert.rejects(controller.dispatch('followup_task', { target: agent.id, message: 'bypass question' }), /answer_agent/);
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 7, answer: { answers: { wrong: { answers: ['x'] } } } }));
  assert.equal(controller.snapshot().agents[0].pending_requests.length, 1);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 7, answer: { answers: { choice: { answers: ['selected'] } } } });
  assert.deepEqual(client.replies[0], { id: 7, result: { answers: { choice: { answers: ['selected'] } } } });
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 7, answer: {} }));
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(controller.snapshot().agents[0].status, 'running');
});

test('all approval families require explicit valid protocol response', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  const cases = [
    ['item/commandExecution/requestApproval', { decision: 'accept' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp'], write: null } }, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'cancel', content: null, _meta: null }],
  ];
  const formats = [
    { decision: 'accept|acceptForSession|decline|cancel' },
    { decision: 'accept|acceptForSession|decline|cancel' },
    { permissions: '<granted subset of requested permissions>', scope: 'turn|session' },
    { action: 'accept|decline|cancel', content: '<form data or null>', _meta: null },
  ];
  for (const [index, [method, answer]] of cases.entries()) {
    client.ask(index, method, { threadId: 'thread-1', turnId: 'turn-1', itemId: 'approval' }); await tick();
    assert.deepEqual(controller.eventsAfter(0).at(-1).reply_format, formats[index]);
    assert.deepEqual((await controller.dispatch('list_agents')).agents[0].pending_requests[0].reply_format, formats[index]);
    assert.equal(client.replies.length, index);
    await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: index, answer: { decision: 'allow' } }));
    await controller.dispatch('answer_agent', { target: agent.id, request_id: index, answer });
    assert.deepEqual(client.replies.at(-1).result, answer);
  }
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'approval').length, 4);
  client.ask('limited', 'item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', availableDecisions: ['decline', 'cancel'] });
  assert.deepEqual(controller.eventsAfter(0).at(-1).reply_format, { decision: '<one value from availableDecisions>' });
});

test('answers are isolated to their owning agent', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn(); const other = await spawn();
  client.ask('private', 'item/tool/requestUserInput', pendingQuestion());
  await assert.rejects(controller.dispatch('answer_agent', { target: other.id, request_id: 'private', answer: { answers: { choice: { answers: ['x'] } } } }));
  assert.equal(client.replies.length, 0);
});

test('external request IDs are strings while replies preserve numeric wire IDs and collisions are rejected', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.ask(0, 'item/tool/requestUserInput', pendingQuestion());
  assert.equal(controller.eventsAfter(0)[0].request_id, '0');
  assert.equal(controller.snapshot().agents[0].pending_requests[0].request_id, '0');
  client.ask('0', 'item/tool/requestUserInput', pendingQuestion()); await tick();
  assert.deepEqual(client.rejected.map((r) => [r.id, r.code]), [['0', -32600]]);
  client.note('serverRequest/resolved', { threadId: 'thread-1', requestId: '0' });
  assert.equal(controller.snapshot().agents[0].pending_requests.length, 1);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: { answers: { choice: { answers: ['yes'] } } } });
  assert.equal(client.replies[0].id, 0);
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: {} }));
});

test('unclassified final fallback applies only on success and explicit final beats it', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  const message = (text, phase) => client.note('item/completed', { threadId: 'thread-1', turnId: `turn-${client.turnCount}`, item: { type: 'agentMessage', text, phase } });
  message('Legacy final response', null); message('Explicit commentary after legacy response', 'commentary');
  client.complete(); assert.equal(controller.eventsAfter(0).at(-1).result, 'Legacy final response');
  await controller.dispatch('followup_task', { target: 'thread-1', message: 'second' });
  message('Explicit final', 'final_answer'); message('Unclassified after explicit', null);
  client.complete('thread-1', 'turn-2'); assert.equal(controller.eventsAfter(0).at(-1).result, 'Explicit final');
  await controller.dispatch('followup_task', { target: 'thread-1', message: 'third' });
  message('Unclassified failed turn content', null);
  client.complete('thread-1', 'turn-3', 'failed', { message: 'Failure' });
  assert.equal(controller.eventsAfter(0).at(-1).kind, 'failed');
  assert.equal(controller.snapshot().agents[0].result, null);
});

test('verified descendants forward only questions and approvals to root and retain wire routing', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('thread/started', { thread: { id: 'grandchild', source: { subAgent: { thread_spawn: { parent_thread_id: 'child' } } } } });
  client.note('turn/started', { threadId: 'grandchild', turn: { id: 'grand-turn' } });
  client.note('item/completed', { threadId: 'grandchild', turnId: 'grand-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'SECRET CHILD FINAL' } });
  client.note('item/completed', { threadId: 'grandchild', turnId: 'grand-turn', item: { type: 'commandExecution', aggregatedOutput: 'SECRET TOOL OUTPUT' } });
  client.ask(10, 'item/tool/requestUserInput', pendingQuestion('grandchild', 'grand-turn'));
  client.ask(11, 'item/fileChange/requestApproval', { threadId: 'grandchild', turnId: 'grand-turn', itemId: 'file', reason: 'Need permission' });
  await tick();
  const events = controller.eventsAfter(0);
  assert.deepEqual(events.map((e) => [e.agent_id, e.kind, e.source_thread_id]), [[agent.id, 'question', 'grandchild'], [agent.id, 'approval', 'grandchild']]);
  assert.equal(events[0].request_id, '10'); assert.doesNotMatch(JSON.stringify(controller.snapshot()), /SECRET/);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '10', answer: { answers: { choice: { answers: ['yes'] } } } });
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '11', answer: { decision: 'decline' } });
  assert.deepEqual(client.replies.map((r) => r.id), [10, 11]);
  assert.equal(controller.snapshot().agents[0].status, 'running');
  assert.equal(client.rejected.length, 0);
});

test('descendant discovery and requests before root spawn reply are replayed safely', async (t) => {
  const { client, controller, spawn } = await setup(t);
  client.handler = (method) => {
    if (method !== 'thread/start') return;
    client.note('thread/started', { thread: { id: 'early-child', source: { subAgent: { thread_spawn: { parent_thread_id: 'thread-1' } } } } });
    client.note('turn/started', { threadId: 'early-child', turn: { id: 'child-turn' } });
    client.ask(0, 'item/tool/requestUserInput', pendingQuestion('early-child', 'child-turn'));
    return { thread: { id: 'thread-1' } };
  };
  const agent = await spawn(); await tick();
  assert.equal(agent.status, 'waiting');
  assert.equal(controller.eventsAfter(0)[0].source_thread_id, 'early-child');
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: { answers: { choice: { answers: ['resolved'] } } } });
  assert.equal(client.replies[0].id, 0); assert.equal(client.rejected.length, 0);
});

test('a still-running descendant can ask after root finishes without reviving root turn', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.complete();
  client.ask('child-q', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  await assert.rejects(controller.dispatch('send_message', { target: agent.id, message: 'bypass' }), /answer_agent/);
  await controller.dispatch('answer_agent', { target: agent.id, request_id: 'child-q', answer: { answers: { choice: { answers: ['done'] } } } });
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  assert.equal(controller.snapshot().agents[0].activity, 'completed');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(client.replies.at(-1).id, 'child-q');
});

test('descendant questions and approvals asked before root completion remain deliverable and answerable', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.ask(0, 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  client.ask(1, 'item/fileChange/requestApproval', { threadId: 'child', turnId: 'child-turn', itemId: 'file', reason: 'Need permission' });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Root result' } });
  client.complete(); await tick();
  const listed = (await controller.dispatch('list_agents')).agents[0];
  assert.equal(listed.status, 'completed');
  assert.deepEqual(listed.pending_requests.map((r) => [r.request_id, r.source_thread_id]), [['0', 'child'], ['1', 'child']]);
  assert.deepEqual(controller.eventsAfter(0, [agent.id]).map((event) => event.kind), ['question', 'approval', 'completed']);
  assert.equal(controller.eventsAfter(0).at(-1).result, 'Root result');
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '0', answer: { answers: { choice: { answers: ['yes'] } } } });
  await controller.dispatch('answer_agent', { target: agent.id, request_id: '1', answer: { decision: 'decline' } });
  assert.deepEqual(client.replies.map((r) => r.id), [0, 1]);
  client.complete();
  assert.equal(controller.eventsAfter(0).filter((event) => event.kind === 'completed').length, 1);
  assert.equal(controller.snapshot().agents[0].result, 'Root result');
  assert.equal(controller.snapshot().agents[0].status, 'completed');
  assert.deepEqual(controller.snapshot().agents[0].pending_requests, []);
});

test('descendant pending requests clear only on their own lifecycle or controller shutdown', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  for (const id of ['a', 'b', 'c']) {
    client.note('thread/started', { thread: { id, parentThreadId: 'thread-1' } });
    client.note('turn/started', { threadId: id, turn: { id: `${id}-turn` } });
    client.ask(id, 'item/tool/requestUserInput', pendingQuestion(id, `${id}-turn`));
  }
  client.complete();
  client.complete('a', 'a-turn');
  await assert.rejects(controller.dispatch('answer_agent', { target: agent.id, request_id: 'a', answer: {} }), /No matching/);
  assert.deepEqual(controller.snapshot().agents[0].pending_requests.map((r) => r.request_id), ['b', 'c']);
  client.note('serverRequest/resolved', { threadId: 'b', requestId: 'b' });
  assert.deepEqual(controller.snapshot().agents[0].pending_requests.map((r) => r.request_id), ['c']);
  await controller.close();
  assert.deepEqual(controller.snapshot().agents[0].pending_requests, []);
  assert.equal(controller.snapshot().agents[0].status, 'completed');
});

test('notify_parent returns dynamic tool response and unknown requests are rejected', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.ask('notice', 'item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', tool: 'notify_parent', arguments: { message: 'Need a decision' } });
  client.ask('invalid', 'item/tool/call', { threadId: 'thread-1', tool: 'notify_parent', arguments: {} });
  client.ask('unknown', 'something/new', { threadId: 'thread-1' }); await tick();
  assert.deepEqual(client.replies[0].result, { contentItems: [{ type: 'inputText', text: 'Delivered to parent.' }], success: true });
  assert.equal(client.replies[1].result.success, false); assert.equal(client.rejected[0].code, -32601);
  assert.equal(controller.eventsAfter(0)[0].message, 'Need a decision');
});

test('send and followup steer running turn; interrupt never starts a new turn', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  await controller.dispatch('send_message', { target: agent.id, message: 'steer one' });
  await controller.dispatch('followup_task', { target: agent.id, message: 'steer two' });
  assert.equal(client.calls.filter((c) => c.method === 'turn/steer').length, 2);
  assert.equal(client.calls.at(-1).params.expectedTurnId, 'turn-1');
  await controller.dispatch('interrupt_agent', { target: agent.id });
  client.complete('thread-1', 'turn-1', 'interrupted'); await tick();
  assert.equal(controller.eventsAfter(0).at(-1).kind, 'interrupted');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('true overflow compacts after failed turn, waits for compaction turn, and retries once', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('error', { threadId: 'thread-1', turnId: 'turn-1', error: { message: 'Too long', codexErrorInfo: 'contextWindowExceeded' } });
  assert.equal(client.calls.filter((c) => c.method === 'thread/compact/start').length, 0);
  client.complete('thread-1', 'turn-1', 'failed');
  assert.equal(client.calls.at(-1).method, 'thread/compact/start');
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'compact-1' } });
  client.note('item/started', { threadId: 'thread-1', turnId: 'compact-1', item: { type: 'contextCompaction', id: 'compact-item' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'compact-1', item: { type: 'contextCompaction', id: 'compact-item' } });
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  client.complete('thread-1', 'compact-1'); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 2);
  assert.match(client.calls.at(-1).params.input[0].text, /^Continue the existing task/);
  assert.doesNotMatch(client.calls.at(-1).params.input[0].text, /Solve task/);
  client.complete('thread-1', 'turn-2', 'failed', { message: 'Still too long', codexErrorInfo: 'contextWindowExceeded' }); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'thread/compact/start').length, 1);
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'compacting').length, 1);
  assert.equal(controller.eventsAfter(0).at(-1).kind, 'failed');
});

test('compaction failures terminate without retry loops', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.handler = (method) => { if (method === 'thread/compact/start') throw new Error('compact unavailable'); };
  client.complete('thread-1', 'turn-1', 'failed', { message: 'overflow', codexErrorInfo: 'contextWindowExceeded' }); await tick();
  assert.match(controller.eventsAfter(0).at(-1).message, /compaction failed/);
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('compaction turn failure and parent interrupt prevent continuation', async (t) => {
  for (const interrupt of [false, true]) {
    const { client, controller, spawn } = await setup(t); const agent = await spawn();
    client.complete('thread-1', 'turn-1', 'failed', { codexErrorInfo: 'contextWindowExceeded' });
    client.note('turn/started', { threadId: 'thread-1', turn: { id: 'compact' } });
    if (interrupt) await controller.dispatch('interrupt_agent', { target: agent.id });
    client.complete('thread-1', 'compact', interrupt ? 'completed' : 'failed', { message: 'compaction failed' }); await tick();
    assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
    assert.equal(controller.eventsAfter(0).at(-1).kind, interrupt ? 'interrupted' : 'failed');
  }
});

test('interrupt between failed turn and compaction start wins and emits once', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.complete('thread-1', 'turn-1', 'failed', { codexErrorInfo: 'contextWindowExceeded' });
  await controller.dispatch('interrupt_agent', { target: agent.id });
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'late-compact' } });
  client.complete('thread-1', 'late-compact'); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(client.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'interrupted').length, 1);
  assert.equal(controller.snapshot().agents[0].status, 'interrupted');
});

test('interrupt while turn/start reply is pending interrupts the observed turn only once', async (t) => {
  const { client, controller, spawn } = await setup(t);
  let release;
  client.handler = (method) => {
    if (method === 'turn/start') return new Promise((resolve) => { release = resolve; });
  };
  const starting = spawn();
  await tick(); const agent = controller.snapshot().agents[0];
  await controller.dispatch('interrupt_agent', { target: agent.id });
  client.note('turn/started', { threadId: 'thread-1', turn: { id: 'late-start' } });
  release({ turn: { id: 'late-start' } }); await starting;
  client.complete('thread-1', 'late-start', 'interrupted'); await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  assert.equal(controller.eventsAfter(0).filter((e) => e.kind === 'interrupted').length, 1);
});

test('ack removes delivered event while retaining final result and actual cached usage', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', text: 'Routine progress' } });
  client.note('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Verified final result' } });
  client.note('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: { cachedInputTokens: 234 } } });
  client.complete(); await tick();
  const final = controller.eventsAfter(0)[0]; assert.equal(final.result, 'Verified final result');
  await controller.ackEvents(final.seq);
  assert.deepEqual(controller.eventsAfter(0), []);
  assert.equal(controller.snapshot().agents[0].result, 'Verified final result');
  assert.equal(controller.snapshot().agents[0].token_usage.total.cachedInputTokens, 234);
});

test('automatic compaction emits once per item without claiming an overflow', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  for (const method of ['item/started', 'item/completed']) client.note(method, { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'auto', type: 'contextCompaction' } });
  assert.equal(controller.eventsAfter(0).length, 1); assert.equal(controller.eventsAfter(0)[0].reason, undefined);
});

test('models use pagination and actual catalog effort IDs', async (t) => {
  const { client, controller } = await setup(t);
  client.handler = (method, params) => {
    if (method === 'model/list') return { data: [{ id: params.cursor ? 'b' : 'catalog-a', ...(params.cursor ? {} : { model: 'a' }), displayName: 'Actual catalog', isDefault: !params.cursor,
      supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra' }], nextCursor: params.cursor ? null : 'next' };
  };
  const { models } = await controller.dispatch('list_models');
  assert.deepEqual(models.map((m) => m.id), ['a', 'b']); assert.deepEqual(models[0].efforts, ['ultra']);
  assert.equal(client.calls[1].params.cursor, 'next');
});

test('durable journal preserves cached usage and result, ack retains sequence, restart clears requests', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-agents-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const { client, controller, spawn } = await setup(t, { statePath }); const agent = await spawn({ message: 'PRIVATE LONG INPUT' });
  client.note('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 }, last: { cachedInputTokens: 40 }, modelContextWindow: 1234 } });
  client.ask('q', 'item/tool/requestUserInput', pendingQuestion()); await controller.persist();
  const serialized = await readFile(statePath, 'utf8'); assert.doesNotMatch(serialized, /PRIVATE LONG INPUT/);
  const restarted = new AgentController({ client: new MockClient(), statePath }); await restarted.init(); t.after(() => restarted.close());
  assert.equal(restarted.snapshot().agents[0].status, 'interrupted'); assert.deepEqual(restarted.snapshot().agents[0].pending_requests, []);
  assert.equal(restarted.snapshot().agents[0].token_usage.total.cachedInputTokens, 80);
  const seq = restarted.snapshot().nextSeq; await restarted.ackEvents(seq - 1);
  assert.equal(restarted.eventsAfter(0).length, 0); assert.equal(restarted.snapshot().nextSeq, seq);
  assert.equal((await restarted.dispatch('list_agents')).agents[0].token_usage, undefined);
  assert.equal((await restarted.dispatch('list_agents')).agents[0].result, undefined);
  await assert.rejects(restarted.dispatch('answer_agent', { target: agent.id, request_id: 'q', answer: {} }));
});

test('client close rejects outstanding calls and close marks active agents interrupted', async (t) => {
  const { client, controller, spawn } = await setup(t); const agent = await spawn();
  client.handler = (method) => { if (method === 'turn/steer') return new Promise(() => {}); };
  const sending = controller.dispatch('send_message', { target: agent.id, message: 'pending' });
  client.emit('closed'); await assert.rejects(sending, /closed/); assert.equal(controller.snapshot().agents[0].status, 'failed');
  const second = await setup(t); await second.spawn(); await second.controller.close();
  assert.equal(second.controller.snapshot().agents[0].status, 'interrupted');
});

test('close interrupts known root and descendant turns once and prevents new work or overflow recovery', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  const interruptRequests = [], release = [];
  client.handler = (method, params, options) => {
    if (method !== 'turn/interrupt') return;
    interruptRequests.push({ params, options });
    return new Promise((resolve) => { release.push(resolve); });
  };
  const first = controller.close(); const second = controller.close();
  assert.equal(first, second);
  await tick();
  assert.deepEqual(interruptRequests.map((request) => request.params).sort((a, b) => a.threadId.localeCompare(b.threadId)), [
    { threadId: 'child', turnId: 'child-turn' }, { threadId: 'thread-1', turnId: 'turn-1' },
  ]);
  assert.ok(interruptRequests.every((request) => request.options.timeoutMs === 1500));
  assert.equal(controller.closed, false);
  await assert.rejects(controller.dispatch('list_agents'), /closing/);
  client.complete('thread-1', 'turn-1', 'failed', { message: 'overflow', codexErrorInfo: 'contextWindowExceeded' });
  assert.equal(client.calls.filter((call) => call.method === 'thread/compact/start').length, 0);
  for (const resolve of release) resolve({});
  await first; await controller.close();
  assert.equal(interruptRequests.length, 2);
  assert.equal(controller.closed, true);
  assert.equal(controller.snapshot().agents[0].status, 'interrupted');
  assert.equal(controller.eventsAfter(0).filter((event) => event.kind === 'interrupted').length, 1);
});

test('native interruption failures do not prevent shutdown and already closed transport is skipped', async (t) => {
  const { client, controller, spawn } = await setup(t); await spawn();
  client.note('thread/started', { thread: { id: 'child', parentThreadId: 'thread-1' } });
  client.note('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  client.ask('pending', 'item/tool/requestUserInput', pendingQuestion('child', 'child-turn'));
  client.handler = (method) => { if (method === 'turn/interrupt') throw new Error('transport unavailable'); };
  await controller.close();
  assert.equal(client.calls.filter((call) => call.method === 'turn/interrupt').length, 2);
  assert.equal(controller.closed, true);
  assert.equal(controller.snapshot().agents[0].status, 'interrupted');
  assert.deepEqual(controller.snapshot().agents[0].pending_requests, []);
  const other = await setup(t); await other.spawn(); other.client.emit('closed');
  await other.controller.close();
  assert.equal(other.client.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActivityStore } from '../runtime/activity.mjs';
import { orderWaits } from '../shared/activity-order.mjs';
import { toolSections } from '../hooks/tool-presentation.js';

function fixture() {
  const client = new EventEmitter(), controller = new EventEmitter(), requests = [];
  const a = { id: 'a', threadId: 'root', name: 'worker', status: 'running' };
  controller.agents = new Map([[a.id, a]]); controller.threads = new Map([[a.threadId, a]]);
  controller.find = (id) => { if (id !== a.id) throw new Error('Unknown agent'); return a; };
  controller.view = (agent) => ({ agent_id: agent.id, name: agent.name, status: agent.status });
  client.request = async (method, args) => {
    requests.push({ method, args });
    if (method === 'thread/turns/list') return { data: [{ id: 'turn' }], nextCursor: 'older-turn' };
    if (method === 'thread/items/list') return { data: [{ turnId: 'turn', outputDeferred: true, item: { id: 'cmd', type: 'commandExecution', command: 'test' } }], nextCursor: 'older-item' };
    if (method === 'thread/items/read') return { data: [{ item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'x'.repeat(20000) } }] };
  };
  return { client, controller, requests, store: ActivityStore.attach(client, controller) };
}

test('history uses owned native thread and bounded deferred pages', async () => {
  const { store, requests } = fixture();
  await assert.rejects(() => store.history({ target: 'foreign' }), /Unknown/);
  assert.equal(requests.length, 0);
  const result = await store.history({ target: 'a', limit: 1 });
  assert.deepEqual(result.entries.map((e) => e.id), ['cmd']);
  assert.equal(result.entries[0].deferred, true);
  assert.deepEqual(result.next_cursor, { turn_id: 'turn', items_cursor: 'older-item', turns_cursor: 'older-turn' });
  assert.equal(requests[1].args.threadId, 'root');
  assert.equal(requests[1].args.deferOutput.commandExecution, true);
  const first = await store.detail({ target: 'a', turn_id: 'turn', item_id: 'cmd' });
  assert.equal(first.text.length, 16000); assert.equal(first.next_offset, 16000);
  const second = await store.detail({ target: 'a', turn_id: 'turn', item_id: 'cmd', offset: first.next_offset });
  assert.equal(second.next_offset, null);
});

test('history combines turns in chronological order and resumes inside a turn', async () => {
  const { client, store } = fixture();
  const turns = ['new', 'middle', 'old'];
  const items = { new: ['n2', 'n1'], middle: ['m'], old: ['o'] };
  client.request = async (method, args) => {
    if (method === 'thread/turns/list') {
      const index = Number(args.cursor ?? 0);
      return { data: [{ id: turns[index] }], nextCursor: index + 1 < turns.length ? String(index + 1) : null };
    }
    const index = Number(args.cursor ?? 0), ids = items[args.turnId];
    return { data: ids.slice(index, index + args.limit).map(id => ({ item: { id, type: 'agentMessage', text: id } })), nextCursor: index + args.limit < ids.length ? String(index + args.limit) : null };
  };
  assert.deepEqual((await store.history({ target: 'a' })).entries.map(e => e.id), ['o', 'm', 'n1', 'n2']);
  const first = await store.history({ target: 'a', limit: 1 });
  const second = await store.history({ target: 'a', limit: 2, cursor: first.next_cursor });
  const third = await store.history({ target: 'a', limit: 2, cursor: second.next_cursor });
  assert.deepEqual(first.entries.map(e => e.id), ['n2']);
  assert.deepEqual(second.entries.map(e => e.id), ['m', 'n1']);
  assert.deepEqual(third.entries.map(e => e.id), ['o']);
  assert.equal(third.next_cursor, null);
});

test('history advances through filtered pages with a bounded continuation', async () => {
  const { client, store } = fixture();
  let calls = 0;
  client.request = async (method, args) => {
    calls++;
    if (method === 'thread/turns/list') return { data: [{ id: 'turn' }], nextCursor: null };
    const index = Number(args.cursor ?? 0);
    return { data: [{ item: index < 82 ? { id: `hidden${index}`, type: 'reasoning' } : { id: 'visible', type: 'agentMessage', text: 'hello' } }], nextCursor: index < 82 ? String(index + 1) : null };
  };
  const first = await store.history({ target: 'a' });
  assert.equal(calls, 80);
  assert.deepEqual(first.entries, []);
  assert.ok(first.next_cursor);
  const second = await store.history({ target: 'a', cursor: first.next_cursor });
  assert.deepEqual(second.entries.map(e => e.id), ['visible']);
  assert.equal(second.next_cursor, null);
});

test('history rejects repeated and malformed cursors across pages', async () => {
  const { client, store } = fixture();
  client.request = async (method, args) => method === 'thread/turns/list'
    ? { data: [{ id: 'turn' }], nextCursor: null }
    : { data: [{ item: { id: args.cursor ?? 'first', type: 'agentMessage', text: 'x' } }], nextCursor: args.cursor === 'a' ? 'b' : 'a' };
  const first = await store.history({ target: 'a', limit: 1 });
  const second = await store.history({ target: 'a', limit: 1, cursor: first.next_cursor });
  await assert.rejects(() => store.history({ target: 'a', limit: 1, cursor: second.next_cursor }), /Repeated native history cursor/);
  await assert.rejects(() => store.history({ target: 'a', cursor: { items_cursor: 'x' } }), /Invalid history cursor/);
  await assert.rejects(() => store.history({ target: 'a', cursor: { seen_turn_cursors: Array.from({ length: 65 }, (_, i) => String(i)) } }), /Invalid history cursor/);
});

test('history keeps a bounded cursor trail while paging through long histories', async () => {
  const { client, store } = fixture();
  client.request = async (method, args) => {
    if (method === 'thread/turns/list') {
      const index = Number(args.cursor ?? 0);
      return { data: [{ id: `turn${index}` }], nextCursor: index < 149 ? String(index + 1) : null };
    }
    return { data: [{ item: { id: args.turnId, type: 'agentMessage', text: 'x' } }], nextCursor: null };
  };
  let cursor, count = 0;
  do {
    const page = await store.history({ target: 'a', limit: 1, cursor });
    assert.equal(page.entries[0].id, `turn${count++}`);
    cursor = page.next_cursor;
    assert.ok((cursor?.seen_turn_cursors?.length ?? 0) <= 64);
  } while (cursor);
  assert.equal(count, 150);
});

test('live cache excludes descendant and reasoning events and never touches pending events', () => {
  const { store, client, controller } = fixture();
  controller.pendingEvents = [{ seq: 1 }];
  const emit = (threadId, item) => client.emit('notification', { method: 'item/completed', params: { threadId, turnId: 't', item } });
  emit('child', { id: 'child', type: 'agentMessage', text: 'private' });
  emit('root', { id: 'reason', type: 'reasoning', content: 'private' });
  controller.emit('agentAction', { kind: 'spawn', agent_id: 'a', thread_id: 'root', turn_id: 't', message: 'task' });
  for (let i = 0; i < 140; i++) emit('root', { id: String(i), type: 'agentMessage', text: `hello ${i}` });
  const data = store.revision({ target: 'a' });
  assert.equal(data.entries.length, 64);
  assert.equal(store.revision({ target: 'a', revision: data.revision }).entries, undefined);
  assert.deepEqual(controller.pendingEvents, [{ seq: 1 }]);
  store.close();
});

test('saved compaction stages use native entry timing when the live cache is absent', async () => {
  const { client, store } = fixture();
  client.request = async method => method === 'thread/turns/list'
    ? { data: [{ id: 'turn' }], nextCursor: null }
    : { data: [
      { turnId: 'turn', startedAtMs: 1000, completedAtMs: 2000, item: { id: 'done', type: 'contextCompaction' } },
      { turnId: 'turn', startedAtMs: 3000, completedAtMs: null, item: { id: 'active', type: 'contextCompaction' } },
    ], nextCursor: null };
  const result = await store.history({ target: 'a' });
  assert.equal(result.entries.find(entry => entry.id === 'done').data.stage, 'completed');
  assert.equal(result.entries.find(entry => entry.id === 'active').data.stage, 'started');
});

test('previews bound deep data and image payloads while details format native items', async () => {
  const { store, client, controller } = fixture();
  const payload = 'A'.repeat(50000);
  const image = { id: 'image', type: 'imageGeneration', savedPath: 'C:/work/out.png', result: payload, inputImages: [{ data: payload }] };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: image } });
  const value = store.revision({ target: 'a' });
  assert.ok(JSON.stringify(value).length < 1000);
  assert.ok(!JSON.stringify(value).includes(payload.slice(0, 100)));
  client.request = async () => ({ data: [{ item: image }] });
  const detail = await store.detail({ target: 'a', turn_id: 't', item_id: 'image' });
  assert.match(detail.text, /C:\/work\/out.png/);
  assert.ok(!detail.text.includes(payload.slice(0, 100)));
  const nested = { id: 'unknown', type: 'futureTool', array: Array.from({ length: 40 }, () => ({ text: 'z '.repeat(50000) })) };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: nested } });
  assert.ok(JSON.stringify(store.revision({ target: 'a' })).length < 20000);
  client.request = async () => ({ data: [{ item: { id: 'diff', type: 'fileChange', changes: [{ path: 'src/a.js', diff: '-old\n+new' }] } }] });
  assert.match((await store.detail({ target: 'a', turn_id: 't', item_id: 'diff' })).text, /src\/a\.js\n-old\n\+new/);
  client.request = async () => ({ data: [{ item: { id: 'tool', type: 'mcpToolCall', server: 'server', tool: 'lookup', arguments: { query: 'x' }, result: { content: [{ type: 'text', text: 'answer' }, { type: 'image', data: payload }] } } }] });
  const toolText = (await store.detail({ target: 'a', turn_id: 't', item_id: 'tool' })).text;
  assert.match(toolText, /Tool: server\/lookup[\s\S]*Input:[\s\S]*query[\s\S]*Output:\nanswer/);
  assert.ok(!toolText.includes(payload.slice(0, 100)));
  controller.guidance = { collaboration: 'Shared rules.', default: { instructions: 'Scout rules.' } };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: { id: 'user', type: 'userMessage', content: [{ text: 'Claude is your parent agent.\n\nScout rules.\n\nFind the issue' }] } } });
  assert.equal(store.revision({ target: 'a' }).entries.find((e) => e.id === 'user').preview, 'Find the issue');
});

test('tool call titles survive live and deferred history projection without reading output titles', async () => {
  const { client, store } = fixture();
  const emit = item => client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item } });
  emit({ id: 'cua', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', arguments: { code: 'x'.repeat(10000), title: 'Finding reopened Claude window' } });
  emit({ id: 'unrelated', type: 'mcpToolCall', server: 'search', tool: 'query', arguments: { title: 'Query title' }, result: { title: 'Result title' } });
  emit({ id: 'malformed', type: 'dynamicToolCall', namespace: 'mcp__cua_repl', tool: 'js', arguments: 'not an object', appContext: null });
  const live = store.revision({ target: 'a' }).entries;
  assert.equal(live[0].data.display_title, 'Finding reopened Claude window');
  assert.equal(live[1].data.display_title, undefined);
  assert.equal(live[2].data.display_title, undefined);
  client.request = async method => method === 'thread/turns/list' ? { data: [{ id: 'turn' }], nextCursor: null } : { data: [
    { outputDeferred: true, item: { id: 'dynamic', type: 'dynamicToolCall', namespace: 'mcp__cua_repl', tool: 'js', arguments: { code: 'x'.repeat(10000), title: 'Checking the layout' } } },
    { item: { id: 'action', type: 'mcpToolCall', server: 'service', tool: 'lookup', appContext: { actionName: 'Look up record' } } },
  ], nextCursor: null };
  const history = (await store.history({ target: 'a' })).entries;
  assert.equal(history.find(entry => entry.id === 'dynamic').data.display_title, 'Checking the layout');
  assert.equal(history.find(entry => entry.id === 'dynamic').deferred, true);
  assert.equal(history.find(entry => entry.id === 'action').data.display_title, 'Look up record');
});

test('cold live caches are evicted without invalidating native history', async () => {
  const { store, controller } = fixture();
  for (let i = 0; i < 40; i++) store.bucket(`cold-${i}`);
  assert.equal(store.live.size, 32);
  assert.equal((await store.history({ target: 'a', limit: 1 })).entries[0].id, 'cmd');
  assert.equal(controller.pendingEvents, undefined);
});

test('ordinary data fields, long text and native dynamic text remain readable', async () => {
  const { store, client } = fixture();
  const plainText = 'x'.repeat(900);
  const item = { id: 'data', type: 'mcpToolCall', tool: 'inspect', arguments: { data: { count: 7 }, text: plainText }, result: { content: [{ type: 'text', text: 'evidence' }], structuredContent: { data: { verified: true } } } };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  const preview = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(preview.data.arguments.data, { count: 7 });
  assert.equal(preview.data.arguments.text, plainText);
  client.request = async () => ({ data: [{ item }] });
  const detail = await store.detail({ target: 'a', turn_id: 't', item_id: 'data' });
  assert.ok(detail.text.includes(plainText)); assert.match(detail.text, /"verified": true/);
  client.request = async () => ({ data: [{ item: { id: 'dynamic', type: 'dynamicToolCall', tool: 'notify_parent', contentItems: [{ type: 'inputText', text: 'Delivered to parent.' }] } }] });
  assert.match((await store.detail({ target: 'a', turn_id: 't', item_id: 'dynamic' })).text, /Delivered to parent\./);
});

test('user source and stop status survive the display projection without consuming events', async () => {
  const { store, client, controller } = fixture();
  const agent = controller.agents.get('a');
  agent.userPaused = true; agent.userControlStatus = 'stopping';
  agent.tokenUsage = { last: { totalTokens: 600 }, total: { totalTokens: 90000 }, modelContextWindow: 1000 };
  controller.settings = { permissionsMode: 'full-access' };
  controller.pendingEvents = [{ seq: 1, origin: 'user' }];
  controller.emit('agentAction', { kind: 'send', origin: 'user', agent_id: 'a', thread_id: 'root', turn_id: 't', message: 'Keep the source files.' });
  const before = store.revision({ target: 'a' });
  assert.equal(before.agent.user_paused, true); assert.equal(before.agent.user_control_status, 'stopping');
  assert.equal(before.agent.context_used_tokens, 600); assert.equal(before.agent.context_limit_tokens, 1000);
  assert.equal(before.agent.permissions_mode, 'full-access');
  assert.equal(before.entries[0].type, 'directUserMessage');
  agent.userControlStatus = 'stopped';
  const after = store.revision({ target: 'a', revision: before.revision });
  assert.equal(after.entries, undefined); assert.equal(after.agent.user_control_status, 'stopped');
  const item = { id: 'native-user', type: 'userMessage', content: [{ type: 'inputText', text: '[Direct message from the user]\n\nKeep the source files.' }] };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  const native = store.revision({ target: 'a' }).entries.at(-1);
  assert.equal(native.type, 'directUserMessage'); assert.equal(native.preview, 'Keep the source files.');
  client.request = async () => ({ data: [{ item }] });
  assert.equal((await store.detail({ target: 'a', turn_id: 't', item_id: item.id })).text, 'Keep the source files.');
  assert.deepEqual(controller.pendingEvents, [{ seq: 1, origin: 'user' }]);
});

test('file change counts use the full native diff before display truncation', () => {
  const { store, client } = fixture();
  const diff = '--- a/file.js\n+++ b/file.js\n@@ -1,1 +1,300 @@\n-old\n' + '+new content\n'.repeat(900);
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: { id: 'edit', type: 'fileChange', changes: [{ path: 'src/file.js', diff }, { path: 'image.png' }] } } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(entry.data.fileSummary, [{ path: 'src/file.js', added: 900, removed: 1 }, { path: 'image.png' }]);
  assert.ok(entry.data.changes[0].diff.length < diff.length);
});

test('root lifecycle rows distinguish compaction stages and keep only child identity and status', () => {
  const { store, client, controller } = fixture();
  controller.pendingEvents = [{ seq: 1 }];
  const emit = (method, params) => client.emit('notification', { method, params });
  emit('thread/started', { thread: { id: 'child', agentNickname: 'Scout' } });
  emit('item/completed', { threadId: 'root', turnId: 't', item: { id: 'delegation', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], prompt: 'private task', agentsStates: { child: { status: 'running', message: 'private descendant output' } } } });
  emit('item/completed', { threadId: 'root', turnId: 't', item: { id: 'child-start', type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/scout', kind: 'started' } });
  emit('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'nested-call', type: 'mcpToolCall', tool: 'private' } });
  emit('item/started', { threadId: 'root', turnId: 't', item: { id: 'compact', type: 'contextCompaction' } });
  let entries = store.revision({ target: 'a' }).entries;
  assert.equal(entries.at(-1).data.stage, 'started');
  emit('thread/compacted', { threadId: 'root', turnId: 't' });
  entries = store.revision({ target: 'a' }).entries;
  assert.equal(entries.at(-1).data.stage, 'completed');
  assert.equal(entries.filter(entry => entry.id === 'compact').length, 1);
  assert.deepEqual(entries[0].data.agents, [{ id: 'child', name: 'Scout', status: 'running' }]);
  assert.equal(entries[1].data.name, 'Scout');
  assert.ok(!JSON.stringify(entries).includes('private'));
  assert.deepEqual(controller.pendingEvents, [{ seq: 1 }]);
});

test('waits use recorded start times without inventing targets or discarding messages', async () => {
  const { client, store } = fixture();
  const child = { id: 'child-done', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child', agentPath: '/root/nested_file_edit' };
  const wait = { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: [], agentsStates: {}, status: 'completed' };
  client.request = async method => method === 'thread/turns/list' ? { data: [{ id: 'turn' }], nextCursor: null } : {
    data: [
      { item: wait, startedAtMs: 100 },
      { item: child, startedAtMs: 200 },
      { item: { id: 'message', type: 'agentMessage', text: 'Real message' }, startedAtMs: 150 },
    ], nextCursor: null,
  };
  const entries = (await store.history({ target: 'a' })).entries;
  assert.deepEqual(entries.map(e => e.id), ['wait', 'message', 'child-done']);
  assert.equal(entries[2].data.display_name, 'nested_file_edit');
  assert.deepEqual(entries[0].data.agents, []);
  const emit = (method, item, time) => client.emit('notification', { method, params: { threadId: 'root', turnId: 'turn', item, ...(time == null ? {} : { startedAtMs: time }) } });
  emit('item/started', wait, 100);
  emit('item/completed', child, 200);
  emit('item/completed', wait);
  const live = store.revision({ target: 'a' }).entries;
  assert.deepEqual(live.map(e => e.id), ['wait', 'child-done']);
  assert.equal(live[0].started_at_ms, 100);
});

test('wait ordering preserves untimed entries and turn boundaries across a long transcript', () => {
  const entries = Array.from({ length: 700 }, (_, i) => ({ id: String(i), turn_id: 't', type: 'agentMessage', started_at_ms: i + 100 }));
  entries.push({ id: 'wait-a', turn_id: 't', type: 'collabAgentToolCall', data: { tool: 'wait' }, started_at_ms: 350 });
  entries.push({ id: 'wait-b', turn_id: 't', type: 'collabAgentToolCall', data: { tool: 'wait' }, started_at_ms: 200 });
  entries.push({ id: 'unknown', turn_id: 't', type: 'collabAgentToolCall', data: { tool: 'wait' } });
  entries.push({ id: 'other-turn', turn_id: 'other', type: 'collabAgentToolCall', data: { tool: 'wait' }, started_at_ms: 1 });
  const ordered = orderWaits(entries);
  assert.equal(ordered.length, entries.length);
  assert.ok(ordered.findIndex(e => e.id === 'wait-a') < ordered.findIndex(e => e.id === '251'));
  assert.ok(ordered.findIndex(e => e.id === 'wait-b') < ordered.findIndex(e => e.id === '101'));
  assert.deepEqual(ordered.slice(-2).map(e => e.id), ['unknown', 'other-turn']);
  assert.deepEqual(ordered.filter(e => e.type === 'agentMessage').map(e => e.id), entries.slice(0, 700).map(e => e.id));
});

test('native user attachments and long text remain readable after history projection', () => {
  const { store, client } = fixture();
  const attachments = [{ name: 'report.pdf', path: 'C:/work/report.pdf', type: 'file' }, { name: 'image.png', path: 'C:/work/image.png', type: 'image' }];
  const text = 'Review these results. '.repeat(300);
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: { id: 'user', type: 'userMessage', content: [{ type: 'text', text: `[Direct message from the user]\n\n${text}\n\nAttached local files: ${JSON.stringify(attachments)}.` }, { type: 'localImage', path: 'C:/work/image.png' }] } } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.ok(entry.preview.startsWith('Review these results.'));
  assert.ok(!entry.preview.includes('Attached local files:'));
  assert.equal(entry.type, 'directUserMessage');
  assert.deepEqual(entry.data.attachments, attachments);
});

test('file detail selects only the recorded file and preserves truthful page formats', async () => {
  const { store, client } = fixture();
  const first = '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new';
  client.request = async () => ({ data: [{ item: { id: 'edits', type: 'fileChange', changes: [{ path: 'a.js', diff: first }, { path: 'b.js', diff: 'line\n'.repeat(5000) }] } }] });
  const result = await store.detail({ target: 'a', turn_id: 't', item_id: 'edits', file_path: 'a.js' });
  assert.equal(result.text, first); assert.equal(result.format, 'diff');
  const page = await store.detail({ target: 'a', turn_id: 't', item_id: 'edits', file_path: 'b.js' });
  assert.equal(page.format, 'source'); assert.equal(page.next_offset, 16000);
  await assert.rejects(store.detail({ target: 'a', turn_id: 't', item_id: 'edits', file_path: 'foreign.js' }), /not part/);
});

test('deferred MCP skeletons show no output until native detail resolves the actual content', async () => {
  const { store, client } = fixture();
  const deferred = { id: 'lookup', type: 'mcpToolCall', server: 'github', tool: 'search', arguments: { query: 'source' }, result: { structuredContent: null, _meta: null } };
  const resolved = { ...deferred, result: { content: [{ type: 'text', text: 'Found the requested source.' }], structuredContent: null, _meta: null } };
  client.request = async method => method === 'thread/turns/list'
    ? { data: [{ id: 'turn' }], nextCursor: null }
    : method === 'thread/items/list' ? { data: [{ turnId: 'turn', outputDeferred: true, item: deferred }], nextCursor: null }
    : { data: [{ item: resolved }] };
  const entry = (await store.history({ target: 'a' })).entries[0];
  assert.equal(entry.deferred, true);
  assert.ok(!toolSections(entry).some(section => section.label === '输出'));
  const result = await store.detail({ target: 'a', turn_id: 'turn', item_id: entry.id, view: 'output' });
  assert.deepEqual(result, { text: 'Found the requested source.', next_offset: null, format: 'source' });
  assert.equal(toolSections({ ...entry, data: resolved }).find(section => section.label === '输出').source, result.text);
  const full = await store.detail({ target: 'a', turn_id: 'turn', item_id: entry.id });
  assert.match(full.text, /Tool: github\/search\nInput:/);
  assert.match(full.text, /Output:\nFound the requested source\./);
});

test('tool output keeps structured results, real fields and errors while dropping null protocol metadata', async () => {
  const { store, client } = fixture();
  const item = { id: 'lookup', type: 'mcpToolCall', tool: 'inspect', arguments: { query: 'do not repeat' }, result: { content: [{ type: 'text', text: 'partial answer' }], structuredContent: { rows: [{ count: 7 }] }, _meta: null, status: 'partial', businessField: null }, error: { message: 'Request timed out' } };
  client.request = async () => ({ data: [{ item }] });
  const detail = await store.detail({ target: 'a', turn_id: 't', item_id: item.id, view: 'output' });
  assert.match(detail.text, /^partial answer\n/);
  assert.match(detail.text, /"count": 7/);
  assert.match(detail.text, /"status": "partial"/);
  assert.match(detail.text, /"businessField": null/);
  assert.match(detail.text, /Request timed out/);
  assert.doesNotMatch(detail.text, /Tool:|Input:|Output:|_meta|do not repeat/);
  const sections = toolSections({ type: item.type, data: item });
  const output = sections.find(section => section.label === '输出').source;
  assert.match(output, /"count": 7/); assert.match(output, /"businessField": null/); assert.doesNotMatch(output, /_meta/);
  assert.match(sections.find(section => section.label === '错误').source, /Request timed out/);
  const empty = { ...item, result: { content: null, structuredContent: null, _meta: null }, error: 'No result returned' };
  client.request = async () => ({ data: [{ item: empty }] });
  assert.equal((await store.detail({ target: 'a', turn_id: 't', item_id: empty.id, view: 'output' })).text, 'No result returned');
});

test('output-only detail paginates command, dynamic and function output without call headers', async () => {
  const { store, client } = fixture();
  const output = 'long result line\n'.repeat(2200);
  const items = [
    { id: 'command', type: 'commandExecution', command: 'private-input', cwd: 'C:/work', aggregatedOutput: output },
    { id: 'dynamic', type: 'dynamicToolCall', tool: 'private-input', contentItems: [{ type: 'inputText', text: output }] },
    { id: 'function', type: 'functionCallOutput', output: { content: [{ type: 'text', text: output }], structuredContent: null, _meta: null } },
  ];
  for (const item of items) {
    client.request = async () => ({ data: [{ item }] });
    let combined = '', offset = 0, pages = 0;
    do {
      const page = await store.detail({ target: 'a', turn_id: 't', item_id: item.id, view: 'output', offset });
      assert.equal(page.format, 'source');
      assert.ok(page.text.length <= 16000);
      assert.doesNotMatch(page.text, /private-input|Command:|Tool:|Input:|Output:/);
      combined += page.text; pages++;
      offset = page.next_offset;
    } while (offset !== null);
    assert.equal(combined, output); assert.ok(pages > 1);
  }
});

test('output-only detail preserves safe binary omission and existing non-tool views', async () => {
  const { store, client, requests } = fixture();
  await assert.rejects(store.detail({ target: 'a', turn_id: 't', item_id: 'cmd', view: 'unknown' }), /Invalid detail view/);
  assert.equal(requests.length, 0);
  const payload = 'A'.repeat(20000);
  client.request = async () => ({ data: [{ item: { id: 'tool', type: 'dynamicToolCall', result: { contentItems: [{ type: 'image', data: payload }], structuredContent: { base64: payload } } } }] });
  const result = await store.detail({ target: 'a', turn_id: 't', item_id: 'tool', view: 'output' });
  assert.match(result.text, /non-text content omitted/); assert.match(result.text, /binary omitted/); assert.ok(!result.text.includes(payload));
  client.request = async () => ({ data: [{ item: { id: 'message', type: 'agentMessage', text: 'Ordinary message' } }] });
  assert.deepEqual(await store.detail({ target: 'a', turn_id: 't', item_id: 'message', view: 'output' }), { text: 'Ordinary message', next_offset: null });
  client.request = async () => ({ data: [{ item: { id: 'files', type: 'fileChange', changes: [{ path: 'a.js', diff: '@@ -1 +1 @@\n-old\n+new' }] } }] });
  assert.deepEqual(await store.detail({ target: 'a', turn_id: 't', item_id: 'files', view: 'output', file_path: 'a.js' }), { text: '@@ -1 +1 @@\n-old\n+new', next_offset: null, file_path: 'a.js', format: 'diff' });
});

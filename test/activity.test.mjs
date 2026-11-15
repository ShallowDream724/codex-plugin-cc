import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActivityStore } from '../runtime/activity.mjs';

function fixture() {
  const client = new EventEmitter(), controller = new EventEmitter(), requests = [];
  const a = { id: 'a', threadId: 'root', name: 'worker', status: 'running' };
  controller.agents = new Map([[a.id, a]]); controller.threads = new Map([[a.threadId, a]]);
  controller.find = (id) => { if (id !== a.id) throw new Error('Unknown agent'); return a; };
  controller.view = (agent) => ({ agent_id: agent.id, name: agent.name, status: agent.status });
  client.request = async (method, args) => {
    requests.push({ method, args });
    if (method === 'thread/turns/list') return { data: [{ id: 'turn' }], nextCursor: 'older-turn' };
    if (method === 'thread/items/list') return { data: [{ turnId: 'turn', outputDeferred: true, item: { id: 'cmd', type: 'commandExecution', command: 'test' } }, { turnId: 'turn', item: { id: 'secret', type: 'reasoning', content: ['hidden'] } }], nextCursor: 'older-item' };
    if (method === 'thread/items/read') return { data: [{ item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'x'.repeat(20000) } }] };
  };
  return { client, controller, requests, store: ActivityStore.attach(client, controller) };
}

test('history uses owned native thread and bounded deferred pages', async () => {
  const { store, requests } = fixture();
  await assert.rejects(() => store.history({ target: 'foreign' }), /Unknown/);
  assert.equal(requests.length, 0);
  const result = await store.history({ target: 'a' });
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

test('cold live caches are evicted without invalidating native history', async () => {
  const { store, controller } = fixture();
  for (let i = 0; i < 40; i++) store.bucket(`cold-${i}`);
  assert.equal(store.live.size, 32);
  assert.equal((await store.history({ target: 'a' })).entries[0].id, 'cmd');
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

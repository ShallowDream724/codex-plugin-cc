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

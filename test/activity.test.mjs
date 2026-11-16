import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ActivityStore } from '../runtime/activity.mjs';
import { orderWaits } from '../shared/activity-order.mjs';
import { toolSections, communicationFailure } from '../hooks/tool-presentation.js';

function fixture(cacheLimits) {
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
  return { client, controller, requests, store: cacheLimits ? new ActivityStore({ client, controller, cacheLimits }) : ActivityStore.attach(client, controller) };
}

test('message metadata survives previews and requires evidence for a final reply', async () => {
  const { client, store } = fixture();
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: 'root', turnId: 'turn', ...params } });
  emit('item/completed', { item: { id: 'c', type: 'agentMessage', text: 'x'.repeat(10000), phase: 'commentary' } });
  let entry = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(entry.message, { phase: 'commentary', complete: true, truncated: true, is_final: false });
  emit('item/completed', { item: { id: 'p', type: 'agentMessage', text: 'partial', phase: 'partial_answer' } });
  emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, false);
  emit('item/completed', { item: { id: 'f', type: 'agentMessage', text: 'ok', phase: 'final_answer' } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, true);
  store.close();
});

test('only explicit final phase with completion is final in history and stream', async () => {
  const { client, store } = fixture();
  let status = 'inProgress';
  client.request = async (method) => method === 'thread/turns/list' ? { data: [{ id: 'turn', status }], nextCursor: null } : { data: [
    { item: { id: 'last', type: 'agentMessage', text: 'answer' } },
    { item: { id: 'old', type: 'agentMessage', text: 'x'.repeat(10000), phase: 'final_answer' } },
  ], nextCursor: null };
  assert.equal((await store.history({ target: 'a' })).entries.at(-1).message.is_final, false);
  status = 'completed';
  const entries = (await store.history({ target: 'a' })).entries;
  assert.equal(entries[0].message.is_final, true); assert.equal(entries[0].message.phase, 'final_answer'); assert.equal(entries[1].message.is_final, false);
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: 'root', turnId: 'live', ...params } });
  emit('item/completed', { item: { id: 'live-last', type: 'agentMessage', text: 'legacy' } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, false);
  emit('turn/completed', { turn: { id: 'live', status: 'completed' } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, false);
  emit('item/started', { item: { id: 'explicit', type: 'agentMessage', text: 'x'.repeat(10000), phase: 'final_answer' } });
  emit('item/agentMessage/delta', { itemId: 'explicit', delta: ' more' });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, false);
  emit('turn/completed', { turn: { id: 'live', status: 'completed' } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, true);
  store.close();
});

test('expand reads once, preserves rich text, and exports long messages at Unicode boundaries', async () => {
  const { client, store } = fixture();
  let calls = 0, text = '# Heading\n\n' + '**rich** 😀\n'.repeat(1000), type = 'agentMessage';
  client.request = async () => { calls++; return { data: [{ turnId: 'turn', item: type === 'agentMessage' ? { id: 'body', type, text } : { id: 'body', type: 'dynamicToolCall', tool: 'notify_parent', arguments: { message: text } } }] }; };
  for (const view of ['message', 'communication']) {
    type = view === 'message' ? 'agentMessage' : 'communication';
    let before = calls;
    const args = { target: 'a', turn_id: 'turn', item_id: 'body', view, expand: true };
    assert.deepEqual(await store.detail(args), { text, format: 'markdown', total_length: text.length, external: false });
    assert.equal(calls, before + 1);
    const short = text; text = 'x'.repeat(47999) + '😀' + '\n**end**'; before = calls;
    const result = await store.detail(args);
    assert.equal(calls, before + 1); assert.equal(result.text, 'x'.repeat(47999));
    assert.equal(result.total_length, text.length); assert.equal(result.format, 'text'); assert.equal(result.external, true);
    assert.equal(fileURLToPath(result.file_url), result.file_path); assert.equal(readFileSync(result.file_path, 'utf8'), text);
    text = short;
  }
  const before = calls;
  for (const extra of [{ view: 'output' }, { view: 'message', expand: false }, { view: 'message', offset: 1 }, { view: 'message', file_path: 'x' }, { view: 'message', bulk: true }, { view: 'communication', export: true }]) {
    await assert.rejects(() => store.detail({ target: 'a', turn_id: 'turn', item_id: 'body', expand: true, ...extra }), /Invalid/);
  }
  assert.equal(calls, before);
  await store.close();
});

test('message detail returns original text across Unicode boundaries and rejects tools', async () => {
  const { client, store } = fixture();
  const text = 'x'.repeat(15999) + '😀' + ' tail\n';
  client.request = async () => ({ data: [{ turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text } }] });
  const first = await store.detail({ target: 'a', turn_id: 'turn', item_id: 'reply', view: 'message' });
  const second = await store.detail({ target: 'a', turn_id: 'turn', item_id: 'reply', view: 'message', offset: first.next_offset });
  assert.equal(first.text + second.text, text); assert.equal(first.total_length, text.length); assert.equal(second.next_offset, null);
  client.request = async () => ({ data: [{ turnId: 'turn', item: { id: 'reply', type: 'mcpToolCall', result: 'secret' } }] });
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 'turn', item_id: 'reply', view: 'message' }), /unavailable/);
  store.close();
});

test('bulk message and communication pages preserve long text within the process output limit', async () => {
  const { client, store } = fixture();
  const text = '\u0000'.repeat(524287) + '😀' + '\u0000'.repeat(524300);
  let calls = 0, type = 'agentMessage';
  client.request = async () => {
    calls++;
    return { data: [{ turnId: 'turn', item: type === 'agentMessage'
      ? { id: 'body', type, text }
      : { id: 'body', type: 'dynamicToolCall', tool: 'notify_parent', arguments: { message: text } } }] };
  };
  for (const view of ['message', 'communication']) {
    type = view === 'message' ? 'agentMessage' : 'dynamicToolCall';
    const args = { target: 'a', turn_id: 'turn', item_id: 'body', view, bulk: true };
    let offset = 0, assembled = '', pages = 0;
    do {
      const page = await store.detail({ ...args, offset });
      assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < 4 * 1024 * 1024);
      assembled += page.text; offset = page.next_offset; pages++;
    } while (offset !== null);
    assert.equal(assembled, text); assert.equal(pages, 3);
  }
  const before = calls;
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 'turn', item_id: 'body', view: 'output', bulk: true }), /Invalid bulk/);
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 'turn', item_id: 'body', view: 'message', bulk: false }), /Invalid bulk/);
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 'turn', item_id: 'body', view: 'communication', bulk: true, export: true }), /Invalid bulk/);
  assert.equal(calls, before);
  await store.close();
});

test('communication export creates a reusable complete owned Markdown snapshot', async () => {
  const { client, store } = fixture();
  const text = '# Message\n' + 'long😀'.repeat(30000);
  client.request = async () => ({ data: [{ turnId: 'turn', item: { id: 'msg', type: 'dynamicToolCall', tool: 'notify_parent', arguments: { message: text } } }] });
  const args = { target: 'a', turn_id: 'turn', item_id: 'msg', view: 'communication', export: true };
  const [first, second] = await Promise.all([store.detail(args), store.detail(args)]);
  assert.deepEqual(second, first); assert.equal(fileURLToPath(first.file_url), first.file_path);
  assert.equal(readFileSync(first.file_path, 'utf8'), text);
  unlinkSync(first.file_path);
  assert.deepEqual(await store.detail(args), first);
  assert.equal(readFileSync(first.file_path, 'utf8'), text);
  await assert.rejects(() => store.detail({ ...args, item_id: 'foreign' }), /unavailable/);
  await assert.rejects(() => store.detail({ ...args, target: 'foreign' }), /Unknown/);
  let requests = 0;
  client.request = async () => { requests++; throw new Error('unexpected RPC'); };
  await assert.rejects(() => store.detail({ ...args, offset: 1 }), /Invalid export/);
  await assert.rejects(() => store.detail({ ...args, file_path: 'other' }), /Invalid export/);
  assert.equal(requests, 0);
  await store.close();
});

test('closing an activity store rejects queued exports and waits for cleanup', async () => {
  const { store } = fixture();
  let release;
  store.exportQueue = new Promise(resolve => { release = resolve; });
  const result = assert.rejects(store.exportCommunication('message'), /closed/);
  const closed = store.close();
  release();
  await result; await closed;
  assert.equal(store.exportDir, null);
});

test('activity summaries expose persistent context origins without guessing missing metadata', () => {
  const { controller, store } = fixture();
  const agent = controller.agents.get('a'); assert.equal(store.list().agents[0].context_source, 'unknown');
  for (const source of ['new', 'claude', 'codex', 'unknown']) {
    agent.contextSource = source;
    assert.equal(store.list().agents[0].context_source, source);
    assert.equal(store.summary(agent).context_source, source);
  }
  store.close();
});

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

test('adopted history crosses repeated compactions with a bounded cursor trail', async () => {
  const { client, store, controller } = fixture();
  controller.agents.get('a').contextSource = 'codex';
  client.request = async (method, args) => {
    if (method === 'thread/turns/list') {
      const index = Number(args.cursor ?? 0);
      return { data: [{ id: `turn${index}`, status: 'completed' }], nextCursor: index < 149 ? String(index + 1) : null };
    }
    return { data: [{ item: { id: args.turnId, type: Number(args.turnId.slice(4)) % 10 === 0 ? 'contextCompaction' : 'agentMessage', text: 'x' } }], nextCursor: null };
  };
  let cursor, count = 0, compactions = 0;
  do {
    const page = await store.history({ target: 'a', limit: 1, cursor });
    assert.equal(page.entries[0].id, `turn${count++}`);
    assert.equal(page.agent.context_source, 'codex');
    if (page.entries[0].type === 'contextCompaction') { compactions++; assert.equal(page.entries[0].data.stage, 'completed'); }
    cursor = page.next_cursor;
    assert.ok((cursor?.seen_turn_cursors?.length ?? 0) <= 64);
  } while (cursor);
  assert.equal(count, 150);
  assert.equal(compactions, 15);
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
  assert.equal(store.revision({ target: 'a' }).entries.find((e) => e.id === 'user').data.message_origin, 'parent');
  const legacy = 'Claude is your parent agent. When important design questions, disagreements or better approaches arise, discuss them before substantial implementation, briefly giving evidence, a recommendation and tradeoffs. Use request_user_input when an answer is needed before continuing; use notify_parent for consequential coordination, not routine progress. Your own subagents remain available.';
  const original = { id: 'legacy-user', type: 'userMessage', content: [{ text: legacy + '\n\nOriginal task' }] };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'old-turn', item: original } });
  assert.equal(store.revision({ target: 'a' }).entries.find(entry => entry.id === 'legacy-user').preview, 'Original task');
  assert.equal(original.content[0].text, legacy + '\n\nOriginal task');
  const quoted = 'Explain these historical instructions: ' + legacy + '\n\nKeep this user text';
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'later-turn', item: { id: 'quoted-guidance', type: 'userMessage', content: [{ text: quoted }] } } });
  assert.equal(store.revision({ target: 'a' }).entries.find(entry => entry.id === 'quoted-guidance').preview, quoted);
  assert.equal(store.revision({ target: 'a' }).entries.find(entry => entry.id === 'quoted-guidance').data.message_origin, undefined);
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
  const diff = '--- a/file.js\n+++ b/file.js\n@@ -1,1 +1,900 @@\n-old\n' + '+new content\n'.repeat(900);
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: { id: 'edit', type: 'fileChange', changes: [{ path: 'src/file.js', diff }, { path: 'image.png' }] } } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(entry.data.fileSummary, [{ path: 'src/file.js', kind: 'unknown', added: 900, removed: 1 }, { path: 'image.png', kind: 'unknown' }]);
  assert.ok(entry.data.changes[0].diff.length < diff.length);
  assert.equal(entry.file_preview.complete, false);
});

test('file preview completeness detects shared budget clipping across files in live and history', async () => {
  const { store, client } = fixture();
  const patch = n => `--- a/${n}.js\n+++ b/${n}.js\n@@ -1 +1 @@\n-old\n+${'x'.repeat(1800)}\n`;
  const item = { id: 'multi', type: 'fileChange', changes: [1, 2, 3].map(n => ({ path: `${n}.js`, kind: 'update', diff: patch(n) })) };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item } });
  const live = store.revision({ target: 'a' }).entries[0];
  assert.equal(live.file_preview.complete, false);
  assert.ok(live.data.changes[1].diff.length < 4096);
  assert.deepEqual(live.data.fileSummary.map(({ added, removed }) => [added, removed]), [[1, 1], [1, 1], [1, 1]]);
  client.request = async method => method === 'thread/turns/list' ? { data: [{ id: 'turn' }], nextCursor: null } : { data: [{ item }], nextCursor: null };
  assert.equal((await store.history({ target: 'a' })).entries[0].file_preview.complete, false);
  const small = { id: 'small', type: 'fileChange', changes: [{ path: 'literal.js', kind: 'update', diff: 'literal…' }] };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item: small } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).file_preview.complete, true);
  await store.close();
});

test('large update file detail returns complete source and structured rows', async () => {
  const { store, client } = fixture();
  const diff = '--- a/large.js\n+++ b/large.js\n@@ -1,300 +1,300 @@\n' + '-old\n'.repeat(300) + '+new\n'.repeat(300);
  const item = { id: 'large', type: 'fileChange', changes: [{ path: 'large.js', kind: 'update', diff }] };
  client.request = async () => ({ data: [{ item }] });
  const pages = []; let offset = 0;
  do { const page = await store.detail({ target: 'a', turn_id: 'turn', item_id: 'large', file_path: 'large.js', offset }); pages.push(page); offset = page.next_offset; } while (offset !== null);
  assert.equal(pages.map(page => page.text).join(''), diff);
  assert.ok(pages.every(page => page.format === 'diff'));
  assert.equal(pages.flatMap(page => page.rows).filter(row => row.kind === 'removed').length, 300);
  assert.equal(pages.flatMap(page => page.rows).filter(row => row.kind === 'added').length, 300);
  await store.close();
});

test('file detail pages retain normalized diff rows and exact previous offsets', async () => {
  const { store, client } = fixture();
  const item = { id: 'files', type: 'fileChange', changes: [{ path: 'notes.md', kind: { type: 'add' }, diff: '- item\n'.repeat(350) }] };
  client.request = async () => ({ data: [{ item }] });
  const args = { target: 'a', turn_id: 't', item_id: 'files', file_path: 'notes.md' };
  const pages = []; let offset = 0;
  do { const page = await store.detail({ ...args, offset }); pages.push(page); offset = page.next_offset; } while (offset !== null);
  assert.ok(pages.length > 2); assert.ok(pages.every(p => p.format === 'diff' && p.rows.length <= 120));
  assert.equal(pages.flatMap(p => p.rows).filter(r => r.kind === 'added').length, 350);
  for (let i = 1; i < pages.length; i++) {
    const previous = await store.detail({ ...args, offset: pages[i].previous_offset });
    assert.equal(previous.text, pages[i - 1].text);
  }
  store.close();
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
  assert.match(result.text, /binary omitted/); assert.ok(!result.text.includes(payload));
  client.request = async () => ({ data: [{ item: { id: 'message', type: 'agentMessage', text: 'Ordinary message' } }] });
  assert.deepEqual(await store.detail({ target: 'a', turn_id: 't', item_id: 'message', view: 'output' }), { text: 'Ordinary message', next_offset: null });
  client.request = async () => ({ data: [{ item: { id: 'files', type: 'fileChange', changes: [{ path: 'a.js', diff: '@@ -1 +1 @@\n-old\n+new' }] } }] });
  const file = await store.detail({ target: 'a', turn_id: 't', item_id: 'files', view: 'output', file_path: 'a.js' });
  assert.equal(file.text, '@@ -1 +1 @@\n-old\n+new'); assert.equal(file.format, 'diff'); assert.equal(file.previous_offset, null); assert.equal(file.next_offset, null); assert.equal(file.rows.length, 3);
});


test('communication pages preserve complete sent text and enforce ownership', async () => {
  const { client, store } = fixture();
  const body = '中'.repeat(15999) + '😀' + '\n公式 $x^2$\n```js\nconsole.log(1)\n```' + '尾'.repeat(18000);
  const sent = { id: 'sent', type: 'dynamicToolCall', tool: 'notify_parent', arguments: JSON.stringify({ message: body }), result: 'Delivered to parent.' };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: sent } });
  assert.deepEqual(store.revision({ target: 'a' }).entries[0].communication, { title: '发给 Claude', text: body.slice(0, 2048), truncated: true });
  let current = sent;
  client.request = async (method, args) => { assert.equal(args.threadId, 'root'); return { data: [{ turnId: 't', item: current }] }; };
  let offset = 0, reconstructed = '';
  do {
    const part = await store.detail({ target: 'a', turn_id: 't', item_id: 'sent', view: 'communication', offset });
    assert.equal(part.format, 'text');
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));
    reconstructed += part.text; offset = part.next_offset;
  } while (offset !== null);
  assert.equal(reconstructed, body);
  await assert.rejects(() => store.detail({ target: 'foreign', turn_id: 't', item_id: 'sent', view: 'communication' }), /Unknown/);
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 'wrong', item_id: 'sent', view: 'communication' }), /unavailable/);
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 't', item_id: 'wrong', view: 'communication' }), /unavailable/);
  current = { ...sent, type: 'mcpToolCall' };
  await assert.rejects(() => store.detail({ target: 'a', turn_id: 't', item_id: 'sent', view: 'communication' }), /unavailable/);
  store.close();
});

test('native communication exposes only the direct sender message', async () => {
  const { client, store } = fixture();
  const emit = item => client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  const item = { id: 'native', type: 'collabAgentToolCall', tool: 'sendMessage', senderThreadId: 'root', receiverThreadIds: ['child-id'], prompt: '你好\n$x$\n```\ncode\n```', agentsStates: { 'child-id': { name: '小组', message: 'private descendant output' } } };
  emit(item);
  emit({ ...item, id: 'spawn', tool: 'spawnAgent' });
  emit({ ...item, id: 'followup', tool: 'followupTask' });
  emit({ ...item, id: 'foreign-sender', senderThreadId: 'child-id' });
  emit({ id: 'mcp', type: 'mcpToolCall', tool: 'notify_parent', arguments: { message: 'unrelated' } });
  emit({ id: 'object', type: 'dynamicToolCall', tool: 'notify_parent', arguments: { message: '简短消息' } });
  const entries = store.revision({ target: 'a' }).entries;
  assert.deepEqual(entries[0].communication, { title: '发给 小组', text: item.prompt, truncated: false });
  for (const entry of entries.slice(1, 5)) assert.equal(entry.communication, undefined);
  assert.equal(entries[5].communication.text, '简短消息');
  assert.ok(!JSON.stringify(entries[0]).includes('private descendant output'));
  client.request = async () => ({ data: [{ item }] });
  assert.deepEqual(await store.detail({ target: 'a', turn_id: 't', item_id: 'native', view: 'communication' }), { text: item.prompt, next_offset: null, format: 'markdown', total_length: item.prompt.length });
  store.close();
});


test('history projects full native communication before bounded cleaning', async () => {
  const { client, store } = fixture();
  const text = '汉字\n$x$\n'.repeat(1500);
  const item = { id: 'notice', type: 'dynamicToolCall', namespace: null, tool: 'notify_parent', arguments: { message: text } };
  client.request = async method => method === 'thread/turns/list' ? { data: [{ id: 't' }], nextCursor: null } : { data: [{ item }], nextCursor: null };
  const { entries } = await store.history({ target: 'a' });
  assert.equal(entries[0].communication.text, text.slice(0, 2048));
  assert.equal(entries[0].communication.truncated, true);
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item: { ...item, id: 'namespaced', namespace: 'other' } } });
  assert.equal(store.revision({ target: 'a' }).entries[0].communication, undefined);
  store.close();
});

test('communication displays agent names and preserves emoji at the preview boundary', () => {
  const { client, store } = fixture();
  const emit = item => client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  const body = 'a'.repeat(2047) + '😀' + 'end';
  emit({ id: 'preview', type: 'dynamicToolCall', tool: 'notify_parent', arguments: { message: body } });
  emit({ id: 'names', type: 'collabAgentToolCall', tool: 'sendInput', senderThreadId: 'root', receiverThreadIds: ['known', '/root/raw-id'], prompt: 'hello', agentsStates: { known: { name: '/root/team/researcher' } } });
  const [preview, names] = store.revision({ target: 'a' }).entries;
  assert.equal(preview.communication.text, 'a'.repeat(2047));
  assert.equal(preview.communication.truncated, true);
  assert.equal(names.communication.title, '发给 Researcher, /root/raw-id');
  assert.deepEqual(names.data.receiverThreadIds, ['known', '/root/raw-id']);
  store.close();
});

test('long communication arguments cannot hide a later delivery failure', () => {
  const { client, store } = fixture();
  const item = { id: 'failed-notice', type: 'dynamicToolCall', tool: 'notify_parent',
    arguments: { message: '长消息'.repeat(10000) }, status: 'failed', success: false,
    error: { details: 'x'.repeat(10000), message: '投递失败' } };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.equal(entry.data.status, 'failed');
  assert.equal(entry.data.success, false);
  assert.equal(communicationFailure(entry), '投递失败');
  assert.ok(JSON.stringify(entry.data).length < 5000);
  store.close();
});

test('media detail lazily decodes mixed protocol images, pages them, and cleans owned cache', async () => {
  const { client, store } = fixture();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
  const blocks = [{ type: 'text', text: 'before' }, ...Array.from({ length: 9 }, () => ({ type: 'image', data: png, mimeType: 'image/png' })), { type: 'text', text: 'after' }];
  const item = { id: 'media', type: 'mcpToolCall', result: { content: [{ type: 'tool_result', content: blocks }] } };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(entry.media, { count: 9, has_images: true });
  assert.ok(!JSON.stringify(entry).includes(png)); assert.equal(store.exportDir, null);
  client.request = async () => ({ data: [{ turnId: 'turn', item }] });
  const args = { target: 'a', turn_id: 'turn', item_id: 'media', view: 'media' };
  const first = await store.detail(args), second = await store.detail({ ...args, offset: first.next_offset });
  assert.equal(first.images.length, 8); assert.equal(first.count, 9); assert.equal(second.images.length, 1); assert.equal(second.next_offset, null);
  assert.equal(first.images[0].previewable, true); assert.equal(first.images[0].width, 1); assert.equal(first.images[0].height, 1);
  assert.ok(first.images.every(image => image.path === first.images[0].path));
  assert.equal(readFileSync(first.images[0].path).toString('base64'), png);
  const output = await store.detail({ ...args, view: 'output' });
  assert.ok(!output.text.includes(png)); assert.match(output.text, /before/); assert.match(output.text, /after/);
  const cachePath = first.images[0].path; await store.close();
  assert.throws(() => readFileSync(cachePath), /ENOENT/);
});

test('media rejects invalid data, preserves original paths and enforces record ownership', async () => {
  const { client, store } = fixture();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
  const file = fileURLToPath(new URL('./media-original.png', import.meta.url));
  const { writeFile, unlink } = await import('node:fs/promises');
  await writeFile(file, Buffer.from(png, 'base64'));
  try {
    const item = { id: 'media', type: 'dynamicToolCall', result: { contentItems: [
      { type: 'image', data: 'bad!', mime_type: 'image/png' },
      { type: 'image', data: png, mimeType: 'image/jpeg' },
      { type: 'input_image', imageUrl: { url: `data:image/png;base64,${png}` } },
      { type: 'image', data: 'A'.repeat(14 * 1024 * 1024), mimeType: 'image/png' },
      { type: 'image', data: png, mimeType: 'image/unknown' },
    ] } };
    client.request = async () => ({ data: [{ turnId: 'turn', item }] });
    const args = { target: 'a', turn_id: 'turn', item_id: 'media', view: 'media' };
    const result = await store.detail(args);
    assert.deepEqual(result.images.map(i => i.previewable), [false, false, true, false, false]);
    assert.ok(result.images.filter(i => !i.previewable).every(i => i.notice));
    await assert.rejects(() => store.detail({ ...args, target: 'foreign' }), /Unknown/);
    await assert.rejects(() => store.detail({ ...args, turn_id: 'foreign' }), /unavailable/);
    await assert.rejects(() => store.detail({ ...args, item_id: 'foreign' }), /unavailable/);
    client.request = async () => ({ data: [{ turnId: 'turn', item: { id: 'media', type: 'imageView', path: file } }] });
    const local = (await store.detail(args)).images[0]; assert.equal(local.path, file); assert.equal(local.previewable, true);
    await store.close(); assert.equal(readFileSync(file).toString('base64'), png);
  } finally { await unlink(file); }
});

test('non-PNG image bytes stay intact and unrelated business data stays text', async () => {
  const { client, store } = fixture();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const item = { id: 'media', type: 'mcpToolCall', result: { content: [
    { type: 'text', text: 'first' }, { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: 'last' },
  ], structuredContent: { data: 'ordinary business data', category: 'photo' } } };
  client.request = async () => ({ data: [{ turnId: 'turn', item }] });
  const args = { target: 'a', turn_id: 'turn', item_id: 'media' };
  const image = (await store.detail({ ...args, view: 'media' })).images[0];
  assert.equal(image.previewable, false); assert.equal(image.mime_type, 'image/jpeg'); assert.ok(image.file_url); assert.deepEqual(readFileSync(image.path), jpeg);
  const text = (await store.detail({ ...args, view: 'output' })).text;
  assert.ok(text.indexOf('first') < text.indexOf('last')); assert.match(text, /ordinary business data/); assert.ok(!text.includes(jpeg.toString('base64')));
  await store.close();
});

test('image-only output has no text while mixed text and safe raw metadata remain', async () => {
  const { client, store } = fixture();
  const payload = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';
  let content = [{ type: 'tool_result', content: [{ type: 'image', mimeType: 'image/png', data: payload }] }];
  const item = () => ({ id: 'media', type: 'mcpToolCall', result: { content } });
  client.request = async () => ({ data: [{ turnId: 'turn', item: item() }] });
  const args = { target: 'a', turn_id: 'turn', item_id: 'media' };
  assert.equal((await store.detail({ ...args, view: 'output' })).text, '');
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item: item() } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.ok(!JSON.stringify(entry).includes(payload)); assert.match(JSON.stringify(entry.data), /media_omitted/);
  content = [{ type: 'text', text: 'first' }, { type: 'image', mimeType: 'image/png', data: payload }, { type: 'text', text: 'last' }];
  assert.equal((await store.detail({ ...args, view: 'output' })).text, 'first\nlast');
  content = [{ type: 'text', text: '[image omitted from text]' }];
  assert.equal((await store.detail({ ...args, view: 'output' })).text, '[image omitted from text]');
  await store.close();
});

test('media sanitization bounds deeply nested and cyclic data', async () => {
  const { sanitizeMedia } = await import('../shared/tool-media.mjs');
  const root = {}, cyclic = { root }; let node = root;
  for (let i = 0; i < 10000; i++) { node.next = {}; node = node.next; }
  node.back = cyclic;
  assert.match(JSON.stringify(sanitizeMedia(root)), /nested data omitted/);
  const loop = {}; loop.self = loop;
  assert.match(JSON.stringify(sanitizeMedia(loop)), /circular data omitted/);
});

test('serialized MCP image results are sanitized and expanded only on request', async () => {
  const { client, store } = fixture();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const encoded = JSON.stringify({ content: [
    { type: 'text', text: 'before' },
    { type: 'image', data: jpeg, mimeType: 'image/jpeg', description: 'image description' },
    { type: 'image', data: jpeg, mimeType: 'image/jpeg' },
    { type: 'text', text: 'after' },
  ], isError: true, extra: 'keep metadata' });
  const item = { id: 'wrapped-media', type: 'mcpToolCall', result: { content: [{ type: 'text', text: encoded, note: 'keep note' }] } };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(entry.media, { count: 2, has_images: true });
  assert.ok(!JSON.stringify(entry).includes(jpeg));
  assert.equal(store.exportDir, null);
  client.request = async () => ({ data: [{ turnId: 'turn', item }] });
  const args = { target: 'a', turn_id: 'turn', item_id: item.id };
  const output = (await store.detail({ ...args, view: 'output' })).text;
  assert.match(output, /before/); assert.match(output, /after/);
  assert.match(output, /isError/); assert.match(output, /keep metadata/); assert.match(output, /keep note/); assert.match(output, /image description/);
  assert.ok(!output.includes(jpeg));
  const media = await store.detail({ ...args, view: 'media' });
  assert.equal(media.images.length, 2);
  assert.ok(media.images.every(image => image.mime_type === 'image/jpeg'));
  assert.deepEqual(readFileSync(media.images[0].path), Buffer.from(jpeg, 'base64'));
  await store.close();
});

test('serialized result recognition leaves prose and unrelated JSON untouched', async () => {
  const { toolOutputText } = await import('../shared/tool-output.mjs');
  const { collectImages } = await import('../shared/tool-media.mjs');
  const prose = 'example: {"content":[{"type":"image","data":"literal"}]}';
  const business = JSON.stringify({ content: ['ordinary'], data: 'business data' });
  for (const value of [prose, business]) {
    assert.equal(toolOutputText(value), value);
    assert.equal(collectImages({ result: value }).images.length, 0);
  }
});

test('Windows codecs convert generated JPEG GIF BMP previews and preserve originals', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'codex-preview-test-'));
  const script = `Add-Type -AssemblyName System.Drawing\n$b = New-Object System.Drawing.Bitmap(1600, 800)\ntry { $b.SetPixel(0, 0, [System.Drawing.Color]::Red); foreach ($kind in @('Jpeg', 'Gif', 'Bmp')) { $f = [System.Drawing.Imaging.ImageFormat]::$kind; $b.Save((Join-Path $env:CODEX_PREVIEW_FIXTURES ($kind.ToLower() + '.img')), $f) } } finally { $b.Dispose() }`;
  const { client, store } = fixture();
  try {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, env: { ...process.env, CODEX_PREVIEW_FIXTURES: dir } });
    const formats = [['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['bmp', 'image/bmp']];
    const sources = await Promise.all(formats.map(async ([name, mimeType]) => ({ type: 'image', mimeType, data: (await readFile(join(dir, `${name}.img`))).toString('base64') })));
    const item = { id: 'media', type: 'mcpToolCall', result: { content: sources } };
    client.request = async () => ({ data: [{ turnId: 'turn', item }] });
    const args = { target: 'a', turn_id: 'turn', item_id: 'media', view: 'media' };
    const started = Date.now(); const first = await store.detail(args); const elapsed = Date.now() - started;
    assert.ok(elapsed < 30000, `conversions took ${elapsed}ms`);
    for (let i = 0; i < formats.length; i++) {
      const result = first.images[i]; assert.equal(result.previewable, true, result.notice); assert.equal(result.mime_type, formats[i][1]);
      assert.equal(result.preview_mime_type, 'image/png'); assert.equal(result.width, 1280); assert.equal(result.height, 640);
      assert.notEqual(result.path, fileURLToPath(result.file_url));
      assert.deepEqual(await readFile(fileURLToPath(result.file_url)), Buffer.from(sources[i].data, 'base64'));
      assert.deepEqual((await readFile(result.path)).subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
    }
    assert.match(first.images[1].notice, /first frame/);
    const second = await store.detail(args); assert.deepEqual(second.images.map(image => image.path), first.images.map(image => image.path));
    const paths = first.images.map(image => image.path); await store.close();
    for (const path of paths) await assert.rejects(readFile(path), /ENOENT/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('media scanning is bounded and reports when its image or node limit is reached', async () => {
  const { client, store } = fixture();
  const image = { type: 'image', mimeType: 'image/png', data: 'a' };
  let item = { id: 'media', type: 'mcpToolCall', result: { content: Array.from({ length: 50000 }, () => image) } };
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item } });
  const entry = store.revision({ target: 'a' }).entries[0];
  assert.deepEqual(entry.media, { count: 256, has_images: true, omitted: true });
  client.request = async () => ({ data: [{ turnId: 'turn', item }] });
  const args = { target: 'a', turn_id: 'turn', item_id: 'media', view: 'media', offset: 256 };
  const result = await store.detail(args); assert.equal(result.count, 256); assert.equal(result.omitted, true); assert.match(result.notice, /scan.*limit/); assert.deepEqual(result.images, []);
  item = { id: 'media', type: 'mcpToolCall', result: { content: Array.from({ length: 50000 }, () => null) } };
  const empty = await store.detail(args); assert.equal(empty.count, 0); assert.equal(empty.omitted, true); assert.match(empty.notice, /scan.*limit/);
  await store.close();
});

test('bounded display cache preserves returned paths and rejects only new assets', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
  const { client, store } = fixture({ files: 2, bytes: png.length + 100 });
  let item = { id: 'media', type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] } };
  client.request = async () => ({ data: [{ turnId: 'turn', item }] });
  const args = { target: 'a', turn_id: 'turn', item_id: 'media', view: 'media' };
  const first = (await store.detail(args)).images[0]; const markdown = await store.exportCommunication('persistent markdown');
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  item = { ...item, result: { content: [{ type: 'image', mimeType: 'image/png', data: changed.toString('base64') }] } };
  const refused = (await store.detail(args)).images[0]; assert.equal(refused.previewable, false); assert.match(refused.notice, /capacity/); assert.equal(refused.file_url, undefined);
  await assert.rejects(store.exportCommunication('new markdown'), /capacity/);
  assert.deepEqual(readFileSync(first.path), png); assert.equal(readFileSync(markdown.file_path, 'utf8'), 'persistent markdown');
  assert.equal((await store.exportCommunication('persistent markdown')).file_path, markdown.file_path);
  assert.equal(store.exports.size, 2); await store.close();
  assert.throws(() => readFileSync(first.path), /ENOENT/); assert.throws(() => readFileSync(markdown.file_path), /ENOENT/);

  const limited = fixture({ files: 10, bytes: png.length - 1 });
  limited.client.request = async () => ({ data: [{ turnId: 'turn', item }] });
  const denied = (await limited.store.detail(args)).images[0]; assert.match(denied.notice, /capacity/); assert.equal(limited.store.exports.size, 0);
  await limited.store.close();
});

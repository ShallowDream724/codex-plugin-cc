import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActivityStore } from '../runtime/activity.mjs';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { durationLabel, finalTimestamp, expandProcessReferences, turnTimeline } from '../hooks/turn-history.js';

const message = (id, phase, text) => ({ id, type: 'agentMessage', phase, text });
const prompt = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
function fixture(turns) {
  const client = new EventEmitter(), controller = new EventEmitter(), requests = [];
  const a = { id: 'a', threadId: 'root', status: 'completed', name: 'A', createdAtMs: 1, lastActivityAtMs: 1 };
  controller.agents = new Map([['a', a]]); controller.threads = new Map([['root', a]]); controller.find = () => a;
  client.request = async (method, args) => {
    requests.push({ method, args });
    const offset = Number(args.cursor ?? 0);
    if (method === 'thread/turns/list') {
      const { items, ...turn } = turns[offset];
      return { data: [turn], nextCursor: offset + 1 < turns.length ? String(offset + 1) : null };
    }
    assert.equal(method, 'thread/items/list');
    const items = turns.find(turn => turn.id === args.turnId).items.slice().reverse();
    const data = items.slice(offset, offset + args.limit).map(item => ({ item, turnId: args.turnId, completedAtMs: item.completedAtMs ?? null }));
    return { data, nextCursor: offset + args.limit < items.length ? String(offset + args.limit) : null };
  };
  return { client, store: ActivityStore.attach(client, controller), requests };
}

test('over forty native process pages fit alongside older answers without transferring tool previews', async t => {
  const process = Array.from({ length: 2050 }, (_, i) => ({ id: 'cmd-' + i, type: 'commandExecution', command: 'long-command-'.repeat(500) }));
  process.splice(500, 0, prompt('steer', '[Direct message from the user]\n\nmid-turn steer'));
  const { store, requests } = fixture([
    { id: 'new', status: 'completed', startedAt: 100, completedAt: 4000, durationMs: 3900567,
      items: [prompt('start', 'initial assignment'), ...process, { ...message('answer', 'final_answer', 'the answer'), completedAtMs: 3999999 }] },
    { id: 'old', status: 'completed', items: [message('old-answer', 'final_answer', 'previous answer')] },
  ]);
  t.after(() => store.close());
  const result = await store.history({ target: 'a', limit: 400, character_budget: 64000, fold_turns: true });
  assert.equal(result.next_cursor, null);
  assert.ok(JSON.stringify(result).length < 36000);
  assert.ok(!JSON.stringify(result).includes('long-command-'));
  assert.ok(requests.filter(r => r.method === 'thread/items/list').length > 40);
  assert.ok(requests.filter(r => r.method === 'thread/items/list').every(r => r.args.limit <= 50 && r.args.deferOutput.commandExecution));
  assert.equal(result.entries.find(e => e.id === 'answer').completed_at_ms, 3999999);
  const all = expandProcessReferences(result.entries), turns = new Map(result.turns.map(turn => [turn.id, turn]));
  const folded = turnTimeline(all, turns, () => false);
  assert.deepEqual(folded.map(e => e.id), ['old-answer', 'start', '@turn-summary', 'answer']);
  assert.equal(durationLabel(folded.at(-2).duration_ms), '用时 1小时5分0秒');
  const ref = folded.at(-2).firstPage, before = requests.length;
  const loaded = await store.history({ target: 'a', process_page: ref.locator });
  assert.equal(requests.length - before, 1); assert.ok(loaded.entries.some(e => e.id === ref.id));
  const pages = new Map([[ref.pageKey, { records: new Map(loaded.entries.map(e => [e.id, e])) }]]);
  const opened = turnTimeline(all, turns, () => true, pages);
  assert.equal(opened[2].type, 'turnSummary');
  assert.ok(opened.some(e => e.id === 'cmd-0' && e.type === 'commandExecution'));
  assert.equal(opened.filter(e => e.id === 'steer').length, 1);
  const steer = opened.findIndex(e => e.id === 'steer');
  assert.deepEqual(opened.slice(steer - 1, steer + 2).map(e => e.id), ['cmd-499', 'steer', 'cmd-500']);
  assert.ok(opened.some(e => e.type === 'turnProcessPending'));
  assert.equal(opened.at(-1).id, 'answer');
});

test('historical timestamps use local Monday weeks across a year boundary and discard missing dates', () => {
  const now = new Date(2026, 0, 5, 12), at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime();
  assert.equal(finalTimestamp(at(2026, 1, 5, 0, 4), now), '周一 00:04');
  assert.equal(finalTimestamp(at(2026, 1, 4, 23, 59), now), '上周日 23:59');
  assert.equal(finalTimestamp(at(2025, 12, 29, 6, 8), now), '上周一 06:08');
  assert.equal(finalTimestamp(at(2025, 12, 28, 16, 0), now), '12月28日 16:00');
  assert.equal(finalTimestamp(null, now), ''); assert.equal(durationLabel(null), '查看过程');
});

test('a history continuation can re-open its native turn metadata after cache eviction', async t => {
  const long = Array.from({ length: 800 }, (_, i) => ({ id: 'stable-item-identifier-'.repeat(3) + i, type: 'commandExecution' }));
  const { store } = fixture([{ id: 't', status: 'completed', durationMs: 2000, items: [prompt('p', 'initial'), ...long, message('f', 'final_answer', 'answer')] }]);
  t.after(() => store.close());
  const args = { target: 'a', limit: 400, character_budget: 16000, fold_turns: true };
  let cursor, entries = [], pages = 0;
  do {
    const result = await store.history({ ...args, cursor });
    assert.equal(result.turns[0].duration_ms, 2000);
    entries = expandProcessReferences(result.entries).concat(entries); pages++;
    cursor = result.next_cursor;
    store.turnStates.clear();
  } while (cursor);
  assert.ok(pages > 1);
  assert.equal(entries.length, 802);
  assert.ok(entries.slice(1, -1).every(entry => entry.type === 'turnProcessRef'));
  assert.deepEqual(turnTimeline(entries, new Map([['t', { status: 'completed', duration_ms: 2000 }]]), () => false).map(entry => entry.id), ['p', '@turn-summary', 'f']);
});

test('completion notification timestamps stay scoped to each turn and unavailable timing stays unavailable', async t => {
  const { store, client } = fixture([]); t.after(() => store.close());
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: 'root', ...params } });
  emit('turn/started', { turn: { id: 'first', status: 'inProgress', startedAt: 10 } });
  emit('item/completed', { turnId: 'first', item: message('f', 'final_answer', 'finished'), completedAtMs: 34001 });
  emit('turn/completed', { turn: { id: 'first', status: 'completed', completedAt: 35 } });
  emit('item/completed', { turnId: 'second', item: message('c', 'commentary', 'interrupted task progress') });
  emit('turn/completed', { turn: { id: 'second', status: 'interrupted' } });
  const result = store.revision({ target: 'a' });
  assert.equal(result.turns[0].duration_ms, 25000);
  assert.deepEqual(result.turns[1], { id: 'second', status: 'interrupted' });
  assert.equal(result.entries[0].completed_at_ms, 34001); assert.equal(result.entries[1].message.is_final, false);
  emit('turn/completed', { turn: { id: 'third', status: 'completed', items: [message('f3', 'final_answer', 'completed payload')] } });
  assert.equal(store.revision({ target: 'a' }).entries.at(-1).message.is_final, true);
});

test('a suffix containing only a steer and a final never promotes the steer to a new prompt', async t => {
  const turns = [
    { id: 'later', status: 'completed', items: [prompt('next-prompt', '[Direct message from the user]\n\nnext task'), message('next-final', 'final_answer', 'done')] },
    { id: 'prior', status: 'completed', items: [prompt('first', 'assignment'), message('progress', 'commentary', 'working'),
      { id: 'compact', type: 'contextCompaction' }, prompt('steer', 'Claude is your parent agent.\n\nclarification'), message('final', 'final_answer', 'done')] },
  ];
  const { store } = fixture(turns); t.after(() => store.close());
  const meta = new Map(), args = { target: 'a', limit: 2, fold_turns: true };
  let cursor, entries = [];
  const read = async () => {
    const result = await store.history({ ...args, cursor });
    entries = expandProcessReferences(result.entries).concat(entries);
    for (const turn of result.turns) meta.set(turn.id, turn);
    cursor = result.next_cursor;
    store.turnStates.clear();
  };
  const ids = open => turnTimeline(entries, meta, () => open).map(item => item.id);
  await read(); await read();
  assert.equal(meta.get('prior').history_start_loaded, false);
  assert.deepEqual(ids(false), ['@turn-summary', 'final', 'next-prompt', 'next-final']);
  assert.deepEqual(ids(true), ['@turn-summary', 'steer', 'final', 'next-prompt', 'next-final']);
  while (cursor) await read();
  assert.deepEqual(ids(false), ['first', '@turn-summary', 'final', 'next-prompt', 'next-final']);
  assert.deepEqual(ids(true), ['first', '@turn-summary', 'progress', 'compact', 'steer', 'final', 'next-prompt', 'next-final']);
});

test('an evicted live prompt and late action echoes stay scoped to their native turn', async t => {
  const { store, client } = fixture([]); t.after(() => store.close());
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: 'root', ...params } });
  const add = (turnId, item) => emit('item/completed', { turnId, item });
  const start = id => emit('turn/started', { turn: { id, status: 'inProgress' } });
  const finish = id => emit('turn/completed', { turn: { id, status: 'completed' } });
  start('old'); add('old', prompt('assignment', 'original task'));
  for (let i = 0; i < 64; i++) add('old', { id: 'step' + i, type: 'commandExecution' });
  add('old', prompt('direct', '[Direct message from the user]\n\ncorrect this')); add('old', message('old-final', 'final_answer', 'old answer')); finish('old');
  start('new'); add('new', prompt('new-task', 'later task')); add('new', message('new-final', 'final_answer', 'later answer')); finish('new');
  store.recordAction({ kind: 'send', turn_input: 'steer', agent_id: 'a', thread_id: 'root', turn_id: 'old', message: 'parent steer' });
  const result = store.revision({ target: 'a' }), meta = new Map(result.turns.map(turn => [turn.id, turn]));
  assert.equal(meta.get('old').opening_item_id, 'assignment');
  assert.ok(!result.entries.some(entry => entry.id === 'assignment'));
  const action = result.entries.at(-1);
  assert.equal(action.turn_input, 'steer');
  assert.deepEqual(turnTimeline(result.entries, meta, () => false).map(item => item.id), ['@turn-summary', 'old-final', 'new-task', 'new-final']);
  assert.deepEqual(turnTimeline(result.entries, meta, () => true).slice(-5).map(item => item.id), ['direct', action.id, 'old-final', 'new-task', 'new-final']);
  // Reconnect during a native turn with neither a start event nor a receipt.
  add('resumed', prompt('native-steer', 'mid-turn input')); add('resumed', message('resumed-final', 'final_answer', 'answer')); finish('resumed');
  const resumed = store.revision({ target: 'a' });
  const suffix = turnTimeline(resumed.entries.filter(entry => entry.turn_id === 'resumed'), new Map(resumed.turns.map(turn => [turn.id, turn])), () => false);
  assert.deepEqual(suffix.map(item => item.id), ['@turn-summary', 'resumed-final']);
});

test('native pane folds intermediate guidance, keeps the prompt and final copy/time visible, and reuses hydrated records', async t => {
  const ended = new Date(2026, 6, 9, 15, 42).getTime();
  const { store, requests, client } = fixture([{ id: 't', status: 'completed', durationMs: 65000, completedAt: (ended + 60000) / 1000,
    items: [prompt('ask', 'initial assignment'), message('comment', 'commentary', 'investigating the issue'),
      prompt('follow', 'Claude is your parent agent.\n\nclarification'), message('comment2', 'commentary', 'checking the result'),
      ...Array.from({ length: 55 }, (_, i) => message('part' + i, 'commentary', 'step ' + i)),
      { ...message('done', 'final_answer', 'shipped'), completedAtMs: ended }] }]);
  // The send was acknowledged before its native echo. The later commentary
  // reached the live cache first, while persisted native order is unambiguous.
  store.recordAction({ kind: 'send', turn_input: 'steer', agent_id: 'a', thread_id: 'root', turn_id: 't', message: 'clarification' });
  for (const item of [message('comment2', 'commentary', 'checking the result'), prompt('follow', 'Claude is your parent agent.\n\nclarification')]) {
    client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  }
  const hooks = [];
  let poll;
  const scrolls = [];
  const $ = {
    ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown', 'Svg', 'Client', 'Code'].map(type => [type, props => ({ type, props })])),
      invalidate() {}, open: async () => ({ isPlaced: true }), scroll: async request => { scrolls.push(request); return {}; } },
    clock: { every: (_, fn) => { poll = fn; return { cancel() {} }; }, after: () => ({ cancel() {} }) },
    state: { get: async () => ({}), set: async () => ({ isSet: true }) },
    env: { get: async () => undefined }, plugin: { root: 'C:/plugin' }, session: { id: async () => 'owner', cwd: async () => 'C:/work' },
    process: { run: async (_, options) => {
      const { operation, args } = JSON.parse(options.stdin);
      const data = operation === 'ui_history' ? await store.history(args) : operation === 'ui_revision' ? store.revision(args) : store.list();
      return { stdout: JSON.stringify(data), exitCode: 0 };
    } },
  };
  closeUI(); t.after(async () => { closeUI(); await store.close(); });
  registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) })); await openAgent($, 'a');
  const leaves = node => node && typeof node === 'object' ? [node, ...(node.props?.children ?? []).flatMap(leaves)] : [];
  const draw = async surface => leaves(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface }, () => null));
  const byKey = (nodes, key) => nodes.find(n => n.props.key === key);
  let tree = await draw();
  assert.equal(byKey(tree, 'message_time_a:t:done').props.children[0], finalTimestamp(ended));
  assert.ok(byKey(tree, 'message_copy_a:t:done'));
  assert.match(byKey(tree, 'turn_process_a:t').props.label, /用时 1分5秒/);
  assert.ok(byKey(tree, 'message_a:t:ask')); assert.ok(!byKey(tree, 'message_a:t:comment')); assert.ok(!byKey(tree, 'message_a:t:follow'));
  const before = requests.length;
  scrolls.length = 0;
  await byKey(tree, 'turn_process_a:t').props.onPress(); tree = await draw();
  assert.ok(byKey(tree, 'message_a:t:comment')); assert.ok(byKey(tree, 'message_a:t:comment2'));
  assert.ok(tree.indexOf(byKey(tree, 'message_a:t:comment')) < tree.indexOf(byKey(tree, 'message_a:t:follow')));
  assert.ok(tree.indexOf(byKey(tree, 'message_a:t:follow')) < tree.indexOf(byKey(tree, 'message_a:t:comment2')));
  assert.equal(tree.filter(n => n.props.text === 'clarification').length, 1);
  assert.ok(!scrolls.some(request => request.to === 'end'), 'opening a reconciled turn retains its reading anchor');
  assert.equal(requests.length, before + 1);
  assert.ok(!byKey(tree, 'message_a:t:part54'));
  await poll(); await new Promise(setImmediate); tree = await draw();
  assert.ok(byKey(tree, 'message_a:t:part54'));
  assert.equal(requests.length, before + 2);
  await byKey(tree, 'turn_process_a:t').props.onPress(); tree = await draw();
  assert.ok(!byKey(tree, 'message_a:t:comment')); assert.ok(byKey(tree, 'message_a:t:done'));
  await byKey(tree, 'turn_process_a:t').props.onPress(); assert.equal(requests.length, before + 2);
  const desktop = await draw('desktop');
  const title = byKey(desktop, 'turn_process_a:t_graphic');
  assert.equal(title.props.alignSelf, 'flex-start');
  assert.deepEqual(title.props.children.slice(0, 2).map(child => child.type), ['Text', 'Svg']);
  assert.equal(title.props.children[0].props.children[0], '用时 1分5秒');
  assert.equal(byKey(desktop, 'turn_process_a:t').type, 'Button');
});

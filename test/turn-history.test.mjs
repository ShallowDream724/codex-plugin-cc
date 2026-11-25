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

async function openFixturePane(t, store, revision = args => store.revision(args)) {
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
      const data = operation === 'ui_history' ? await store.history(args) : operation === 'ui_revision' ? revision(args) : store.list();
      return { stdout: JSON.stringify(data), exitCode: 0 };
    } },
  };
  closeUI(); t.after(async () => { closeUI(); await store.close(); });
  registerUI((...args) => hooks.push({ event: args[0], fn: args.at(-1) })); await openAgent($, 'a');
  const leaves = node => node && typeof node === 'object' ? [node, ...(node.props?.children ?? []).flatMap(leaves)] : [];
  const draw = async surface => leaves(await hooks.find(h => h.event === 'ui.render').fn($, { requestId: 'codex_subagent_activity', surface }, () => null));
  const byKey = (nodes, key) => nodes.find(n => n.props.key === key);
  return { draw, byKey, poll, scrolls };
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

test('historical timestamps prefer local today and yesterday across Monday and New Year', () => {
  const monday = new Date(2026, 0, 5, 12), newYear = new Date(2026, 0, 1, 12);
  const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime();
  assert.equal(finalTimestamp(at(2026, 1, 5, 0, 4), monday), '今天 00:04');
  assert.equal(finalTimestamp(at(2026, 1, 4, 23, 59), monday), '昨天 23:59');
  assert.equal(finalTimestamp(at(2025, 12, 29, 6, 8), monday), '上周一 06:08');
  assert.equal(finalTimestamp(at(2025, 12, 28, 16, 0), monday), '12月28日 16:00');
  assert.equal(finalTimestamp(at(2026, 1, 1, 8, 30), newYear), '今天 08:30');
  assert.equal(finalTimestamp(at(2025, 12, 31, 23, 59), newYear), '昨天 23:59');
  assert.equal(finalTimestamp(at(2025, 12, 30, 16, 0), newYear), '周二 16:00');
  assert.equal(finalTimestamp(null, monday), '');
  assert.equal(durationLabel(null), '执行过程');
  assert.equal(durationLabel(65000, 'interrupted'), '已中断 · 用时 1分5秒');
});

test('historical timestamps use local day boundaries when daylight saving starts or ends', t => {
  const timezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  });

  const spring = new Date('2026-03-09T04:45:00Z');
  assert.equal(finalTimestamp(Date.parse('2026-03-08T04:59:00Z'), spring), '上周六 23:59');
  assert.equal(finalTimestamp(Date.parse('2026-03-08T05:00:00Z'), spring), '昨天 00:00');

  const fall = new Date('2026-11-02T05:45:00Z');
  assert.equal(finalTimestamp(Date.parse('2026-11-01T04:05:00Z'), fall), '昨天 00:05');
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

test('a history-only turn folds on interruption even when no live item arrives', async t => {
  const { client, store } = fixture([{ id: 't', status: 'inProgress', startedAt: 100,
    items: [prompt('ask', 'initial assignment'), message('progress', 'commentary', 'working'),
      prompt('steer', '[Direct message from the user]\n\nmid-turn steer'), { id: 'compact', type: 'contextCompaction' }] }]);
  let stale = false;
  const { draw, byKey, poll } = await openFixturePane(t, store, args => stale
    ? { revision: 'late', entries: [], turns: [{ id: 't', status: 'inProgress', history_start_loaded: false }] }
    : store.revision(args));
  let tree = await draw();
  assert.ok(byKey(tree, 'message_a:t:progress'));
  assert.ok(byKey(tree, 'message_a:t:steer'));
  assert.ok(!byKey(tree, 'turn_process_a:t'));

  client.emit('notification', { method: 'turn/completed', params: { threadId: 'root', turn: { id: 't', status: 'interrupted' } } });
  await poll(); tree = await draw();
  assert.match(byKey(tree, 'turn_process_a:t').props.label, /已中断/);
  assert.ok(byKey(tree, 'message_a:t:ask'));
  assert.ok(!byKey(tree, 'message_a:t:progress'));
  assert.ok(!byKey(tree, 'message_a:t:steer'));

  stale = true;
  await poll(); tree = await draw();
  assert.ok(byKey(tree, 'turn_process_a:t'));
  assert.ok(!byKey(tree, 'message_a:t:steer'));
  await byKey(tree, 'turn_process_a:t').props.onPress(); await new Promise(setImmediate); tree = await draw();
  assert.ok(byKey(tree, 'message_a:t:progress'));
  assert.ok(byKey(tree, 'message_a:t:steer'));
});

test('a native successor closes a previous turn with no completion without inventing timing or a final', async t => {
  const { client, store } = fixture([{ id: 'old', status: 'inProgress', startedAt: 100,
    items: [prompt('ask', 'original task'), message('progress', 'commentary', 'working'), { id: 'compact', type: 'contextCompaction' }, prompt('steer', 'clarification')] }]);
  t.after(() => store.close());
  const emit = (method, params, threadId = 'root') => client.emit('notification', { method, params: { threadId, ...params } });
  const start = (id, startedAt, threadId) => emit('turn/started', { turn: { id, status: 'inProgress', startedAt } }, threadId);
  const { entries, turns } = await store.history({ target: 'a', fold_turns: true });
  const initial = new Map(turns.map(turn => [turn.id, turn]));
  assert.deepEqual(turnTimeline(entries, initial, () => false).map(entry => entry.id), ['ask', 'progress', 'compact', 'steer']);

  start('descendant', 200, 'child');
  start('late-start', 90);
  assert.ok(!store.revision({ target: 'a' }).turns.find(turn => turn.id === 'old')?.superseded);
  start('next', 201);
  const updated = store.revision({ target: 'a' });
  assert.deepEqual(updated.entries, []);
  for (const turn of updated.turns) initial.set(turn.id, { ...initial.get(turn.id), ...turn });
  assert.deepEqual(initial.get('old'), { id: 'old', status: 'inProgress', started_at_ms: 100000, history_start_loaded: true, superseded: true });
  const folded = turnTimeline(entries, initial, () => false);
  assert.deepEqual(folded.map(entry => entry.id), ['ask', '@turn-summary']);
  assert.equal(durationLabel(folded[1].duration_ms, folded[1].status), '执行过程');
  assert.deepEqual(turnTimeline(entries, initial, () => true).map(entry => entry.id), ['ask', '@turn-summary', 'progress', 'compact', 'steer']);
  assert.deepEqual(turnTimeline([{ id: 'new-work', turn_id: 'next', type: 'contextCompaction' }], initial, () => false).map(entry => entry.id), ['new-work']);

  emit('turn/completed', { turn: { id: 'old', status: 'completed', completedAt: 200 } });
  const finished = store.revision({ target: 'a', revision: updated.revision }).turns.find(turn => turn.id === 'old');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.duration_ms, 100000);
});

test('an earlier native history turn folds when a successor is listed before it', async t => {
  const { store } = fixture([
    { id: 'new', status: 'inProgress', items: [prompt('new-task', 'another task'), message('new-progress', 'commentary', 'working')] },
    { id: 'old', status: 'inProgress', items: [prompt('old-task', 'original task'), { id: 'compact', type: 'contextCompaction' }] },
  ]);
  t.after(() => store.close());
  const { entries, turns } = await store.history({ target: 'a', fold_turns: true });
  const timeline = turnTimeline(expandProcessReferences(entries), new Map(turns.map(turn => [turn.id, turn])), () => false);
  assert.deepEqual(timeline.map(entry => entry.id), ['old-task', '@turn-summary', 'new-task', 'new-progress']);
  assert.equal(timeline[1].duration_ms, undefined);
});

test('late active history and older start notifications leave the newer active turn open', async t => {
  const { client, store } = fixture([{ id: 'old', status: 'inProgress', startedAt: 100,
    items: [prompt('old-task', 'original task'), message('old-progress', 'commentary', 'working')] }]);
  t.after(() => store.close());
  const request = client.request;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  client.request = async (method, args) => {
    const result = await request(method, args);
    if (method === 'thread/turns/list') await gate;
    return result;
  };
  const start = (id, startedAt) => client.emit('notification', { method: 'turn/started', params: { threadId: 'root', turn: { id, status: 'inProgress', startedAt } } });
  const read = store.history({ target: 'a', fold_turns: true });
  start('active', 200);
  start('earlier', 99);
  start('unverified');
  client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 'active', item: message('active-progress', 'commentary', 'still working') } });
  release();
  const history = await read, live = store.revision({ target: 'a' });
  const turns = new Map([...history.turns, ...live.turns].map(turn => [turn.id, turn]));
  assert.equal(turns.get('old').superseded, true);
  assert.equal(turns.get('active').superseded, undefined);
  const timeline = turnTimeline(expandProcessReferences(history.entries).concat(live.entries), turns, () => false);
  assert.deepEqual(timeline.map(entry => entry.id), ['old-task', '@turn-summary', 'active-progress']);
});

test('only a sole unphased reply in complete success history stays outside its fold', async t => {
  const { store } = fixture([
    { id: 'interrupted', status: 'interrupted', items: [prompt('interrupted-prompt', 'work'), message('interrupted-note', null, 'unfinished note')] },
    { id: 'explicit', status: 'completed', items: [prompt('explicit-prompt', 'work'), message('explicit-note', null, 'old note'), message('explicit-final', 'finalAnswer', 'done')] },
    { id: 'ambiguous', status: 'completed', items: [prompt('ambiguous-prompt', 'work'), message('first-note', null, 'old note'), message('second-note', null, 'old note')] },
    { id: 'legacy', status: 'completed', items: [prompt('legacy-prompt', 'work'), message('legacy-reply', null, 'old reply')] },
  ]);
  t.after(() => store.close());
  const result = await store.history({ target: 'a', fold_turns: true });
  const entries = expandProcessReferences(result.entries);
  const turns = new Map(result.turns.map(turn => [turn.id, turn]));
  const folded = turnTimeline(entries, turns, () => false);
  assert.deepEqual(folded.map(entry => entry.id), ['legacy-prompt', 'legacy-reply', 'ambiguous-prompt', '@turn-summary',
    'explicit-prompt', '@turn-summary', 'explicit-final', 'interrupted-prompt', '@turn-summary']);
  assert.deepEqual(folded.filter(entry => entry.message?.is_final).map(entry => entry.id), ['explicit-final']);
  assert.ok(turnTimeline(entries, turns, () => true).some(entry => entry.id === 'interrupted-note'));
  turns.get('legacy').history_start_loaded = false;
  const partial = turnTimeline(entries.filter(entry => entry.id !== 'legacy-prompt'), turns, () => false);
  assert.ok(!partial.some(entry => entry.id === 'legacy-reply'));
});

test('the native turn chooses one final across bridge pages and keeps asynchronous messages in order', async t => {
  const asyncMessage = id => ({ ...message(id, 'final_answer', id), delivery: 'async' });
  const { store } = fixture([
    { id: 'next', status: 'completed', items: [prompt('next-ask', 'new task'), asyncMessage('next-note')] },
    { id: 'interrupted', status: 'interrupted', items: [prompt('stopped-ask', 'interrupted task'),
      { ...message('stopped-draft', 'final_answer', 'draft from the interrupted task'), completedAtMs: 300000 }] },
    { id: 't', status: 'completed', items: [prompt('ask', 'initial task'), asyncMessage('first-note'),
      { id: 'tool', type: 'commandExecution' }, message('draft', 'final_answer', 'earlier candidate'), asyncMessage('second-note'),
      message('answer', 'final_answer', 'published reply'), asyncMessage('late-note'), message('empty', 'final_answer', '  ')] },
  ]);
  t.after(() => store.close());

  const turns = new Map(), args = { target: 'a', limit: 2, fold_turns: true };
  let entries = [], cursor;
  do {
    const result = await store.history({ ...args, cursor });
    entries = expandProcessReferences(result.entries).concat(entries);
    for (const turn of result.turns) turns.set(turn.id, turn);
    cursor = result.next_cursor;
    store.turnStates.clear();
  } while (cursor);

  assert.equal(turns.get('t').final_item_id, 'answer');
  const folded = turnTimeline(entries, turns, () => false);
  assert.deepEqual(folded.map(entry => entry.id), ['ask', '@turn-summary', 'answer', 'stopped-ask', '@turn-summary', 'next-ask', '@turn-summary']);
  assert.deepEqual(folded.filter(entry => entry.message?.is_final).map(entry => entry.id), ['answer']);
  assert.ok(entries.find(entry => entry.id === 'draft').locator, 'earlier explicit phases stay lazy even after a helper restart');

  const pages = new Map();
  for (const { pageKey, locator } of entries.filter(entry => entry.locator)) {
    if (pages.has(pageKey)) continue;
    const { entries: records } = await store.history({ target: 'a', process_page: locator });
    pages.set(pageKey, { records: new Map(records.map(entry => [entry.id, entry])) });
  }
  const opened = turnTimeline(entries, turns, () => true, pages);
  assert.deepEqual(opened.filter(entry => entry.turn_id === 't').map(entry => entry.id),
    ['ask', '@turn-summary', 'first-note', 'tool', 'draft', 'second-note', 'late-note', 'empty', 'answer']);
  assert.deepEqual(opened.filter(entry => entry.message?.is_final).map(entry => entry.id), ['answer']);
});

test('the live pane gives only the confirmed final copy and time when an active turn ends', async t => {
  const ended = Date.now();
  const ask = prompt('ask', 'initial task');
  const draft = message('draft', 'final_answer', 'draft while running');
  const answer = message('answer', 'final_answer', 'complete answer');
  const note = { ...message('note', 'final_answer', 'supplement'), delivery: 'async' };
  const { store, client } = fixture([{ id: 't', status: 'inProgress', items: [ask, draft] }]);
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: 'root', turnId: 't', ...params } });
  emit('turn/started', { turn: { id: 't', status: 'inProgress', items: [ask] } });
  emit('item/completed', { item: draft, completedAtMs: ended - 2000 });
  emit('item/started', { item: { ...answer, text: 'prefix' } });
  emit('item/completed', { item: note, completedAtMs: ended + 1000 });
  const liveWithoutTurn = turnTimeline(store.revision({ target: 'a' }).entries, new Map(), () => false);
  assert.ok(liveWithoutTurn.some(entry => entry.id === 'draft' && !entry.message.is_final));

  const { draw, byKey, poll } = await openFixturePane(t, store);
  let tree = await draw();
  assert.ok(byKey(tree, 'message_a:t:draft')); assert.ok(byKey(tree, 'message_a:t:note'));
  assert.ok(!tree.some(node => node.props.key?.startsWith('message_copy_a:t:')));

  emit('turn/completed', { turn: { id: 't', status: 'completed', itemsView: 'full',
    items: [ask, draft, { ...answer, completedAtMs: ended }, { ...note, delivery: null }] } });
  emit('item/agentMessage/delta', { itemId: 'answer', delta: 'late duplicated delta' });
  await poll(); tree = await draw();
  assert.equal(byKey(tree, 'message_a:t:answer').props.text, answer.text);
  assert.equal(byKey(tree, 'message_time_a:t:answer').props.children[0], finalTimestamp(ended));
  assert.ok(byKey(tree, 'message_copy_a:t:answer'));
  assert.ok(!byKey(tree, 'message_a:t:note')); assert.ok(!byKey(tree, 'message_a:t:draft'));

  await byKey(tree, 'turn_process_a:t').props.onPress(); await new Promise(setImmediate); tree = await draw();
  assert.ok(tree.indexOf(byKey(tree, 'message_a:t:draft')) < tree.indexOf(byKey(tree, 'message_a:t:note')));
  assert.deepEqual(tree.filter(node => node.props.key?.startsWith('message_copy_a:t:')).map(node => node.props.key), ['message_copy_a:t:answer']);
  assert.deepEqual(tree.filter(node => node.props.key?.startsWith('message_time_a:t:')).map(node => node.props.key), ['message_time_a:t:answer']);
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
  for (const item of [message('comment2', null, 'checking the result'), prompt('follow', 'Claude is your parent agent.\n\nclarification')]) {
    client.emit('notification', { method: 'item/completed', params: { threadId: 'root', turnId: 't', item } });
  }
  const { draw, byKey, poll, scrolls } = await openFixturePane(t, store);
  let tree = await draw();
  assert.equal(byKey(tree, 'message_time_a:t:done').props.children[0], finalTimestamp(ended));
  assert.ok(byKey(tree, 'message_copy_a:t:done'));
  assert.match(byKey(tree, 'turn_process_a:t').props.label, /用时 1分5秒/);
  assert.ok(byKey(tree, 'message_a:t:ask')); assert.ok(!byKey(tree, 'message_a:t:comment')); assert.ok(!byKey(tree, 'message_a:t:follow'));
  assert.ok(!byKey(tree, 'message_a:t:comment2'), 'native process classification survives the duplicate live message with no phase');
  const before = requests.length;
  scrolls.length = 0;
  await byKey(tree, 'turn_process_a:t').props.onPress(); await new Promise(setImmediate); tree = await draw();
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
  assert.equal(title.props.children[1].props.alt, '收起过程');
  assert.equal(title.props.children[0].props.children[0], '用时 1分5秒');
  assert.equal(byKey(desktop, 'turn_process_a:t').type, 'Button');
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 6, 9, 23, 59) });
  assert.equal(byKey(await draw('desktop'), 'message_time_a:t:done').props.children[0], '今天 15:42');
  t.mock.timers.tick(60_000);
  assert.equal(byKey(await draw('desktop'), 'message_time_a:t:done').props.children[0], '昨天 15:42');
});

test('closing a process discards its pending detail response and reopening requests it again', async t => {
  const { store } = fixture([{ id: 't', status: 'completed', durationMs: 86400000,
    items: [prompt('p', 'start'), message('step', 'commentary', 'running'), message('f', 'final_answer', 'done')] }]);
  const history = store.history.bind(store);
  let started, release, detailRequests = 0;
  const requested = new Promise(resolve => { started = resolve; });
  store.history = async args => {
    const result = await history(args);
    if (args.process_page && ++detailRequests === 1) await new Promise(resolve => { release = resolve; started(); });
    return result;
  };
  const { draw, byKey } = await openFixturePane(t, store);
  t.after(() => release?.());
  const button = tree => byKey(tree, 'turn_process_a:t');
  const opening = button(await draw()).props.onPress();
  await requested;
  const expanded = await draw();
  assert.ok(byKey(expanded, 'turn_process_page_a:t:step'));
  await button(expanded).props.onPress();
  release();
  await opening;
  await new Promise(setImmediate);
  const closed = await draw();
  assert.ok(!byKey(closed, 'message_a:t:step'));
  assert.ok(byKey(closed, 'message_a:t:f'));
  await button(closed).props.onPress();
  await new Promise(setImmediate);
  assert.equal(detailRequests, 2);
  assert.ok(byKey(await draw(), 'message_a:t:step'));
});

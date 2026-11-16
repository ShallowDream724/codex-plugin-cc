import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActivityStore } from '../runtime/activity.mjs';

function fixture(turns) {
  const client = new EventEmitter(), controller = new EventEmitter(), requests = [];
  const agent = { id: 'a', threadId: 'root', name: 'worker', status: 'running' };
  controller.agents = new Map([['a', agent]]); controller.threads = new Map([['root', agent]]);
  controller.find = () => agent;
  controller.view = () => ({ agent_id: 'a' });
  client.request = async (method, args) => {
    requests.push({ method, args });
    if (method === 'thread/turns/list') {
      const i = Number(args.cursor ?? 0);
      return { data: [{ id: String(i) }], nextCursor: i + 1 < turns.length ? String(i + 1) : null };
    }
    const items = turns[Number(args.turnId)], i = Number(args.cursor ?? 0);
    return { data: items.slice(i, i + args.limit).map(item => ({ item })), nextCursor: i + args.limit < items.length ? String(i + args.limit) : null };
  };
  return { store: ActivityStore.attach(client, controller), requests, client };
}
const message = (id, text = 'short') => ({ id: String(id), type: 'agentMessage', text });

test('budgeted short history spans native pages and observes the 400 item limit', async () => {
  const { store, requests } = fixture([Array.from({ length: 450 }, (_, i) => message(i))]);
  const page = await store.history({ target: 'a', limit: 400, character_budget: 64000 });
  assert.ok(page.entries.length > 50 && page.entries.length <= 400);
  assert.deepEqual(page.entries.map(x => x.id), Array.from({ length: page.entries.length }, (_, i) => String(page.entries.length - 1 - i)));
  const maxPage = await store.history({ target: 'a', limit: 400, character_budget: 100000 });
  assert.equal(maxPage.entries.length, 400);
  assert.ok(page.next_cursor);
  assert.ok(requests.filter(x => x.method === 'thread/items/list').every(x => x.args.limit <= 50));
  await assert.rejects(() => store.history({ target: 'a', limit: 51 }), /between 1 and 50/);
  await assert.rejects(() => store.history({ target: 'a', limit: 401, character_budget: 64000 }), /between 1 and 400/);
  await assert.rejects(() => store.history({ target: 'a', character_budget: 15999 }), /character_budget/);
  store.close();
});

test('budget ends after a complete native page and resumes without gaps across turns and hidden items', async () => {
  const turns = [Array.from({ length: 125 }, (_, i) => i % 7 === 0 ? { id: `h${i}`, type: 'reasoning' } : message(`a${i}`, 'x'.repeat(4000))), Array.from({ length: 10 }, (_, i) => message(`b${i}`))];
  const { store } = fixture(turns);
  let cursor, results = [], pages = 0;
  do {
    const page = await store.history({ target: 'a', limit: 400, character_budget: 16000, cursor });
    if (pages === 0) { assert.ok(page.next_cursor); assert.ok(page.entries.length < 100); }
    results.push(...page.entries.slice().reverse().map(x => x.id));
    cursor = page.next_cursor; pages++;
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(results, turns.flat().filter(x => x.type !== 'reasoning').map(x => x.id));
  store.close();
});

test('budgeted history retains the 80 request cap through hidden pages', async () => {
  const { store, client } = fixture([[]]);
  let calls = 0;
  client.request = async (method, args) => {
    calls++;
    if (method === 'thread/turns/list') return { data: [{ id: '0' }], nextCursor: null };
    const i = Number(args.cursor ?? 0);
    return { data: [{ item: i < 82 ? { id: `h${i}`, type: 'reasoning' } : message('visible') }], nextCursor: i < 82 ? String(i + 1) : null };
  };
  const first = await store.history({ target: 'a', limit: 400, character_budget: 64000 });
  assert.equal(calls, 80); assert.deepEqual(first.entries, []); assert.ok(first.next_cursor);
  const second = await store.history({ target: 'a', limit: 400, character_budget: 64000, cursor: first.next_cursor });
  assert.deepEqual(second.entries.map(x => x.id), ['visible']); assert.equal(second.next_cursor, null);
  store.close();
});

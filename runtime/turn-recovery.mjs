// Fetch only the registered native turn. A different client can have added
// more turns to the same thread while the controller was offline.
async function* pages(request, method, params) {
  const seen = new Set();
  let cursor;
  do {
    const page = await request(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error('Codex returned an invalid native history page.');
    yield page.data;
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('Codex returned a repeated or invalid native history cursor.');
    seen.add(cursor);
  } while (cursor);
}

export async function findOwnedTurn(request, threadId, turnId) {
  for await (const turns of pages(request, 'thread/turns/list', { threadId, limit: 32, sortDirection: 'desc', itemsView: 'notLoaded' })) {
    const match = turns.find(turn => turn.id === turnId);
    if (match) return match;
  }
}

export function answerFromItems(items) {
  let final, legacy;
  for (const item of items ?? []) {
    if (item.type !== 'agentMessage' || typeof item.text !== 'string') continue;
    if (['final_answer', 'finalAnswer'].includes(item.phase)) final = item.text;
    else if (item.phase == null) legacy = item.text;
  }
  return { final, legacy };
}

export async function readOwnedAnswer(request, threadId, turnId) {
  let legacy;
  const params = { threadId, turnId, limit: 32, sortDirection: 'desc', deferOutput: { commandExecution: true, mcpToolCall: true } };
  for await (const records of pages(request, 'thread/items/list', params)) {
    const items = records.filter(entry => entry.item && (!entry.turnId || entry.turnId === turnId)).map(entry => entry.item).reverse();
    const answer = answerFromItems(items);
    if (answer.final !== undefined) return answer.final;
    legacy ??= answer.legacy;
  }
  return legacy ?? '';
}

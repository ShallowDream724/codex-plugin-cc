// Read-only presentation of the controller's own root threads. The controller's
// delivery queue is deliberately independent of this bounded live cache.
const LIVE_LIMIT = 64;
const AGENT_LIMIT = 32;
const PREVIEW_BUDGET = 8192;
const BINARY = /^(?:base64|imageData|image_data|b64_json)$/i;
// This is a presentation projection only: it never changes the model's input or
// native history. Account for keys, values, depth and element count together.
function clean(value, limit = PREVIEW_BUDGET) {
  let remaining = limit, nodes = 0;
  function visit(v, depth, key = '') {
    if (++nodes > 256 || remaining <= 0) return '[truncated]';
    if (BINARY.test(key) && typeof v === 'string') return '[binary omitted]';
    if (typeof v === 'string') {
      if (/^data:[^,]*;base64,/i.test(v)) return '[binary omitted]';
      const n = Math.min(v.length, remaining); remaining -= n;
      return v.slice(0, n) + (n < v.length ? '…' : '');
    }
    if (!v || typeof v !== 'object') { remaining -= 8; return v; }
    if (depth >= 6) return '[nested data omitted]';
    if (/^(?:image|blob|audio)$/i.test(v.type ?? '')) return { type: v.type, path: typeof v.path === 'string' ? visit(v.path, depth + 1) : undefined };
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => visit(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      remaining -= k.length; if (remaining <= 0) break;
      out[k] = visit(x, depth + 1, k);
    }
    return out;
  }
  return visit(value, 0);
}
const imageFields = (item) => Object.fromEntries(['id', 'type', 'status', 'generationId', 'generation_id', 'savedPath', 'saved_path', 'path', 'failure'].filter((key) => item[key] != null).map((key) => [key, item[key]]));
const delegationFields = (item) => ({ id: item.id, type: item.type, tool: item.tool, status: item.status, names: Object.entries(item.agentsStates ?? {}).map(([id, a]) => a?.name ?? a?.nickname ?? id).slice(0, 20), name: item.name ?? item.agentName });
const project = (item) => item.type === 'imageGeneration' || item.type === 'imageView' ? imageFields(item) : ['collabAgentToolCall', 'collabToolCall'].includes(item.type) ? delegationFields(item) : item;
const binaryString = (value) => typeof value === 'string' && /^data:[^,]*;base64,/i.test(value);
const textValue = (value) => {
  if (binaryString(value)) return '[binary omitted]';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (key, v) => BINARY.test(key) && typeof v === 'string' || binaryString(v) ? '[binary omitted]' : v && typeof v === 'object' && /^(?:image|blob|audio)$/i.test(v.type ?? '') ? { type: v.type, path: v.path } : v, 2) ?? '';
};
const outputValue = (value) => {
  const content = Array.isArray(value) ? value : value?.content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => ['text', 'inputText', 'outputText', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string' ? textValue(part.text) : '[non-text content omitted]');
    if (!Array.isArray(value) && value.structuredContent != null) parts.push(textValue(value.structuredContent));
    return parts.join('\n');
  }
  return textValue(value);
};
export function formatItem(item) {
  const d = project(item);
  switch (d.type) {
    case 'parentMessage': case 'agentMessage': return d.text ?? '';
    case 'userMessage': return (d.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n\n');
    case 'commandExecution': return [`Command: ${d.command ?? ''}`, d.cwd && `Directory: ${d.cwd}`, d.exitCode != null && `Exit code: ${d.exitCode}`, d.status && `Status: ${d.status}`, d.aggregatedOutput != null && `Output:\n${d.aggregatedOutput}`].filter(Boolean).join('\n');
    case 'fileChange': return (d.changes ?? []).map((change) => `${change.path ?? 'File'}${change.kind ? ` (${typeof change.kind === 'string' ? change.kind : change.kind.type ?? 'change'})` : ''}\n${change.diff ?? ''}`).join('\n\n');
    case 'mcpToolCall': case 'dynamicToolCall': return [`Tool: ${d.server ? d.server + '/' : ''}${d.tool ?? ''}`, d.arguments != null && `Input:\n${textValue(d.arguments)}`, d.result != null && `Output:\n${outputValue(d.result)}`, d.contentItems != null && `Output:\n${outputValue(d.contentItems)}`, d.error != null && `Error:\n${textValue(d.error)}`].filter(Boolean).join('\n');
    case 'imageGeneration': case 'imageView': return [`Image: ${d.savedPath ?? d.saved_path ?? d.path ?? ''}`, d.status && `Status: ${d.status}`, d.failure && `Error: ${textValue(d.failure)}`].filter(Boolean).join('\n');
    case 'collabAgentToolCall': case 'collabToolCall': return `Delegation: ${[d.name, ...(d.names ?? [])].filter(Boolean).join(', ') || d.tool || 'agent'}`;
    default: return textValue(d);
  }
}
const visible = (item) => item && item.type !== 'reasoning' && item.type !== 'subAgentActivity';
const simplify = (item, turnId, deferred = false) => {
  const data = clean(project(item), PREVIEW_BUDGET / 2);
  return { id: String(item.id ?? ''), turn_id: turnId, type: item.type ?? 'unknown', data, preview: formatItem(data).slice(0, PREVIEW_BUDGET / 2), deferred };
};
function removeGuidance(item, guidance) {
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return item;
  const prefixes = [guidance?.collaboration?.trim(), 'Claude is your parent agent.', guidance?.default?.instructions?.trim()].filter(Boolean);
  return { ...item, content: item.content.map((part) => {
    if (typeof part.text !== 'string') return part;
    let text = part.text;
    for (const prefix of prefixes) if (text.startsWith(prefix + '\n\n')) text = text.slice(prefix.length + 2);
    return { ...part, text };
  }) };
}

export class ActivityStore {
  static attach(client, controller) { return new ActivityStore({ client, controller }); }
  constructor({ client, controller }) {
    this.client = client; this.controller = controller; this.live = new Map(); this.nextRevision = 1;
    this.notification = (message) => this.observe(message);
    this.action = (action) => this.recordAction(action);
    client.on('notification', this.notification);
    controller.on('agentAction', this.action);
  }
  close() {
    this.client.off('notification', this.notification);
    this.controller.off('agentAction', this.action);
    this.live.clear();
  }
  find(target) {
    const agent = this.controller.find(target);
    if (!agent?.threadId || this.controller.threads.get(agent.threadId) !== agent) throw new Error('Agent thread is unavailable.');
    return agent;
  }
  summary(a) { return { id: a.id, agent_id: a.id, name: a.name, status: a.status, activity: a.activity }; }
  list() { return { agents: [...this.controller.agents.values()].map((a) => this.summary(a)) }; }
  bucket(id) {
    let bucket = this.live.get(id);
    if (!bucket) { bucket = { revision: this.nextRevision++, entries: [] }; }
    else this.live.delete(id);
    this.live.set(id, bucket);
    while (this.live.size > AGENT_LIMIT) this.live.delete(this.live.keys().next().value);
    return bucket;
  }
  put(agent, entry) {
    const bucket = this.bucket(agent.id);
    const index = bucket.entries.findIndex((x) => x.turn_id === entry.turn_id && x.id === entry.id);
    if (index >= 0) bucket.entries[index] = entry; else bucket.entries.push(entry);
    if (bucket.entries.length > LIVE_LIMIT) bucket.entries.splice(0, bucket.entries.length - LIVE_LIMIT);
    bucket.revision = this.nextRevision++;
  }
  recordAction(action) {
    const agent = this.controller.agents.get(action.agent_id);
    if (action.kind === 'close') { this.live.delete(action.agent_id); return; }
    if (!agent || action.thread_id !== agent.threadId || typeof action.message !== 'string') return;
    this.put(agent, { id: `action:${action.kind}:${this.bucket(agent.id).revision}`, turn_id: action.turn_id ?? '', type: 'parentMessage', data: { text: clean(action.message) } });
  }
  observe(message) {
    const p = message?.params ?? {};
    const agent = this.controller.threads.get(p.threadId);
    // Never follow descendant IDs, even when they are tracked by the controller.
    if (!agent || agent.threadId !== p.threadId) return;
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (visible(p.item)) this.put(agent, simplify(removeGuidance(p.item, this.controller.guidance), p.turnId));
      return;
    }
    if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(message.method) && typeof p.delta === 'string' && p.itemId) {
      const bucket = this.bucket(agent.id);
      const old = bucket.entries.find((x) => x.id === p.itemId && x.turn_id === p.turnId);
      const isCommand = message.method === 'item/commandExecution/outputDelta';
      const field = isCommand ? 'aggregatedOutput' : 'text';
      const text = (old?.data?.[field] ?? '') + p.delta;
      this.put(agent, simplify({ ...old?.data, id: p.itemId, type: isCommand ? 'commandExecution' : 'agentMessage', [field]: text }, p.turnId));
    }
  }
  revision({ target, revision } = {}) {
    const agent = this.find(target), bucket = this.bucket(agent.id);
    return { revision: bucket.revision, ...(revision === bucket.revision ? {} : { entries: bucket.entries }) };
  }
  async history({ target, cursor, limit = 30 } = {}) {
    const agent = this.find(target);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be between 1 and 50.');
    if (cursor != null && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))) throw new TypeError('Invalid history cursor.');
    let { turn_id: turnId, turns_cursor: turnsCursor, items_cursor: itemsCursor } = cursor ?? {};
    if (![turnId, turnsCursor, itemsCursor].every((v) => v == null || typeof v === 'string')) throw new TypeError('Invalid history cursor.');
    if (!turnId) {
      const page = await this.client.request('thread/turns/list', { threadId: agent.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...(turnsCursor ? { cursor: turnsCursor } : {}) });
      turnId = page.data?.[0]?.id;
      turnsCursor = page.nextCursor ?? null;
      if (!turnId) return { agent: this.summary(agent), entries: [], next_cursor: null };
    }
    const page = await this.client.request('thread/items/list', { threadId: agent.threadId, turnId, limit, sortDirection: 'desc', deferOutput: { commandExecution: true, mcpToolCall: true }, ...(itemsCursor ? { cursor: itemsCursor } : {}) });
    const entries = (page.data ?? []).filter((entry) => visible(entry.item)).map((entry) => simplify(removeGuidance(entry.item, this.controller.guidance), entry.turnId ?? turnId, entry.outputDeferred === true)).reverse();
    const next_cursor = page.nextCursor ? { turn_id: turnId, items_cursor: page.nextCursor, turns_cursor: turnsCursor } : turnsCursor ? { turns_cursor: turnsCursor } : null;
    return { agent: this.summary(agent), entries, next_cursor };
  }
  async detail({ target, turn_id, item_id, offset = 0 } = {}) {
    const agent = this.find(target);
    if (typeof turn_id !== 'string' || !turn_id || typeof item_id !== 'string' || !item_id) throw new TypeError('turn_id and item_id are required.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid detail offset.');
    const page = await this.client.request('thread/items/read', { threadId: agent.threadId, turnId: turn_id, itemIds: [item_id] });
    const item = page.data?.[0]?.item;
    if (!visible(item)) return { text: '', next_offset: null };
    const text = formatItem(removeGuidance(item, this.controller.guidance));
    return { text: text.slice(offset, offset + 16000), next_offset: offset + 16000 < text.length ? offset + 16000 : null };
  }
}

// Read-only presentation of the controller's own root threads. The controller's
// delivery queue is deliberately independent of this bounded live cache.
import { toolOutputText } from '../shared/tool-output.mjs';
import { orderWaits } from '../shared/activity-order.mjs';
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
    if (/^(?:image|blob|audio)$/i.test(v.type ?? '')) return { type: v.type, path: typeof v.path === 'string' ? visit(v.path, depth + 1) : undefined, ...(typeof v.name === 'string' ? { name: visit(v.name, depth + 1) } : {}) };
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
const imageFields = (item) => Object.fromEntries(['id', 'type', 'status', 'generationId', 'generation_id', 'savedPath', 'saved_path', 'path', 'failure', 'contentType', 'mimeType'].filter((key) => item[key] != null).map((key) => [key, item[key]]));
const delegationFields = (item) => {
  const ids = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])].slice(0, 20);
  const agents = ids.map(id => ({ id, name: item.displayAgentNames?.[id] ?? item.agentsStates?.[id]?.name ?? item.agentsStates?.[id]?.nickname, status: item.agentsStates?.[id]?.status }));
  return { id: item.id, type: item.type, tool: item.tool, status: item.status, receiverThreadIds: ids, agents, names: agents.map(a => a.name ?? a.id), name: item.name ?? item.agentName };
};
const subagentFields = (item) => ({ id: item.id, type: item.type, kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath, name: item.name, display_name: item.display_name, model: item.model, reasoningEffort: item.reasoningEffort });
const fileSummary = (item) => (item.changes ?? []).map((change) => {
  const summary = { path: change.path };
  if (typeof change.diff === 'string') {
    let added = 0, removed = 0;
    for (const line of change.diff.matchAll(/^[+-].*$/gm)) {
      if (line[0].startsWith('+++ ') || line[0].startsWith('--- ')) continue;
      if (line[0][0] === '+') added++; else removed++;
    }
    Object.assign(summary, { added, removed });
  }
  return summary;
});
const project = (item) => item.type === 'imageGeneration' || item.type === 'imageView' ? imageFields(item) : ['collabAgentToolCall', 'collabToolCall'].includes(item.type) ? delegationFields(item) : item.type === 'subAgentActivity' ? subagentFields(item) : item.type === 'fileChange' ? { fileSummary: fileSummary(item), ...item } : item.type === 'directUserMessage' ? { id: item.id, type: item.type, attachments: item.attachments, text: item.text } : item;
const binaryString = (value) => typeof value === 'string' && /^data:[^,]*;base64,/i.test(value);
const textValue = (value) => {
  if (binaryString(value)) return '[binary omitted]';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (key, v) => BINARY.test(key) && typeof v === 'string' || binaryString(v) ? '[binary omitted]' : v && typeof v === 'object' && /^(?:image|blob|audio)$/i.test(v.type ?? '') ? { type: v.type, path: v.path } : v, 2) ?? '';
};
const outputValue = (value) => toolOutputText(value, { serialize: textValue, formatPart: (part) => ['text', 'inputText', 'outputText', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string' ? textValue(part.text) : '[non-text content omitted]' });
const OUTPUT_TYPES = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput']);
export function formatItemOutput(item) {
  let output;
  switch (item.type) {
    case 'commandExecution': output = item.aggregatedOutput == null ? '' : textValue(item.aggregatedOutput); break;
    case 'mcpToolCall': case 'dynamicToolCall': output = [item.result, item.contentItems].filter(value => value != null).map(outputValue).filter(Boolean).join('\n'); break;
    case 'functionCallOutput': output = item.output == null ? '' : outputValue(item.output); break;
    default: return formatItem(item);
  }
  return [output, item.error != null && textValue(item.error)].filter(Boolean).join('\n');
}
export function formatItem(item) {
  const d = project(item);
  switch (d.type) {
    case 'parentMessage': case 'directUserMessage': case 'agentMessage': return d.text ?? '';
    case 'userMessage': return (d.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n\n');
    case 'commandExecution': return [`Command: ${d.command ?? ''}`, d.cwd && `Directory: ${d.cwd}`, d.exitCode != null && `Exit code: ${d.exitCode}`, d.status && `Status: ${d.status}`, d.aggregatedOutput != null && `Output:\n${d.aggregatedOutput}`].filter(Boolean).join('\n');
    case 'fileChange': return (d.changes ?? []).map((change) => `${change.path ?? 'File'}${change.kind ? ` (${typeof change.kind === 'string' ? change.kind : change.kind.type ?? 'change'})` : ''}\n${change.diff ?? ''}`).join('\n\n');
    case 'mcpToolCall': case 'dynamicToolCall': return [`Tool: ${d.server ? d.server + '/' : ''}${d.tool ?? ''}`, d.arguments != null && `Input:\n${textValue(d.arguments)}`, d.result != null && `Output:\n${outputValue(d.result)}`, d.contentItems != null && `Output:\n${outputValue(d.contentItems)}`, d.error != null && `Error:\n${textValue(d.error)}`].filter(Boolean).join('\n');
    case 'imageGeneration': case 'imageView': return [`Image: ${d.savedPath ?? d.saved_path ?? d.path ?? ''}`, d.status && `Status: ${d.status}`, d.failure && `Error: ${textValue(d.failure)}`].filter(Boolean).join('\n');
    case 'collabAgentToolCall': case 'collabToolCall': return `Delegation: ${[d.name, ...(d.names ?? [])].filter(Boolean).join(', ') || d.tool || 'agent'}`;
    case 'subAgentActivity': return `Subagent: ${d.name || d.agentPath || d.agentThreadId || 'agent'} (${d.kind || 'activity'})`;
    case 'plan': return d.text ?? '';
    case 'contextCompaction': return 'Context compaction';
    case 'functionCallOutput': return outputValue(d.output);
    default: return textValue(d);
  }
}
const visible = (item) => item && item.type !== 'reasoning';
const simplify = (item, turnId, deferred = false, stage, startedAtMs) => {
  const data = clean({ ...(stage ? { stage } : {}), ...project(item) }, PREVIEW_BUDGET / 2);
  return { id: String(item.id ?? ''), turn_id: turnId, type: item.type ?? 'unknown', data, preview: formatItem(data).slice(0, PREVIEW_BUDGET / 2), deferred, ...(Number.isFinite(startedAtMs) ? { started_at_ms: startedAtMs } : {}) };
};
function removeGuidance(item, guidance) {
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return item;
  const directPrefix = '[Direct message from the user]\n\n';
  if (item.content[0]?.text?.startsWith(directPrefix)) {
    let text = item.content.map((part, index) => typeof part.text === 'string' ? index === 0 ? part.text.slice(directPrefix.length) : part.text : '').filter(Boolean).join('\n\n');
    let attachments = item.content.filter(part => part.type === 'localImage' && typeof part.path === 'string').map(part => ({ type: 'image', path: part.path, name: part.path.split(/[\\/]/).at(-1) }));
    const marker = '\n\nAttached local files: ', at = text.lastIndexOf(marker);
    if (at >= 0 && text.endsWith('.')) {
      try {
        const saved = JSON.parse(text.slice(at + marker.length, -1));
        if (Array.isArray(saved) && saved.every(a => a && typeof a.name === 'string' && typeof a.path === 'string' && ['file', 'image'].includes(a.type))) { attachments = saved; text = text.slice(0, at); }
      } catch { /* Ordinary user text remains visible. */ }
    }
    return { ...item, type: 'directUserMessage', text, ...(attachments.length ? { attachments } : {}) };
  }
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
    this.agentNames = new Map(); this.turnStates = new Map();
    this.notification = (message) => this.observe(message);
    this.action = (action) => this.recordAction(action);
    client.on('notification', this.notification);
    controller.on('agentAction', this.action);
  }
  close() {
    this.client.off('notification', this.notification);
    this.controller.off('agentAction', this.action);
    this.live.clear();
    this.agentNames.clear(); this.turnStates.clear();
  }
  find(target) {
    const agent = this.controller.find(target);
    if (!agent?.threadId || this.controller.threads.get(agent.threadId) !== agent) throw new Error('Agent thread is unavailable.');
    return agent;
  }
  summary(a) { return { id: a.id, agent_id: a.id, name: a.name, status: a.status, activity: a.activity,
    model: a.model, reasoning_effort: a.effort,
    permissions_mode: this.controller.settings?.permissionsMode ?? null,
    context_used_tokens: Number.isSafeInteger(a.tokenUsage?.last?.totalTokens) && a.tokenUsage.last.totalTokens >= 0 ? a.tokenUsage.last.totalTokens : null,
    context_limit_tokens: Number.isSafeInteger(a.tokenUsage?.modelContextWindow) && a.tokenUsage.modelContextWindow > 0 ? a.tokenUsage.modelContextWindow : null,
    user_paused: a.userPaused === true, user_control_status: a.userControlStatus ?? null }; }
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
    this.put(agent, { id: `action:${action.kind}:${this.bucket(agent.id).revision}`, turn_id: action.turn_id ?? '', type: action.origin === 'user' ? 'directUserMessage' : 'parentMessage', data: { text: clean(action.message), ...(action.attachments?.length ? { attachments: clean(action.attachments) } : {}) } });
  }
  decorate(item) {
    if (['collabAgentToolCall', 'collabToolCall'].includes(item.type)) return { ...item, displayAgentNames: Object.fromEntries([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})].filter(id => this.agentNames.has(id)).map(id => [id, this.agentNames.get(id)])) };
    if (item.type === 'subAgentActivity') {
      const name = this.agentNames.get(item.agentThreadId) ?? item.name;
      const pathName = typeof item.agentPath === 'string' ? item.agentPath.split('/').filter(Boolean).at(-1) : undefined;
      return { ...item, name: name ?? item.agentPath, display_name: name ?? pathName };
    }
    return item;
  }
  remember(map, key, value) { map.delete(key); map.set(key, value); if (map.size > 256) map.delete(map.keys().next().value); }
  stage(item, threadId, turnId, entry = item) {
    if (entry.completedAtMs != null || item.completedAtMs != null || this.turnStates.get(`${threadId}:${turnId}`) === 'completed') return 'completed';
    return entry.startedAtMs != null || item.startedAtMs != null ? 'started' : undefined;
  }
  observe(message) {
    const p = message?.params ?? {};
    if (message.method === 'thread/started' && p.thread?.id) {
      const name = p.thread.name || p.thread.agentNickname;
      if (typeof name === 'string' && name) this.remember(this.agentNames, p.thread.id, name.slice(0, 512));
    }
    const agent = this.controller.threads.get(p.threadId);
    // Never follow descendant IDs, even when they are tracked by the controller.
    if (!agent || agent.threadId !== p.threadId) return;
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (visible(p.item)) {
        const previous = this.bucket(agent.id).entries.find(entry => entry.turn_id === p.turnId && entry.id === p.item.id);
        const startedAtMs = p.item.startedAtMs ?? (message.method === 'item/started' ? p.startedAtMs : undefined) ?? previous?.started_at_ms;
        this.put(agent, simplify(this.decorate(removeGuidance(p.item, this.controller.guidance)), p.turnId, false, message.method === 'item/completed' ? 'completed' : 'started', startedAtMs));
      }
      return;
    }
    if (message.method === 'turn/completed' && p.turn?.id) this.remember(this.turnStates, `${p.threadId}:${p.turn.id}`, p.turn.status);
    if (message.method === 'thread/compacted') {
      const bucket = this.bucket(agent.id);
      const entry = [...bucket.entries].reverse().find(entry => entry.type === 'contextCompaction' && (!p.turnId || entry.turn_id === p.turnId));
      if (entry && entry.data?.stage !== 'completed') this.put(agent, { ...entry, data: { ...entry.data, stage: 'completed' } });
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
    return { agent: this.summary(agent), revision: bucket.revision, ...(revision === bucket.revision ? {} : { entries: orderWaits(bucket.entries) }) };
  }
  async history({ target, cursor, limit = 30 } = {}) {
    const agent = this.find(target);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be between 1 and 50.');
    if (cursor != null && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))) throw new TypeError('Invalid history cursor.');
    let { turn_id: turnId, turns_cursor: turnsCursor, items_cursor: itemsCursor, seen_turn_cursors: seenTurns = [], seen_item_cursors: seenItems = [] } = cursor ?? {};
    const validToken = (v) => v == null || (typeof v === 'string' && v.length > 0);
    const validSeen = (v) => Array.isArray(v) && v.length <= 64 && v.every((s) => typeof s === 'string' && s.length > 0) && new Set(v).size === v.length;
    if (![turnId, turnsCursor, itemsCursor].every(validToken) || !validSeen(seenTurns) || !validSeen(seenItems) || (!turnId && (itemsCursor || seenItems.length))) throw new TypeError('Invalid history cursor.');
    seenTurns = new Set(seenTurns); seenItems = new Set(seenItems);
    const entries = [];
    // Bound work even when native pages contain only hidden or empty items.
    let requests = 0, done = false;
    const advance = (current, next, seen) => {
      if (!validToken(next)) throw new Error('Invalid native history cursor.');
      if (current) {
        if (seen.has(current)) throw new Error('Repeated native history cursor.');
        seen.add(current);
      }
      if (next && seen.has(next)) throw new Error('Repeated native history cursor.');
      return next ?? null;
    };
    while (entries.length < limit && requests < 80 && !done) {
      if (!turnId) {
        const page = await this.client.request('thread/turns/list', { threadId: agent.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...(turnsCursor ? { cursor: turnsCursor } : {}) });
        requests++;
        turnsCursor = advance(turnsCursor, page.nextCursor, seenTurns);
        turnId = page.data?.[0]?.id;
        if (turnId && !validToken(turnId)) throw new Error('Invalid native turn ID.');
        if (turnId) this.remember(this.turnStates, `${agent.threadId}:${turnId}`, page.data[0].status);
        else if (!turnsCursor) done = true;
        continue;
      }
      const page = await this.client.request('thread/items/list', { threadId: agent.threadId, turnId, limit: limit - entries.length, sortDirection: 'desc', deferOutput: { commandExecution: true, mcpToolCall: true }, ...(itemsCursor ? { cursor: itemsCursor } : {}) });
      requests++;
      if ((page.data?.length ?? 0) > limit - entries.length) throw new Error('Native history page exceeded its requested limit.');
      itemsCursor = advance(itemsCursor, page.nextCursor, seenItems);
      entries.push(...(page.data ?? []).filter((entry) => visible(entry.item)).map((entry) => simplify(this.decorate(removeGuidance(entry.item, this.controller.guidance)), entry.turnId ?? turnId, entry.outputDeferred === true, this.stage(entry.item, agent.threadId, entry.turnId ?? turnId, entry), entry.startedAtMs ?? entry.item.startedAtMs)));
      if (!itemsCursor) {
        turnId = null; seenItems = new Set();
        if (!turnsCursor) done = true;
      }
    }
    const next_cursor = done ? null : { ...(turnId ? { turn_id: turnId, items_cursor: itemsCursor ?? null } : {}), ...(turnsCursor ? { turns_cursor: turnsCursor } : {}), ...(seenTurns.size ? { seen_turn_cursors: [...seenTurns].slice(-64) } : {}), ...(seenItems.size ? { seen_item_cursors: [...seenItems].slice(-64) } : {}) };
    return { agent: this.summary(agent), entries: orderWaits(entries.reverse()), next_cursor };
  }
  async detail({ target, turn_id, item_id, offset = 0, file_path, view } = {}) {
    const agent = this.find(target);
    if (typeof turn_id !== 'string' || !turn_id || typeof item_id !== 'string' || !item_id) throw new TypeError('turn_id and item_id are required.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid detail offset.');
    if (file_path !== undefined && (typeof file_path !== 'string' || !file_path)) throw new TypeError('Invalid file path.');
    if (view !== undefined && view !== 'output') throw new TypeError('Invalid detail view.');
    const page = await this.client.request('thread/items/read', { threadId: agent.threadId, turnId: turn_id, itemIds: [item_id] });
    const item = page.data?.[0]?.item;
    if (!visible(item)) return { text: '', next_offset: null };
    const change = file_path !== undefined && item.type === 'fileChange' ? item.changes?.find(change => change.path === file_path) : null;
    if (file_path !== undefined && !change) throw new Error('File is not part of this recorded change.');
    const outputOnly = view === 'output' && OUTPUT_TYPES.has(item.type);
    const text = change ? change.diff ?? '' : (outputOnly ? formatItemOutput : formatItem)(removeGuidance(item, this.controller.guidance));
    const next_offset = offset + 16000 < text.length ? offset + 16000 : null;
    return { text: text.slice(offset, offset + 16000), next_offset, ...(change ? { file_path, format: offset === 0 && next_offset === null && /^@@ -\d+(?:,\d+)? \+\d+/m.test(text) ? 'diff' : 'source' } : outputOnly ? { format: 'source' } : {}) };
  }
}

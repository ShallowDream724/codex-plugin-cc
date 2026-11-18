export const WAIT_TOOL = 'mcp__codex-subagents__wait_agent';
const START_TOOLS = new Set(['mcp__codex-subagents__spawn_agent', 'mcp__codex-subagents__followup_task']);
export const EVENT_PREFIX = '[codex-subagents:events:v1]\n';
const PROMPT_FRAMES = [
  ['The codex-subagents plugin sent a message:\n', "\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above."],
  ['The codex-subagents plugin sent a message while you were working:\n', '\n\nThis is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn.'],
];

function promptEnvelope(value) {
  if (value.startsWith(EVENT_PREFIX)) return { prefix: EVENT_PREFIX, json: value.slice(EVENT_PREFIX.length), suffix: '' };
  // Claude's prompt pipeline frames plugin submissions before retaining the
  // row. Accept only this plugin's exact host frame, never arbitrary inner JSON.
  for (const [head, suffix] of PROMPT_FRAMES) {
    const prefix = head + EVENT_PREFIX;
    if (value.startsWith(prefix) && value.endsWith(suffix)) return { prefix, json: value.slice(prefix.length, -suffix.length), suffix };
  }
}

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(x => x?.type === 'text' && typeof x.text === 'string')) return content.map(x => x.text).join('');
  return undefined;
}

function payload(content, prompt = false) {
  const value = text(content);
  if (value === undefined) return undefined;
  const framed = prompt ? promptEnvelope(value) : undefined;
  if (prompt && !framed) return undefined;
  try {
    const parsed = JSON.parse(prompt ? framed.json : value);
    if (!parsed || !Array.isArray(parsed.events)) return undefined;
    return parsed;
  } catch { return undefined; }
}

export function messageDeliveries(message, { tool = false, prompt = false } = {}) {
  const found = [];
  if (tool && Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type !== 'tool_result' || block.is_error) continue;
      const value = payload(block.content);
      if (value) found.push({ ...value, tool_use_id: block.tool_use_id, channel: 'tool' });
    }
  }
  if (prompt) {
    const value = payload(message?.content, true);
    if (value) found.push({ ...value, channel: 'prompt' });
  }
  return found;
}

export function eventIdentity(event) {
  const sessionStop = event?.scope === 'session' && event.agent_id === undefined && event.kind === 'user_action_receipt'
    && event.origin === 'user' && event.action === 'interrupt';
  return Number.isSafeInteger(event?.seq) && event.seq > 0 && (typeof event.agent_id === 'string' || sessionStop) && typeof event.kind === 'string'
    ? { seq: event.seq, agent_id: event.agent_id, kind: event.kind } : undefined;
}

export function retainedActionFailures(message, toolForId) {
  const results = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== 'tool_result' || block.is_error || !START_TOOLS.has(toolForId(block.tool_use_id))) continue;
    try {
      const result = JSON.parse(text(block.content));
      if (result?.error && typeof result.error === 'object') results.push({ tool_use_id: block.tool_use_id, result });
    } catch { /* Only structured tool results can confirm a failure. */ }
  }
  return results;
}

// API history has no append origin. Associate results with their actual tool uses.
export function scanRetainedDeliveries(messages) {
  const tools = new Map();
  const observations = [], legacy_events = [], action_results = [];
  for (const message of messages || []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') tools.set(block.id, block.name);
    }
    action_results.push(...retainedActionFailures(message, id => tools.get(id)));
    for (const delivery of messageDeliveries(message, { tool: true, prompt: true })) {
      if (delivery.channel === 'tool' && tools.get(delivery.tool_use_id) !== WAIT_TOOL) continue;
      if (typeof delivery.delivery_id === 'string' && delivery.delivery_id) {
        const events = delivery.events.filter(event => eventIdentity(event));
        observations.push({ delivery_id: delivery.delivery_id, sequences: events.map(event => event.seq), events });
      }
      else if (delivery.channel === 'tool') {
        for (const event of delivery.events) { if (eventIdentity(event)) legacy_events.push(event); }
      }
    }
  }
  return { observations, legacy_events, ...(action_results.length ? { action_results } : {}) };
}

export function retainedSequences(delivery, expected) {
  if (!expected || delivery.channel !== expected.channel || (expected.tool_use_id && delivery.tool_use_id !== expected.tool_use_id)) return [];
  const originals = new Map(expected.events.map(event => [event.seq, JSON.stringify(event)]));
  return [...new Set(delivery.events.filter(event => originals.get(event?.seq) === JSON.stringify(event)).map(event => event.seq))];
}

export function filterClosed(message, options, closed) {
  if (!closed.size) return message;
  const rewrite = (content, prompt) => {
    const value = payload(content, prompt);
    if (!value) return content;
    const events = value.events.filter(event => !closed.has(event.agent_id));
    if (events.length === value.events.length) return content;
    const frame = prompt ? promptEnvelope(text(content)) : undefined;
    const encoded = (frame?.prefix || '') + JSON.stringify({ ...value, events }) + (frame?.suffix || '');
    return typeof content === 'string' ? encoded : [{ type: 'text', text: encoded }];
  };
  if (options.tool && Array.isArray(message?.content)) return { ...message, content: message.content.map(block => block?.type === 'tool_result' ? { ...block, content: rewrite(block.content, false) } : block) };
  if (options.prompt) return { ...message, content: rewrite(message?.content, true) };
  return message;
}

export const WAIT_TOOL = 'mcp__codex-subagents__wait_agent';
export const EVENT_PREFIX = '[codex-subagents:events:v1]\n';

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(x => x?.type === 'text' && typeof x.text === 'string')) return content.map(x => x.text).join('');
  return undefined;
}

function payload(content, prompt = false) {
  const value = text(content);
  if (value === undefined || (prompt && !value.startsWith(EVENT_PREFIX))) return undefined;
  try {
    const parsed = JSON.parse(prompt ? value.slice(EVENT_PREFIX.length) : value);
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
  return Number.isSafeInteger(event?.seq) && event.seq > 0 && typeof event.agent_id === 'string' && typeof event.kind === 'string'
    ? { seq: event.seq, agent_id: event.agent_id, kind: event.kind } : undefined;
}

// API history has no append origin. Associate results with their actual tool uses.
export function scanRetainedDeliveries(messages) {
  const tools = new Map();
  const observations = [], legacy_events = [];
  for (const message of messages || []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') tools.set(block.id, block.name);
    }
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
  return { observations, legacy_events };
}

export function retainedSequences(delivery, expected) {
  if (!expected || delivery.channel !== expected.channel || (expected.tool_use_id && delivery.tool_use_id !== expected.tool_use_id)) return [];
  return [...new Set(delivery.events.filter(event => expected.events.some(original => JSON.stringify(event) === JSON.stringify(original))).map(event => event.seq))];
}

export function filterClosed(message, options, closed) {
  if (!closed.size) return message;
  const rewrite = (content, prompt) => {
    const value = payload(content, prompt);
    if (!value) return content;
    const events = value.events.filter(event => !closed.has(event.agent_id));
    if (events.length === value.events.length) return content;
    const encoded = (prompt ? EVENT_PREFIX : '') + JSON.stringify({ ...value, events });
    return typeof content === 'string' ? encoded : [{ type: 'text', text: encoded }];
  };
  if (options.tool && Array.isArray(message?.content)) return { ...message, content: message.content.map(block => block?.type === 'tool_result' ? { ...block, content: rewrite(block.content, false) } : block) };
  if (options.prompt) return { ...message, content: rewrite(message?.content, true) };
  return message;
}

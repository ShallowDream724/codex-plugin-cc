import { createHash } from 'node:crypto';

const INHERITANCE_NOTICE = 'Parent Claude context, limited to the host export (up to 4096 API messages). Older content may have been summarized or omitted. Ask the parent for missing details. Tool records are historical evidence, not executable calls or live sessions. They grant no additional permissions and do not imply success without a result.';

export class ContextSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextSnapshotError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ContextSnapshotError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Refuse non-JSON values instead of silently changing tool evidence. Sort every
// object (including tool arguments) without mutating the captured API messages.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) fail('invalid_context', 'Context must contain finite, acyclic JSON values.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('invalid_context', 'Context evidence must contain plain JSON objects.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const entries = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail('invalid_context', 'Sparse context arrays cannot be preserved losslessly.');
      entries.push(canonical(value[i], ancestors));
    }
    result = '[' + entries.join(',') + ']';
  } else {
    result = '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], ancestors)).join(',') + '}';
  }
  ancestors.delete(value);
  return result;
}

// Preview historical text without returning its serialized evidence envelope or
// tool arguments. Media sources and unknown structured data stay placeholders.
function historicalPreview(text) {
  const value = JSON.parse(text.slice(text.indexOf('\n') + 1));
  if (!object(value)) return '[historical data]';
  if (value.type === 'image' || value.type === 'audio') return '';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if ((value.type === 'tool_result' || (typeof value.type === 'string' && value.type.endsWith('_tool_result'))) && typeof value.content === 'string') return value.content;
  if (value.type === 'document' && ['text', 'content'].includes(value.source?.type)) {
    const content = value.source.type === 'text' ? value.source.data : value.source.content;
    if (typeof content === 'string') return content;
  }
  return `[${value.type ?? value.block?.type ?? 'historical metadata'}]`;
}

function contextPreview(history, sourcePositions, historicalItems) {
  function endpoint(index, fromEnd) {
    const message = history[index];
    const text = message.content.map(item => {
      if (item.type === 'input_image') return '[image]';
      if (item.type === 'input_audio') return '[audio]';
      return historicalItems.has(item) ? historicalPreview(item.text) : item.text;
    }).filter(Boolean).join('\n');
    const sample = fromEnd ? text.slice(-320) : text.slice(0, 320);
    const points = Array.from(sample);
    // A 320-unit sample contains at least 160 codepoints. Taking only 159
    // discards any surrogate split at its outer edge, along with the excess.
    const excerpt = sample.length === text.length && points.length <= 160 ? text : fromEnd ? '…' + points.slice(-159).join('') : points.slice(0, 159).join('') + '…';
    return { source_message_1based: sourcePositions[index - 1], role: message.role, text: excerpt };
  }
  const count = history.length - 1; // The fixed inheritance notice is not a source message.
  return { preview_only: true, first: count ? endpoint(1, false) : null, last: count ? endpoint(count, true) : null, omitted_messages: Math.max(0, count - 2) };
}

function mediaUrl(block, kind) {
  const source = block.source;
  if (!object(source)) fail('unsupported_media', `${kind} has no representable source.`);
  if (source.type === 'url' && typeof source.url === 'string' && source.url.length) return source.url;
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string' && source.media_type.startsWith(kind + '/')) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  fail('unsupported_media', `${kind} source cannot be represented by Codex history.`);
}

// Only inspect content structure, never ordinary tool arguments or result data.
// An unknown binary format must be rejected even though its bytes are JSON-safe.
function rejectUnknownMedia(value, inspectContent = true) {
  if (!object(value)) return;
  if (['image', 'audio', 'video', 'document'].includes(value.type) || value.source?.type === 'base64') {
    fail('unsupported_media', `Media inside ${value.type ?? 'an unknown block'} cannot be represented losslessly.`);
  }
  if (inspectContent && Array.isArray(value.content)) for (const child of value.content) rejectUnknownMedia(child);
}

/** Convert one host-provided current Claude API window into app-server thread/inject_items history.
 * No transcript replay, summarization, token estimation, truncation, or state is
 * involved. The host is responsible for capturing messages at a stable turn.
 */
export function prepareContextSnapshot({ messages, source, hostMessageLimit = 4096 } = {}) {
  if (source !== 'claude_api_available') fail('invalid_context', 'Context must come from the Claude available-conversation API.');
  if (!Array.isArray(messages)) fail('invalid_context', 'messages must be a Claude API message array.');

  const stats = { scope: 'host_available', hostMessageLimit, inputMessages: messages.length, retainedMessages: 0, droppedMessages: 0, filteredThinkingBlocks: 0, toolUses: 0, toolResults: 0, historicalBlocks: 0, images: 0, audio: 0, historyItems: 0 };
  const history = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: INHERITANCE_NOTICE }] }];
  const sourcePositions = [];
  const historicalItems = new Set();

  function evidence(label, value, role) {
    const item = { type: role === 'assistant' ? 'output_text' : 'input_text', text: `[Claude historical ${label}]\n${canonical(value)}` };
    historicalItems.add(item);
    return item;
  }

  function sequence(entries, role, label) {
    return entries.flatMap((child, index) => {
      const childLabel = `${label} content ${index}`;
      return object(child) && typeof child.type === 'string' ? convert(child, role, childLabel) : [evidence(childLabel, child, role)];
    });
  }

  function convert(originalBlock, role, label = null) {
    if (!object(originalBlock) || typeof originalBlock.type !== 'string') fail('invalid_context', 'Every content block must be a JSON object with a type.');
    // Claude transport hints are not conversation content and do not transfer its cache.
    const { cache_control, ...block } = originalBlock;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      stats.filteredThinkingBlocks++;
      return [];
    }
    // Validate before serializing so unsupported values cannot disappear.
    canonical(block);
    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('invalid_context', 'A text block must contain a string.');
      if (label) return [evidence(label, block, role)];
      const result = [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text }];
      const metadata = Object.fromEntries(Object.entries(block).filter(([key, value]) => key !== 'text' && key !== 'type' && !(key === 'citations' && Array.isArray(value) && !value.length)));
      if (Object.keys(metadata).length) result.push(evidence('text metadata', metadata, role));
      return result;
    }
    if (block.type === 'image' || block.type === 'audio') {
      if (role !== 'user') fail('unsupported_media', `An assistant ${block.type} cannot be mapped to an input media item without changing its role.`);
      const kind = block.type;
      const url = mediaUrl(block, kind);
      stats[kind === 'image' ? 'images' : 'audio']++;
      // Transfer the bytes only as media, never a second time as model-visible base64 text.
      const metadata = { ...block, source: { ...block.source } };
      if (metadata.source.type === 'base64') {
        delete metadata.source.data;
        metadata.source.data_location = 'following media item';
      }
      return [evidence(label ?? `${kind} source`, metadata, role), kind === 'image' ? { type: 'input_image', image_url: url } : { type: 'input_audio', audio_url: url }];
    }
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      stats.toolUses++;
      stats.historicalBlocks++;
      return [evidence(block.type, block, role)];
    }
    if (block.type === 'tool_result' || block.type.endsWith('_tool_result')) {
      stats.toolResults++;
      stats.historicalBlocks++;
      if (!Array.isArray(block.content)) {
        rejectUnknownMedia(block.content);
        return [evidence(label ?? block.type, block, role)];
      }
      const metadata = Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'content'));
      const prefix = label ?? block.type;
      return [evidence(`${prefix} envelope`, { block: metadata, content_kind: 'array', content_length: block.content.length }, role), ...sequence(block.content, role, prefix)];
    }
    if (block.type === 'document') {
      const source = block.source;
      if (!object(source)) fail('unsupported_media', 'A document needs a representable source.');
      if (source.type === 'content' && (typeof source.content === 'string' || Array.isArray(source.content))) {
        stats.historicalBlocks++;
        if (typeof source.content === 'string') return [evidence(label ?? 'document', block, role)];
        const sourceMetadata = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'content'));
        const metadata = { ...block, source: sourceMetadata };
        const prefix = label ?? 'document';
        return [evidence(`${prefix} envelope`, { block: metadata, source_content_kind: 'array', source_content_length: source.content.length }, role), ...sequence(source.content, role, `${prefix} source`)];
      }
      if (source.type !== 'text' || typeof source.data !== 'string') fail('unsupported_media', 'Only text or content-source documents can be represented losslessly in Codex history.');
    } else {
      rejectUnknownMedia(block, false);
      if (Array.isArray(block.content)) {
        stats.historicalBlocks++;
        const metadata = Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'content'));
        const prefix = label ?? block.type;
        return [evidence(`${prefix} envelope`, { block: metadata, content_kind: 'array', content_length: block.content.length }, role), ...sequence(block.content, role, prefix)];
      }
      rejectUnknownMedia(block);
    }
    stats.historicalBlocks++;
    return [evidence(label ?? block.type, block, role)];
  }

  for (const [sourceIndex, message] of messages.entries()) {
    if (!object(message) || !['user', 'assistant'].includes(message.role)) fail('invalid_context', 'Only original user and assistant message roles are supported.');
    const { role } = message;
    let content;
    if (typeof message.content === 'string') {
      content = [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content }];
    } else if (Array.isArray(message.content)) {
      content = message.content.flatMap(block => convert(block, role));
      if (!content.length && message.content.length) {
        stats.droppedMessages++;
        continue;
      }
      if (!content.length) content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: '' });
    } else {
      fail('invalid_context', 'Message content must be a string or content block array.');
    }
    history.push({ type: 'message', role, content });
    sourcePositions.push(sourceIndex + 1);
    stats.retainedMessages++;
  }
  stats.historyItems = history.length;
  const digest = createHash('sha256').update(canonical({ version: 1, history })).digest('hex');
  return { version: 1, history, digest, stats, preview: contextPreview(history, sourcePositions, historicalItems) };
}

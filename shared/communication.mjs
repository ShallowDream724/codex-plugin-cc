export const claudeMessagePrefix = '[Message from Claude]\n\n';

// Extract only messages sent by this agent, never nested agent state or tool output.
export function communication(item, threadId) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'dynamicToolCall' && item.tool === 'notify_parent' && item.namespace == null) {
    let args = item.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
    return args && typeof args === 'object' && !Array.isArray(args) && typeof args.message === 'string'
      ? { title: '发给 Claude', text: args.message } : null;
  }
  if (!['collabAgentToolCall', 'collabToolCall'].includes(item.type) ||
      !['sendInput', 'sendMessage'].includes(item.tool) || typeof item.prompt !== 'string' ||
      (item.senderThreadId != null && item.senderThreadId !== threadId)) return null;
  const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(id => typeof id === 'string' && id) : [];
  const names = ids.slice(0, 20).map(id => {
    const name = [item.displayAgentNames?.[id], item.agentsStates?.[id]?.name, item.agentsStates?.[id]?.nickname].find(value => typeof value === 'string' && value);
    return name ? (name.split('/').filter(Boolean).at(-1) ?? name).replace(/\p{L}/u, letter => letter.toUpperCase()) : id;
  });
  return { title: names.length ? `发给 ${names.join(', ')}`.slice(0, 256) : '发送消息', text: item.prompt };
}

// Fixed offsets make both next_offset and offset - page size reversible.
export function safeBoundary(text, offset) {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]) ? offset + 1 : offset;
}

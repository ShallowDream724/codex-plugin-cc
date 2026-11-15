// Pure presentation of a tool result; callers supply their own safe serializer.
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
export function toolOutputText(value, { serialize = text, formatPart = (part) => typeof part?.text === 'string' ? serialize(part.text) : serialize(part) } = {}) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(formatPart).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return serialize(value);
  const protocolKeys = ['content', 'contentItems', 'structuredContent', '_meta'];
  if (!protocolKeys.some(key => Object.hasOwn(value, key))) return serialize(value);
  const parts = [], extra = {};
  for (const [key, field] of Object.entries(value)) {
    if (['content', 'contentItems'].includes(key) && Array.isArray(field)) parts.push(...field.map(formatPart));
    else if (key === 'structuredContent' && field != null) parts.push(serialize(field));
    else if (!(protocolKeys.includes(key) && field == null)) extra[key] = field;
  }
  if (Object.keys(extra).length) parts.push(serialize(extra));
  return parts.filter(Boolean).join('\n');
}

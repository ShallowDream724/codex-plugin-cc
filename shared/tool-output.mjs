// Pure presentation of a tool result; callers supply their own safe serializer.
import { isImageBlock, sanitizeMedia, serializedToolResult } from './tool-media.mjs';
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
export function toolOutputText(value, { serialize = text, formatPart = (part) => typeof part?.text === 'string' ? serialize(part.text) : serialize(part) } = {}) {
  if (value == null) return '';
  value = sanitizeMedia(value);
  const serialized = serializedToolResult(value);
  if (serialized?.value) value = serialized.value;
  const partText = (part) => {
    if (isImageBlock(part)) {
      const { type, media_omitted, mimeType, ...extra } = part;
      return Object.keys(extra).length ? serialize(extra) : '';
    }
    if (part && typeof part === 'object') {
      if (Array.isArray(part.content) || Array.isArray(part.contentItems)) return toolOutputText(part, { serialize, formatPart });
      if (['text', 'inputText', 'outputText', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') {
        const wrapped = serializedToolResult(part.text);
        if (wrapped?.value) {
          const { type, text, ...extra } = part;
          return [toolOutputText(wrapped.value, { serialize, formatPart }), Object.keys(extra).length ? serialize(extra) : ''].filter(Boolean).join('\n');
        }
      }
    }
    return formatPart(part);
  };
  if (isImageBlock(value)) return partText(value);
  if (Array.isArray(value)) return value.map(partText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return serialize(value);
  const protocolKeys = ['content', 'contentItems', 'structuredContent', '_meta'];
  if (!protocolKeys.some(key => Object.hasOwn(value, key))) return serialize(value);
  const parts = [], extra = {};
  for (const [key, field] of Object.entries(value)) {
    if (['content', 'contentItems'].includes(key) && Array.isArray(field)) parts.push(...field.map(partText));
    else if (key === 'structuredContent' && field != null) parts.push(serialize(field));
    else if (key === 'type' && ['tool_result', 'toolResult'].includes(field) && (Array.isArray(value.content) || Array.isArray(value.contentItems))) continue;
    else if (!(protocolKeys.includes(key) && field == null)) extra[key] = field;
  }
  if (Object.keys(extra).length) parts.push(serialize(extra));
  return parts.filter(Boolean).join('\n');
}

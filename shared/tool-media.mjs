// Recognize only protocol-defined image blocks and native image records.
const types = new Set(['image', 'input_image', 'inputImage', 'output_image', 'outputImage']);
export function isImageBlock(value) { return !!value && typeof value === 'object' && types.has(value.type) && (value.media_omitted === true || value.data != null || value.base64 != null || value.image_url != null || value.imageUrl != null); }
// Some MCP transports wrap the complete result in a text block. Parse only an
// exact JSON protocol container, with a cap independent of its image count.
const SERIALIZED_LIMIT = 32 * 1024 * 1024;
export function serializedToolResult(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  if (trimmed.length > SERIALIZED_LIMIT) {
    return /"(?:content|contentItems)"\s*:/.test(trimmed) && /"type"\s*:\s*"(?:image|input_image|inputImage|output_image|outputImage)"/.test(trimmed) ? { omitted: true } : null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const content = parsed.content ?? parsed.contentItems;
    if (!Array.isArray(content) || !content.every(part => part && typeof part === 'object' && !Array.isArray(part) && typeof part.type === 'string')) return null;
    return { value: parsed };
  } catch { return null; }
}
export function sanitizeMedia(value) {
  let nodes = 0;
  const seen = new WeakSet();
  function visit(field, depth) {
    if (++nodes > 10000 || depth > 20) return '[nested data omitted]';
    if (isImageBlock(field)) {
      const mime = field.mimeType ?? field.mime_type ?? field.media_type;
      const result = { type: 'image', media_omitted: true, ...(typeof mime === 'string' ? { mimeType: mime } : {}) };
      for (const [key, value] of Object.entries(field)) {
        if (['type', 'media_omitted', 'mimeType', 'mime_type', 'media_type', 'data', 'base64', 'image_url', 'imageUrl'].includes(key)) continue;
        Object.defineProperty(result, key, { value: visit(value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    if (typeof field === 'string') {
      const parsed = serializedToolResult(field);
      if (parsed?.omitted) return '[serialized image result omitted]';
      if (parsed) return JSON.stringify(visit(parsed.value, depth + 1));
      return /^data:image\/[^,]*;base64,/i.test(field) ? '[image data omitted]' : field;
    }
    if (!field || typeof field !== 'object') return field;
    if (seen.has(field)) return '[circular data omitted]';
    seen.add(field);
    let result;
    if (Array.isArray(field)) {
      result = [];
      for (const value of field) { if (nodes >= 10000) { result.push('[remaining data omitted]'); break; } result.push(visit(value, depth + 1)); }
    } else {
      result = {};
      for (const key in field) {
        if (!Object.hasOwn(field, key)) continue;
        if (nodes >= 10000) { result['[remaining data omitted]'] = true; break; }
        Object.defineProperty(result, key, { value: visit(field[key], depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    seen.delete(field);
    return result;
  }
  return visit(value, 0);
}
export function collectImages(item) {
  const images = []; let nodes = 0, omitted = false;
  const add = (source) => {
    if (images.length >= 256) { omitted = true; return; }
    images.push({ ...source, index: images.length });
  };
  function visit(value, depth = 0) {
    if (depth > 8 || ++nodes > 4096 || images.length >= 256) { omitted = true; return; }
    if (typeof value === 'string') {
      const parsed = serializedToolResult(value);
      if (parsed?.omitted) omitted = true;
      else if (parsed) visit(parsed.value, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const part of value) { if (nodes >= 4096 || images.length >= 256) { omitted = true; break; } visit(part, depth + 1); } return; }
    if (isImageBlock(value)) {
      const url = value.image_url ?? value.imageUrl;
      const dataUrl = typeof url === 'string' ? url : url?.url;
      add({ data: value.data ?? value.base64 ?? dataUrl, mime: value.mimeType ?? value.mime_type ?? value.media_type, alt: value.alt ?? value.name });
      return;
    }
    if (value.type === 'localImage' && typeof value.path === 'string') { add({ path: value.path }); return; }
    if (['text', 'inputText', 'outputText', 'input_text', 'output_text'].includes(value.type) && typeof value.text === 'string') visit(value.text, depth + 1);
    // Descend only through protocol containers, avoiding arbitrary business JSON.
    for (const key of ['content', 'contentItems', 'result', 'output']) if (value[key] != null) visit(value[key], depth + 1);
  }
  if (['imageView', 'imageGeneration'].includes(item?.type)) {
    const path = item.savedPath ?? item.saved_path ?? item.path;
    if (typeof path === 'string' && path) add({ path, alt: item.name });
  } else if (item?.type === 'directUserMessage') {
    for (const attachment of item.attachments ?? []) {
      if (++nodes > 4096 || images.length >= 256) { omitted = true; break; }
      if (attachment?.type === 'image' && typeof attachment.path === 'string') add({ path: attachment.path, alt: attachment.name });
    }
  } else visit(item);
  return { images, omitted };
}

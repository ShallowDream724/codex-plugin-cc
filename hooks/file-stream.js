// Projection units are deliberately smaller than transport pages so the history
// window can virtualize a large file without mounting the entire page at once.
const MAX_ROWS = 24;
const MAX_TEXT = 4000;
const rowGroupsCache = new WeakMap();

function safeEnd(text, start, limit = MAX_TEXT) {
  let end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return end;
}

function splitText(text) {
  const parts = [];
  for (let start = 0; start < text.length;) {
    const end = safeEnd(text, start);
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function splitRows(rows) {
  if (rowGroupsCache.has(rows)) return rowGroupsCache.get(rows);
  const groups = []; let group = [], size = 0;
  const flush = () => { if (group.length) groups.push(group); group = []; size = 0; };
  for (const row of rows) {
    const value = typeof row.text === 'string' ? row.text : '';
    const pieces = splitText(value);
    if (!pieces.length) pieces.push('');
    pieces.forEach((piece, index) => {
      if (group.length >= MAX_ROWS || (group.length && size + piece.length > MAX_TEXT)) flush();
      const fragment = { ...row, text: piece };
      if (index) { delete fragment.old; delete fragment.new; fragment.continuation = true; }
      group.push(fragment); size += piece.length;
    });
  }
  flush();
  rowGroupsCache.set(rows, groups);
  return groups;
}

/** Add a transport page without changing previously cached pages. */
export function appendFilePage(previous, result, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !result || typeof result !== 'object') throw new Error('Invalid file page');
  if (offset !== 0 && (!previous || previous.next_offset !== offset)) throw new Error('Unexpected file page offset');
  const next = result.next_offset;
  if (next != null && (!Number.isSafeInteger(next) || next <= offset)) throw new Error('File page did not advance');
  const chunk = { ...result, offset };
  return { chunks: [...(offset === 0 ? [] : previous.chunks ?? []), chunk], next_offset: next ?? null };
}

/** Expand file changes into independently virtualizable history entries. */
export function fileViewEntries(entry, agentId, { isOpen = () => false, getDetail = () => undefined } = {}) {
  const summaries = entry?.data?.fileSummary;
  const rawChanges = entry?.data?.changes;
  const changes = Array.isArray(rawChanges) ? rawChanges : rawChanges && typeof rawChanges === 'object'
    ? Object.entries(rawChanges).filter(([, change]) => change && typeof change === 'object' && !Array.isArray(change)).map(([path, change]) => ({ ...change, path: typeof change.path === 'string' ? change.path : path }))
    : undefined;
  const files = Array.isArray(summaries) && summaries.length ? summaries : changes;
  if (entry?.type !== 'fileChange' || !Array.isArray(files) || !files.length) return [entry];
  const output = [];
  files.forEach((file, index) => {
    const path = typeof file?.path === 'string' ? file.path : '';
    const change = Array.isArray(changes) ? changes.find(item => item?.path === path) ?? file : file;
    const key = `${agentId}:${entry.turn_id || ''}:${entry.id}:file:${index}`;
    const meta = { key, source: entry, path, index, change, ...(files === summaries ? { summary: file } : {}) };
    const add = (type, suffix, view) => output.push({ id: `${entry.id}:file:${index}:${suffix}`, turn_id: entry.turn_id, type, fileView: { ...meta, ...view } });
    add('fileChangeHeader', 'header', { kind: 'header' });
    if (!isOpen(key)) return;
    const detail = getDetail(path);
    const projected = [];
    let lineWidth = Math.max(2, ...[file?.added, file?.removed].filter(Number.isSafeInteger).map(value => String(value).length));
    for (const chunk of detail?.chunks ?? []) {
      if (chunk.format === 'diff') {
        const rows = Array.isArray(chunk.rows) ? chunk.rows : [];
        for (const row of rows) lineWidth = Math.max(lineWidth, String(row.old ?? '').length, String(row.new ?? '').length);
        splitRows(rows).forEach((rows, group) => projected.push({ offset: chunk.offset, group, text: '', rows, format: chunk.format }));
      } else {
        splitText(typeof chunk.text === 'string' ? chunk.text : '').forEach((text, group) => projected.push({ offset: chunk.offset, group, text, format: chunk.format }));
      }
    }
    projected.forEach((part, chunkIndex) => add('fileDiffChunk', `chunk:${part.offset}:${part.group}`, {
      kind: 'chunk', rows: part.rows, text: part.text, format: part.format, lineWidth, chunkIndex, isFirst: chunkIndex === 0,
      prefetch: detail?.next_offset != null && chunkIndex >= projected.length - 2,
    }));
    if (!detail || detail.next_offset != null || detail.error || detail.loading) add('fileDiffTail', 'tail', { kind: 'tail', detail, next_offset: detail?.next_offset, error: detail?.error, loading: detail?.loading });
  });
  return output;
}

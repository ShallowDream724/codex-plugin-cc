import { parseUnifiedDiff, parseUnifiedDiffDetailed } from './unified-diff.mjs';

export function fileChanges(item) {
  if (Array.isArray(item?.changes)) return item.changes.filter(c => c && typeof c.path === 'string');
  if (!item?.changes || typeof item.changes !== 'object') return [];
  return Object.entries(item.changes).filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c)).map(([path, c]) => ({ ...c, path: typeof c.path === 'string' ? c.path : path }));
}

function kindOf(change) {
  const kind = typeof change?.kind === 'string' ? change.kind : change?.kind?.type ?? change?.type;
  return ['add', 'delete', 'update'].includes(kind) ? kind : 'unknown';
}

function sourceText(change, kind) {
  if (kind === 'add' || kind === 'delete') return typeof change?.content === 'string' ? change.content : change?.diff;
  return typeof change?.unified_diff === 'string' ? change.unified_diff : change?.diff;
}

function oneWayDiff(path, text, kind) {
  const lines = text ? text.split('\n') : [];
  const terminated = text.endsWith('\n');
  if (terminated) lines.pop();
  const count = lines.length, add = kind === 'add';
  // Keep CR in body lines: it is part of the original CRLF file content.
  let patch = `--- ${add ? '/dev/null' : `a/${path}`}\n+++ ${add ? `b/${path}` : '/dev/null'}\n@@ -${add ? '0,0' : `1,${count}`} +${add ? `1,${count}` : '0,0'} @@\n`;
  if (!count) patch = `--- ${add ? '/dev/null' : `a/${path}`}\n+++ ${add ? `b/${path}` : '/dev/null'}\n@@ -0,0 +0,0 @@\n`;
  for (const [i, line] of lines.entries()) {
    patch += `${add ? '+' : '-'}${line}\n`;
    if (i === count - 1 && !terminated) patch += '\\ No newline at end of file\n';
  }
  return patch;
}

export function fileChangeSource(change) {
  const kind = kindOf(change); let text = sourceText(change, kind);
  if (typeof text !== 'string') return { text: '', format: 'source' };
  if ((kind === 'add' || kind === 'delete') && typeof change?.path === 'string') return { text: oneWayDiff(change.path, text, kind), format: 'diff' };
  // app-server item_builders::format_file_change_diff appends this exact
  // footer for a move. Remove it only when the record names that destination.
  const move = change?.kind?.move_path ?? change?.move_path;
  const footer = typeof move === 'string' ? `\n\nMoved to: ${move}` : null;
  if (footer && text.endsWith(footer)) text = text.slice(0, -footer.length);
  return { text, format: parseUnifiedDiff(text) ? 'diff' : 'source' };
}

export function fileChangeSummary(change) {
  const kind = kindOf(change), summary = { path: change?.path, kind };
  const move = change?.kind?.move_path ?? change?.move_path;
  if (typeof move === 'string') summary.move_path = move;
  if (kind === 'add' || kind === 'delete') {
    const text = sourceText(change, kind);
    if (typeof text === 'string') {
      // A summary needs line counts, not an allocated patch and row tree.
      let count = text.length ? 1 : 0;
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
      if (text.endsWith('\n')) count--;
      summary.added = kind === 'add' ? count : 0;
      summary.removed = kind === 'delete' ? count : 0;
    }
    return summary;
  }
  const source = fileChangeSource(change);
  if (source.format === 'diff') {
    const rows = parseUnifiedDiff(source.text);
    if (rows) { summary.added = rows.filter(r => r.kind === 'added').length; summary.removed = rows.filter(r => r.kind === 'removed').length; }
  }
  return summary;
}

// Page boundaries are generated in one pass; the offset always addresses the
// same normalized patch, including its file headers and line terminators.
let cachedPageIndex;
export function fileChangePage(change, offset = 0) {
  const kind = kindOf(change), raw = sourceText(change, kind), move = change?.kind?.move_path ?? change?.move_path;
  if (cachedPageIndex && cachedPageIndex.kind === kind && cachedPageIndex.raw === raw && cachedPageIndex.path === change?.path && cachedPageIndex.move === move) return selectPage(cachedPageIndex, offset);
  const source = fileChangeSource(change), text = source.text;
  const safeEnd = end => end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
  const detailed = source.format === 'diff' ? parseUnifiedDiffDetailed(text) : null;
  const pages = []; let start = 0, rowIndex = 0;
  do {
    let end = safeEnd(Math.min(text.length, start + 16000));
    if (detailed) while (rowIndex < detailed.length && detailed[rowIndex].end <= start) rowIndex++;
    let index = rowIndex, count = 0;
    if (detailed) {
      while (index < detailed.length && detailed[index].start < end) {
        if (count === 120) { end = detailed[index].start; break; }
        count++; index++;
      }
      // Prefer whole lines unless one line exceeds the character limit.
      if (index && end < text.length && detailed[index - 1].end > end && detailed[index - 1].start > start) end = detailed[index - 1].start;
    }
    if (end <= start && start < text.length) end = safeEnd(Math.min(text.length, start + 16000));
    const rows = [];
    if (detailed) {
      for (let j = rowIndex; j < detailed.length && detailed[j].start < end; j++) {
        const r = detailed[j], from = Math.max(start, r.start), to = Math.min(end, r.end);
        const contentEnd = r.start + r.text.length;
        const fragment = text.slice(from, Math.min(to, contentEnd));
        if (from >= contentEnd) continue;
        const { start: ignoredStart, end: ignoredEnd, ...row } = r;
        row.text = fragment;
        if (from > r.start) { delete row.old; delete row.new; row.continuation = true; }
        rows.push(row);
      }
    }
    pages.push({ start, end, rows }); start = end;
  } while (start < text.length);
  cachedPageIndex = { kind, raw, path: change?.path, move, text, format: source.format, detailed: !!detailed, pages };
  return selectPage(cachedPageIndex, offset);
}

function selectPage({ text, format, detailed, pages }, offset) {
  let low = 0, high = pages.length;
  while (low + 1 < high) { const mid = (low + high) >>> 1; if (pages[mid].start <= offset) low = mid; else high = mid; }
  const pageIndex = low;
  const page = pages[pageIndex];
  return { text: text.slice(page.start, page.end), format, ...(detailed ? { rows: page.rows } : {}), next_offset: pageIndex + 1 < pages.length ? page.end : null, previous_offset: pageIndex ? pages[pageIndex - 1].start : null };
}

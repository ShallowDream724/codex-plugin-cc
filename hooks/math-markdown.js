// Index backtick runs once so unmatched code delimiters cannot repeatedly scan
// the rest of a long streaming message. Backslashes are literal inside code.
function codeRuns(text) {
  const runs = [];
  const fences = [...text.matchAll(/^ {0,3}(?:`{3,}|~{3,})/gm)].map(match => match.index);
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') { i++; continue; }
    const start = i;
    while (text[i] === '`') i++;
    runs.push({ start, end: i, size: i - start });
  }
  const next = new Map();
  const byStart = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    run.close = next.get(run.size);
    if (run.close) {
      let low = 0;
      let high = fences.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (fences[mid] <= run.start) low = mid + 1;
        else high = mid;
      }
      if (fences[low] < run.close.start) run.close = undefined;
    }
    next.set(run.size, run);
    byStart.set(run.start, run);
  }
  return byStart;
}

function fenceAt(text, index) {
  if (index && text[index - 1] !== '\n') return null;
  const end = text.indexOf('\n', index);
  const lineEnd = end < 0 ? text.length : end;
  const line = text.slice(index, lineEnd).replace(/\r$/, '');
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1], end: end < 0 ? text.length : end + 1 };
}

function skipFence(text, fence) {
  let index = fence.end;
  while (index < text.length) {
    const end = text.indexOf('\n', index);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(index, lineEnd).replace(/\r$/, '');
    const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
    index = end < 0 ? text.length : end + 1;
    if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) break;
  }
  return index;
}

function skipDollarMath(text, start) {
  const delimiter = text.startsWith('$$', start) ? '$$' : '$';
  let i = start + delimiter.length;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text.startsWith(delimiter, i)) return i + delimiter.length;
    i++;
  }
  // An unfinished math region is opaque while the response is streaming.
  return text.length;
}

// Returns complete LaTeX spans as offsets into the original string. Code and
// existing dollar math are opaque; a partial region is left untouched.
export function parseMathSpans(text) {
  if (!text.includes('\\[') && !text.includes('\\(')) return [];
  const runs = codeRuns(text);
  const spans = [];
  let pending = null;
  let i = 0;
  while (i < text.length) {
    const fence = fenceAt(text, i);
    if (fence) { pending = null; i = skipFence(text, fence); continue; }
    if (pending) {
      if (text[i] === '\\') {
        if (text[i + 1] === pending.close) {
          spans.push({ type: pending.type, start: pending.start, end: i + 2,
            content: text.slice(pending.start + 2, i) });
          pending = null;
        }
        i += 2;
      } else i++;
      continue;
    }
    if (text[i] === '`') {
      const run = runs.get(i);
      if (run?.close) { pending = null; i = run.close.end; continue; }
      i = run?.end ?? i + 1;
      continue;
    }
    if (text[i] === '\\') {
      const next = text[i + 1];
      if (next === '[' || next === '(') {
        pending = { start: i, type: next === '[' ? 'display' : 'inline', close: next === '[' ? ']' : ')' };
      }
      // This also consumes escaped backslashes, including TeX's \\[3pt].
      i += 2;
      continue;
    }
    if (text[i] === '$') { i = skipDollarMath(text, i); continue; }
    i++;
  }
  return spans;
}

// Display conversion is applied only to a rendering copy. Inline spans remain
// available to the caller without changing their paragraph layout.
export function normalizeDisplayMath(text) {
  if (!text.includes('\\[')) return text;
  const spans = parseMathSpans(text).filter(span => span.type === 'display');
  if (!spans.length) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let result = '';
  let copied = 0;
  for (const span of spans) {
    const before = span.start > 0 && text[span.start - 1] !== '\n' ? newline : '';
    const after = span.end < text.length && text[span.end] !== '\r' && text[span.end] !== '\n' ? newline : '';
    result += text.slice(copied, span.start) + before + '$$' +
      (span.content.startsWith('\n') || span.content.startsWith('\r\n') ? '' : newline) + span.content +
      (span.content.endsWith('\n') ? '' : newline) + '$$' + after;
    copied = span.end;
  }
  return result + text.slice(copied);
}

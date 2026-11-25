const containerPrefix = /^(?:(?: {0,3}>[ \t]?)|(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+))*/;
const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Index backtick runs once so unmatched code delimiters cannot repeatedly scan
// the rest of a long streaming message. Backslashes are literal inside code.
function codeRuns(text) {
  const runs = [];
  const fences = [];
  for (const line of text.matchAll(/[^\n]+/g)) {
    if (openFence.test(line[0].replace(containerPrefix, '').replace(/\r$/, ''))) fences.push(line.index);
  }
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
  const raw = text.slice(index, lineEnd).replace(/\r$/, '');
  const prefix = raw.match(containerPrefix)[0];
  const line = raw.slice(prefix.length);
  const match = line.match(openFence);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1], quotes: (prefix.match(/>/g) ?? []).length, end: end < 0 ? text.length : end + 1 };
}

function skipFence(text, fence) {
  let index = fence.end;
  while (index < text.length) {
    const end = text.indexOf('\n', index);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(index, lineEnd).replace(/\r$/, '');
    const prefix = line.match(containerPrefix)[0];
    if ((prefix.match(/>/g) ?? []).length < fence.quotes) return index;
    const close = line.slice(prefix.length).match(/^ {0,3}(`+|~+)[ \t]*$/);
    index = end < 0 ? text.length : end + 1;
    if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) break;
  }
  return index;
}

function dollarMathEnd(text, start) {
  const size = text.startsWith('$$', start) ? 2 : 1;
  const first = start + size;
  if (size === 1 && (!text[first] || /\s/.test(text[first]))) return first;
  let i = first;
  while (i < text.length) {
    if (size === 1 && text[i] === '\n') break;
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$') {
      if (size === 2 && text[i + 1] === '$') return i + size;
      if (size === 1) {
        const canClose = i > first && !/\s/.test(text[i - 1]) && !/[\d$]/.test(text[i + 1] || '');
        const next = text[i + 1] || '';
        // A price followed by prose can precede a separate dollar formula.
        const crossesPrice = canClose && /[A-Za-z]/.test(next) && /^\d[\d.,]*[^\d.^_{}=<>|!+*/-]/.test(text.slice(first, i));
        if (crossesPrice) return first;
        return canClose ? i + size : first;
      }
    }
    i++;
  }
  // A bare currency symbol does not open math across the rest of the message.
  return size === 1 ? first : text.length;
}

function linkDestinationEnd(text, start) {
  let depth = 1;
  let i = start + 2;
  while (i < text.length && text[i] !== '\n' && depth) {
    const char = text[i++];
    if (char === '\\' && i < text.length && text[i] !== '\n') i++;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  return i;
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
    if (pending?.type === 'inline' && text[i] === '\n') pending = null;
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
    if ((i === 0 || text[i - 1] === '\n') && (text.startsWith('    ', i) || text[i] === '\t')) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('](', i)) { i = linkDestinationEnd(text, i); continue; }
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
    if (text[i] === '$') { i = dollarMathEnd(text, i); continue; }
    i++;
  }
  return spans;
}

function inlineForNative(text, span) {
  const content = span.content.trim();
  const previous = text[span.start - 1] || '';
  const next = text[span.end] || '';
  // Dollar-delimited native math recognizes bare variables and can sit next to
  // CJK text. Keep backslashes for complex TeX that its dollar rule rejects.
  const singleVariable = /^[A-Za-z]$/.test(content);
  const backslashBoundary = !previous || /[ \t\n([]/.test(previous);
  if (!backslashBoundary && !/[^\x00-\x7f]/.test(previous)) return null;
  if (next && !/[ \t\r\n.,;:!?\])\[*_~|`<\-\u0080-\uffff]/.test(next)) return null;
  if (backslashBoundary && /[\\^{}=<>|!+]|[A-Za-z]_\d/.test(content)) return null;
  const compatible = /^[A-Za-z\\]/.test(content) && /[\\^{}=<>|!+_()*/:,'-]/.test(content);
  if (!singleVariable && (!compatible || content.length > 60 || /[\r\n$`]|\\[([|.+*?0-9]|\\\\/.test(content))) return null;
  return `$${content}$`;
}

// Normalize explicit TeX delimiters in the rendering copy only.
export function normalizeMath(text, { inline = false } = {}) {
  const spans = parseMathSpans(text);
  if (!spans.length) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let result = '';
  let copied = 0;
  for (const span of spans) {
    if (span.type === 'inline') {
      const normalized = inline && inlineForNative(text, span);
      if (!normalized) continue;
      result += text.slice(copied, span.start) + normalized;
      copied = span.end;
      continue;
    }
    const before = span.start > 0 && text[span.start - 1] !== '\n' ? newline : '';
    const after = span.end < text.length && text[span.end] !== '\r' && text[span.end] !== '\n' ? newline : '';
    result += text.slice(copied, span.start) + before + '$$' +
      (span.content.startsWith('\n') || span.content.startsWith('\r\n') ? '' : newline) + span.content +
      (span.content.endsWith('\n') ? '' : newline) + '$$' + after;
    copied = span.end;
  }
  return result + text.slice(copied);
}

export const normalizeDisplayMath = text => normalizeMath(text);

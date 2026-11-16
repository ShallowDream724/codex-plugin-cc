import { normalizeDisplayMath } from './math-markdown.js';

const punctuation = /[\p{P}\p{S}]/u;
const letterOrNumber = /[\p{L}\p{N}]/u;
const prose = /\p{Script=Han}/u;
const terminal = /[。！？：；，、.!?:;,]/u;

// Only repair obvious prose pairs. A line containing nested or ambiguous stars
// is left to the host renderer, as are all incomplete streaming pairs.
function repairLine(line, mask) {
  const pairs = [];
  for (let i = 0; i < line.length;) {
    if (line[i] !== '*' || mask[i]) { i++; continue; }
    let end = i + 1;
    while (line[end] === '*' && !mask[end]) end++;
    if (end - i === 2) pairs.push(i);
    else pairs.push(-1);
    i = end;
  }
  if (pairs.includes(-1)) return line;
  const edits = [];
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const start = pairs[p], close = pairs[p + 1];
    const content = line.slice(start + 2, close);
    if (!content || !prose.test(content) || mask.slice(start, close + 2).some(Boolean)) continue;
    const before = line[start - 1] || '';
    const first = content[0];
    // CommonMark's opening delimiter must be left-flanking.
    if (/\s/u.test(first) || (punctuation.test(first) && before && !/\s/u.test(before) && !punctuation.test(before))) continue;
    const spaces = content.match(/[ \t]+$/u)?.[0] || '';
    const trimmed = spaces ? content.slice(0, -spaces.length) : content;
    const last = trimmed.at(-1) || '';
    if (!terminal.test(last)) continue;
    if (spaces) {
      edits.push({ start: close - spaces.length, end: close + 2, text: '**' + spaces });
    } else {
      const after = line[close + 2] || '';
      // A punctuation-ending delimiter followed by a letter cannot close in
      // CommonMark. Move existing punctuation outside; visible text is equal.
      if (letterOrNumber.test(after)) {
        const ending = trimmed.match(/[。！？：；，、.!?:;,]+$/u)?.[0];
        if (ending && trimmed.length > ending.length) {
          edits.push({ start: close - ending.length, end: close + 2, text: '**' + ending });
        }
      }
    }
  }
  if (!edits.length) return line;
  let out = '', copied = 0;
  for (const edit of edits) {
    out += line.slice(copied, edit.start) + edit.text;
    copied = edit.end;
  }
  return out + line.slice(copied);
}

// Scan independently by line while retaining block/math state. Protected spans
// are opaque to the repair and are copied verbatim.
function repairStrong(text) {
  if (!text.includes('**')) return text;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let fence = null, math = null, htmlBlock = false, codeSize = 0, linkDepth = 0;
  const output = [];
  for (const line of lines) {
    const body = line.replace(/\r?\n$/, '');
    // Strip container markers before recognizing fences and indented code.
    const container = body.replace(/^(?:(?: {0,3}>[ \t]?)|(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+))*/, '');
    const fenceMatch = container.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && /^[ \t]*$/.test(fenceMatch[2])) fence = null;
      output.push(line); continue;
    }
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = fenceMatch[1]; output.push(line); continue;
    }
    if (/^(?: {4}|\t)/.test(container)) { output.push(line); continue; }
    if (htmlBlock) {
      output.push(line);
      if (/^\s*$/.test(body)) htmlBlock = false;
      continue;
    }
    if (/^ {0,3}<(?:!--|\/?(?:address|article|aside|div|pre|script|style|table|section|details|blockquote)(?:\s|>|\/))/i.test(container)) {
      htmlBlock = true; output.push(line); continue;
    }
    // Inline HTML may alter how its contents are parsed by the host.
    if (/<(?:!--|\/?[A-Za-z][A-Za-z0-9-]*(?:\s|>|\/))/.test(body)) {
      output.push(line); continue;
    }
    const mask = new Uint8Array(body.length);
    const runs = new Map(), next = new Map();
    for (let i = 0; i < body.length;) {
      if (body[i] !== '`') { i++; continue; }
      const start = i;
      while (body[i] === '`') i++;
      runs.set(start, { end: i, size: i - start });
    }
    for (const [start, run] of [...runs].reverse()) {
      run.close = next.get(run.size);
      next.set(run.size, { start, end: run.end });
    }
    const protect = (start, end) => mask.fill(1, start, Math.min(end, body.length));
    let i = 0;
    while (i < body.length) {
      const start = i;
      if (codeSize) {
        while (i < body.length) {
          if (body[i] !== '`') { i++; continue; }
          const run = runs.get(i);
          i = run.end;
          if (run.size === codeSize) { codeSize = 0; break; }
        }
        protect(start, i); continue;
      }
      if (linkDepth) {
        while (i < body.length && linkDepth) {
          if (body[i] === '\\') { i += 2; continue; }
          if (body[i] === '(') linkDepth++;
          if (body[i] === ')') linkDepth--;
          i++;
        }
        protect(start, i); continue;
      }
      if (math) {
        while (i < body.length) {
          if (body[i] === '\\') {
            if (math[0] === '\\' && body.startsWith(math, i)) { i += 2; math = null; break; }
            i += 2; continue;
          }
          if (math[0] === '$' && body.startsWith(math, i)) { i += math.length; math = null; break; }
          i++;
        }
        protect(start, i); continue;
      }
      if (body[i] === '\\') {
        if (body[i + 1] === '[' || body[i + 1] === '(') {
          math = body[i + 1] === '[' ? '\\]' : '\\)';
        }
        i += 2; protect(start, i); continue;
      }
      if (body[i] === '$') {
        math = body[i + 1] === '$' ? '$$' : '$';
        i += math.length; protect(start, i); continue;
      }
      if (body[i] === '`') {
        const run = runs.get(i);
        if (!run.close) codeSize = run.size;
        i = run.close?.end ?? body.length;
        protect(start, i); continue;
      }
      if (body[i] === '<') {
        const end = body.indexOf('>', i + 1);
        i = end < 0 ? body.length : end + 1;
        protect(start, i); continue;
      }
      if (body[i] === ']' && body[i + 1] === '(') {
        i += 2;
        linkDepth = 1;
        while (i < body.length && linkDepth) {
          if (body[i] === '\\') { i += 2; continue; }
          if (body[i] === '(') linkDepth++;
          if (body[i] === ')') linkDepth--;
          i++;
        }
        protect(start, i); continue;
      }
      i++;
    }
    output.push(repairLine(body, mask) + line.slice(body.length));
  }
  return output.join('');
}

// This function is for a rendering copy only; persisted messages stay intact.
export function normalizeMessageMarkdown(text, { displayMath = false } = {}) {
  const repaired = repairStrong(text);
  return displayMath ? normalizeDisplayMath(repaired) : repaired;
}

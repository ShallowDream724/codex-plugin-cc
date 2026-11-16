const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

// Offsets refer to UTF-16 positions in the original source, including CRLF.
export function parseUnifiedDiffDetailed(source) {
  if (typeof source !== 'string' || !source) return null;
  const lines = [];
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf('\n', start), end = newline < 0 ? source.length : newline + 1;
    let text = source.slice(start, newline < 0 ? end : newline);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    lines.push({ text, start, end }); start = end;
  }
  let i = 0;
  if (lines[i]?.text.startsWith('diff --git ')) {
    i++;
    while (/^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )/.test(lines[i]?.text ?? '')) i++;
  }
  if (lines[i]?.text.startsWith('--- ')) {
    if (!lines[i + 1]?.text.startsWith('+++ ')) return null;
    i += 2;
  }
  const rows = []; let hunks = 0;
  const push = (row, line) => rows.push({ ...row, start: line.start, end: line.end });
  while (i < lines.length) {
    const header = HUNK.exec(lines[i].text);
    if (!header) return null;
    const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1), newStart = Number(header[3]), newCount = Number(header[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || (oldCount && !oldStart) || (newCount && !newStart)) return null;
    push({ kind: 'hunk', text: lines[i].text }, lines[i]); i++;
    let oldLine = oldStart, newLine = newStart, oldLeft = oldCount, newLeft = newCount, canMark = false;
    while (i < lines.length && !HUNK.test(lines[i].text)) {
      const entry = lines[i++], line = entry.text;
      if (line === '\\ No newline at end of file') {
        if (!canMark) return null;
        push({ kind: 'marker', text: line }, entry); canMark = false; continue;
      }
      const prefix = line[0];
      if (prefix !== ' ' && prefix !== '+' && prefix !== '-') return null;
      const row = { kind: prefix === '+' ? 'added' : prefix === '-' ? 'removed' : 'context', text: line };
      if (prefix !== '+') { if (oldLeft-- <= 0) return null; row.old = oldLine++; }
      if (prefix !== '-') { if (newLeft-- <= 0) return null; row.new = newLine++; }
      push(row, entry); canMark = true;
    }
    if (oldLeft || newLeft) return null;
    hunks++;
  }
  return hunks ? rows : null;
}

export function parseUnifiedDiff(source) {
  return parseUnifiedDiffDetailed(source)?.map(({ start, end, ...row }) => row) ?? null;
}

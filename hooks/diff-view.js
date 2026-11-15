const PAGE_SIZE = 120;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

// Parse only complete, single-file unified diffs. In particular, do not turn a
// truncated preview into a plausible-looking patch.
export function parseDiff(source) {
  if (typeof source !== 'string' || !source) return null;
  const lines = source.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.at(-1) === '') lines.pop();
  let i = 0;
  if (lines[i]?.startsWith('diff --git ')) {
    i++;
    while (/^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )/.test(lines[i] ?? '')) i++;
  }
  if (lines[i]?.startsWith('--- ')) {
    if (!lines[i + 1]?.startsWith('+++ ')) return null;
    i += 2;
  }
  const rows = [];
  let hunks = 0;
  while (i < lines.length) {
    const header = HUNK.exec(lines[i]);
    if (!header) return null;
    const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1);
    const newStart = Number(header[3]), newCount = Number(header[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || (oldCount && !oldStart) || (newCount && !newStart)) return null;
    rows.push({ kind: 'hunk', text: lines[i++] });
    let oldLine = oldStart, newLine = newStart, oldLeft = oldCount, newLeft = newCount, canMark = false;
    while (i < lines.length && !HUNK.test(lines[i])) {
      const line = lines[i++];
      if (line === '\\ No newline at end of file') {
        if (!canMark) return null;
        rows.push({ kind: 'marker', text: line }); canMark = false; continue;
      }
      const prefix = line[0];
      if (prefix !== ' ' && prefix !== '+' && prefix !== '-') return null;
      const row = { kind: prefix === '+' ? 'added' : prefix === '-' ? 'removed' : 'context', text: line };
      if (prefix !== '+') { if (oldLeft-- <= 0) return null; row.old = oldLine++; }
      if (prefix !== '-') { if (newLeft-- <= 0) return null; row.new = newLine++; }
      rows.push(row); canMark = true;
    }
    if (oldLeft || newLeft) return null;
    hunks++;
  }
  return hunks ? rows : null;
}

export function renderDiff({ Box, Text, Button }, { key, source, page = 0, onPage, onCopy, copyControl }) {
  const rows = parseDiff(source);
  if (!rows) return null;
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  const current = Number.isFinite(page) ? Math.max(0, Math.min(pages - 1, Math.trunc(page))) : 0;
  const lineWidth = rows.reduce((width, row) => Math.max(width, String(row.old ?? '').length, String(row.new ?? '').length), 2);
  const copy = copyControl ?? (onCopy ? Button({ key: `${key}:copy`, plain: true, label: '⧉', onPress: () => onCopy(source) }) : null);
  const children = [];
  const text = (value, props = {}) => Text({ mono: true, size: 'footnote', wrap: 'wrap', ...props, children: [value] });
  for (const [index, row] of rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).entries()) {
    const backgroundColor = row.kind === 'added' ? 'rgba(46,160,67,0.16)' : row.kind === 'removed' ? 'rgba(248,81,73,0.16)' : undefined;
    children.push(Box({ key: `${key}:row:${current * PAGE_SIZE + index}`, flexDirection: 'row', ...(copy && index === 0 ? { paddingRight: 3 } : {}), ...(backgroundColor ? { backgroundColor } : {}), children: [
      Box({ width: lineWidth + 1, flexShrink: 0, children: [text(row.old == null ? '' : String(row.old), { dimColor: true, tabular: true })] }),
      Box({ width: lineWidth + 1, flexShrink: 0, children: [text(row.new == null ? '' : String(row.new), { dimColor: true, tabular: true })] }),
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, children: [text(row.text, row.kind === 'hunk' || row.kind === 'marker' ? { dimColor: true } : {})] }),
    ] }));
  }
  if (pages > 1) {
    const navigation = [];
    if (current > 0) navigation.push(Button({ key: `${key}:previous`, label: '上一页', onPress: () => onPage?.(current - 1) }));
    navigation.push(Text({ dimColor: true, children: [`${current + 1} / ${pages}`] }));
    if (current + 1 < pages) navigation.push(Button({ key: `${key}:next`, label: '下一页', onPress: () => onPage?.(current + 1) }));
    children.push(Box({ key: `${key}:pages`, flexDirection: 'row', gap: 'sm', children: navigation }));
  }
  if (copy) children.push(Box({ key: `${key}:copy_position`, position: 'absolute', right: 0, top: 0, children: [copy] }));
  return Box({ key, position: 'relative', flexDirection: 'column', width: '100%', borderStyle: 'round', borderDimColor: true, children });
}

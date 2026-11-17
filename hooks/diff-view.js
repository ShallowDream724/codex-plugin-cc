import { parseUnifiedDiff, parseUnifiedDiffDetailed } from '../shared/unified-diff.mjs';
const PAGE_SIZE = 120;

export const parseDiff = parseUnifiedDiff;

export function renderDiff({ Box, Text, Button }, { key, source, rows: suppliedRows, page = 0, onPage, onCopy, copyControl, framed = true, lineWidth: suppliedWidth = 2 }) {
  const detailed = suppliedRows == null ? parseUnifiedDiffDetailed(source) : null;
  const parsed = suppliedRows ?? detailed;
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const rows = parsed.filter(row => row.kind !== 'hunk');
  // A valid empty diff still has a hunk, even though it has no visible rows.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Number.isFinite(page) ? Math.max(0, Math.min(pages - 1, Math.trunc(page))) : 0;
  const lineWidth = rows.reduce((width, row) => Math.max(width, String(row.old ?? '').length, String(row.new ?? '').length), suppliedWidth);
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  // Preserve exact raw patch bytes, including headers, delimiters and CRLF.
  // Server-supplied rows already correspond to the raw source page.
  const pageSource = pages > 1 && detailed
    ? source.slice(current === 0 ? 0 : visible[0].start, current + 1 < pages ? rows[(current + 1) * PAGE_SIZE].start : source.length)
    : pages > 1 ? visible.map(row => row.text).join('\n') + '\n' : source;
  const copy = (typeof copyControl === 'function' ? copyControl(pageSource, pages > 1) : copyControl) ?? (onCopy ? Button({ key: `${key}:copy`, plain: true, label: '⧉', onPress: () => onCopy(pageSource) }) : null);
  const children = [];
  const text = (value, props = {}) => Text({ mono: true, size: 'footnote', wrap: 'wrap', ...props, children: [String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�')] });
  for (const [index, row] of visible.entries()) {
    const backgroundColor = row.kind === 'added' ? 'rgba(46,160,67,0.16)' : row.kind === 'removed' ? 'rgba(248,81,73,0.16)' : undefined;
    const numberColor = row.kind === 'added' ? '#2ea043' : row.kind === 'removed' ? '#f85149' : undefined;
    children.push(Box({ key: `${key}:row:${current * PAGE_SIZE + index}`, flexDirection: 'row', alignItems: 'flex-start', ...(copy && index === 0 ? { paddingRight: 3 } : {}), ...(backgroundColor ? { backgroundColor } : {}), children: [
      Box({ width: lineWidth + 1, flexShrink: 0, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'flex-end', paddingRight: 1, children: [text((row.kind === 'removed' ? row.old : row.new) == null ? '' : String(row.kind === 'removed' ? row.old : row.new), { ...(numberColor ? { color: numberColor } : { dimColor: true }), tabular: true })] }),
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, children: [text(['added', 'removed', 'context'].includes(row.kind) && !row.continuation ? row.text.slice(1) : row.text, row.kind === 'marker' ? { dimColor: true } : {})] }),
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
  return Box({ key, position: 'relative', flexDirection: 'column', width: '100%', ...(framed ? { borderStyle: 'round', borderDimColor: true } : {}), children });
}

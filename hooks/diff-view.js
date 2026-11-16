import { parseUnifiedDiff } from '../shared/unified-diff.mjs';
const PAGE_SIZE = 120;

export const parseDiff = parseUnifiedDiff;

export function renderDiff({ Box, Text, Button }, { key, source, rows: suppliedRows, page = 0, onPage, onCopy, copyControl }) {
  const rows = suppliedRows ?? parseDiff(source);
  if (!Array.isArray(rows) || !rows.length) return null;
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  const current = Number.isFinite(page) ? Math.max(0, Math.min(pages - 1, Math.trunc(page))) : 0;
  const lineWidth = rows.reduce((width, row) => Math.max(width, String(row.old ?? '').length, String(row.new ?? '').length), 2);
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const pageSource = pages > 1 ? visible.map(row => row.text).join('\n') + '\n' : source;
  const copy = (typeof copyControl === 'function' ? copyControl(pageSource, pages > 1) : copyControl) ?? (onCopy ? Button({ key: `${key}:copy`, plain: true, label: '⧉', onPress: () => onCopy(pageSource) }) : null);
  const children = [];
  const text = (value, props = {}) => Text({ mono: true, size: 'footnote', wrap: 'wrap', ...props, children: [value] });
  for (const [index, row] of visible.entries()) {
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

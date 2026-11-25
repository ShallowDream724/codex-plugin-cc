import { appendRenderCost, renderCostFits } from './render-budget.js';

export const maxBandRows = 10_000;

// Spend the remainder on real, contiguous neighbours. They share the pane's
// ordinary text, wire, node and entry budgets with the in-flow reading window.
export function historyBand({ records, render, cost, limit, remaining, direction }) {
  const selected = [];
  for (const record of records) {
    const count = record.end - record.start;
    if (count > remaining) break;
    const group = { ...record, ...render(record) };
    const next = appendRenderCost(cost, group.cost, 6);
    if (!renderCostFits(next, limit)) break;
    selected.push(group);
    cost = next;
    remaining -= count;
  }
  return { groups: direction < 0 ? selected.reverse() : selected, cost, remaining };
}

export function historyCoreLimit(shell, limit) {
  const result = { ...limit };
  for (const key of ['chars', 'wireChars', 'nodes']) {
    result[key] = shell[key] + Math.floor((limit[key] - shell[key]) * 0.65);
  }
  return result;
}

export function bandSections(children, cost) {
  const sections = [];
  let section, chars = 0;
  for (const child of children) {
    const next = cost(child).wireChars;
    if (!section || sections.length < 12 && section.length && (chars + next > 8000 || section.length >= 12)) {
      section = []; sections.push(section); chars = 0;
    }
    section.push(child); chars += next;
  }
  return sections;
}

// Preserve native gaps and the fractional remainder of the bottom-aligned
// stack. Only off-screen sections are replaced by their measured dimensions.
export function cropBandSections({ sections, heights, naturalRows, height, visibleRows, alignStart, Box }) {
  if (!sections.length || sections.length !== heights?.length || heights.some(rows => !(rows > 0 && rows <= maxBandRows)) ||
      !(naturalRows > 0 && naturalRows <= maxBandRows)) return null;
  const total = heights.reduce((sum, rows) => sum + rows, 0);
  const gap = sections.length > 1 ? (naturalRows - total) / (sections.length - 1) : 0;
  if (Math.abs(total - naturalRows) > sections.length * 2 + 1) return null;
  let top = alignStart ? 0 : height - naturalRows;
  return sections.map((section, index) => {
    const rows = heights[index], bottom = top + rows;
    const visible = bottom >= -2 && top <= visibleRows + 2;
    top = bottom + gap;
    return visible ? Box({ height: rows, flexDirection: 'column', rowGap: 1, minWidth: 0, flexShrink: 0, children: section }) :
      Box({ height: rows, flexShrink: 0, children: [] });
  });
}

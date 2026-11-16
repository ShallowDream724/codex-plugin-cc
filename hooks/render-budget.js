// Account from constructor inputs: native nodes are deliberately opaque to us.
// The host shares its text allowance across the complete render tree.
export const RENDER_LIMIT = Object.freeze({ chars: 80000, nodes: 12000, depth: 28 });
export const CONTENT_LIMIT = Object.freeze({ chars: 58000, nodes: 8500, depth: 22 });

const strings = (value, seen = new Set()) => {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  return Object.values(value).reduce((sum, child) => sum + strings(child, seen), 0);
};
const fits = (cost, limit) => cost.chars <= limit.chars && cost.nodes <= limit.nodes && cost.depth <= limit.depth;
const add = (own, children) => ({ chars: own.chars + children.reduce((sum, c) => sum + c.chars, 0), nodes: 1 + children.reduce((sum, c) => sum + c.nodes, 0), depth: 1 + Math.max(0, ...children.map(c => c.depth)) });
const childrenOf = value => value == null ? [] : Array.isArray(value) ? value : [value];
function compactKey(key) {
  if (typeof key !== 'string' || key.length <= 4096) return key;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return `${key.slice(0, 128)}:${(hash >>> 0).toString(36)}:${key.length}`;
}
function fragments(source, width) {
  const result = [];
  for (let at = 0; at < source.length;) {
    let end = Math.min(source.length, at + Math.max(2, width));
    if (end < source.length) {
      const line = source.lastIndexOf('\n', end - 1) + 1;
      if (line > at + width * 0.75) end = line;
      if (end > at && /[\uD800-\uDBFF]/.test(source[end - 1]) && /[\uDC00-\uDFFF]/.test(source[end])) end--;
    }
    result.push(source.slice(at, end)); at = end;
  }
  return result;
}

export function nativeRenderBudget(constructors, { copy, copyLabel } = {}) {
  const records = new WeakMap();
  const cost = node => typeof node === 'string' ? { chars: node.length, nodes: 1, depth: 1 } : records.get(node)?.cost ?? { chars: 0, nodes: 0, depth: 0 };
  const build = (type, props) => {
    props = { ...props, ...(props.key !== undefined ? { key: compactKey(props.key) } : {}) };
    const node = constructors[type](props), { children: input, ...fields } = props, children = childrenOf(input);
    // Svg path data and image data are not part of the host's text allowance.
    const counted = type === 'Svg' || type === 'Image' ? { key: fields.key, alt: fields.alt } : type === 'Input' ? { ...fields, value: undefined } : fields;
    // Client payloads are serialized by the host, including JSON punctuation and
    // property names; count those as well as ordinary native text properties.
    const own = { chars: type === 'Client' ? strings({ ...counted, props: undefined }) + JSON.stringify(fields.props ?? null).length : strings(counted) };
    if (node && typeof node === 'object') records.set(node, { type, props: { ...props, ...(input !== undefined ? { children } : {}) }, own, hasCopy: /(?:^|_)diff_copy_/.test(props.key ?? '') || children.some(child => records.get(child)?.hasCopy), cost: add(own, children.map(cost)) });
    return node;
  };
  const ui = Object.fromEntries(Object.entries(constructors).map(([type, constructor]) => [type, typeof constructor === 'function' ? props => build(type, props) : constructor]));
  // Split only the displayed representation. Callbacks (including copy) retain
  // their original complete sources and no entry/detail cache is changed.
  const pages = (node, limit = CONTENT_LIMIT, inheritedCopy = false) => {
    if (fits(cost(node), limit)) return [node];
    if (typeof node === 'string') {
      return fragments(node, limit.chars);
    }
    const record = records.get(node);
    if (!record) return [node];
    const { type, props, own } = record;
    const hasCopy = inheritedCopy || record.hasCopy;
    const field = type === 'Markdown' ? 'text' : type === 'Code' ? 'source' : Object.keys(props).find(key => key !== 'key' && typeof props[key] === 'string' && props[key].length > limit.chars / 2);
    if (field && typeof props[field] === 'string') {
      const source = props[field];
      const sourcePage = fragment => build('Box', { key: props.key, flexDirection: 'column', children: [
        ...(!hasCopy && typeof copy === 'function' ? [build('Button', { key: `${props.key ?? 'content'}:copy`, plain: true, label: copyLabel?.(props.key ?? 'content') || '复制完整内容', onPress: () => copy(source, props.key ?? 'content') })] : []),
        build('Text', { key: `${props.key ?? 'content'}:source`, mono: true, size: 'caption', children: [fragment] }),
      ] });
      const sourceType = type === 'Markdown' || type === 'Code';
      const overhead = sourceType ? cost(sourcePage('')).chars : own.chars - source.length;
      const width = Math.max(2, limit.chars - overhead);
      return fragments(source, width).map(fragment => {
        // A fragment can end inside Markdown math/fences or a unified hunk.
        // Present paged source honestly instead of misrendering partial markup.
        // Text has no native fragment-copy action or misleading source line
        // numbers. Its single explicit copy action retains the whole source.
        return sourceType ? sourcePage(fragment) : build(type, { ...props, [field]: fragment });
      });
    }
    const inner = { chars: Math.max(1, limit.chars - own.chars), nodes: Math.max(1, limit.nodes - 1), depth: Math.max(1, limit.depth - 1) };
    const children = (props.children ?? []).flatMap(child => pages(child, inner, hasCopy));
    const result = []; let batch = [], batchCost = add(own, []);
    for (const child of children) {
      const childCost = cost(child);
      const append = () => ({ chars: batchCost.chars + childCost.chars, nodes: batchCost.nodes + childCost.nodes, depth: Math.max(batchCost.depth, childCost.depth + 1) });
      if (batch.length && !fits(append(), limit)) { result.push(build(type, { ...props, children: batch })); batch = []; batchCost = add(own, []); }
      batchCost = append(); batch.push(child);
    }
    if (batch.length) result.push(build(type, { ...props, children: batch }));
    return result.length ? result : [node];
  };
  return { ui, cost, fits: (node, limit = RENDER_LIMIT) => fits(cost(node), limit), pages };
}

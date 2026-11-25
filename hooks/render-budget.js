// Claude Desktop rejects the entire tree at 2,000 nodes or depth 32. The
// host also caps displayed text and input values separately at 100,000 chars.
// Leave room for host furnishings and small changes outside the timeline.
export const RENDER_LIMIT = Object.freeze({ chars: 80000, wireChars: 246000, nodes: 1800, depth: 28 });
export const CONTENT_LIMIT = Object.freeze({ chars: 58000, wireChars: 100000, nodes: 1250, depth: 22 });
export const GROUP_RENDER_LIMIT = Object.freeze({ chars: 32000, wireChars: 68000, nodes: 740, depth: 22 });
export const INPUT_RENDER_LIMIT = 100000;

const strings = (value, seen = new Set()) => {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  return Object.values(value).reduce((sum, child) => sum + strings(child, seen), 0);
};
const emptyCost = Object.freeze({ chars: 0, wireChars: 0, nodes: 0, depth: 0 });
export const renderCostFits = (cost, limit = RENDER_LIMIT) => cost.chars <= limit.chars && (cost.wireChars ?? cost.chars) <= (limit.wireChars ?? Infinity) && cost.nodes <= limit.nodes && cost.depth <= limit.depth;
export const appendRenderCost = (own, child, depthOffset = 1) => ({
  chars: own.chars + child.chars,
  wireChars: (own.wireChars ?? own.chars) + (child.wireChars ?? child.chars),
  nodes: own.nodes + child.nodes,
  depth: Math.max(own.depth, child.depth + depthOffset),
});
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

export function nativeRenderBudget(constructors, { copy, copyLabel, copyLabelWidth = 0 } = {}) {
  const records = new WeakMap();
  const cost = node => typeof node === 'string' ? { chars: node.length, wireChars: node.length, nodes: 1, depth: 1 } : records.get(node)?.cost ?? emptyCost;
  const build = (type, props, construct = constructors[type]) => {
    props = { ...props, ...(props.key !== undefined ? { key: compactKey(props.key) } : {}) };
    const node = construct(props), { children: input, ...fields } = props, children = childrenOf(input);
    // SVG source and the independently capped Input.value contribute to the
    // Desktop tree budget. Image bytes are carried separately.
    const counted = type === 'Svg' || type === 'Image' ? { key: fields.key, alt: fields.alt } : type === 'Input' ? { ...fields, value: undefined } : fields;
    // Client payloads are serialized by the host, including JSON punctuation and
    // property names; count those as well as ordinary native text properties.
    const chars = type === 'Client' ? strings({ ...counted, props: undefined }) + JSON.stringify(fields.props ?? null).length : strings(counted);
    // Desktop includes options and pressable links as additional nodes, plus
    // plugin names and style property names in its character accounting.
    const styleNames = ['Box', 'Text', 'div', 'span', 'b'].includes(type) ? Object.keys(fields).reduce((sum, key) => sum + key.length, 0) : 0;
    const hoverNames = fields.hover ? Object.keys(fields.hover).reduce((sum, key) => sum + key.length, 0) : 0;
    const pluginNameLength = ['Button', 'Input', 'Select', 'Markdown', 'Client'].includes(type) ? 'codex-subagents'.length : 0;
    const extraWireChars = type === 'Svg' ? fields.source?.length ?? 0 : type === 'Input' ? Math.min(fields.value?.length ?? 0, INPUT_RENDER_LIMIT) : 0;
    const own = { chars, wireChars: chars + styleNames + hoverNames + pluginNameLength + extraWireChars, nodes: 1 + (type === 'Select' ? fields.options?.length ?? 0 : type === 'Markdown' ? fields.pressableLinks?.length ?? 0 : 0), depth: 1 };
    if (node && typeof node === 'object') records.set(node, { type, props: { ...props, ...(input !== undefined ? { children } : {}) }, own, hasCopy: /(?:^|_)diff_copy_/.test(props.key ?? '') || children.some(child => records.get(child)?.hasCopy), cost: children.reduce((sum, child) => appendRenderCost(sum, cost(child)), { ...own }) });
    return node;
  };
  const ui = Object.fromEntries(Object.entries(constructors).map(([type, constructor]) => [type, typeof constructor === 'function' ? props => build(type, props) : constructor]));
  const reserveChars = (node, additional, wireAdditional = additional) => {
    const record = records.get(node);
    if (record) {
      record.own.chars += additional;
      record.cost.chars += additional;
      record.own.wireChars += wireAdditional;
      record.cost.wireChars += wireAdditional;
    }
    return node;
  };
  // Split only the displayed representation. Callbacks (including copy) retain
  // their original complete sources and no entry/detail cache is changed.
  const pages = (node, limit = CONTENT_LIMIT, inheritedCopy = false) => {
    if (renderCostFits(cost(node), limit)) return [node];
    if (typeof node === 'string') {
      return fragments(node, Math.min(limit.chars, limit.wireChars ?? Infinity));
    }
    const record = records.get(node);
    if (!record) return [node];
    const { type, props, own } = record;
    const hasCopy = inheritedCopy || record.hasCopy;
    const field = type === 'Markdown' ? 'text' : type === 'Code' ? 'source' : Object.keys(props).find(key => key !== 'key' && typeof props[key] === 'string' && props[key].length > limit.chars / 2);
    if (field && typeof props[field] === 'string') {
      const source = props[field];
      const copyKey = props.key ?? 'content';
      const copyLabelText = copyLabel?.(copyKey) || '复制完整内容';
      const sourcePage = fragment => build('Box', { key: props.key, flexDirection: 'column', children: [
        ...(!hasCopy && typeof copy === 'function' ? [reserveChars(build('Button', { key: `${copyKey}:copy`, plain: true, label: copyLabelText, onPress: () => copy(source, copyKey) }), Math.max(0, copyLabelWidth - copyLabelText.length))] : []),
        build('Text', { key: `${props.key ?? 'content'}:source`, mono: true, size: 'caption', children: [fragment] }),
      ] });
      const sourceType = type === 'Markdown' || type === 'Code';
      const empty = sourceType ? cost(sourcePage('')) : { chars: own.chars - source.length, wireChars: own.wireChars - source.length };
      const width = Math.max(2, Math.min(limit.chars - empty.chars, (limit.wireChars ?? Infinity) - empty.wireChars));
      return fragments(source, width).map(fragment => {
        // A fragment can end inside Markdown math/fences or a unified hunk.
        // Present paged source honestly instead of misrendering partial markup.
        // Text has no native fragment-copy action or misleading source line
        // numbers. Its single explicit copy action retains the whole source.
        return sourceType ? sourcePage(fragment) : build(type, { ...props, [field]: fragment });
      });
    }
    const inner = { chars: Math.max(1, limit.chars - own.chars), wireChars: Math.max(1, (limit.wireChars ?? Infinity) - own.wireChars), nodes: Math.max(1, limit.nodes - own.nodes), depth: Math.max(1, limit.depth - 1) };
    const children = (props.children ?? []).flatMap(child => pages(child, inner, hasCopy));
    const result = []; let batch = [], batchCost = own;
    for (const child of children) {
      const childCost = cost(child);
      if (batch.length && !renderCostFits(appendRenderCost(batchCost, childCost), limit)) { result.push(build(type, { ...props, children: batch })); batch = []; batchCost = own; }
      batchCost = appendRenderCost(batchCost, childCost); batch.push(child);
    }
    if (batch.length) result.push(build(type, { ...props, children: batch }));
    return result.length ? result : [node];
  };
  return { ui, cost, fits: (node, limit = RENDER_LIMIT) => renderCostFits(cost(node), limit), pages, reserveChars,
    // A retained native Button still counts against this frame's budget.
    buttonWith: (props, construct) => build('Button', props, construct) };
}

import { requestBridge as bridge } from './bridge.js';

const PANE = 'codex_subagent_activity';
const MAX_PAGES = 50;
const safe = (value) => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
const label = (agent) => safe(agent.name || agent.agent_id || agent.id || 'Codex').replace(/\s+/g, ' ').slice(0, 32);
const idOf = (agent) => agent.agent_id || agent.id;
const summaries = (agents) => agents.map((agent) => ({ agent_id: idOf(agent), name: agent.name, status: agent.status }));
const entryKey = (entry) => `${entry.turn_id || ''}:${entry.id}`;
const groupable = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
const description = (entry) => {
  const d = entry.data || {};
  if (entry.type === 'parentMessage') return 'Claude';
  if (entry.type === 'userMessage') return 'Claude';
  if (entry.type === 'agentMessage') return 'Codex';
  if (entry.type === 'commandExecution') return `Command: ${d.command || ''}`;
  if (entry.type === 'mcpToolCall' || entry.type === 'dynamicToolCall') return `Tool: ${d.server ? d.server + '/' : ''}${d.tool || ''}`;
  if (entry.type === 'fileChange') return 'File changes';
  if (entry.type === 'collabAgentToolCall' || entry.type === 'collabToolCall') return `Delegation: ${[d.name, ...(d.names || [])].filter(Boolean).join(', ') || d.tool || 'agent'}`;
  if (entry.type === 'imageView' || entry.type === 'imageGeneration') return `Image: ${d.path || d.savedPath || ''}`;
  return String(entry.type || 'Activity');
};
const body = (entry) => {
  const d = entry.data || {};
  if (typeof entry.preview === 'string') return entry.preview;
  if (typeof d.text === 'string') return d.text;
  if (entry.type === 'userMessage' && Array.isArray(d.content)) return d.content.map((part) => part.text || '').filter(Boolean).join('\n\n');
  return JSON.stringify(d, null, 2);
};

// Groups preserve the original items and only join adjacent calls in one turn.
export function groupEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (groupable.has(entry.type) && last && last.type === entry.type && last.turn_id === entry.turn_id) last.items.push(entry);
    else groups.push({ type: entry.type, turn_id: entry.turn_id, items: [entry] });
  }
  return groups;
}

// The caller feeds its existing low-frequency observe result to observeUI.
// There are no session hooks, model calls, or delivery acknowledgements here.
const state = { agents: [], selected: null, opened: false, timer: null, pages: new Map(), folds: new Set(), scroll: new Map(), restore: false, generation: 0 };
  const pageFor = (id) => {
    if (!state.pages.has(id)) state.pages.set(id, { mode: 'live', entries: [], live: [], revision: undefined, cursor: null, cursorStack: [], stackTruncated: false, loaded: false, busy: false, historyGeneration: 0, detailGeneration: 0, detail: null });
    const page = state.pages.get(id); state.pages.delete(id); state.pages.set(id, page);
    while (state.pages.size > 16) {
      const old = state.pages.keys().next().value; state.pages.delete(old); state.scroll.delete(old);
      for (const key of state.folds) if (key.startsWith(`${old}:`)) state.folds.delete(key);
    }
    return page;
  };
  const toggle = (key) => { if (!state.folds.delete(key)) { state.folds.add(key); if (state.folds.size > 512) state.folds.delete(state.folds.values().next().value); } };
  const reading = (id, page) => page.live.some((entry) => {
    const key = `${id}:${entryKey(entry)}`;
    return state.folds.has(key) || state.folds.has(`${key}:group`);
  });
  function invalidate($) { $.ui.invalidate('ui.render'); }
  async function poll($) {
    const id = state.selected, gen = state.generation;
    if (!state.opened || !id) return;
    const page = pageFor(id);
    if (page.busy || page.mode !== 'live' || reading(id, page)) return;
    page.busy = true;
    try {
      const result = await bridge($, 'ui_revision', { target: id, revision: page.revision });
      if (!state.opened || state.selected !== id || state.generation !== gen || page.mode !== 'live' || reading(id, page) || result.error || result.offline) return;
      if (result.entries) {
        page.revision = result.revision; page.live = result.entries;
        invalidate($);
      }
    } finally { page.busy = false; }
  }
  async function history($, id, direction = 'latest') {
    const page = pageFor(id), gen = state.generation, request = ++page.historyGeneration;
    if (page.mode === 'live') { page.mode = 'history'; page.entries = []; page.cursor = null; page.cursorStack = []; page.stackTruncated = false; page.loaded = false; invalidate($); }
    let stack = direction === 'older' ? [...page.cursorStack, page.cursor] : direction === 'newer' ? page.cursorStack.slice(0, -1) : [];
    let truncated = direction === 'latest' ? false : page.stackTruncated;
    if (direction === 'older' && !page.cursor) return;
    if (stack.length > MAX_PAGES) { stack = stack.slice(-MAX_PAGES); truncated = true; }
    const cursor = stack.at(-1);
    try {
      const result = await bridge($, 'ui_history', { target: id, ...(cursor ? { cursor } : {}) });
      if (!state.opened || state.selected !== id || state.generation !== gen || request !== page.historyGeneration) return;
      if (result.error || result.offline) throw new Error(result.error?.message || 'History unavailable');
      page.mode = 'history'; page.entries = result.entries || []; page.cursorStack = stack; page.stackTruncated = truncated; page.detail = null;
      page.cursor = result.next_cursor; page.loaded = true; page.error = null; invalidate($);
    } catch (error) { if (state.opened && state.selected === id && state.generation === gen && request === page.historyGeneration) { page.error = String(error.message || error); invalidate($); } }
  }
  async function select($, id) {
    state.selected = id; state.generation++; state.restore = true;
    const page = pageFor(id);
    if (page.mode === 'live') void poll($).catch(() => {});
    else if (!page.loaded) void history($, id);
    invalidate($);
  }
  export async function openAgent($, id) {
    state.opened = true; const gen = ++state.generation;
    try {
      const list = await bridge($, 'ui_list', {});
      if (!state.opened || state.generation !== gen) return;
      if (Array.isArray(list.agents)) state.agents = summaries(list.agents);
    } catch { /* The selected agent's history can still be opened. */ }
    if (!state.opened || state.generation !== gen) return;
    await select($, id);
    const selectedGen = state.generation;
    const result = await $.ui.open({ id: PANE, title: 'Codex agents', focus: true, closeOnEscape: true, rows: 24 });
    if (!state.opened || state.generation !== selectedGen) return;
    if (result.isPlaced === false) { state.opened = false; state.generation++; return; }
    if (!state.timer) state.timer = $.clock.every(1000, () => { void poll($).catch(() => {}); });
  }
  async function detail($, id, entry, offset = 0) {
    const page = pageFor(id), key = entryKey(entry), gen = state.generation, historyGen = page.historyGeneration, request = ++page.detailGeneration;
    const result = await bridge($, 'ui_detail', { target: id, turn_id: entry.turn_id, item_id: entry.id, offset });
    if (state.selected !== id || !state.opened || state.generation !== gen || page.historyGeneration !== historyGen || request !== page.detailGeneration || !state.folds.has(`${id}:${key}`)) return;
    if (result.error || result.offline) page.detail = { key, text: result.error?.message || 'Detail unavailable', next_offset: null, offset };
    else page.detail = { key, text: result.text || '', next_offset: result.next_offset, offset };
    invalidate($);
  }
export function registerUI(on) {
  on('command.run', { command: 'codex-agents' }, async ($) => {
    try {
      const result = await bridge($, 'ui_list', {});
      if (result.error || result.offline) { $.ui.toast('Codex agents are unavailable.'); return {}; }
      const agents = Array.isArray(result.agents) ? result.agents : [];
      if (!agents.length) { $.ui.toast('No Codex agents in this session.'); return {}; }
      state.agents = summaries(agents);
      const selected = agents.find((agent) => idOf(agent) === state.selected)
        || [...agents].reverse().find((agent) => ['running', 'waiting', 'starting', 'compacting'].includes(agent.status))
        || agents.at(-1);
      await openAgent($, idOf(selected));
    } catch { $.ui.toast('Codex agents are unavailable.'); }
    return {};
  });
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { state.opened = false; state.generation++; state.timer?.cancel(); state.timer = null; }
    return next(e);
  });
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person' && state.selected) state.scroll.set(state.selected, e.offset);
    if (e.origin.kind === 'plugin' && state.restore) { state.restore = false; return next({ ...e, offset: state.scroll.get(state.selected) || 0 }); }
    return next(e);
  });
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e), id = state.selected, page = pageFor(id);
    const all = page.mode === 'history' ? page.entries : page.live;
    // The action gives immediate feedback while native history catches up. Once
    // the same message is persisted, retain the native copy for pagination.
    const nativeMessages = all.filter((entry) => entry.type === 'userMessage').map(body);
    const entries = all.filter((entry) => entry.type !== 'parentMessage' || !nativeMessages.some((text) => entry.data?.text && text.includes(entry.data.text)));
    const rows = [];
    const selected = state.agents.find((a) => idOf(a) === id);
    rows.push(Text({ children: [safe(selected?.name || id || 'Codex')] }));
    if (page.mode === 'live') rows.push(Button({ key: 'codex_history', label: 'Browse history', onPress: () => history($, id) }));
    else {
      rows.push(Button({ key: 'codex_live', label: 'Live activity', onPress: () => { page.mode = 'live'; page.historyGeneration++; page.detail = null; void poll($).catch(() => {}); invalidate($); } }));
      if (page.cursor) rows.push(Button({ key: 'codex_older', label: 'Earlier activity', onPress: () => history($, id, 'older') }));
      if (page.cursorStack.length > (page.stackTruncated ? 1 : 0)) rows.push(Button({ key: 'codex_newer', label: 'Newer activity', onPress: () => history($, id, 'newer') }));
      if (page.cursorStack.length) rows.push(Button({ key: 'codex_latest', label: 'Latest history', onPress: () => history($, id) }));
    }
    if (page.error) rows.push(Text({ children: [page.error] }));
    for (const group of groupEntries(entries)) {
      const first = group.items[0], groupKey = `${id}:${entryKey(first)}:group`, folded = !state.folds.has(groupKey);
      if (group.items.length > 1) {
        rows.push(Button({ key: `group_${groupKey}`, label: `${safe(description(first)).slice(0, 120)} (${group.items.length}) ${folded ? '▸' : '▾'}`, onPress: () => { toggle(groupKey); invalidate($); } }));
        if (folded) continue;
      }
      for (const entry of group.items) {
        if (['collabAgentToolCall', 'collabToolCall'].includes(entry.type)) { rows.push(Text({ children: [safe(description(entry))] })); continue; }
        const key = `${id}:${entryKey(entry)}`, expanded = state.folds.has(key);
        rows.push(Button({ key: `item_${key}`, label: `${safe(description(entry)).slice(0, 120)} ${expanded ? '▾' : '▸'}`, onPress: () => { toggle(key); if (expanded) page.detailGeneration++; invalidate($); } }));
        if (expanded) {
          const loaded = page.detail?.key === entryKey(entry) ? page.detail : null;
          rows.push(Text({ children: [safe(loaded?.text ?? body(entry))] }));
          const imagePath = entry.data?.path || entry.data?.savedPath || entry.data?.saved_path;
          if (['imageView', 'imageGeneration'].includes(entry.type) && typeof imagePath === 'string' && /^(?:[a-z]:[\\/]|\/)/i.test(imagePath)) {
            rows.push(Button({ key: `copy_${key}`, label: 'Copy image path', onPress: press => $.ui.copy({ text: imagePath, surface: press.surface }) }));
          }
          if (loaded?.offset > 0) rows.push(Button({ key: `detail_prev_${key}`, label: 'Previous output page', onPress: () => detail($, id, entry, Math.max(0, loaded.offset - 16000)) }));
          if (entry.type !== 'parentMessage' && (!loaded || loaded.next_offset != null)) rows.push(Button({ key: `detail_${key}`, label: loaded ? 'Next output page' : 'Load full item', onPress: () => detail($, id, entry, loaded?.next_offset ?? 0) }));
        }
      }
    }
    if (state.restore) void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {});
    return Box({ flexDirection: 'column', children: [Box({ flexDirection: 'row', flexWrap: 'wrap', children: state.agents.map((agent) => Button({ key: `codex_select_${idOf(agent)}`, label: label(agent), onPress: () => select($, idOf(agent)) })) }), ...rows] });
  });
}
export function closeUI() { state.opened = false; state.generation++; state.timer?.cancel(); state.timer = null; state.pages.clear(); state.folds.clear(); state.scroll.clear(); state.agents = []; state.selected = null; }
export function observeUI($, result) {
    if (!Array.isArray(result?.agents)) return;
    const before = JSON.stringify(state.agents.map(({ agent_id, name }) => ({ agent_id, name })));
    state.agents = summaries(result.agents);
    const ids = new Set(state.agents.map(idOf));
    for (const id of state.pages.keys()) if (!ids.has(id)) {
      state.pages.delete(id); state.scroll.delete(id);
      for (const key of state.folds) if (key.startsWith(`${id}:`)) state.folds.delete(key);
    }
    if (state.opened && before !== JSON.stringify(state.agents.map(({ agent_id, name }) => ({ agent_id, name })))) invalidate($);
}

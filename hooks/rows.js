import { EVENT_PREFIX } from './delivery.js';
import { openAgent } from './ui.js';

const PREFIX = 'mcp__codex-subagents__';
const EVENTS = { completed: 'completed', failed: 'failed', interrupted: 'stopped', unknown: 'needs attention', question: 'has a question', approval: 'needs approval', message: 'sent a message', compacting: 'is compacting' };
const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const short = (value, max = 32) => { const chars = [...safe(value)]; return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join(''); };

export function parseDisplayResult(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    if (value.length > 524288) return null;
    try { return parseDisplayResult(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    const text = value.filter(part => part?.type === 'text').map(part => part.text || '').join('');
    return text ? parseDisplayResult(text, depth + 1) : null;
  }
  if (typeof value !== 'object') return null;
  if (value.result !== undefined && typeof value.result !== 'boolean') return parseDisplayResult(value.result, depth + 1) ?? value;
  if (Array.isArray(value.content)) return parseDisplayResult(value.content, depth + 1) ?? value;
  return value;
}

export function describeCall(tool, input = {}, output, isRunning = false) {
  if (!tool?.startsWith(PREFIX)) return null;
  const operation = tool.slice(PREFIX.length), value = parseDisplayResult(output);
  if (output !== undefined && value === null) return null;
  if (value?.error) return [{ kind: 'error', text: value.error.message || 'Codex request failed', id: value.error.agent_id }];
  if (operation === 'wait_agent') {
    if (Array.isArray(value?.events) && value.events.length) return value.events.map(event => ({ id: event.agent_id, name: event.name, kind: event.kind, text: EVENTS[event.kind] || 'updated' }));
    return [{ text: isRunning ? 'Waiting for Codex' : value?.idle ? 'Codex is idle' : value?.timed_out ? 'Wait finished; agents continue' : value?.cancelled ? 'Wait cancelled; agents continue' : 'Waiting for Codex delivery' }];
  }
  if (operation === 'spawn_agent' || operation === 'followup_task') return [{ id: value?.agent_id, name: value?.name || input?.name, text: isRunning ? 'starting' : operation === 'spawn_agent' ? 'started work' : 'received the task' }];
  if (operation === 'list_agents' && Array.isArray(value?.agents)) return value.agents.map(agent => ({ id: agent.agent_id || agent.id, name: agent.name, text: agent.status || 'saved' }));
  if (operation === 'close_agent') return [{ text: isRunning ? 'Closing selected agents' : value?.closed_count !== undefined ? `Closed ${value.closed_count} agents${value.skipped?.length ? `; ${value.skipped.length} kept` : ''}` : 'Agent closed; history retained' }];
  if (operation === 'list_models' && Array.isArray(value?.models)) return value.models.map(model => ({ text: `${model.name || model.id} · ${(model.efforts || []).join(', ')}` }));
  const action = { send_message: 'message accepted', answer_agent: 'answer accepted', interrupt_agent: 'stop requested' }[operation];
  return action ? [{ id: value?.agent_id, name: null, text: isRunning ? 'working' : action }] : null;
}

function draw($, e, entries) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const groups = [];
  for (const entry of entries) {
    const prior = groups.at(-1);
    if (prior && prior.text === entry.text && prior.kind === entry.kind && entry.id) prior.entries.push(entry);
    else groups.push({ text: entry.text, kind: entry.kind, entries: [entry] });
  }
  return Box({ flexDirection: 'column', children: groups.map((group, index) => {
    const buttons = group.entries.filter(entry => entry.id).map((entry, position) => Button({
      key: `${e.requestId || 'codex'}:${index}:${position}:${entry.id}`,
      label: `${short(entry.name || 'Codex', 28)} · ${String(entry.id).slice(0, 6)}`,
      plain: true,
      onPress: () => openAgent($, entry.id),
    }));
    if (!buttons.length) return Text({ children: [`${group.kind === 'error' ? 'Codex: ' : ''}${short(group.text, 600)}`] });
    return Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: [...buttons, Text({ children: [short(group.text, 600)] })] });
  }) });
}

// These hooks replace drawings only. They never edit tool results or messages.
export function registerRows(on) {
  const displayed = new Map();
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool?.startsWith(PREFIX)) {
      const id = e.props.tool_use_id || e.requestId;
      displayed.delete(id);
      displayed.set(id, { expanded: e.props.isExpanded, hasResult: e.props.output !== undefined });
      if (displayed.size > 256) displayed.delete(displayed.keys().next().value);
    }
    if (e.props.isExpanded || e.props.isErrored || e.props.isInterrupted) return next(e);
    const entries = describeCall(e.props.tool, e.props.input, e.props.output, e.props.isRunning);
    return entries ? draw($, e, entries) : next(e);
  });
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const entries = describeCall(e.props.tool, {}, e.props.output);
    if (!entries || e.props.isErrored || e.props.isInterrupted) return next(e);
    const prior = displayed.get(e.props.tool_use_id || e.requestId);
    if (prior?.expanded) return next(e);
    // Expanded native transcripts keep the original result; the compact view
    // draws it once rather than repeating the JSON below the tool row.
    return prior?.hasResult ? $.ui.resolve(e).Box({ children: [] }) : draw($, e, entries);
  });
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const calls = e.props.calls || [];
    if (e.props.isExpanded || !calls.length || calls.some(call => !call.tool?.startsWith(PREFIX) || call.isErrored || call.isInterrupted)) return next(e);
    const entries = calls.flatMap(call => describeCall(call.tool, call.input, call.output, call.isRunning) || []);
    return entries.length ? draw($, e, entries) : next(e);
  });
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.props.isExpanded || e.props.origin?.kind !== 'plugin' || e.props.origin?.name !== 'codex-subagents' || !e.props.text?.startsWith(EVENT_PREFIX)) return next(e);
    const value = parseDisplayResult(e.props.text.slice(EVENT_PREFIX.length));
    if (!Array.isArray(value?.events)) return next(e);
    return draw($, e, value.events.map(event => ({ id: event.agent_id, name: event.name, kind: event.kind, text: EVENTS[event.kind] || 'updated' })));
  });
}

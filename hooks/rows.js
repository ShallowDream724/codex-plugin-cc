import { messageDeliveries } from './delivery.js';
import { openAgent } from './ui.js';
import { agentIcon, agentVisual, agentDisplayName } from './presentation.js';

const PREFIX = 'mcp__codex-subagents__';
const EVENTS = { completed: '已完成', failed: '失败', interrupted: '本轮已停止', unknown: '需要关注', question: '有问题', approval: '需要批准', message: '发送了消息', compacting: '正在压缩上下文' };
function eventText(event) {
  if (event.origin === 'user' && event.action === 'interrupt') return ({ requested: '你已请求停止', stopping: '正在停止', confirmed: '已按你的要求停止', unconfirmed: '停止状态未确认' })[event.phase] || '停止状态已更新';
  if (event.origin === 'user' && event.action === 'send') return event.phase === 'delivered' ? '已收到你的消息' : '消息发送状态未确认';
  return EVENTS[event.kind] || '已更新';
}
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
  if (value?.error) {
    const error = value.error;
    const message = ['helper_restart_required', 'bridge_version_mismatch'].includes(error.code)
      ? '插件已更新，重启 Claude 后继续原对话'
      : typeof error === 'string' ? error : error.message || error.code;
    return [{ kind: 'error', text: `Codex 请求失败${message ? `：${message}` : ''}`, id: error.agent_id }];
  }
  if (operation === 'wait_agent') {
    if (Array.isArray(value?.events) && value.events.length) return value.events.map(event => ({ id: event.agent_id, name: event.name, kind: event.kind, text: eventText(event) }));
    return [{ text: isRunning ? '正在等待 Codex' : value?.parent_idle && value?.active ? '有代理继续工作' : value?.idle ? 'Codex 空闲' : value?.timed_out ? '等待结束，代理继续工作' : value?.cancelled ? '已取消等待，代理继续工作' : '等待 Codex 更新' }];
  }
  if (operation === 'spawn_agent' || operation === 'followup_task') return [{ id: value?.agent_id, name: value?.name || input?.name, text: isRunning ? '正在启动' : operation === 'spawn_agent' ? '开始工作' : '已收到任务' }];
  if (operation === 'list_agents' && Array.isArray(value?.agents)) return value.agents.map(agent => ({ id: agent.agent_id || agent.id, name: agent.name, text: ({ running: '工作中', starting: '正在启动', waiting: '等待中', completed: '已完成', interrupted: '本轮已停止', failed: '失败', unknown: '状态未知', compacting: '正在压缩上下文' })[agent.status] || '已保存' }));
  if (operation === 'close_agent') return [{ text: isRunning ? '正在关闭代理' : value?.closed_count !== undefined ? `已关闭 ${value.closed_count} 个代理${value.skipped?.length ? `，保留 ${value.skipped.length} 个` : ''}` : '代理已关闭，历史已保留' }];
  if (operation === 'list_models' && Array.isArray(value?.models)) return [{ text: `${value.models.length} 个 Codex 模型可用` }];
  const action = { send_message: '已收到消息', answer_agent: '已收到答复', interrupt_agent: '已请求停止' }[operation];
  return action ? [{ id: value?.agent_id, name: null, text: isRunning ? '处理中' : action }] : null;
}

function draw($, e, entries) {
  const { Box, Text, Button, Svg } = $.ui.resolve(e);
  const icon = id => {
    const visual = agentVisual(id);
    return e.surface === 'desktop' && typeof Svg === 'function' ? Svg({ key: `icon_${id}`, source: visual.source, alt: visual.alt, width: 16, height: 16 }) : Text({ key: `icon_${id}`, size: 'footnote', children: [agentIcon(id)] });
  };
  const groups = [];
  for (const entry of entries) {
    const prior = groups.at(-1);
    if (prior && prior.text === entry.text && prior.kind === entry.kind && entry.id) prior.entries.push(entry);
    else groups.push({ text: entry.text, kind: entry.kind, entries: [entry] });
  }
  return Box({ key: `codex_rows_${e.requestId || 'events'}`, flexDirection: 'column', gap: 'xs', children: groups.map((group, index) => {
    const buttons = group.entries.filter(entry => entry.id).flatMap((entry, position) => [...(position ? [Text({ key: `join_${entry.id}`, size: 'footnote', dimColor: true, children: ['和'] })] : []), icon(entry.id), Button({
      key: `${e.requestId || 'codex'}:${index}:${position}:${entry.id}`,
      label: safe(agentDisplayName(entry.name || entry.id || 'Codex')),
      plain: true,
      children: [Text({ size: 'footnote', weight: 'medium', children: [safe(agentDisplayName(entry.name || entry.id || 'Codex'))] })],
      onPress: () => openAgent($, entry.id),
    })]);
    if (!buttons.length) return Text({ key: `codex_row_${index}`, size: 'footnote', dimColor: group.kind !== 'error', children: [short(group.text, 600)] });
    return Box({ key: `codex_row_${index}`, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 'xs', children: [...buttons, Text({ key: `codex_row_status_${index}`, size: 'footnote', dimColor: true, children: [short(group.text, 600)] })] });
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
    if (e.props.isExpanded || e.props.origin?.kind !== 'plugin' || e.props.origin?.name !== 'codex-subagents') return next(e);
    const [value] = messageDeliveries({ content: e.props.text }, { prompt: true });
    if (!Array.isArray(value?.events)) return next(e);
    return draw($, e, value.events.map(event => ({ id: event.agent_id, name: event.name, kind: event.kind, text: eventText(event) })));
  });
}

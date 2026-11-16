// Keep protocol data separate from its shortened, human-readable preview.
import { toolOutputText } from '../shared/tool-output.mjs';
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
const outputText = toolOutputText;
const completedStates = new Set(['completed', 'complete', 'success', 'succeeded']);
const failureStates = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'interrupted', 'timeout', 'timed_out']);

export function communicationFailure(entry) {
  const data = entry.data || {};
  const error = data.error;
  if (error != null && error !== '' && error !== false) return typeof error === 'object' && typeof error.message === 'string' ? error.message : text(error);
  const status = [data.status, data.stage].find(value => typeof value === 'string' && failureStates.has(value.trim().toLowerCase()));
  if (status) return status;
  return data.success === false ? '工具报告失败' : '';
}

function statusText(data) {
  const seen = new Set(), parts = [];
  for (const value of [data.status, data.stage]) {
    if (value == null || value === '') continue;
    const label = String(value), normalized = label.trim().toLowerCase();
    if (completedStates.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized); parts.push(label);
  }
  if (data.exitCode != null) parts.push(`退出码 ${data.exitCode}`);
  if (data.durationMs != null) parts.push(`${data.durationMs} ms`);
  return parts.join(' · ');
}

export function toolSections(entry) {
  const data = entry.data || {}, sections = [];
  const add = (label, value) => { if (value != null && value !== '') sections.push({ label, source: text(value) }); };
  let consumed;
  if (entry.type === 'commandExecution') {
    consumed = ['command', 'cwd', 'aggregatedOutput', 'exitCode'];
    add('命令', data.command);
    add('目录', data.cwd);
    add('输出', data.aggregatedOutput);
  } else if (['mcpToolCall', 'dynamicToolCall'].includes(entry.type) || (entry.communication && ['collabAgentToolCall', 'collabToolCall'].includes(entry.type))) {
    consumed = ['arguments', 'result', 'contentItems', 'server', 'tool'];
    let args = data.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Preserve an opaque input as supplied. */ } }
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const rest = { ...args };
      for (const name of ['command', 'cmd']) if (typeof rest[name] === 'string') { add('命令', rest[name]); delete rest[name]; }
      for (const name of ['file_path', 'path', 'cwd', 'directory']) if (typeof rest[name] === 'string') { add(name === 'cwd' || name === 'directory' ? '目录' : '路径', rest[name]); delete rest[name]; }
      if (Object.keys(rest).length) add('参数', rest);
    } else add('参数', args);
    if (data.result != null) add('输出', outputText(data.result));
    if (data.contentItems != null) add('输出', outputText(data.contentItems));
  } else if (entry.type === 'functionCallOutput') { consumed = ['output']; add('输出', outputText(data.output)); }
  add('错误', data.error);
  if (consumed) {
    const status = statusText(data);
    if (status) sections.push({ label: '状态', source: status, compact: true });
    const metadata = Object.fromEntries(Object.entries(data).filter(([key, value]) =>
      !['id', 'type', 'display_title', 'error', 'status', 'stage', 'exitCode', 'durationMs', 'startedAtMs', 'completedAtMs', 'namespace', ...consumed].includes(key)
      && !(key === 'success' && value === true)));
    if (Object.keys(metadata).length) sections.push({ label: '详情', source: text(metadata), collapsible: true });
  }
  return sections;
}

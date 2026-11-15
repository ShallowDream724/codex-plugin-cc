// Keep protocol data separate from its shortened, human-readable preview.
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
const outputText = (value) => {
  const content = Array.isArray(value) ? value : value?.content ?? value?.contentItems;
  if (!Array.isArray(content)) return text(value);
  const parts = content.map((part) => typeof part?.text === 'string' ? part.text : text(part));
  if (!Array.isArray(value)) {
    const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !['content', 'contentItems'].includes(key)));
    if (Object.keys(extra).length) parts.push(text(extra));
  }
  return parts.join('\n');
};

export function toolSections(entry) {
  const data = entry.data || {}, sections = [];
  const add = (label, value) => { if (value != null && value !== '') sections.push({ label, source: text(value) }); };
  let consumed;
  if (entry.type === 'commandExecution') {
    consumed = ['command', 'cwd', 'aggregatedOutput', 'exitCode'];
    add('命令', data.command);
    add('目录', data.cwd);
    add('输出', data.aggregatedOutput);
  } else if (['mcpToolCall', 'dynamicToolCall'].includes(entry.type)) {
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
    const status = [data.status, data.stage, data.exitCode != null ? `退出码 ${data.exitCode}` : null, data.durationMs != null ? `${data.durationMs} ms` : null].filter((value) => value != null && value !== '').join(' · ');
    if (status) sections.push({ label: '状态', source: status, compact: true });
    const metadata = Object.fromEntries(Object.entries(data).filter(([key]) => !['id', 'type', 'display_title', 'error', 'status', 'stage', 'exitCode', 'durationMs', ...consumed].includes(key)));
    if (Object.keys(metadata).length) sections.push({ label: '详情', source: text(metadata), collapsible: true });
  }
  return sections;
}

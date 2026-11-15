const drawings = {
  integration: ['集成', '⋮⋮', '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><circle cx="17" cy="17" r="3"/><path d="m14.9 9.1-5.8 5.8"/>'],
  edit: ['编辑文件', '✎', '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>'],
  terminal: ['命令', '›_', '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>'],
  search: ['搜索', '⌕', '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'],
  computer: ['电脑操作', '▱', '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 21h6m-3-4v4"/>'],
  image: ['图片', '▧', '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>'],
  compact: ['整理上下文', '≋', '<path d="M6 3H4v18h2m12-18h2v18h-2M9 7h6M8 12h8m-7 5h6"/>'],
  plan: ['计划', '☷', '<path d="m3 6 1 1 2-2m3 1h12M3 12h3m3 0h12M3 18h3m3 0h12"/>'],
  activity: ['活动', '·', '<circle cx="12" cy="12" r="3"/>'],
};

function svg(contents) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${contents}</svg>`;
}

export function activityIcon(entry = {}, integration = false) {
  const type = entry.type, data = entry.data || {};
  const tool = [data.server, data.namespace, data.tool, data.name].filter(value => typeof value === 'string').join(' ').toLowerCase();
  let kind = 'activity';
  if (integration) kind = 'integration';
  else if (type === 'fileChange' || type === 'applyPatch') kind = 'edit';
  else if (/computer|cua_repl|computer_use|browser__|browser_use/.test(tool)) kind = 'computer';
  else if (type === 'commandExecution') kind = 'terminal';
  else if (type === 'webSearch') kind = 'search';
  else if (['imageView', 'imageGeneration'].includes(type)) kind = 'image';
  else if (type === 'contextCompaction') kind = 'compact';
  else if (type === 'plan') kind = 'plan';
  else if (['mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(type)) kind = 'integration';
  const [alt, glyph, contents] = drawings[kind];
  return { kind, alt, glyph, source: svg(contents) };
}

export function contextIndicator(used, limit) {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return null;
  const percent = Math.round(used / limit * 100), fill = Math.min(100, percent);
  const alt = `上下文已用 ${percent}%（${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} tokens）`;
  return { alt, glyph: `◔ ${percent}%`, source: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><title>${alt}</title><circle cx="10" cy="10" r="7" fill="none" stroke="#888888" stroke-opacity=".25" stroke-width="2"/><circle cx="10" cy="10" r="7" fill="none" stroke="#888888" stroke-width="2" pathLength="100" stroke-dasharray="${fill} 100" transform="rotate(-90 10 10)"/></svg>` };
}

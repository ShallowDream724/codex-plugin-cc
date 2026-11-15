const drawings = {
  integration: ['集成', '⋮⋮', '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><circle cx="17" cy="17" r="3"/><path d="m14.9 9.1-5.8 5.8"/>'],
  edit: ['编辑文件', '✎', '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>'],
  terminal: ['命令', '›_', '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>'],
  search: ['搜索', '⌕', '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'],
  computer: ['电脑操作', '▱', '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 21h6m-3-4v4"/>'],
  image: ['图片', '▧', '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>'],
  compact: ['压缩上下文', '≋', '<path d="M7 3H5v6l-2 3 2 3v6h2m10-18h2v6l2 3-2 3v6h-2M9 8h6m-6 4h4m-4 4h6"/>'],
  plan: ['计划', '☷', '<path d="m3 6 1 1 2-2m3 1h12M3 12h3m3 0h12M3 18h3m3 0h12"/>'],
  activity: ['活动', '·', '<circle cx="12" cy="12" r="3"/>'],
  wait: ['等待', '⋯', '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'],
};

function svg(contents) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${contents}</svg>`;
}

export function activityIcon(entry = {}, integration = false) {
  const type = entry.type, data = entry.data || {};
  const tool = [data.server, data.namespace, data.tool, data.name].filter(value => typeof value === 'string').join(' ').toLowerCase();
  let kind = 'activity';
  if (integration) kind = 'integration';
  else if (['collabAgentToolCall', 'collabToolCall'].includes(type) && data.tool === 'wait') kind = 'wait';
  else if (type === 'fileChange' || type === 'applyPatch') kind = 'edit';
  else if (/computer|cua_repl|computer_use|browser__|browser_use/.test(tool)) kind = 'computer';
  else if (type === 'commandExecution') kind = 'terminal';
  else if (type === 'webSearch') kind = 'search';
  else if (['imageView', 'imageGeneration'].includes(type)) kind = 'image';
  else if (type === 'contextCompaction') kind = 'compact';
  else if (type === 'plan') kind = 'plan';
  else if (['mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(type)) kind = 'integration';
  const [alt, glyph, contents] = drawings[kind];
  const animated = kind === 'compact' && data.stage === 'started';
  return { kind, alt, glyph, ...(animated ? { animated: true } : {}), source: svg(animated ? `<g>${contents}<animate attributeName="opacity" values="1;.4;1" dur="2s" repeatCount="indefinite"/></g>` : contents) };
}

export function contextIndicator(used, limit) {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return null;
  const percent = Math.round(used / limit * 100), fill = Math.min(100, percent);
  const alt = `上下文已用 ${percent}%（${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} tokens）`;
  return { alt, glyph: `◔ ${percent}%`, source: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><title>${alt}</title><circle cx="10" cy="10" r="7" fill="none" stroke="#888888" stroke-opacity=".25" stroke-width="2"/><circle cx="10" cy="10" r="7" fill="none" stroke="#888888" stroke-width="2" pathLength="100" stroke-dasharray="${fill} 100" transform="rotate(-90 10 10)"/></svg>` };
}

export function disclosureIcon(expanded) {
  return svg(`<path d="${expanded ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'}"/>`);
}

export const copyIcon = svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>');
export const jumpIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#ffffff" stroke="#dddddd"/><path d="M16 9v14m-5-5 5 5 5-5" fill="none" stroke="#333333" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

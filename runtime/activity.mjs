// Read-only presentation of the controller's own root threads. The controller's
// delivery queue is deliberately independent of this bounded live cache.
import { toolOutputText } from '../shared/tool-output.mjs';
import { collectImages, sanitizeMedia } from '../shared/tool-media.mjs';
import { materializeImage, pngDimensions } from './tool-media-files.mjs';
import { RolloutMedia } from './rollout-media.mjs';
import { orderWaits } from '../shared/activity-order.mjs';
import { communication, safeBoundary } from '../shared/communication.mjs';
import { fileChanges, fileChangeSummary, fileChangePage } from '../shared/file-changes.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rename, unlink, rmdir, access, open, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runFile = promisify(execFile);
const previewScript = fileURLToPath(new URL('../scripts/image-preview.ps1', import.meta.url));
const inlineScript = fileURLToPath(new URL('../scripts/image-inline.ps1', import.meta.url));
const LIVE_LIMIT = 64;
const AGENT_LIMIT = 32;
const PREVIEW_BUDGET = 8192;
const BINARY = /^(?:base64|imageData|image_data|b64_json)$/i;
// This is a presentation projection only: it never changes the model's input or
// native history. Account for keys, values, depth and element count together.
function clean(value, limit = PREVIEW_BUDGET) {
  let remaining = limit, nodes = 0;
  function visit(v, depth, key = '') {
    if (++nodes > 256 || remaining <= 0) return '[truncated]';
    if (BINARY.test(key) && typeof v === 'string') return '[binary omitted]';
    if (typeof v === 'string') {
      if (/^data:[^,]*;base64,/i.test(v)) return '[binary omitted]';
      const n = Math.min(v.length, remaining); remaining -= n;
      return v.slice(0, n) + (n < v.length ? '…' : '');
    }
    if (!v || typeof v !== 'object') { remaining -= 8; return v; }
    if (depth >= 6) return '[nested data omitted]';
    if (/^(?:image|blob|audio)$/i.test(v.type ?? '')) return { type: v.type, ...(v.media_omitted === true ? { media_omitted: true } : {}), ...(typeof v.mimeType === 'string' ? { mimeType: visit(v.mimeType, depth + 1) } : {}), path: typeof v.path === 'string' ? visit(v.path, depth + 1) : undefined, ...(typeof v.name === 'string' ? { name: visit(v.name, depth + 1) } : {}) };
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => visit(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      remaining -= k.length; if (remaining <= 0) break;
      out[k] = visit(x, depth + 1, k);
    }
    return out;
  }
  return visit(value, 0);
}
const imageFields = (item) => Object.fromEntries(['id', 'type', 'status', 'generationId', 'generation_id', 'savedPath', 'saved_path', 'path', 'failure', 'contentType', 'mimeType'].filter((key) => item[key] != null).map((key) => [key, item[key]]));
const delegationFields = (item) => {
  const ids = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])].slice(0, 20);
  const agents = ids.map(id => ({ id, name: item.displayAgentNames?.[id] ?? item.agentsStates?.[id]?.name ?? item.agentsStates?.[id]?.nickname, status: item.agentsStates?.[id]?.status }));
  return { id: item.id, type: item.type, tool: item.tool, status: item.status, receiverThreadIds: ids, agents, names: agents.map(a => a.name ?? a.id), name: item.name ?? item.agentName };
};
const subagentFields = (item) => ({ id: item.id, type: item.type, kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath, name: item.name, display_name: item.display_name, model: item.model, reasoningEffort: item.reasoningEffort });
const fileSummary = (item) => fileChanges(item).map(fileChangeSummary);
// A preview shares one budget across all fields and files, so its length or a
// trailing ellipsis cannot reliably establish whether a particular diff fits.
// Keep this flag outside that budget and compare the fields used by file detail.
function filePreviewComplete(item, data) {
  const original = fileChanges(item), preview = fileChanges(data);
  if (original.length !== preview.length) return false;
  const kind = change => typeof change.kind === 'string' ? change.kind : change.kind?.type ?? change.type;
  const move = change => change.kind?.move_path ?? change.move_path;
  return original.every((change, index) => {
    const shown = preview[index];
    return change.path === shown.path && kind(change) === kind(shown) && move(change) === move(shown)
      && ['diff', 'unified_diff', 'content'].every(key => change[key] === shown[key]);
  });
}
const titleText = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 256) : '';
function toolFields(item) {
  const server = typeof item.server === 'string' ? item.server : item.namespace;
  const isCuaJs = (['cua_repl', 'mcp__cua_repl'].includes(server) && item.tool === 'js') || item.tool === 'mcp__cua_repl__js';
  const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? item.arguments : null;
  const title = titleText(item.display_title) || (isCuaJs ? titleText(args?.title) : '') || titleText(item.appContext?.actionName);
  // Put the title first so a large code argument or output cannot consume the
  // preview budget before the presentation metadata is projected.
  return { ...(title ? { display_title: title } : {}), ...item, ...(title ? { display_title: title } : {}) };
}
const project = (item) => item.type === 'imageGeneration' || item.type === 'imageView' ? imageFields(item) : ['collabAgentToolCall', 'collabToolCall'].includes(item.type) ? delegationFields(item) : item.type === 'subAgentActivity' ? subagentFields(item) : item.type === 'fileChange' ? { fileSummary: fileSummary(item), ...item } : item.type === 'directUserMessage' ? { id: item.id, type: item.type, attachments: item.attachments, text: item.text } : ['mcpToolCall', 'dynamicToolCall'].includes(item.type) ? toolFields(item) : item;
const binaryString = (value) => typeof value === 'string' && /^data:[^,]*;base64,/i.test(value);
const textValue = (value) => {
  if (binaryString(value)) return '[binary omitted]';
  if (typeof value === 'string') return value;
  return JSON.stringify(sanitizeMedia(value), (key, v) => BINARY.test(key) && typeof v === 'string' || binaryString(v) ? '[binary omitted]' : v && typeof v === 'object' && /^(?:image|blob|audio)$/i.test(v.type ?? '') ? { type: v.type, path: v.path } : v, 2) ?? '';
};
const outputValue = (value) => toolOutputText(value, { serialize: textValue, formatPart: (part) => ['text', 'inputText', 'outputText', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string' ? textValue(part.text) : '[non-text content omitted]' });
const OUTPUT_TYPES = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput']);
export function formatItemOutput(item) {
  let output;
  switch (item.type) {
    case 'commandExecution': output = item.aggregatedOutput == null ? '' : textValue(item.aggregatedOutput); break;
    case 'mcpToolCall': case 'dynamicToolCall': output = [item.result, item.contentItems].filter(value => value != null).map(outputValue).filter(Boolean).join('\n'); break;
    case 'functionCallOutput': output = item.output == null ? '' : outputValue(item.output); break;
    default: return formatItem(item);
  }
  return [output, item.error != null && textValue(item.error)].filter(Boolean).join('\n');
}
export function formatItem(item) {
  const d = project(item);
  switch (d.type) {
    case 'parentMessage': case 'directUserMessage': case 'agentMessage': return d.text ?? '';
    case 'userMessage': return (d.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n\n');
    case 'commandExecution': return [`Command: ${d.command ?? ''}`, d.cwd && `Directory: ${d.cwd}`, d.exitCode != null && `Exit code: ${d.exitCode}`, d.status && `Status: ${d.status}`, d.aggregatedOutput != null && `Output:\n${d.aggregatedOutput}`].filter(Boolean).join('\n');
    case 'fileChange': return fileChanges(d).map((change) => `${change.path ?? 'File'}${change.kind ? ` (${typeof change.kind === 'string' ? change.kind : change.kind.type ?? 'change'})` : ''}\n${change.diff ?? change.unified_diff ?? change.content ?? ''}`).join('\n\n');
    case 'mcpToolCall': case 'dynamicToolCall': return [`Tool: ${d.server ? d.server + '/' : ''}${d.tool ?? ''}`, d.arguments != null && `Input:\n${textValue(d.arguments)}`, d.result != null && `Output:\n${outputValue(d.result)}`, d.contentItems != null && `Output:\n${outputValue(d.contentItems)}`, d.error != null && `Error:\n${textValue(d.error)}`].filter(Boolean).join('\n');
    case 'imageGeneration': case 'imageView': return [`Image: ${d.savedPath ?? d.saved_path ?? d.path ?? ''}`, d.status && `Status: ${d.status}`, d.failure && `Error: ${textValue(d.failure)}`].filter(Boolean).join('\n');
    case 'collabAgentToolCall': case 'collabToolCall': return `Delegation: ${[d.name, ...(d.names ?? [])].filter(Boolean).join(', ') || d.tool || 'agent'}`;
    case 'subAgentActivity': return `Subagent: ${d.name || d.agentPath || d.agentThreadId || 'agent'} (${d.kind || 'activity'})`;
    case 'plan': return d.text ?? '';
    case 'contextCompaction': return 'Context compaction';
    case 'functionCallOutput': return outputValue(d.output);
    default: return textValue(d);
  }
}
const visible = (item) => item && item.type !== 'reasoning';
const simplify = (item, turnId, deferred = false, stage, startedAtMs, threadId) => {
  const message = communication(item, threadId);
  let projected = project(item);
  if (message) {
    // Preserve delivery failures even when a large input would exhaust the
    // shared preview budget. Limit each field before projecting other data.
    const { status, success, error, ...rest } = projected;
    const errorValue = error && typeof error === 'object' && !Array.isArray(error) && typeof error.message === 'string'
      ? { message: error.message, ...error } : error;
    projected = { ...(status !== undefined ? { status: clean(status, 128) } : {}),
      ...(success !== undefined ? { success: clean(success, 128) } : {}),
      ...(error !== undefined ? { error: clean(errorValue, 512) } : {}), ...rest };
  }
  const { images, omitted } = collectImages(item);
  const data = clean(sanitizeMedia({ ...(stage ? { stage } : {}), ...projected }), PREVIEW_BUDGET / 2);
  const end = message ? Math.min(message.text.length, 2048) : 0;
  const safeEnd = message && end < message.text.length && safeBoundary(message.text, end) !== end ? end - 1 : end;
  const communicationPreview = message && { title: message.title, text: message.text.slice(0, safeEnd), truncated: safeEnd < message.text.length };
  const phase = ['final_answer', 'commentary', 'partial_answer'].includes(item.phase) ? item.phase : null;
  const messageMeta = item.type === 'agentMessage' ? { phase, complete: stage === 'completed', truncated: typeof item.text === 'string' && data.text !== item.text, is_final: phase === 'final_answer' && stage === 'completed' } : null;
  return { ...(images.length || omitted ? { media: { count: images.length, has_images: images.length > 0, ...(omitted ? { omitted: true } : {}) } } : {}), ...(communicationPreview ? { communication: communicationPreview } : {}), ...(messageMeta ? { message: messageMeta } : {}), ...(item.type === 'fileChange' ? { file_preview: { complete: filePreviewComplete(item, data) } } : {}), id: String(item.id ?? ''), turn_id: turnId, type: item.type ?? 'unknown', data, preview: formatItem(data).slice(0, PREVIEW_BUDGET / 2), deferred, ...(Number.isFinite(startedAtMs) ? { started_at_ms: startedAtMs } : {}) };
};
function removeGuidance(item, guidance) {
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return item;
  const directPrefix = '[Direct message from the user]\n\n';
  if (item.content[0]?.text?.startsWith(directPrefix)) {
    let text = item.content.map((part, index) => typeof part.text === 'string' ? index === 0 ? part.text.slice(directPrefix.length) : part.text : '').filter(Boolean).join('\n\n');
    let attachments = item.content.filter(part => part.type === 'localImage' && typeof part.path === 'string').map(part => ({ type: 'image', path: part.path, name: part.path.split(/[\\/]/).at(-1) }));
    const marker = '\n\nAttached local files: ', at = text.lastIndexOf(marker);
    if (at >= 0 && text.endsWith('.')) {
      try {
        const saved = JSON.parse(text.slice(at + marker.length, -1));
        if (Array.isArray(saved) && saved.every(a => a && typeof a.name === 'string' && typeof a.path === 'string' && ['file', 'image'].includes(a.type))) { attachments = saved; text = text.slice(0, at); }
      } catch { /* Ordinary user text remains visible. */ }
    }
    return { ...item, type: 'directUserMessage', text, ...(attachments.length ? { attachments } : {}) };
  }
  const legacyCollaboration = 'Claude is your parent agent. When important design questions, disagreements or better approaches arise, discuss them before substantial implementation, briefly giving evidence, a recommendation and tradeoffs. Use request_user_input when an answer is needed before continuing; use notify_parent for consequential coordination, not routine progress. Your own subagents remain available.';
  const parentPrefixes = [guidance?.collaboration?.trim(), legacyCollaboration, 'Claude is your parent agent.'].filter(Boolean);
  const prefixes = [...parentPrefixes, guidance?.default?.instructions?.trim()].filter(Boolean);
  const parent = item.content.some(part => typeof part.text === 'string' && parentPrefixes.some(prefix => part.text.startsWith(prefix + '\n\n')));
  return { ...item, ...(parent ? { message_origin: 'parent' } : {}), content: item.content.map((part) => {
    if (typeof part.text !== 'string') return part;
    let text = part.text;
    for (const prefix of prefixes) if (text.startsWith(prefix + '\n\n')) text = text.slice(prefix.length + 2);
    return { ...part, text };
  }) };
}

export class ActivityStore {
  static attach(client, controller) { return new ActivityStore({ client, controller }); }
  constructor({ client, controller, cacheLimits = { bytes: 256 * 1024 * 1024, files: 512 } }) {
    this.client = client; this.controller = controller; this.live = new Map(); this.nextRevision = 1;
    this.agentNames = new Map(); this.turnStates = new Map();
    this.rolloutMedia = new RolloutMedia(client);
    this.exportDir = null; this.exports = new Map(); this.exportSizes = new Map(); this.exportBytes = 0; this.cacheLimits = cacheLimits; this.exportQueue = Promise.resolve(); this.closed = false;
    this.notification = (message) => this.observe(message);
    this.action = (action) => this.recordAction(action);
    client.on('notification', this.notification);
    controller.on('agentAction', this.action);
  }
  close() {
    this.client.off('notification', this.notification);
    this.controller.off('agentAction', this.action);
    this.live.clear();
    this.agentNames.clear(); this.turnStates.clear();
    this.closed = true;
    // Serialize cleanup behind in-flight writes; close remains safe for callers
    // that do not await it, and only files created by this store are removed.
    const cleanup = this.exportQueue.then(async () => {
      for (const file of this.exports.values()) { try { await unlink(file); } catch { /* Best effort for files currently in use. */ } }
      if (this.exportDir) { try { await rmdir(this.exportDir); } catch { /* Never remove unknown files. */ } }
      this.exports.clear(); this.exportSizes.clear(); this.exportBytes = 0; this.exportDir = null;
    });
    this.exportQueue = cleanup.catch(() => {});
    return cleanup;
  }
  ensureExportCapacity(key, size) {
    if (!this.exports.has(key) && (this.exports.size >= this.cacheLimits.files || this.exportBytes + size > this.cacheLimits.bytes)) {
      const error = new Error('Display cache capacity reached for this session.');
      error.code = 'DISPLAY_CACHE_FULL'; throw error;
    }
  }
  registerExport(key, path, size) {
    if (!this.exports.has(key)) { this.exportSizes.set(key, size); this.exportBytes += size; }
    this.exports.set(key, path);
  }
  exportCommunication(text) {
    // A single queue prevents capacity checks, recreation and close from racing with
    // each other, including simultaneous requests for the same content.
    const operation = this.exportQueue.then(async () => {
      if (this.closed) throw new Error('Activity store is closed.');
      if (!this.exportDir) this.exportDir = await mkdtemp(join(tmpdir(), 'codex-subagents-display-'));
      if (this.closed) throw new Error('Activity store is closed.');
      const hash = createHash('sha256').update(text).digest('hex');
      const filePath = join(this.exportDir, `${hash}.md`);
      const size = Buffer.byteLength(text);
      let exists = false;
      if (this.exports.has(hash)) {
        try { await access(filePath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!exists) {
        this.ensureExportCapacity(hash, size);
        const temporary = join(this.exportDir, `${randomUUID()}.tmp`);
        try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, filePath); }
        finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        this.registerExport(hash, filePath, size);
      }
      if (this.closed) throw new Error('Activity store is closed.');
      return { file_path: filePath, file_url: pathToFileURL(filePath).href };
    });
    this.exportQueue = operation.catch(() => {});
    return operation;
  }
  exportImage(buffer, mime) {
    const operation = this.exportQueue.then(async () => {
      if (this.closed) throw new Error('Activity store is closed.');
      if (!this.exportDir) this.exportDir = await mkdtemp(join(tmpdir(), 'codex-subagents-display-'));
      const hash = `image:${createHash('sha256').update(buffer).digest('hex')}:${mime}`;
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp' }[mime];
      const filePath = join(this.exportDir, `${hash.split(':')[1]}.${extension}`);
      let exists = false;
      if (this.exports.has(hash)) { try { await access(filePath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (!exists) {
        this.ensureExportCapacity(hash, buffer.length);
        const temporary = join(this.exportDir, `${randomUUID()}.tmp`);
        try { await writeFile(temporary, buffer, { flag: 'wx' }); await rename(temporary, filePath); }
        finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        this.registerExport(hash, filePath, buffer.length);
      }
      if (this.closed) throw new Error('Activity store is closed.');
      return filePath;
    });
    this.exportQueue = operation.catch(() => {});
    return operation;
  }
  exportPreview(sourcePath) {
    if (process.platform !== 'win32') return Promise.resolve(null);
    // The same queue serializes conversion, capacity accounting, and close. Snapshot
    // at most 10 MiB so a changing source cannot bypass the byte limit.
    const operation = this.exportQueue.then(async () => {
      if (this.closed) throw new Error('Activity store is closed.');
      const handle = await open(sourcePath, 'r');
      let bytes;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) throw new Error('Image exceeds the preview size limit.');
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new Error('Image changed during preview.'); offset += result.bytesRead; }
      } finally { await handle.close(); }
      if (!this.exportDir) this.exportDir = await mkdtemp(join(tmpdir(), 'codex-subagents-display-'));
      const digest = createHash('sha256').update(bytes).digest('hex');
      const key = `preview:${digest}`, path = join(this.exportDir, `preview-${digest}.png`);
      let exists = false;
      if (this.exports.has(key)) { try { await access(path); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (!exists) {
        const input = join(this.exportDir, `${randomUUID()}.source`), temporary = join(this.exportDir, `${randomUUID()}.png`);
        try {
          await writeFile(input, bytes, { flag: 'wx' });
          await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', previewScript], {
            windowsHide: true, timeout: 15000, maxBuffer: 16384,
            env: { ...process.env, CODEX_SUBAGENTS_IMAGE_SOURCE: input, CODEX_SUBAGENTS_IMAGE_PREVIEW: temporary },
          });
          const size = (await stat(temporary)).size;
          this.ensureExportCapacity(key, size);
          await rename(temporary, path);
          this.registerExport(key, path, size);
        } finally {
          const cleanup = await Promise.allSettled([input, temporary].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
          const failure = cleanup.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
        }
      }
      const previewHandle = await open(path, 'r');
      let dimensions;
      try { const header = Buffer.alloc(24); const result = await previewHandle.read(header, 0, header.length, 0); dimensions = result.bytesRead === 24 && pngDimensions(header); }
      finally { await previewHandle.close(); }
      if (!dimensions || dimensions.width > 1280 || dimensions.height > 1280) throw new Error('Invalid converted preview.');
      if (this.closed) throw new Error('Activity store is closed.');
      return { path, ...dimensions };
    });
    this.exportQueue = operation.catch(() => {});
    return operation;
  }
  async inlinePreview(sourcePath) {
    if (process.platform !== 'win32') return null;
    try {
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) return null;
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', inlineScript], {
        windowsHide: true, timeout: 15000, maxBuffer: 100000,
        env: { ...process.env, CODEX_SUBAGENTS_IMAGE_SOURCE: sourcePath },
      });
      const result = JSON.parse(stdout);
      const valid = (value, max) => typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.startsWith('/9j/');
      if (!valid(result.thumbnail, 4500) || !valid(result.large, 42000)) return null;
      return { desktop_thumbnail: `data:image/jpeg;base64,${result.thumbnail}`, desktop_preview: `data:image/jpeg;base64,${result.large}` };
    } catch { return null; }
  }
  find(target) {
    const agent = this.controller.find(target);
    if (!agent?.threadId || this.controller.threads.get(agent.threadId) !== agent) throw new Error('Agent thread is unavailable.');
    return agent;
  }
  summary(a) { return { id: a.id, agent_id: a.id, name: a.name, status: a.status, activity: a.activity,
    model: a.model, reasoning_effort: a.effort, context_source: a.contextSource ?? 'unknown',
    permissions_mode: this.controller.settings?.permissionsMode ?? null,
    context_used_tokens: Number.isSafeInteger(a.tokenUsage?.last?.totalTokens) && a.tokenUsage.last.totalTokens >= 0 ? a.tokenUsage.last.totalTokens : null,
    context_limit_tokens: Number.isSafeInteger(a.tokenUsage?.modelContextWindow) && a.tokenUsage.modelContextWindow > 0 ? a.tokenUsage.modelContextWindow : null,
    user_paused: a.userPaused === true, user_control_status: a.userControlStatus ?? null }; }
  list() { return { agents: [...this.controller.agents.values()].map((a) => this.summary(a)) }; }
  bucket(id) {
    let bucket = this.live.get(id);
    if (!bucket) { bucket = { revision: this.nextRevision++, entries: [] }; }
    else this.live.delete(id);
    this.live.set(id, bucket);
    while (this.live.size > AGENT_LIMIT) this.live.delete(this.live.keys().next().value);
    return bucket;
  }
  put(agent, entry) {
    const bucket = this.bucket(agent.id);
    const index = bucket.entries.findIndex((x) => x.turn_id === entry.turn_id && x.id === entry.id);
    if (index >= 0) bucket.entries[index] = entry; else bucket.entries.push(entry);
    if (bucket.entries.length > LIVE_LIMIT) bucket.entries.splice(0, bucket.entries.length - LIVE_LIMIT);
    bucket.revision = this.nextRevision++;
  }
  recordAction(action) {
    const agent = this.controller.agents.get(action.agent_id);
    if (action.kind === 'close') { this.live.delete(action.agent_id); return; }
    if (!agent || action.thread_id !== agent.threadId || typeof action.message !== 'string') return;
    this.put(agent, { id: `action:${action.kind}:${this.bucket(agent.id).revision}`, turn_id: action.turn_id ?? '', type: action.origin === 'user' ? 'directUserMessage' : 'parentMessage', data: { text: clean(action.message), ...(action.attachments?.length ? { attachments: clean(action.attachments) } : {}) } });
  }
  decorate(item) {
    if (['collabAgentToolCall', 'collabToolCall'].includes(item.type)) return { ...item, displayAgentNames: Object.fromEntries([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})].filter(id => this.agentNames.has(id)).map(id => [id, this.agentNames.get(id)])) };
    if (item.type === 'subAgentActivity') {
      const name = this.agentNames.get(item.agentThreadId) ?? item.name;
      const pathName = typeof item.agentPath === 'string' ? item.agentPath.split('/').filter(Boolean).at(-1) : undefined;
      return { ...item, name: name ?? item.agentPath, display_name: name ?? pathName };
    }
    return item;
  }
  remember(map, key, value) { map.delete(key); map.set(key, value); if (map.size > 256) map.delete(map.keys().next().value); }
  stage(item, threadId, turnId, entry = item) {
    if (entry.completedAtMs != null || item.completedAtMs != null || this.turnStates.get(`${threadId}:${turnId}`) === 'completed') return 'completed';
    return entry.startedAtMs != null || item.startedAtMs != null ? 'started' : undefined;
  }
  observe(message) {
    const p = message?.params ?? {};
    if (message.method === 'thread/started' && p.thread?.id) {
      const name = p.thread.name || p.thread.agentNickname;
      if (typeof name === 'string' && name) this.remember(this.agentNames, p.thread.id, name.slice(0, 512));
    }
    const agent = this.controller.threads.get(p.threadId);
    // Never follow descendant IDs, even when they are tracked by the controller.
    if (!agent || agent.threadId !== p.threadId) return;
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (visible(p.item)) {
        const previous = this.bucket(agent.id).entries.find(entry => entry.turn_id === p.turnId && entry.id === p.item.id);
        const startedAtMs = p.item.startedAtMs ?? (message.method === 'item/started' ? p.startedAtMs : undefined) ?? previous?.started_at_ms;
        this.put(agent, simplify(this.decorate(removeGuidance(p.item, this.controller.guidance)), p.turnId, false, message.method === 'item/completed' ? 'completed' : 'started', startedAtMs, agent.threadId));
      }
      return;
    }
    if (message.method === 'turn/completed' && p.turn?.id) {
      this.remember(this.turnStates, `${p.threadId}:${p.turn.id}`, p.turn.status);
      if (p.turn.status === 'completed') {
        const bucket = this.bucket(agent.id);
        for (const entry of [...bucket.entries]) {
          if (entry.turn_id === p.turn.id && entry.message?.phase === 'final_answer') this.put(agent, { ...entry, message: { ...entry.message, complete: true, is_final: true } });
        }
      }
    }
    if (message.method === 'thread/compacted') {
      const bucket = this.bucket(agent.id);
      const entry = [...bucket.entries].reverse().find(entry => entry.type === 'contextCompaction' && (!p.turnId || entry.turn_id === p.turnId));
      if (entry && entry.data?.stage !== 'completed') this.put(agent, { ...entry, data: { ...entry.data, stage: 'completed' } });
    }
    if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(message.method) && typeof p.delta === 'string' && p.itemId) {
      const bucket = this.bucket(agent.id);
      const old = bucket.entries.find((x) => x.id === p.itemId && x.turn_id === p.turnId);
      const isCommand = message.method === 'item/commandExecution/outputDelta';
      const field = isCommand ? 'aggregatedOutput' : 'text';
      const text = (old?.data?.[field] ?? '') + p.delta;
      const entry = simplify({ ...old?.data, ...(old?.message?.phase ? { phase: old.message.phase } : {}), id: p.itemId, type: isCommand ? 'commandExecution' : 'agentMessage', [field]: text }, p.turnId);
      if (entry.message && old?.message?.truncated) entry.message.truncated = true;
      this.put(agent, entry);
    }
  }
  revision({ target, revision } = {}) {
    const agent = this.find(target), bucket = this.bucket(agent.id);
    return { agent: this.summary(agent), revision: bucket.revision, ...(revision === bucket.revision ? {} : { entries: orderWaits(bucket.entries) }) };
  }
  async history({ target, cursor, limit = 30 } = {}) {
    const agent = this.find(target);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be between 1 and 50.');
    if (cursor != null && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))) throw new TypeError('Invalid history cursor.');
    let { turn_id: turnId, turns_cursor: turnsCursor, items_cursor: itemsCursor, seen_turn_cursors: seenTurns = [], seen_item_cursors: seenItems = [] } = cursor ?? {};
    const validToken = (v) => v == null || (typeof v === 'string' && v.length > 0);
    const validSeen = (v) => Array.isArray(v) && v.length <= 64 && v.every((s) => typeof s === 'string' && s.length > 0) && new Set(v).size === v.length;
    if (![turnId, turnsCursor, itemsCursor].every(validToken) || !validSeen(seenTurns) || !validSeen(seenItems) || (!turnId && (itemsCursor || seenItems.length))) throw new TypeError('Invalid history cursor.');
    seenTurns = new Set(seenTurns); seenItems = new Set(seenItems);
    const entries = [];
    // Bound work even when native pages contain only hidden or empty items.
    let requests = 0, done = false;
    const advance = (current, next, seen) => {
      if (!validToken(next)) throw new Error('Invalid native history cursor.');
      if (current) {
        if (seen.has(current)) throw new Error('Repeated native history cursor.');
        seen.add(current);
      }
      if (next && seen.has(next)) throw new Error('Repeated native history cursor.');
      return next ?? null;
    };
    while (entries.length < limit && requests < 80 && !done) {
      if (!turnId) {
        const page = await this.client.request('thread/turns/list', { threadId: agent.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...(turnsCursor ? { cursor: turnsCursor } : {}) });
        requests++;
        turnsCursor = advance(turnsCursor, page.nextCursor, seenTurns);
        turnId = page.data?.[0]?.id;
        if (turnId && !validToken(turnId)) throw new Error('Invalid native turn ID.');
        if (turnId) this.remember(this.turnStates, `${agent.threadId}:${turnId}`, page.data[0].status);
        else if (!turnsCursor) done = true;
        continue;
      }
      const page = await this.client.request('thread/items/list', { threadId: agent.threadId, turnId, limit: limit - entries.length, sortDirection: 'desc', deferOutput: { commandExecution: true, mcpToolCall: true }, ...(itemsCursor ? { cursor: itemsCursor } : {}) });
      requests++;
      if ((page.data?.length ?? 0) > limit - entries.length) throw new Error('Native history page exceeded its requested limit.');
      itemsCursor = advance(itemsCursor, page.nextCursor, seenItems);
      entries.push(...(page.data ?? []).filter((entry) => visible(entry.item)).map((entry) => {
        const actualTurn = entry.turnId ?? turnId;
        const result = simplify(this.decorate(removeGuidance(entry.item, this.controller.guidance)), actualTurn, entry.outputDeferred === true, this.stage(entry.item, agent.threadId, actualTurn, entry), entry.startedAtMs ?? entry.item.startedAtMs, agent.threadId);
        return result;
      }));
      if (!itemsCursor) {
        turnId = null; seenItems = new Set();
        if (!turnsCursor) done = true;
      }
    }
    const next_cursor = done ? null : { ...(turnId ? { turn_id: turnId, items_cursor: itemsCursor ?? null } : {}), ...(turnsCursor ? { turns_cursor: turnsCursor } : {}), ...(seenTurns.size ? { seen_turn_cursors: [...seenTurns].slice(-64) } : {}), ...(seenItems.size ? { seen_item_cursors: [...seenItems].slice(-64) } : {}) };
    return { agent: this.summary(agent), entries: orderWaits(entries.reverse()), next_cursor };
  }
  async detail({ target, turn_id, item_id, offset = 0, file_path, view, export: exportMessage, bulk, expand } = {}) {
    const agent = this.find(target);
    if (typeof turn_id !== 'string' || !turn_id || typeof item_id !== 'string' || !item_id) throw new TypeError('turn_id and item_id are required.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid detail offset.');
    if (file_path !== undefined && (typeof file_path !== 'string' || !file_path)) throw new TypeError('Invalid file path.');
    if (view !== undefined && view !== 'output' && view !== 'communication' && view !== 'message' && view !== 'media') throw new TypeError('Invalid detail view.');
    if (view === 'media' && (file_path !== undefined || bulk !== undefined || expand !== undefined || exportMessage !== undefined)) throw new TypeError('Invalid media request.');
    if (exportMessage !== undefined && (view !== 'communication' || exportMessage !== true)) throw new TypeError('Invalid export request.');
    if (bulk !== undefined && (bulk !== true || !['message', 'communication'].includes(view) || exportMessage)) throw new TypeError('Invalid bulk request.');
    if (exportMessage && (file_path !== undefined || offset !== 0)) throw new TypeError('Invalid export request.');
    if (expand !== undefined && (expand !== true || !['message', 'communication'].includes(view) || offset !== 0 || file_path !== undefined || bulk !== undefined || exportMessage !== undefined)) throw new TypeError('Invalid expand request.');
    const pageSize = bulk ? 524288 : 16000;
    const page = await this.client.request('thread/items/read', { threadId: agent.threadId, turnId: turn_id, itemIds: [item_id] });
    const record = page.data?.[0];
    const item = record?.item;
    if (view === 'media') {
      if (item?.id !== item_id || (record?.turnId != null && record.turnId !== turn_id)) throw new Error('Media item is unavailable.');
      let { images, omitted, truncated } = collectImages(removeGuidance(item, this.controller.guidance));
      if (truncated && ['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
        const recovered = await this.rolloutMedia.lookup(agent.threadId, turn_id, item_id);
        if (recovered) {
          const found = collectImages({ output: recovered });
          if (found.images.length && !found.truncated) ({ images, omitted, truncated } = found);
        }
      }
      const batch = await Promise.all(images.slice(offset, offset + 8).map(async image => {
        const result = await materializeImage(image, (buffer, mime) => this.exportImage(buffer, mime), path => this.exportPreview(path));
        const inline = result.previewable && result.path ? await this.inlinePreview(result.path) : null;
        return inline ? { ...result, ...inline } : result;
      }));
      return { images: batch, count: images.length, next_offset: offset + 8 < images.length ? offset + 8 : null, ...(omitted ? { omitted: true, notice: truncated ? '原始图片数据已被截断，无法恢复完整图片。' : 'Image scan reached its limit; additional images may not be listed.' } : {}) };
    }
    if (view === 'communication') {
      if (file_path !== undefined || item?.id !== item_id || (record?.turnId != null && record.turnId !== turn_id)) throw new Error('Communication item is unavailable.');
      const message = communication(item, agent.threadId);
      if (!message) throw new Error('Communication item is unavailable.');
      if (exportMessage) return this.exportCommunication(message.text);
      if (expand) return this.expandText(message.text);
      const text = message.text, next_offset = offset + pageSize < text.length ? offset + pageSize : null;
      return { text: text.slice(safeBoundary(text, offset), safeBoundary(text, offset + pageSize)), next_offset, format: offset === 0 && next_offset === null ? 'markdown' : 'text', total_length: text.length };
    }
    if (view === 'message') {
      if (file_path !== undefined || item?.id !== item_id || (record?.turnId != null && record.turnId !== turn_id) || !['agentMessage', 'parentMessage', 'directUserMessage', 'userMessage'].includes(item.type)) throw new Error('Message item is unavailable.');
      const text = formatItem(removeGuidance(item, this.controller.guidance));
      if (expand) return this.expandText(text);
      const next_offset = offset + pageSize < text.length ? offset + pageSize : null;
      return { text: text.slice(safeBoundary(text, offset), safeBoundary(text, offset + pageSize)), next_offset, format: offset === 0 && next_offset === null ? 'markdown' : 'text', total_length: text.length };
    }
    if (!visible(item)) return { text: '', next_offset: null };
    const change = file_path !== undefined && item.type === 'fileChange' ? fileChanges(item).find(change => change.path === file_path) : null;
    if (file_path !== undefined && !change) throw new Error('File is not part of this recorded change.');
    if (change) return { ...fileChangePage(change, offset), file_path };
    const outputOnly = view === 'output' && OUTPUT_TYPES.has(item.type);
    const text = (outputOnly ? formatItemOutput : formatItem)(removeGuidance(item, this.controller.guidance));
    const next_offset = offset + 16000 < text.length ? offset + 16000 : null;
    return { text: text.slice(offset, offset + 16000), next_offset, ...(outputOnly ? { format: 'source' } : {}) };
  }
  async expandText(text) {
    const total_length = text.length;
    if (total_length <= 48000) return { text, format: 'markdown', total_length, external: false };
    const end = safeBoundary(text, 48000) === 48000 ? 48000 : 47999;
    return { text: text.slice(0, end), format: 'text', total_length, external: true, ...await this.exportCommunication(text) };
  }
}

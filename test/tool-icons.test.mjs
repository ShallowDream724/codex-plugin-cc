import test from 'node:test';
import assert from 'node:assert/strict';
import { activityIcon, contextIndicator } from '../hooks/tool-icons.js';

test('activity icons distinguish native actions and computer tools from integration calls', () => {
  assert.equal(activityIcon({ type: 'mcpToolCall', data: { server: 'fastctx', tool: 'run' } }).kind, 'integration');
  assert.equal(activityIcon({ type: 'commandExecution' }).kind, 'terminal');
  assert.equal(activityIcon({ type: 'fileChange' }).kind, 'edit');
  assert.equal(activityIcon({ type: 'webSearch' }).kind, 'search');
  assert.equal(activityIcon({ type: 'dynamicToolCall', data: { tool: 'mcp__cua_repl__js' } }).kind, 'computer');
  assert.equal(activityIcon({ type: 'dynamicToolCall', data: { tool: 'mcp__cua_repl__js' } }, true).kind, 'integration');
});

test('context indicator requires native usage and exposes actual over-limit use without overfilling the ring', () => {
  assert.equal(contextIndicator(undefined, 100), null);
  assert.equal(contextIndicator(10, 0), null);
  assert.match(contextIndicator(7, 100).source, /stroke-dasharray="7 100"/);
  assert.match(contextIndicator(120, 100).alt, /120%/);
  assert.match(contextIndicator(120, 100).source, /stroke-dasharray="100 100"/);
});

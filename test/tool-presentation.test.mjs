import test from 'node:test';
import assert from 'node:assert/strict';
import { toolSections } from '../hooks/tool-presentation.js';

test('completed tool shows its useful input and duration without transport-only details', () => {
  const sections = toolSections({ type: 'mcpToolCall', data: {
    server: 'codex', tool: 'notify_parent', arguments: { message: 'Ready for review' },
    status: 'completed', stage: 'completed', durationMs: 11,
    namespace: null, success: true, startedAtMs: 100, completedAtMs: 111,
  } });
  assert.deepEqual(sections, [
    { label: '参数', source: JSON.stringify({ message: 'Ready for review' }, null, 2) },
    { label: '状态', source: '11 ms', compact: true },
  ]);
});

test('deduplicates status while preserving failure, output and nested business fields', () => {
  const business = { success: true, namespace: null, startedAtMs: 3, completedAtMs: 4 };
  const sections = toolSections({ type: 'dynamicToolCall', data: {
    arguments: { payload: business }, result: { content: [{ type: 'text', text: 'actual output' }] },
    status: 'FAILED', stage: 'failed', durationMs: 5, success: false, error: 'denied', business,
  } });
  assert.deepEqual(sections, [
    { label: '参数', source: JSON.stringify({ payload: business }, null, 2) },
    { label: '输出', source: 'actual output' },
    { label: '错误', source: 'denied' },
    { label: '状态', source: 'FAILED · 5 ms', compact: true },
    { label: '详情', source: JSON.stringify({ success: false, business }, null, 2), collapsible: true },
  ]);
});

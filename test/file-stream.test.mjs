import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChangePage } from '../shared/file-changes.mjs';
import { appendFilePage, fileViewEntries } from '../hooks/file-stream.js';

const entry = changes => ({ id: 'item', turn_id: 'turn', type: 'fileChange', data: { changes } });
const project = (item, detail, isOpen = () => true) => fileViewEntries(item, 'agent', { isOpen, getDetail: path => detail[path] });
const bodies = entries => entries.filter(e => e.type === 'fileDiffChunk');

test('streams all transport pages with bounded units and stable append keys', () => {
  const change = { path: 'large.js', kind: 'update', diff: `--- a/large.js\n+++ b/large.js\n@@ -1,1100 +1,1100 @@\n${Array.from({ length: 1100 }, (_, i) => `-old ${i}\n+new ${i}\n`).join('')}` };
  let offset = 0, detail, firstKeys;
  const expectedRows = [];
  do {
    const page = fileChangePage(change, offset);
    expectedRows.push(...page.rows);
    detail = appendFilePage(detail, page, offset);
    const result = project(entry([change]), { [change.path]: detail });
    const chunks = bodies(result);
    if (firstKeys) assert.deepEqual(chunks.slice(0, firstKeys.length).map(e => e.id), firstKeys);
    else firstKeys = chunks.map(e => e.id);
    offset = page.next_offset;
  } while (offset != null);
  const result = project(entry([change]), { [change.path]: detail });
  const chunks = bodies(result);
  assert.deepEqual(chunks.flatMap(e => e.fileView.rows), expectedRows);
  assert.ok(chunks.every(e => e.fileView.rows.length > 0 && e.fileView.rows.length <= 24 && e.fileView.rows.reduce((n, row) => n + row.text.length, 0) <= 4000));
  assert.ok(chunks.every(e => e.fileView.lineWidth === 4));
  assert.ok(!result.some(e => e.type === 'fileDiffTail'));
  assert.equal(chunks[0].fileView.source.id, 'item');
});

test('closed files retain their headers and files have independent streams', () => {
  const item = entry([{ path: 'a' }, { path: 'b' }]);
  const detail = { a: appendFilePage(null, { text: 'alpha', format: 'source', next_offset: null }, 0) };
  const all = project(item, detail, key => key.endsWith(':0'));
  assert.deepEqual(all.map(e => e.type), ['fileChangeHeader', 'fileDiffChunk', 'fileChangeHeader']);
  assert.equal(all[0].fileView.key, 'agent:turn:item:file:0');
  assert.equal(all[2].fileView.key, 'agent:turn:item:file:1');
  const closed = project(item, detail, () => false);
  assert.deepEqual(closed.map(e => e.id), all.filter(e => e.type === 'fileChangeHeader').map(e => e.id));
  const missing = project(item, {}, () => true);
  assert.deepEqual(missing.map(e => e.type), ['fileChangeHeader', 'fileDiffTail', 'fileChangeHeader', 'fileDiffTail']);
  assert.deepEqual(fileViewEntries({ id: 'other', type: 'message' }, 'agent'), [{ id: 'other', type: 'message' }]);
});

test('preserves long unicode row fragments without splitting surrogate pairs', () => {
  const value = '+' + '😀'.repeat(4500);
  const rows = [{ kind: 'added', text: value, new: 8 }];
  const detail = appendFilePage(null, { text: value, rows, format: 'diff', next_offset: null }, 0);
  const chunks = bodies(project(entry([{ path: 'x' }]), { x: detail }));
  const fragments = chunks.flatMap(e => e.fileView.rows);
  assert.equal(fragments.map(r => r.text).join(''), value);
  assert.equal(fragments[0].new, 8);
  assert.ok(fragments.slice(1).every(r => r.continuation && r.new === undefined));
  assert.ok(fragments.every(r => !/[\uD800-\uDBFF]$/.test(r.text)));
});

test('does not project raw diff headers as empty rows and shares line width', () => {
  const detail = appendFilePage(null, { text: 'header'.repeat(2000), rows: [{ kind: 'added', text: '+a', new: 99 }, { kind: 'added', text: '+b', new: 100 }], format: 'diff', next_offset: null }, 0);
  const chunks = bodies(project(entry([{ path: 'x' }]), { x: detail }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].fileView.lineWidth, 3);
  assert.equal(chunks[0].fileView.rows.length, 2);
  assert.equal(detail.chunks[0].text.length, 12000);
});

test('rejects non-progress and mismatched pages without mutating prior cache', () => {
  const first = appendFilePage(null, { text: 'one', next_offset: 3 }, 0);
  assert.throws(() => appendFilePage(first, { text: 'bad', next_offset: 3 }, 3));
  assert.throws(() => appendFilePage(first, { text: 'bad', next_offset: null }, 4));
  const second = appendFilePage(first, { text: 'two', next_offset: null }, 3);
  assert.equal(first.chunks.length, 1);
  assert.equal(second.chunks.length, 2);
  assert.equal(appendFilePage(second, { text: 'new', next_offset: null }, 0).chunks.length, 1);
});

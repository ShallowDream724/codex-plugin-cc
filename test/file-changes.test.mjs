import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChangeSummary, fileChangeSource, fileChangePage, fileChanges } from '../shared/file-changes.mjs';
import { parseUnifiedDiff } from '../shared/unified-diff.mjs';

test('creation and deletion treat all content as complete source, including patch-shaped Markdown', () => {
  for (const content of ['- item\n---\n++ words\n', '{"a": 1}\n', 'print(1)\n', '@@ -1 +1 @@\n-old\n+new\n', '', 'a\r\nb', '😀']) {
    const count = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
    for (const kind of ['add', 'delete']) {
      const change = { path: 'x', kind: { type: kind }, diff: content };
      assert.deepEqual(fileChangeSummary(change), { path: 'x', kind, added: kind === 'add' ? count : 0, removed: kind === 'delete' ? count : 0 });
      const source = fileChangeSource(change); assert.equal(source.format, 'diff'); assert.ok(parseUnifiedDiff(source.text));
      if (content && !content.endsWith('\n')) assert.match(source.text, /\\ No newline at end of file\n$/);
    }
  }
});

test('updates require complete unified patches and legacy forms retain moves', () => {
  const patch = '@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(fileChangeSummary({ path: 'a', type: 'update', unified_diff: patch, move_path: 'b' }), { path: 'a', kind: 'update', move_path: 'b', added: 1, removed: 1 });
  assert.deepEqual(fileChangeSummary({ path: 'a', type: 'add', content: 'x\ny' }), { path: 'a', kind: 'add', added: 2, removed: 0 });
  assert.deepEqual(fileChanges({ changes: { a: { type: 'delete', content: 'x' } } })[0], { path: 'a', type: 'delete', content: 'x' });
  assert.deepEqual(fileChangeSummary({ path: 'a', diff: patch }), { path: 'a', kind: 'unknown', added: 1, removed: 1 });
  for (const diff of [undefined, '-old\n+new', '@@ -1 +1 @@\n-old\n', '']) {
    const change = { path: 'a', kind: { type: 'update' }, diff };
    assert.deepEqual(fileChangeSummary(change), { path: 'a', kind: 'update' }); assert.equal(fileChangeSource(change).format, 'source');
  }
});

test('app-server rename footer is removed only for the exact recorded destination', () => {
  const patch = '@@ -1 +1 @@\n-old\n+new\n';
  const change = { path: 'a', kind: { type: 'update', move_path: 'b' }, diff: patch + '\n\nMoved to: b' };
  assert.equal(fileChangeSource(change).text, patch);
  assert.equal(fileChangeSummary(change).added, 1);
  assert.equal(fileChangeSource({ ...change, kind: { type: 'update', move_path: 'c' } }).format, 'source');
});

test('long pages preserve source, line numbers, colors and accurate backwards boundaries', () => {
  const change = { path: 'large', kind: { type: 'add' }, diff: Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n') + '\n' };
  const original = fileChangeSource(change).text, pages = []; let offset = 0;
  do { const page = fileChangePage(change, offset); pages.push(page); offset = page.next_offset; } while (offset !== null);
  assert.ok(pages.length > 3); assert.equal(pages.map(p => p.text).join(''), original);
  const rows = pages.flatMap(p => p.rows).filter(r => r.kind === 'added');
  assert.equal(rows.length, 450); assert.deepEqual(rows.map(r => r.new), Array.from({ length: 450 }, (_, i) => i + 1));
  pages.forEach((p, i) => { assert.ok(p.rows.length <= 120); assert.ok(p.text.length <= 16000); assert.equal(p.previous_offset, i ? pages[i - 1].previous_offset === null ? 0 : pages[i - 2].next_offset : null); });
});

test('oversized Unicode lines continue without invented numbers or split surrogate pairs', () => {
  const change = { path: 'long', kind: 'add', diff: '😀'.repeat(18000) + '\n' };
  const source = fileChangeSource(change).text; let offset = 0, text = '', rows = [];
  do { const p = fileChangePage(change, offset); assert.ok(p.text.length <= 16000); assert.ok(!/[\uD800-\uDBFF]$/.test(p.text)); text += p.text; rows.push(...p.rows.filter(r => r.kind === 'added')); offset = p.next_offset; } while (offset !== null);
  assert.equal(text, source); assert.equal(rows[0].new, 1); assert.ok(rows.slice(1).every(r => r.continuation && r.new === undefined));
  assert.equal(rows.map(r => r.text).join(''), '+' + change.diff.slice(0, -1));
});

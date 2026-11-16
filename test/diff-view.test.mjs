import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, renderDiff } from '../hooks/diff-view.js';

const components = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({ type, props })]));
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children ?? []).flatMap(nodes)] : [];
const render = (source, options = {}) => renderDiff(components, { key: 'd', source, path: 'src/example.js', ...options });

test('hunk lines carry correct old and new numbers across additions and removals', () => {
  const rows = parseDiff('@@ -4,3 +4,4 @@ section\n keep\n-old\n+new\n+extra\n end\n');
  assert.deepEqual(rows.map(({ kind, old, new: next }) => [kind, old, next]), [
    ['hunk', undefined, undefined], ['context', 4, 4], ['removed', 5, undefined],
    ['added', undefined, 5], ['added', undefined, 6], ['context', 6, 7],
  ]);
  const tree = render('@@ -1 +1 @@\n-old\n+new\n');
  const boxes = nodes(tree).filter(n => n.type === 'Box' && n.props.backgroundColor);
  assert.equal(boxes.length, 2);
  assert.match(boxes[0].props.backgroundColor, /248,81,73/);
  assert.match(boxes[1].props.backgroundColor, /46,160,67/);
  assert.deepEqual(boxes.map(box => box.props.children.map(child => child.props.children[0].props.children[0])), [['1', 'old'], ['1', 'new']]);
  assert.ok(!nodes(tree).some(n => n.type === 'Text' && n.props.children.some(v => typeof v === 'string' && v.startsWith('@@'))));
  assert.ok(!nodes(tree).some(n => n.type === 'Text' && n.props.children.includes('example.js')));
});

test('file headers, multiple hunks, empty ranges and no-newline markers remain readable', () => {
  const source = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n@@ -3,0 +4,1 @@\n+another\n';
  const rows = parseDiff(source);
  assert.equal(rows.filter(row => row.kind === 'hunk').length, 2);
  assert.equal(rows.filter(row => row.kind === 'marker').length, 2);
  assert.deepEqual(rows.at(-1), { kind: 'added', text: '+another', new: 4 });
  let copied;
  const copy = nodes(render(source, { onCopy: value => { copied = value; } })).find(n => n.type === 'Button' && n.props.key.endsWith(':copy'));
  copy.props.onPress(); assert.equal(copied, source);
});

test('incomplete or malformed hunks fall back to source', () => {
  for (const source of ['@@ -1,2 +1,2 @@\n one\n', '@@ -1 +1 @@\n-old\n', '--- a/x\n@@ -1 +1 @@\n-old\n+new\n', '@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n', '@@ -1 +1 @@\n-old\n+new\ntruncated']) {
    assert.equal(parseDiff(source), null);
    assert.equal(render(source), null);
  }
});

test('paging reaches every line, clamps the index and keeps nodes bounded', () => {
  const source = '@@ -1,300 +1,300 @@\n' + Array.from({ length: 300 }, (_, i) => ` line ${i + 1}\n`).join('');
  const seen = [], calls = [];
  for (let page = 0; page < 3; page++) {
    const tree = render(source, { page, onPage: next => calls.push(next) });
    const all = nodes(tree);
    assert.ok(all.length < 1000);
    seen.push(...all.filter(n => n.type === 'Text').flatMap(n => n.props.children).filter(v => typeof v === 'string' && v.startsWith('line ')));
    const next = all.find(n => n.type === 'Button' && n.props.label === '下一页');
    if (next) next.props.onPress();
  }
  assert.equal(seen.length, 300); assert.equal(new Set(seen).size, 300);
  assert.deepEqual(calls, [1, 2]);
  const last = nodes(render(source, { page: 999, onPage: next => calls.push(next) }));
  assert.ok(last.some(n => n.type === 'Text' && n.props.children.includes('3 / 3')));
  last.find(n => n.type === 'Button' && n.props.label === '上一页').props.onPress();
  assert.equal(calls.at(-1), 1);
});

test('supplied paged rows render without reparsing partial patch text', () => {
  const rows = [{ kind: 'added', text: '+new item', new: 121 }, { kind: 'removed', text: '-old item', old: 119 }];
  const tree = render('partial patch page', { rows });
  const all = nodes(tree); assert.equal(all.filter(n => n.type === 'Box' && n.props.backgroundColor).length, 2);
  assert.ok(all.some(n => n.type === 'Text' && n.props.children.includes('121')));
  assert.ok(all.some(n => n.type === 'Text' && n.props.children.includes('119')));
});

test('internal diff page copies only its visible rows', () => {
  const source = '@@ -1,250 +1,250 @@' + String.fromCharCode(10) + Array.from({ length: 250 }, (_, i) => ` line ${i + 1}`).join(String.fromCharCode(10)) + String.fromCharCode(10);
  let copied; const tree = render(source, { page: 1, onCopy: value => { copied = value; } });
  nodes(tree).find(n => n.type === 'Button' && n.props.key.endsWith(':copy')).props.onPress();
  assert.ok(copied.includes(' line 121')); assert.ok(!copied.includes(' line 120' + String.fromCharCode(10))); assert.ok(!copied.includes(' line 241' + String.fromCharCode(10)));
});

test('one gutter follows old lines for deletions and new lines for additions and context', () => {
  const source = '@@ -4,3 +4,4 @@ heading\n keep\n--literal\n++literal\n+extra\n end\n@@ -20 +21 @@\n-tail\n+finish\n';
  const tree = render(source);
  const rows = nodes(tree).filter(n => n.type === 'Box' && n.props.key?.startsWith('d:row:'));
  assert.deepEqual(rows.map(row => row.props.children.map(child => child.props.children[0].props.children[0])), [
    ['4', 'keep'], ['5', '-literal'], ['5', '+literal'], ['6', 'extra'], ['7', 'end'], ['20', 'tail'], ['21', 'finish'],
  ]);
});

test('continuations preserve literal leading signs, with raw page copy unchanged', () => {
  const source = '+first fragment\n+literal continuation';
  const rows = [{ kind: 'added', text: '+first fragment', new: 1 }, { kind: 'added', text: '+literal continuation', continuation: true }];
  let copied;
  const tree = render(source, { rows, onCopy: value => { copied = value; } });
  const texts = nodes(tree).filter(n => n.type === 'Text').flatMap(n => n.props.children);
  assert.ok(texts.includes('first fragment')); assert.ok(texts.includes('+literal continuation'));
  nodes(tree).find(n => n.type === 'Button' && n.props.key.endsWith(':copy')).props.onPress();
  assert.equal(copied, source);
});

test('internal pages copy exact patch slices, including headers and CRLF', () => {
  const source = '--- a/x\r\n+++ b/x\r\n@@ -1,121 +1,121 @@\r\n' + Array.from({ length: 121 }, (_, i) => ` line ${i}\r\n`).join('');
  const copies = [];
  for (const page of [0, 1]) {
    const tree = render(source, { page, onCopy: value => copies.push(value) });
    nodes(tree).find(n => n.type === 'Button' && n.props.key.endsWith(':copy')).props.onPress();
  }
  assert.equal(copies.join(''), source);
});

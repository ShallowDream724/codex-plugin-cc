import test from 'node:test';
import assert from 'node:assert/strict';
import DisclosureControl from '../hooks/icon-control.js';

test('the vector chevron hit area activates on release and keyboard, rejecting stale and outside clicks', () => {
  let state, pointer, key;
  const posts = [];
  const surface = { columns: 2, rows: 1, elements: { Box: props => ({ type: 'Box', props }) }, get state() { return state; }, setState(value) { state = value; }, onPointer(fn) { pointer = fn; }, onKey(fn) { key = fn; }, post(data) { posts.push(data); } };
  const draw = expanded => DisclosureControl({ expanded }, surface);
  const event = (type, x = 1, button = 'left') => ({ type, x, y: 0, button });
  draw(false);
  pointer(event('down')); pointer(event('up')); pointer(event('up'));
  assert.deepEqual(posts, [{ action: 'toggle', expanded: false }]);
  pointer(event('down')); pointer(event('up', 2));
  pointer(event('down', 1, 'right')); pointer(event('up', 1, 'right'));
  pointer(event('down')); draw(true); pointer(event('up'));
  assert.equal(posts.length, 1);
  key({ key: 'return', ctrl: true }); key({ key: 'a' });
  key({ key: 'return' }); key({ key: ' ' });
  assert.deepEqual(posts.slice(1), [{ action: 'toggle', expanded: true }, { action: 'toggle', expanded: true }]);
});

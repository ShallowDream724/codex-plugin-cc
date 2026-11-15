import test from 'node:test';
import assert from 'node:assert/strict';
import ActionControl from '../hooks/action-control.js';

function mount(props = {}) {
  const posts = [];
  let pointer, key, currentProps = { mode: 'send', ...props }, state;
  const surface = {
    elements: Object.fromEntries(['Box', 'Text'].map((type) => [type, (props) => ({ type, props })])),
    columns: 3, rows: 2,
    get state() { return state; },
    setState(next) { state = next; },
    onPointer(fn) { pointer = fn; return () => {}; },
    onKey(fn) { key = fn; return () => {}; },
    post(data) { posts.push(data); },
  };
  const redraw = (next = {}) => { currentProps = { ...currentProps, ...next }; return ActionControl(currentProps, surface); };
  redraw();
  return { posts, surface, redraw, pointer: (event) => pointer(event), key: (event) => key(event) };
}
const pointer = (type, x = 1, y = 0, button = 'left') => ({ type, x, y, button });

test('a left click activates once after release inside the region', () => {
  const control = mount();
  control.pointer(pointer('down'));
  assert.deepEqual(control.posts, []);
  control.redraw();
  control.pointer(pointer('up'));
  control.pointer(pointer('up'));
  assert.deepEqual(control.posts, [{ action: 'activate' }]);
});

test('outside releases, outside presses and other mouse buttons do not activate', () => {
  const control = mount();
  for (const [down, up] of [
    [pointer('down'), pointer('up', 3)],
    [pointer('down'), pointer('up', -1)],
    [pointer('down'), pointer('up', 1, 2)],
    [pointer('down', -1), pointer('up')],
    [pointer('down', 1, 0, 'right'), pointer('up', 1, 0, 'right')],
    [pointer('down', 1, 0, 'middle'), pointer('up', 1, 0, 'middle')],
  ]) {
    control.pointer(down); control.pointer(up);
  }
  control.pointer({ ...pointer('down'), fine: { x: 3.1, y: 0.1 } });
  control.pointer(pointer('up'));
  assert.deepEqual(control.posts, []);
});

test('keyboard Return and Space activate while other keys and modified chords do not', () => {
  const control = mount();
  for (const key of ['escape', 'tab', 'a', 'space']) control.key({ key });
  for (const modifier of ['ctrl', 'meta', 'shift']) control.key({ key: 'return', [modifier]: true });
  assert.deepEqual(control.posts, []);
  control.key({ key: 'return' }); control.key({ key: ' ' });
  assert.deepEqual(control.posts, [{ action: 'activate' }, { action: 'activate' }]);
});

test('disabled controls suppress pointer and keyboard activation, including a pending press', () => {
  const control = mount({ disabled: true });
  control.pointer(pointer('down')); control.pointer(pointer('up'));
  control.key({ key: 'return' }); control.key({ key: ' ' });
  control.redraw({ disabled: false });
  control.pointer(pointer('down'));
  control.redraw({ disabled: true });
  control.pointer(pointer('up'));
  assert.deepEqual(control.posts, []);
  control.redraw({ disabled: false });
  control.pointer(pointer('up'));
  assert.deepEqual(control.posts, []);
});

test('changing send to stop cancels a pending pointer press and preserves the keyboard handler', () => {
  const control = mount();
  control.pointer(pointer('down'));
  control.redraw({ mode: 'stop' });
  control.pointer(pointer('up'));
  assert.deepEqual(control.posts, []);
  control.key({ key: 'return' });
  assert.deepEqual(control.posts, [{ action: 'activate' }]);
});

test('redraws and hover events do not create a state update loop', () => {
  const control = mount({ label: '发送消息' });
  let updates = 0;
  control.surface.setState = () => { updates++; };
  control.redraw(); control.redraw();
  control.pointer({ type: 'enter', x: 1, y: 0 });
  control.pointer({ type: 'move', x: 1, y: 0 });
  control.pointer({ type: 'leave', x: 1, y: 0 });
  assert.equal(updates, 0);
  assert.deepEqual(control.posts, []);
});

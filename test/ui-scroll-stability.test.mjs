import test from 'node:test';
import assert from 'node:assert/strict';
import { registerUI, openAgent, closeUI } from '../hooks/ui.js';
import { nativeHooks } from './native-hooks.mjs';

const entry = id => ({ id, turn_id: 't', type: 'agentMessage', data: { text: id } });

async function setup() {
  const hooks = [], timers = [], afters = [], scrolls = []; let revision = 1, entries = [entry('one')];
  const $ = {
    ui: { resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [type, props => ({ type, props })])), open: async () => ({ isPlaced: true }), scroll: async args => { scrolls.push(args); } },
    state: { get: async () => ({}), set: async () => ({ isSet: true }) },
    clock: { every(_ms, fn) { timers.push(fn); return { cancel() {} }; }, after(_ms, fn) { afters.push(() => host.callback(fn)); return { cancel() {} }; } },
    session: { id: async () => 's', cwd: async () => 'C:/work' }, env: { get: async () => undefined }, plugin: { root: 'C:/plugin' },
    process: { run: async (_argv, options) => { const { operation } = JSON.parse(options.stdin); return { exitCode: 0, stdout: JSON.stringify(operation === 'ui_list' ? { agents: [{ agent_id: 'a', status: 'running' }] } : operation === 'ui_history' ? { entries: [], next_cursor: null } : { revision, entries }) }; } },
  };
  closeUI(); const host = nativeHooks(hooks, $); registerUI(host.on); await openAgent($, 'a');
  const scroll = (event, next = async e => e) => host.dispatch('ui.scroll', { origin: { kind: 'person' }, ...event }, next);
  return { scroll, scrolls, async update() { revision++; entries = [...entries, entry(`message-${revision}`)]; await timers[0](); while (afters.length) await afters.shift()(); } };
}

test('upward intent at a short viewport never resumes streaming follow', async t => {
  t.after(closeUI); const ui = await setup(); const before = ui.scrolls.length;
  await ui.scroll({ by: -1, offset: 0, contentRows: 10, bodyRows: 20 });
  await ui.update();
  assert.equal(ui.scrolls.length, before);
});

test('an older delayed wheel event cannot override later upward intent', async t => {
  t.after(closeUI); const ui = await setup(); let release;
  const previous = ui.scroll({ by: 1, offset: 80, contentRows: 100, bodyRows: 20 }, () => new Promise(resolve => { release = resolve; }));
  await ui.scroll({ by: -1, offset: 20, contentRows: 100, bodyRows: 20 });
  release({}); await previous;
  const before = ui.scrolls.length; await ui.update();
  assert.equal(ui.scrolls.length, before);
});

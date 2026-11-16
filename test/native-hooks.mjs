import { AsyncLocalStorage } from 'node:async_hooks';

// Model the host's registration-specific origin exclusion. A callback invoked
// outside a registration carries the plugin name and excludes all its hooks.
const matches = (actual, expected) => expected && typeof expected === 'object' ? actual && Object.entries(expected).every(([key, value]) => matches(actual[key], value)) : actual === expected;

export function nativeHooks(hooks, $) {
  const context = new AsyncLocalStorage();
  const calls = [];
  const on = (...args) => hooks.push({ event: args[0], matcher: args.length === 3 ? args[1] : {}, fn: args.at(-1) });
  const dispatch = (event, input, next = value => value) => {
    input = { requestId: 'codex_subagent_activity', ...input };
    const origin = context.getStore() ?? [];
    const matching = hooks.filter(hook => hook.event === event && Object.entries(hook.matcher).every(([key, value]) => matches(input[key], value)) && Array.isArray(origin) && !origin.includes(hook));
    const run = (index, value) => {
      if (index === matching.length) return next(value);
      const hook = matching[index]; calls.push({ event, hook, input: value, origin });
      return context.run([...origin, hook], () => hook.fn($, value, value => run(index + 1, value)));
    };
    return run(0, input);
  };
  return { on, dispatch, calls, callback: fn => context.run('plugin', fn), surface: fn => context.run([], fn), origin: () => context.getStore() };
}

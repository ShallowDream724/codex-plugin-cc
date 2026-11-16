// Native Pane scroll is asynchronous. A revision-specific *Button* is our
// paint barrier: Desktop's key table does not contain Box keys. Never await
// network/history work in the wheel handler and never infer paint from a timer.
export function paneScroll({ scroll, later, valid, position }) {
  let pending = null, serial = 0, disposed = false;
  const sample = e => ({ offset: Math.max(0, e.offset - (e.origin.kind === 'plugin' ? e.by : 0)), contentRows: e.contentRows, bodyRows: e.bodyRows });
  let latest = null, intent = 0;
  return {
    get latest() { return latest; },
    get intent() { return intent; },
    get pending() { return !!pending; },
    cancel() { disposed = true; serial++; pending = null; },
    observe(e) {
      if (e.origin.kind === 'person') {
        latest = sample(e); intent++;
        return e;
      }
      if (!pending) { latest = sample(e); return e; }
      const request = pending;
      const measured = sample(e);
      // A later human move owns the viewport. Do not overwrite it with an
      // asynchronous correction from an older frame.
      const unchanged = request.intent === intent;
      const current = !unchanged && latest ? latest : measured;
      const offset = request.before && unchanged
        ? request.before.offset + (request.above ? measured.contentRows - request.before.contentRows : 0)
        : current.offset;
      const result = { ...current, offset: Math.max(0, Math.min(offset, Math.max(0, current.contentRows - current.bodyRows))) };
      latest = result;
      request.result = result;
      position(result.offset);
      return { ...e, offset: result.offset };
    },
    async measure(key, before = null, above = false) {
      const token = ++serial, request = { intent, before, above, result: null };
      pending = request;
      // A missing key means the host has not painted this revision yet. The
      // retries are bounded and run independently of native scrolling.
      for (const delay of [0, 16, 32, 64, 128]) {
        if (disposed || !valid() || token !== serial) break;
        if (delay) await new Promise(resolve => later(delay, resolve));
        if (disposed || !valid() || token !== serial) break;
        try { await scroll({ to: { key }, block: 'start' }); } catch { /* Not drawn yet. */ }
        if (request.result) break;
      }
      if (pending === request) pending = null;
      return token === serial ? request.result : null;
    },
  };
}

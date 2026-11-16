// Native Pane scroll is asynchronous. A revision-specific *Button* is our
// revision marker: Desktop's key table does not contain Box keys. Native leaf
// layout can settle after that marker, so changed frames get another sample.
// Never await network/history work in the wheel handler.
export function paneScroll({ scroll, later, valid, position, refresh }) {
  let pending = null, serial = 0, disposed = false;
  const sample = e => ({ offset: Math.max(0, e.offset - (e.origin.kind === 'plugin' ? e.by : 0)), contentRows: e.contentRows, bodyRows: e.bodyRows, ...(e.origin.kind === 'plugin' ? { anchorOffset: e.offset } : {}) });
  let latest = null, intent = 0;
  return {
    get latest() { return latest; },
    get intent() { return intent; },
    get pending() { return !!pending; },
    get disposed() { return disposed; },
    cancel() { disposed = true; serial++; pending = null; },
    stage(before, above, anchor = false) {
      pending = { token: ++serial, intent, before, above, anchor, staged: true, layoutChange: true, result: null };
    },
    observe(e) {
      if (e.origin.kind === 'person') {
        // Desktop reports resize/scroll anchoring as person input too. During
        // our own layout transaction, a changed geometry is not a new reading
        // position. Preserve the anchor; same-geometry input remains user-owned.
        const baseline = latest ?? pending?.before;
        const layoutChanged = pending?.layoutChange && baseline &&
          (e.contentRows !== baseline.contentRows || e.bodyRows !== baseline.bodyRows);
        if (!layoutChanged) {
          const anchorOffset = latest?.contentRows === e.contentRows && latest?.bodyRows === e.bodyRows ? latest.anchorOffset : undefined;
          latest = { ...sample(e), ...(Number.isFinite(anchorOffset) ? { anchorOffset } : {}) }; intent++; return e;
        }
        // A generic layout event has no reading-marker coordinate. Wait for
        // its keyed sample instead of inferring the prefix from total height.
        if (pending.anchor) return e;
      }
      if (!pending) { latest = sample(e); return e; }
      const request = pending;
      const measured = sample(e);
      // A later human move owns the viewport. Do not overwrite it with an
      // asynchronous correction from an older frame.
      const unchanged = request.intent === intent;
      const current = !unchanged && latest ? latest : measured;
      const reference = request.before ? (unchanged ? request.before : current) : current;
      // A wheel event may belong to the frame before OR after the prepend.
      // Compensate only the geometry not yet present in that human sample;
      // retaining its old absolute offset would jump into the newly added rows.
      const delta = request.anchor && Number.isFinite(reference.anchorOffset)
        ? measured.anchorOffset - reference.anchorOffset : measured.contentRows - reference.contentRows;
      const offset = reference.offset + (request.before && request.above ? delta : 0);
      const result = { ...measured, offset: Math.max(0, Math.min(offset, Math.max(0, measured.contentRows - measured.bodyRows))) };
      latest = result;
      request.result = result;
      if (e.origin.kind === 'person') position(result.offset);
      return { ...e, offset: result.offset };
    },
    async measure(key, before = null, above = false, anchor = false) {
      const request = pending?.staged && pending.before === before && pending.above === above && pending.anchor === anchor
        ? pending : { token: ++serial, intent, before, above, anchor, result: null };
      const token = request.token;
      request.staged = false;
      pending = request;
      let previous = null, result = null, elapsed = 0;
      // A missing key means the host has not painted this revision yet. The
      // retries are bounded and run independently of native scrolling.
      for (const delay of before ? anchor ? [0, 32, 64, 128, 256] : [0, 32, 64, 128] : [0, 16, 32, 64, 128]) {
        if (disposed || !valid() || token !== serial) break;
        if (delay) await new Promise(resolve => later(delay, resolve));
        elapsed += delay;
        if (disposed || !valid() || token !== serial) break;
        if (refresh) await refresh();
        if (disposed || !valid() || token !== serial) break;
        request.result = null;
        let accepted = false;
        try { accepted = !(await scroll({ to: { key }, block: 'start' }))?.deny; } catch { /* Not drawn yet. */ }
        if (accepted && request.result) {
          result = request.result;
          position(result.offset);
          const stable = anchor ? previous?.anchorOffset === result.anchorOffset : previous?.contentRows === result.contentRows;
          if (!before || elapsed >= (anchor ? 224 : 96) && stable && previous.bodyRows === result.bodyRows) break;
          previous = result;
        } else previous = null;
      }
      if (pending === request) pending = null;
      return token === serial ? result : null;
    },
  };
}

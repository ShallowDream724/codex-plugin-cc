// Native Pane scroll is asynchronous. A revision-specific *Button* is our
// revision marker: Desktop's key table does not contain Box keys. Native leaf
// layout can settle after that marker, so changed frames get another sample.
// Never await network/history work in the wheel handler.
export const paneMarkerOffset = (e, block) => e.offset + (block === 'end' ? e.bodyRows - 1 : 0);

export function paneScroll({ scroll, later, valid, position, refresh, settleBeforeCommit = false, synchronousLayout = () => false }) {
  let pending = null, serial = 0, disposed = false;
  const sample = (e, block) => ({ offset: Math.max(0, e.offset - (e.origin.kind === 'plugin' ? e.by : 0)), contentRows: e.contentRows, bodyRows: e.bodyRows, ...(e.origin.kind === 'plugin' ? { anchorOffset: paneMarkerOffset(e, block) } : {}) });
  let latest = null, intent = 0;
  return {
    get latest() { return latest; },
    get intent() { return intent; },
    get pending() { return !!pending; },
    get nativeOffset() { return pending?.nativeOffset; },
    get disposed() { return disposed; },
    cancel() { disposed = true; serial++; pending = null; },
    stage(before, above, anchor = false, movement) {
      pending = { token: ++serial, intent, before, above, anchor, movement, staged: true, layoutChange: true, result: null };
    },
    observe(e) {
      if (e.origin.kind === 'person') {
        // Desktop reports resize/scroll anchoring as person input too. During
        // our own layout transaction, a changed geometry is not a new reading
        // position. Preserve the anchor; same-geometry input remains user-owned.
        const baseline = latest ?? pending?.before;
        const layoutChanged = pending?.layoutChange && baseline &&
          (e.contentRows !== baseline.contentRows || e.bodyRows !== baseline.bodyRows);
        if (!layoutChanged && !(settleBeforeCommit && pending?.before && e.by === 0)) {
          const anchorOffset = latest?.contentRows === e.contentRows && latest?.bodyRows === e.bodyRows ? latest.anchorOffset : undefined;
          latest = { ...sample(e), ...(Number.isFinite(anchorOffset) ? { anchorOffset } : {}) }; intent++; return e;
        }
        // A generic layout event has no reading-marker coordinate. Wait for
        // its keyed sample instead of inferring the prefix from total height.
        if (pending.anchor) return e;
      }
      if (!pending) { latest = sample(e); return e; }
      const request = pending;
      const measured = sample(e, request.block);
      request.clipped = request.block === 'end' && e.offset === 0;
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
      request.sampledMovement = request.movement?.() ?? 0;
      const offset = reference.offset + request.sampledMovement + (request.before && (request.above || request.anchor) ? delta : 0);
      const result = { ...measured, offset: Math.max(0, Math.min(offset, Math.max(0, measured.contentRows - measured.bodyRows))) };
      request.result = result;
      request.nativeOffset = settleBeforeCommit && request.before && !request.committing ? measured.offset : result.offset;
      if (settleBeforeCommit && request.before) {
        if (request.committing && !request.clipped) {
          // The host can finish a rich leaf between the last probe and this
          // dispatch. Commit the coordinate measured by the commit itself.
          request.commitObserved = true;
          return { ...e, offset: result.offset };
        }
        // The keyed scroll reveals the marker coordinate, but its native
        // movement must not expose partially painted history to the reader.
        return { ...e, offset: measured.offset };
      }
      latest = result;
      if (e.origin.kind === 'person') position(result.offset);
      return { ...e, offset: result.offset };
    },
    async measure(key, before = null, above = false, anchor = false, block = 'start') {
      const request = pending?.staged && pending.before === before && pending.above === above && pending.anchor === anchor
        ? pending : { token: ++serial, intent, before, above, anchor, result: null };
      const token = request.token;
      request.staged = false;
      pending = request;
      const current = () => !disposed && valid() && token === serial;
      let previous = null, result = null, elapsed = 0, settled = false;
      const atomic = settleBeforeCommit && before != null;
      // A missing key means the host has not painted this revision yet. The
      // retries are bounded and run independently of native scrolling.
      for (const delay of before ? anchor ? [0, 32, 64, 128, 256] : [0, 32, 64, 128] : [0, 16, 32, 64, 128]) {
        if (!current()) break;
        if (delay) await new Promise(resolve => later(delay, resolve));
        elapsed += delay;
        if (!current()) break;
        if (refresh) await refresh();
        if (!current()) break;
        request.result = null;
        request.block = block;
        let accepted = false;
        try { accepted = !(await scroll({ to: { key }, block }))?.deny; } catch { /* Not drawn yet. */ }
        if (!current()) break;
        if (accepted && request.result) {
          // An end-aligned marker can be in the first viewport after a trim.
          // The top alignment can measure that same marker after clamping.
          if (request.clipped) { block = 'start'; previous = null; continue; }
          result = request.result;
          if (!atomic) position(result.offset);
          const stable = anchor ? previous?.anchorOffset === result.anchorOffset : previous?.contentRows === result.contentRows;
          const minimum = atomic && synchronousLayout() ? 32 : anchor ? 224 : 96;
          if (!before || elapsed >= minimum && stable && previous.bodyRows === result.bodyRows) { settled = true; break; }
          previous = result;
        } else previous = null;
      }
      if (atomic) {
        // A painted reading marker is usable even while the surrounding
        // Markdown keeps growing. Its live size observer maintains the anchor.
        let committed = null;
        if ((settled || anchor || !above) && result) {
          for (let attempt = 0; attempt < 3 && current() && request.intent === intent; attempt++) {
            request.committing = true;
            request.commitObserved = false;
            request.block = block;
            let accepted = false;
            try { accepted = !(await scroll({ to: { key }, block }))?.deny; } catch { /* Commit failed. */ }
            if (accepted && request.commitObserved && !request.clipped) committed = { ...request.result, movement: request.sampledMovement, block };
            if (request.clipped) { block = 'start'; continue; }
            if (!request.commitObserved || request.sampledMovement === (request.movement?.() ?? 0)) break;
            // A wheel report arrived after dispatch sampled the commit target.
            // Resample before revealing the frame with that newer displacement.
          }
        }
        if (!committed || !current() || request.intent !== intent) result = null;
        else { result = latest = committed; position(result.offset); }
      }
      if (pending === request) pending = null;
      return current() ? result : null;
    },
  };
}

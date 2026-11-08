/**
 * Spread a batch of xterm `fit()` calls across animation frames — ONE per frame —
 * instead of running them all synchronously in a single tick.
 *
 * WHY: fitting N DOM-renderer terminals back-to-back in one tick is super-linear: each
 * fit() READS layout (to measure the glyph cell) right after the previous fit WROTE the
 * DOM, so every fit forces a full synchronous reflow of all the pending writes — classic
 * layout thrash. Measured: 8 terminals reclaiming the sidebar strip = ~570ms in one
 * frozen frame. Draining one fit per rAF lets the layout SETTLE between fits, so each
 * reads a clean layout and costs ~its own size only — turning one ~570ms lockup into a
 * handful of cheap frames the app stays interactive through.
 *
 * Dedupe by identity so a terminal that enqueues twice before its turn fits once.
 */
const queue: Array<() => void> = [];
let scheduled = false;

function drain(): void {
  scheduled = false;
  const job = queue.shift();
  if (job) { try { job(); } catch { /* fit on a disposed terminal is a no-op */ } }
  if (queue.length > 0) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(drain);
}

/** Queue a fit to run on a future frame (one fit per frame, FIFO, deduped). */
export function enqueueFit(fit: () => void): void {
  if (!queue.includes(fit)) queue.push(fit);
  schedule();
}

/** Drop a queued fit (e.g. on unmount) so we never call into a disposed terminal. */
export function cancelFit(fit: () => void): void {
  const i = queue.indexOf(fit);
  if (i >= 0) queue.splice(i, 1);
}

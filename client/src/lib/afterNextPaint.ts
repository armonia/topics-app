/**
 * Run `fn` in a task of its own, right after the next frame is painted.
 *
 * For a gesture whose visible answer is cheap (a dialog closing) and whose
 * consequence is heavy (a pane rendering): React flushes the updates of a
 * discrete event (keydown, click) synchronously, so doing both in the handler
 * holds the frame until the heavy render is done. Scheduling the heavy part
 * here lets the cheap part reach the screen first.
 *
 * rAF alone is not enough: its callback runs BEFORE the paint of that frame.
 * The message posted from it is delivered after the frame, which is the
 * earliest moment the paint is guaranteed. A hidden page draws no frames, so
 * there (and where rAF does not exist) it falls back to a plain task.
 */
export function afterNextPaint(fn: () => void): void {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (typeof requestAnimationFrame !== 'function' || typeof MessageChannel !== 'function' || hidden) {
    setTimeout(fn, 0);
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      fn();
    };
    channel.port2.postMessage(null);
  });
}

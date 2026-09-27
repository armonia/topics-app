/**
 * THE THREAD RECONCILE OF AN OPEN PANE: from `topic:updated` to a history read
 * (usePanelLifecycle, Cluster 1). The caller decides whether the chat is open;
 * this decides when, and how, it is read again.
 *
 * Debounced per session, so a finalize burst collapses to one fetch. A frame
 * that says rows changed with no turn's frames to carry them (`threadChanged`)
 * makes that read `fresh`, past the history dedup: without it a window that
 * read the chat in the last 5 s, which at boot is every window, dropped the
 * change (card edf3c4db). Kept apart from the timer, since a plain frame inside
 * the debounce resets it.
 */
export function createThreadReconcile(deps: {
  isOwnStream(sessionKey: string): boolean;
  isSessionStreaming(sessionKey: string): boolean;
  loadHistory(sessionKey: string, opts?: { fresh?: boolean }): void;
}): { request(sessionKey: string, threadChanged: boolean): void; dispose(): void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const fresh = new Set<string>();
  return {
    request(sessionKey, threadChanged) {
      // The window's own turn: its frames keep the chat in sync.
      if (deps.isOwnStream(sessionKey)) return;
      if (threadChanged) fresh.add(sessionKey);
      const pending = timers.get(sessionKey);
      if (pending) clearTimeout(pending);
      timers.set(sessionKey, setTimeout(() => {
        timers.delete(sessionKey);
        const pastDedup = fresh.delete(sessionKey);
        // Not while the turn streams into this window: its frames keep the
        // chat in sync, and a snapshot read in the middle of the turn held
        // the chunk still buffered for the next frame, drawn then twice.
        // Checked when the timer fires, not when the frame came: the
        // `topic:updated` that opens a turn arrives before its
        // `stream:start`, the one that closes it after its `stream:end`.
        if (deps.isSessionStreaming(sessionKey)) return;
        deps.loadHistory(sessionKey, pastDedup ? { fresh: true } : undefined);
      }, 400));
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      fresh.clear();
    },
  };
}

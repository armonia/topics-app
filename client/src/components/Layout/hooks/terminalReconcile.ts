/**
 * Pure decision for reconciling a project window's restored terminal panes
 * against the server session roster.
 *
 * Why this is subtle: a project's terminal/claude-code tabs are restored from
 * the saved layout (`nonChatPanes`) at mount, but their live identity comes
 * from the server roster. The naive rule "drop any terminal pane whose session
 * isn't in the roster" loses tabs on every refresh, because the roster is
 * momentarily empty/partial right after:
 *   - a server hot-reload (bun --watch restart — the in-memory session map is
 *     repopulated asynchronously by reconcileSessions),
 *   - a WebSocket reconnect following an Electron window refresh (a roster can
 *     arrive before reconcile finishes).
 * Pruning then, and persisting the pruned layout, deletes live Claude sessions
 * for good.
 *
 * The fix: a terminal pane is pruned ONLY when its session has been positively
 * SEEN in some roster and has since disappeared (e.g. closed in another
 * window). A pane whose session has never appeared yet is kept as pending — it
 * was just restored and the roster hasn't caught up. A truly-dead session that
 * never reappears lingers as a (recoverable) stale tab rather than silently
 * vanishing — the strictly safer failure mode.
 */

/**
 * @param sessionId    the terminal pane's pty session id.
 * @param rosterIds    session ids the current roster lists.
 * @param seenIds      session ids ever observed in ANY roster this mount.
 * @returns true to keep the pane, false to prune it.
 */
export function shouldKeepRestoredTerminalPane(
  sessionId: string,
  rosterIds: ReadonlySet<string>,
  seenIds: ReadonlySet<string>,
): boolean {
  // Present now → keep. Never seen → keep (restored, roster not caught up).
  // Seen-then-gone → prune (genuinely closed).
  return rosterIds.has(sessionId) || !seenIds.has(sessionId);
}

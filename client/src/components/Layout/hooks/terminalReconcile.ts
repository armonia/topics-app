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
 * The fix: a terminal pane is pruned when EITHER
 *   (a) its session has been positively SEEN in some roster and has since
 *       disappeared (e.g. closed in another window), OR
 *   (b) its session has never been seen AND an AUTHORITATIVE roster — a
 *       non-empty response from a server that is up and answering — does not
 *       list it. A restored id that is absent from a real, populated roster is
 *       a genuine corpse (a session from a previous run that no longer exists),
 *       not a still-loading pane.
 *
 * The `rosterAuthoritative` gate is what makes (b) safe: an EMPTY roster (the
 * server is mid hot-reload / reconcile hasn't repopulated the session map, or a
 * WS reconnect delivered a roster before reconcile finished) is NOT
 * authoritative, so never-seen panes are kept as pending during that window —
 * the original hot-reload / reconnect protection. Only once a populated roster
 * proves the server is live does an unknown, never-seen id get reaped.
 *
 * Without (b), a dead terminal id restored from a project's persisted
 * `nonChatPanes` after an app restart was kept FOREVER: it is never in any
 * roster, so it never transitions to seen-then-gone, and it waited on a roster
 * that would never contain it — surfacing as a permanent "dead session" tab in
 * the project window and its sidebar row.
 *
 * DORMANT is a third state, and it breaks (a) if you forget it. The roster is
 * built from the server's IN-MEMORY session map, and a parked session
 * (`TOPICS_TERMINAL_IDLE_PARK_MS`, lib/terminal-idle-park.ts) leaves that map
 * when its PTY dies — while its DB row survives as `dormant`, resumable with
 * `--resume` exactly where it was. To rule (a) that looks identical to "closed
 * in another window": seen, then gone. So parking a session would DELETE its
 * tab, and the layout would persist the deletion — the parking mechanism
 * eating the very thing it was parking.
 *
 * That is why the project layout used to revive every dormant session of the
 * project's cwd at mount: it forced them back into the roster BEFORE this
 * decision ran. It worked, and it made parking pointless (open a project → all
 * its parked processes come back at once). The honest fix is here instead:
 * dormant ids are passed in, and a dormant session is KEPT — it is parked, not
 * gone. The pane revives it lazily, only when it becomes active
 * (SingleTerminalPane, gated on `isActive`).
 *
 * AND THE DORMANT LIST GOES STALE THE MOMENT AFTER IT IS READ. It is fetched
 * once, at mount; a session that exits LATER (the user types `/exit` in a live
 * claude tab) is parked by the server right then, and the broadcast that
 * follows is built from the in-memory map alone. To a set captured minutes ago
 * that id is simply seen-then-gone, so the tab was deleted a second after the
 * exit and the persisted layout was rewritten before anyone could look at it:
 * the resumable row survived with nobody left to offer it.
 *
 * Hence the third verdict, `verify`: a disappearance is not evidence of death
 * until the dormant list has been re-read AFTER it. The caller keeps the pane,
 * asks the server again, and only an id the fresh answer does NOT list (it
 * lands in `confirmedGoneIds`) is finally pruned. That is also what terminates
 * the loop: without it a re-read would return `verify` forever.
 */

/** Keep the pane · re-read the dormant list before deciding · prune it. */
export type RestoredTerminalPaneVerdict = 'keep' | 'verify' | 'prune';

/**
 * @param sessionId            the terminal pane's pty session id.
 * @param rosterIds            session ids the current roster lists.
 * @param seenIds              session ids ever observed in ANY roster this mount.
 * @param rosterAuthoritative  true when `rosterIds` came from a server that is
 *                             up and answering (a NON-EMPTY roster). Defaults to
 *                             false so existing callers keep the never-seen
 *                             grace until they opt in.
 * @param dormantIds           session ids the server reports as PARKED
 *                             (`GET /api/terminal/sessions/dormant`). Absent
 *                             from the roster by construction, but alive as a
 *                             resumable row. Defaults to empty so existing
 *                             callers are unaffected.
 * @param confirmedGoneIds     session ids a dormant list read AFTER their
 *                             disappearance did not list: neither live nor
 *                             parked, so they are really gone.
 */
const NO_IDS: ReadonlySet<string> = new Set<string>();

export function decideRestoredTerminalPane(
  sessionId: string,
  rosterIds: ReadonlySet<string>,
  seenIds: ReadonlySet<string>,
  rosterAuthoritative = false,
  dormantIds: ReadonlySet<string> = NO_IDS,
  confirmedGoneIds: ReadonlySet<string> = NO_IDS,
): RestoredTerminalPaneVerdict {
  // Present now → keep.
  if (rosterIds.has(sessionId)) return 'keep';
  // Parked → keep. Must come BEFORE the seen-then-gone rule: to that rule a
  // parked session is indistinguishable from one closed elsewhere, and pruning
  // it would make the idle-park mechanism delete the tabs it is parking.
  if (dormantIds.has(sessionId)) return 'keep';
  // Seen-then-gone: closed in another window, or parked one second ago. The
  // dormant set in hand cannot tell them apart, because it was read before the
  // disappearance. Ask again; prune only once the fresh answer has ruled.
  if (seenIds.has(sessionId)) return confirmedGoneIds.has(sessionId) ? 'prune' : 'verify';
  // Never seen: keep while the roster is unproven (server mid-restart / partial
  // reconnect); prune once an authoritative, populated roster shows it's gone.
  return rosterAuthoritative ? 'prune' : 'keep';
}

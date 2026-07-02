/**
 * terminalLocator — the single "where is this terminal session currently
 * shown?" lookup. Pure, injectable, unit-testable.
 *
 * WHY THIS EXISTS
 * A terminal session's pane id is deterministic: `terminal:<sessionId>`
 * (createPaneId). That id is a GLOBAL identity — the same session can only
 * legitimately be shown in ONE place. But before this module the "is it already
 * open?" check was fragmented across the three open paths and each one only
 * looked at its OWN surface:
 *   - handleTerminalClick / handleFocusPanel checked only the app-level
 *     `openPanels` set, then blindly queued a `pendingProjectPane`.
 *   - the project's `pendingPane` consumer (useProjectLayout) checked only
 *     THAT project's inner `panes`.
 * So a session already open standalone (app-level tab) — or open inside a
 * DIFFERENT project window — was invisible to the path that decided to route it
 * into a project, and a NEW duplicate pane was created alongside the existing
 * one. Compounding it: whether a click routes to a project vs. standalone
 * depends on mutable UI state (an open project pane makes its cwd a "known
 * project"), so the SAME session flip-flopped between surfaces across clicks,
 * minting a second tab.
 *
 * This module unifies that check: it scans BOTH surfaces —
 *   (1) the app-level standalone pane set, and
 *   (2) every project's persisted inner layout (`topics-project-panes-<hash>`,
 *       the `nonChatPanes` array) —
 * and reports the ONE place the session is shown, so every open path can focus
 * the existing tab instead of adding a duplicate.
 *
 * Project-inner panes do NOT live in the pane store (they're device-local React
 * state persisted to localStorage — see projectLayoutSync.ts), so the only
 * cross-project source of truth readable synchronously is that localStorage
 * channel. We read it through an injected reader so the function stays pure and
 * testable without a DOM.
 */
import { getTerminalSessionFromPaneId } from './paneConfig';
import { projectPanesLocalKey } from './projectLayoutSync';

const PANES_PREFIX = 'topics-project-panes-';

/** Where a terminal session is currently shown.
 *  - `standalone`      — an app-level (top-level) tab hosts it.
 *  - `project`         — a named project window hosts it (path known).
 *  - `project-unknown` — a project layout hosts it but the caller didn't pass
 *                        the path, so we can't name it. The session IS already
 *                        open somewhere; the caller must NOT mint a duplicate.
 *  - `none`            — not open anywhere → safe to open fresh. */
export type TerminalLocation =
  | { kind: 'standalone' }
  | { kind: 'project'; projectPath: string }
  | { kind: 'project-unknown' }
  | { kind: 'none' };

/**
 * Minimal reader over the localStorage project-panes channel. Injected so the
 * locator is pure and unit-testable. In the app this is backed by
 * window.localStorage; in tests by a plain Map.
 */
export interface ProjectPanesStore {
  /** All keys currently present (so we can enumerate every open/known project's
   *  persisted layout without knowing the project paths up front). */
  keys(): string[];
  /** Raw JSON string for a key, or null. */
  getItem(key: string): string | null;
}

/** Adapt the real browser localStorage to ProjectPanesStore. Returns a store
 *  whose `keys()` yields only the project-panes keys. Safe on SSR / private
 *  mode (returns an empty store). */
export function browserProjectPanesStore(): ProjectPanesStore {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { keys: () => [], getItem: () => null };
  }
  const ls = window.localStorage;
  return {
    keys() {
      const out: string[] = [];
      try {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k && k.startsWith(PANES_PREFIX)) out.push(k);
        }
      } catch {
        /* access denied — treat as empty */
      }
      return out;
    },
    getItem(key) {
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    },
  };
}

/** Does a persisted project-panes record host `terminal:<sessionId>`? */
function recordHostsTerminal(raw: string | null, terminalPaneId: string): boolean {
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const panes = (parsed as { nonChatPanes?: unknown }).nonChatPanes;
  if (!Array.isArray(panes)) return false;
  return panes.some(
    (p) => p && typeof p === 'object' && (p as { id?: unknown }).id === terminalPaneId,
  );
}

/**
 * Find where terminal session `sessionId` is currently shown.
 *
 * Precedence: standalone (app-level) wins if the pane id is present there,
 * otherwise the first project whose persisted layout lists it. The app-level
 * set is authoritative and cheap; the project scan is the fallback that catches
 * cross-project / in-project duplicates the app-level check can't see.
 *
 * @param sessionId          the terminal session id (NOT the pane id)
 * @param appLevelPaneIds    ids currently in the app-level tab set (openPanels)
 * @param knownProjectPaths  project paths to check FIRST (e.g. the one being
 *                           routed to) — an optimization + determinism aid; the
 *                           full localStorage scan still runs so a project not
 *                           in this set is still found.
 * @param store              reader over the project-panes localStorage channel
 */
export function locateTerminalPane(
  sessionId: string,
  appLevelPaneIds: readonly string[],
  knownProjectPaths: readonly string[],
  store: ProjectPanesStore,
): TerminalLocation {
  if (!sessionId) return { kind: 'none' };
  const terminalPaneId = `terminal:${sessionId}`;

  // 1) App-level standalone surface.
  if (appLevelPaneIds.includes(terminalPaneId)) return { kind: 'standalone' };

  // 2) Preferred project paths first (deterministic when a caller knows the
  //    target project) — map each to its storage key and check.
  const checkedKeys = new Set<string>();
  for (const projectPath of knownProjectPaths) {
    const key = projectPanesLocalKey(projectPath);
    checkedKeys.add(key);
    if (recordHostsTerminal(store.getItem(key), terminalPaneId)) {
      return { kind: 'project', projectPath };
    }
  }

  // 3) Full scan of every persisted project layout — catches a project whose
  //    path the caller didn't pass (a session open in a project window the
  //    current click has no reference to). The localStorage key is a one-way
  //    hash of the path, so a hit here can only be attributed to a path if we
  //    were also given it in `knownProjectPaths`; otherwise we know a duplicate
  //    exists but can't name its window → `project-unknown`, which still tells
  //    the caller "do NOT open a fresh one".
  const pathByKey = new Map<string, string>();
  for (const projectPath of knownProjectPaths) {
    pathByKey.set(projectPanesLocalKey(projectPath), projectPath);
  }
  for (const key of store.keys()) {
    if (checkedKeys.has(key)) continue;
    if (recordHostsTerminal(store.getItem(key), terminalPaneId)) {
      const projectPath = pathByKey.get(key);
      return projectPath ? { kind: 'project', projectPath } : { kind: 'project-unknown' };
    }
  }

  return { kind: 'none' };
}

/** Convenience: extract the session id from a pane id and locate it. Returns
 *  'none' for non-terminal pane ids. */
export function locateByPaneId(
  paneId: string,
  appLevelPaneIds: readonly string[],
  knownProjectPaths: readonly string[],
  store: ProjectPanesStore,
): TerminalLocation {
  const sessionId = getTerminalSessionFromPaneId(paneId);
  if (!sessionId) return { kind: 'none' };
  return locateTerminalPane(sessionId, appLevelPaneIds, knownProjectPaths, store);
}

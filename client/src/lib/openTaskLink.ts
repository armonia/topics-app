// URL router for the kanban board — the ONE module that reads and writes the
// app's location for board deep-links. Everything about the `/task/…` route
// lives here so there is a single, testable contract.
//
// ── Supported URL forms (the whole client surface) ───────────────────────────
//   /task/<taskId>   (PATH-BASED, current)
//       Deep-link to a task in the GLOBAL board ("Board generale"). Opening the
//       URL ACTIVATES the global board pane (surviving the pane-store hydrate,
//       see usePanelLifecycle deep-link intent), selects the task and opens its
//       drawer. It is ALSO the live reflection of the open drawer: opening a
//       drawer pushes this path, closing it returns to '/' — so every kanban
//       view has a copyable, refresh-survivable URL and back/forward navigate
//       the drawer. The taskId is a globally-unique UUID, so it resolves the
//       task on its own (WHERE id=<uuid>); the project slug is redundant and no
//       longer part of the URL. The board resolves `projectId` from the loaded
//       task list (it holds every task) when it needs the /api/boards/:projectId
//       endpoints.
//   ?task=<projectId>~<taskId>   (LEGACY query form — read-only back-compat)
//       The previous deep-link format. Links already pasted into merged review
//       comments still open in-app: parse() reads this too, and the first
//       drawer reflection upgrades the URL to the clean `/task/<id>` path.
//   ?topics=a,b,c   (alias: ?topic=a)   — handled in App.tsx, NOT here
//       Detached / pop-out window contract: the OS window boots showing exactly
//       these topics and skips pane-store sync (see popOutTopic.ts + App
//       `detachedTopicIds`). Documented here so the param map is in one place.
//
// This module never strips the deep-link on load (a refresh must recover the
// drawer); the path returns to '/' only when the drawer is closed.

import { serverHttpBase } from './shell/net';

// Legacy query form (`?task=<projectId>~<taskId>`), kept for read back-compat.
const LEGACY_PARAM = 'task';
const LEGACY_SEP = '~';

// New path form: /task/<taskId>. Match a single non-empty segment; a trailing
// slash is tolerated. Anything deeper (/task/a/b) is not a deep-link.
const TASK_PATH_RE = /^\/task\/([^/]+)\/?$/;

export interface TaskTarget {
  taskId: string;
}

export function buildTaskLink(taskId: string): string {
  // Build against a REAL, openable server origin — NOT window.location.origin.
  // On the Tauri desktop shell the UI is served from `tauri://localhost`, an
  // origin that can't be opened/shared (opening it just spawns a browser);
  // `serverHttpBase()` gives the data server (`http://127.0.0.1:13333` on
  // desktop, same-machine). On web it returns '' → fall back to the page origin
  // (the actual https server / tunnel). Same-machine only; LAN sharing needs
  // the LAN host and is out of scope.
  const base = serverHttpBase() || window.location.origin;
  const u = new URL(base);
  u.pathname = `/task/${taskId}`;
  u.search = '';
  return u.toString();
}

/** Parse a location (pathname + search) into a task target, or null. Reads the
 *  new `/task/<id>` path first, then falls back to the legacy `?task=slug~id`
 *  query so links pasted before the migration still resolve. */
export function parseTaskLocation(pathname: string, search: string): TaskTarget | null {
  const m = TASK_PATH_RE.exec(pathname);
  if (m && m[1]) {
    try {
      return { taskId: decodeURIComponent(m[1]) };
    } catch {
      return { taskId: m[1] };
    }
  }
  return parseLegacyQuery(search);
}

// Legacy `?task=<projectId>~<taskId>`. Both ids contain '-' but never '~', so
// '~' is an unambiguous split point (split on the FIRST '~'; the projectId is a
// free-form slug, the taskId a fixed-length UUID). Only the taskId survives —
// the projectId was always redundant.
function parseLegacyQuery(search: string): TaskTarget | null {
  try {
    const raw = new URLSearchParams(search).get(LEGACY_PARAM);
    if (!raw) return null;
    const i = raw.indexOf(LEGACY_SEP);
    if (i <= 0 || i >= raw.length - 1) return null;
    return { taskId: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

/** The task encoded in the CURRENT location, or null. The board reads this on
 *  mount (and on popstate) — it is the source of truth, not a one-shot, so it
 *  survives a remount / an inactive→active board tab (the old `pending` was
 *  consumed once and lost if the board wasn't the mounted-active pane). */
export function currentTaskTarget(): TaskTarget | null {
  return parseTaskLocation(window.location.pathname, window.location.search);
}

// ── Self-origin detection (in-app link interception) ─────────────────────────

/** True if `origin` is one this app is served from — either the page origin
 *  (web/Electron: same-origin) or the data server origin (`serverHttpBase()` on
 *  the Tauri shell, where the UI itself runs from tauri://localhost). */
function isSelfOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true;
  const serverBase = serverHttpBase();
  if (serverBase) {
    try { return origin === new URL(serverBase).origin; } catch { /* fall through */ }
  }
  return false;
}

/** If `url` is a SELF-origin board deep-link, return its target so the caller
 *  can open the drawer IN-APP instead of spawning an external browser (a
 *  buildTaskLink URL pasted into a review comment points back at this very
 *  app). Recognizes BOTH the new `/task/<id>` path and the legacy
 *  `?task=slug~id` query. Non-self URLs return null → caller falls back to
 *  openExternalOnce. */
export function selfTaskLinkTarget(url: string): TaskTarget | null {
  try {
    const u = new URL(url, window.location.origin);
    if (!isSelfOrigin(u.origin)) return null;
    return parseTaskLocation(u.pathname, u.search);
  } catch {
    return null;
  }
}

// ── URL reflection (drawer open/close ⇄ /task/<id>) ──────────────────────────

// The pathname check below is also the loop guard: when a popstate drives the
// selection, the reflect effect re-runs but the URL already carries the target
// path, so reflectPath no-ops instead of pushing a duplicate entry. Reflecting
// also DROPS any legacy `?task=` query, so an old link that opened a drawer is
// upgraded to the clean `/task/<id>` path on first reflection.
function reflectPath(target: TaskTarget | null): void {
  try {
    const desired = target ? `/task/${target.taskId}` : '/';
    if (window.location.pathname === desired && !window.location.search) return;
    const u = new URL(window.location.href);
    u.pathname = desired;
    u.search = '';
    window.history.pushState(null, '', u.toString());
  } catch {
    /* history unavailable — local state still drives the UI, URL just stays put */
  }
}

/** Drawer opened for a task → push `/task/<id>` (a new history entry, so Back
 *  closes it). No-op if the URL already reflects this target. */
export function reflectTaskOpen(target: TaskTarget): void {
  reflectPath(target);
}

/** Drawer closed → return to '/' (a new history entry, so Back reopens the
 *  previous task). No-op if the path is already '/'. */
export function reflectTaskClose(): void {
  reflectPath(null);
}

/** Subscribe to browser back/forward: `cb` gets the task now in the URL (or
 *  null). The board uses it to drive the drawer selection from history. */
export function subscribePopstateTask(cb: (target: TaskTarget | null) => void): () => void {
  const handler = () => cb(currentTaskTarget());
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}

// ── Open in-app ──────────────────────────────────────────────────────────────

/** Activate the global board and open `target`'s drawer, IN-APP. Reflected in
 *  the URL by the board once its drawer opens. Used both at boot (openTaskFromUrl)
 *  and by self-origin link interception (a buildTaskLink URL pasted in a comment
 *  points back at this app — open the drawer instead of spawning a browser). */
export function openTaskInApp(target: TaskTarget): void {
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } }));
  window.dispatchEvent(new CustomEvent('topics:open-task', { detail: target }));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/** Called once at boot (App). If the URL carries a deep-link (new `/task/<id>`
 *  path or legacy `?task=`), ACTIVATE the global board and hand it the target.
 *  The location is NOT stripped: the URL stays the source of truth (a refresh
 *  recovers the drawer; the board reads `currentTaskTarget()` on mount whenever
 *  it activates), cleared only when the drawer closes.
 *
 *  Emits a live `topics:open-task` for a board already open, and
 *  `topics:open-utility` (board) which usePanelLifecycle turns into a
 *  hydrate-surviving deep-link intent so the board actually becomes active. */
export function openTaskFromUrl(): void {
  const target = currentTaskTarget();
  if (target) openTaskInApp(target);
}

// URL router for the kanban board — the ONE module that reads and writes the
// app's location for board deep-links. Everything about `?task=` lives here so
// there is a single, testable contract.
//
// ── Supported URL params (the whole client surface) ──────────────────────────
//   ?task=<projectId>~<taskId>
//       Deep-link to a task in the GLOBAL board ("Board generale"). Opening the
//       URL ACTIVATES the global board pane (surviving the pane-store hydrate,
//       see usePanelLifecycle deep-link intent), selects the task and opens its
//       drawer. It is ALSO the live reflection of the open drawer: opening a
//       drawer pushes this param, closing it removes the param — so every
//       kanban view has a copyable, refresh-survivable URL and back/forward
//       navigate the drawer. Both ids contain '-' but never '~', so '~' is an
//       unambiguous split point (split on the FIRST '~': the taskId is a
//       fixed-length UUID, the projectId a free-form slug).
//   ?topics=a,b,c   (alias: ?topic=a)   — handled in App.tsx, NOT here
//       Detached / pop-out window contract: the OS window boots showing exactly
//       these topics and skips pane-store sync (see popOutTopic.ts + App
//       `detachedTopicIds`). Documented here so the param map is in one place.
//
// This module never strips ?task on load (a refresh must recover the drawer);
// the param leaves the URL only when the drawer is closed.

import { serverHttpBase } from './shell/net';

const PARAM = 'task';
const SEP = '~';

export interface TaskTarget {
  projectId: string;
  taskId: string;
}

export function buildTaskLink(projectId: string, taskId: string): string {
  // Build against a REAL, openable server origin — NOT window.location.origin.
  // On the Tauri desktop shell the UI is served from `tauri://localhost`, an
  // origin that can't be opened/shared (opening it just spawns a browser);
  // `serverHttpBase()` gives the data server (`http://127.0.0.1:13333` on
  // desktop, same-machine). On web it returns '' → fall back to the page origin
  // (the actual https server / tunnel). Same-machine only; LAN sharing needs
  // the LAN host and is out of scope.
  const base = serverHttpBase() || window.location.origin;
  const u = new URL(base);
  u.search = composeSearch(u.search, `${projectId}${SEP}${taskId}`);
  return u.toString();
}

// Serialize a query string with the task param kept LITERAL (`projectId~taskId`).
// URLSearchParams form-encodes '~' to %7E — valid (it round-trips through
// parseTaskLink) but ugly in a copied/shared link. '~' is an RFC 3986 unreserved
// char and both ids are URL-safe (slug + UUID), so we emit the task param raw via
// `url.search =` (the WHATWG query percent-encode set excludes '~'). OTHER params
// keep their normal URLSearchParams encoding. The task goes FIRST so a copied
// link reads `?task=…` up front.
function composeSearch(search: string, taskValue: string | null): string {
  const others = new URLSearchParams(search);
  others.delete(PARAM);
  const rest = others.toString();
  const task = taskValue === null ? '' : `${PARAM}=${taskValue}`;
  const q = [task, rest].filter(Boolean).join('&');
  return q ? `?${q}` : '';
}

export function parseTaskLink(search: string): TaskTarget | null {
  try {
    const raw = new URLSearchParams(search).get(PARAM);
    if (!raw) return null;
    const i = raw.indexOf(SEP);
    if (i <= 0 || i >= raw.length - 1) return null;
    return { projectId: raw.slice(0, i), taskId: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

/** The task encoded in the CURRENT location, or null. The board reads this on
 *  mount (and on popstate) — it is the source of truth, not a one-shot, so it
 *  survives a remount / an inactive→active board tab (the old `pending` was
 *  consumed once and lost if the board wasn't the mounted-active pane). */
export function currentTaskTarget(): TaskTarget | null {
  return parseTaskLink(window.location.search);
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
 *  app). Non-self URLs return null → caller falls back to openExternalOnce. */
export function selfTaskLinkTarget(url: string): TaskTarget | null {
  try {
    const u = new URL(url, window.location.origin);
    if (!isSelfOrigin(u.origin)) return null;
    return parseTaskLink(u.search);
  } catch {
    return null;
  }
}

// ── URL reflection (drawer open/close ⇄ ?task=) ──────────────────────────────

// The value-equality checks below are also the loop guard: when a popstate
// drives the selection, the reflect effect re-runs but the URL already carries
// the target, so writeTaskParam no-ops instead of pushing a duplicate entry.
function writeTaskParam(next: string | null): void {
  try {
    const u = new URL(window.location.href);
    // Guard (also the popstate loop guard): searchParams.get/has DECODE, so a
    // literal '~' and a stale %7E both compare equal to `next` here — no dup push.
    if (next === null) {
      if (!u.searchParams.has(PARAM)) return; // nothing to remove
    } else {
      if (u.searchParams.get(PARAM) === next) return; // already reflected
    }
    u.search = composeSearch(u.search, next); // keeps '~' literal
    window.history.pushState(null, '', u.toString());
  } catch {
    /* history unavailable — local state still drives the UI, URL just stays put */
  }
}

/** Drawer opened for a task → push `?task=` (a new history entry, so Back
 *  closes it). No-op if the URL already reflects this target. */
export function reflectTaskOpen(target: TaskTarget): void {
  writeTaskParam(`${target.projectId}${SEP}${target.taskId}`);
}

/** Drawer closed → remove `?task=` (a new history entry, so Back reopens the
 *  previous task). No-op if the param is already absent. */
export function reflectTaskClose(): void {
  writeTaskParam(null);
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

/** Called once at boot (App). If the URL carries ?task=, ACTIVATE the global
 *  board and hand it the target. Unlike before, the param is NOT stripped: the
 *  URL stays the source of truth (a refresh recovers the drawer; the board
 *  reads `currentTaskTarget()` on mount whenever it activates), and it is the
 *  reflection cleared only when the drawer closes.
 *
 *  Emits a live `topics:open-task` for a board already open, and
 *  `topics:open-utility` (board) which usePanelLifecycle turns into a
 *  hydrate-surviving deep-link intent so the board actually becomes active. */
export function openTaskFromUrl(): void {
  const target = currentTaskTarget();
  if (target) openTaskInApp(target);
}

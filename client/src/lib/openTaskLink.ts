// URL router for the kanban board — the ONE module that reads and writes the
// app's location for board deep-links. Everything about the `/task/…` route
// lives here so there is a single, testable contract.
//
// ── Supported URL forms (the whole client surface) ───────────────────────────
//   /task/<title-slug>-<taskId>   (PATH-BASED, current)
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
//       What comes BEFORE the uuid is the task title, slugged, and it is pure
//       DECORATION: whoever gets the link in a chat reads what it is about, and
//       reading the URL throws it away (`taskIdFromSegment`). A wrong slug, or
//       a title renamed after the link was sent, opens the same task — the day
//       the prefix started to matter it would have stopped being decoration and
//       gone back to being addressing.
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

import { isAppLoopbackOrigin, serverHttpBase } from './shell/net';
import { taskIdFromSegment, taskLinkSegment } from '../../../shared/task-slug';
// The deep-link FRONT DOOR (`openDeepLinkInApp`, `openTopicInApp`, the
// service-worker listener) lives in ./deepLinkEntry, one layer ABOVE this file:
// it needs the single gate in `tabLink`, and `tabLink` already imports this
// module. Keeping it here made the two import each other.

// Legacy query form (`?task=<projectId>~<taskId>`), kept for read back-compat.
const LEGACY_PARAM = 'task';
const LEGACY_SEP = '~';

// New path form: /task/<taskId>. Match a single non-empty segment; a trailing
// slash is tolerated. Anything deeper (/task/a/b) is not a deep-link.
const TASK_PATH_RE = /^\/task\/([^/]+)\/?$/;

// Il gemello per la CHAT: `/topic/<topicId>`. La push di fine risposta
// (server/push-triggers.ts) ci manda qui — apre la tab del topic in-app.
const TOPIC_PATH_RE = /^\/topic\/([^/]+)\/?$/;

export interface TaskTarget {
  taskId: string;
}

export interface TopicTarget {
  topicId: string;
}

export function buildTaskLink(taskId: string, title?: string | null): string {
  // Build against a REAL, openable server origin — NOT window.location.origin.
  // On the Tauri desktop shell the UI is served from `tauri://localhost`, an
  // origin that can't be opened/shared (opening it just spawns a browser);
  // `serverHttpBase()` gives the data server (`http://127.0.0.1:13333` on
  // desktop, same-machine). On web it returns '' → fall back to the page origin
  // (the actual https server / tunnel). Same-machine only; LAN sharing needs
  // the LAN host and is out of scope.
  //
  // `title` only decorates the path (`<slug>-<uuid>`): pass it whenever it is
  // at hand, leave it out and the link is the bare uuid, which resolves the
  // same. Nothing downstream reads it back.
  const base = serverHttpBase() || window.location.origin;
  const u = new URL(base);
  u.pathname = `/task/${taskLinkSegment(taskId, title)}`;
  u.search = '';
  return u.toString();
}

/** Parse a location into a TOPIC target, or null. The chat end-of-turn push
 *  points at `/topic/<id>`; opening it activates that topic's chat tab. */
export function parseTopicLocation(pathname: string): TopicTarget | null {
  const m = TOPIC_PATH_RE.exec(pathname);
  if (m && m[1]) {
    try {
      return { topicId: decodeURIComponent(m[1]) };
    } catch {
      return { topicId: m[1] };
    }
  }
  return null;
}

/** Parse a location (pathname + search) into a task target, or null. Reads the
 *  new `/task/<id>` path first, then falls back to the legacy `?task=slug~id`
 *  query so links pasted before the migration still resolve. */
export function parseTaskLocation(pathname: string, search: string): TaskTarget | null {
  const m = TASK_PATH_RE.exec(pathname);
  if (m && m[1]) {
    let segment = m[1];
    try {
      segment = decodeURIComponent(segment);
    } catch { /* not percent-encoded: read the raw segment */ }
    // Drop the decorative title slug, if any: only the trailing uuid resolves.
    return { taskId: taskIdFromSegment(segment) };
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
 *  the Tauri shell, where the UI itself runs from tauri://localhost).
 *
 *  ESPORTATA perché il permalink delle TAB (`lib/tabLink.ts`) deve decidere la
 *  stessa identica cosa — «questa URL punta a NOI?» — e una seconda copia della
 *  regola diverge alla prima origine nuova: sul guscio Tauri le origini valide
 *  sono due, e chi ne conosce una sola manda l'utente in un browser esterno
 *  invece di aprire la tab in-app. */
export function isSelfOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true;
  const serverBase = serverHttpBase();
  if (serverBase) {
    try { if (origin === new URL(serverBase).origin) return true; } catch { /* fall through */ }
  }
  // The third case, and the one the two above cannot cover: the SAME app reached
  // on its OTHER loopback port. The shell can only mint 13333 (its webview knows
  // no other door) while the web client and the agent tools mint 3333, so every
  // permalink that crosses between them used to miss both equalities and leave
  // through the system browser. See `isAppLoopbackOrigin`.
  return isAppLoopbackOrigin(origin);
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

/** Il gemello per la CHAT: se `url` è un deep-link SELF-origin `/topic/<id>`,
 *  restituisce il topic da aprire in-app (la push di fine risposta ci manda
 *  qui). Non-self o non-topic → null. */
export function selfTopicLinkTarget(url: string): TopicTarget | null {
  try {
    const u = new URL(url, window.location.origin);
    if (!isSelfOrigin(u.origin)) return null;
    return parseTopicLocation(u.pathname);
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
//
// A path ALREADY pointing at this task is left exactly as it is, decoration
// included: the incoming link's slug (right, wrong or absent) is not worth a
// second history entry that Back would have to walk back through with nothing
// visible changing. The canonical `<slug>-<uuid>` is written when the URL was
// somewhere else — which is the case that puts a readable link in the address
// bar, opening a drawer from the board.
function reflectPath(target: TaskTarget | null, title?: string | null, mode: 'push' | 'replace' = 'push'): void {
  try {
    const already = target && parseTaskLocation(window.location.pathname, '')?.taskId === target.taskId;
    const desired = target
      ? (already ? window.location.pathname : `/task/${taskLinkSegment(target.taskId, title)}`)
      : '/';
    // `?space=` SOPRAVVIVE alla riflessione. In una finestra-GRUPPO quella
    // query non è un parametro di navigazione: è l'IDENTITÀ della finestra —
    // dice quale gruppo disegna (`lib/windowRole.spaceWindowId`). Cancellarla
    // la degrada a finestra principale, e siccome la board è quasi sempre
    // aperta la riflessione partiva al primo montaggio: la finestra staccata
    // perdeva il suo gruppo PRIMA ancora di annunciarsi, quindi disegnava le
    // stesse tab della principale (il "detach duplicato") e nessuno la
    // riconosceva come la casa di quel gruppo (il simbolo che non compariva).
    // Misurato il 05/08/2026: `pushState('/')` da KanbanBoardPane, e la query
    // spariva 4 s dopo il boot.
    const pinnedSpace = new URLSearchParams(window.location.search).get('space');
    const keep = pinnedSpace ? `?space=${encodeURIComponent(pinnedSpace)}` : '';
    if (window.location.pathname === desired && window.location.search === keep) return;
    const u = new URL(window.location.href);
    u.pathname = desired;
    u.search = '';
    if (pinnedSpace) u.searchParams.set('space', pinnedSpace);
    if (mode === 'replace') window.history.replaceState(null, '', u.toString());
    else window.history.pushState(null, '', u.toString());
  } catch {
    /* history unavailable — local state still drives the UI, URL just stays put */
  }
}

/** Drawer opened for a task → push `/task/<slug>-<id>` (a new history entry, so
 *  Back closes it). `title` is the decoration; without it the path is the bare
 *  id, which resolves the same. No-op if the URL already points at this task. */
export function reflectTaskOpen(target: TaskTarget, title?: string | null): void {
  reflectPath(target, title);
}

/** Drawer closed → return to '/' (a new history entry, so Back reopens the
 *  previous task). No-op if the path is already '/'. */
export function reflectTaskClose(): void {
  reflectPath(null);
}
/** The board tab lost or regained the focus while its drawer is open.
 *
 *  The URL mirrors the drawer only while the board is the tab on screen. On
 *  2026-09-03 a `/task/<id>` left behind after switching to a project tab was
 *  read by the next reload as a boot deep-link, and the reload landed on the
 *  kanban with the drawer instead of on the tab the user was on. Leaving a tab
 *  is not a navigation, so this REPLACES the entry: Back keeps its meaning
 *  (close the drawer), and a leftover path never survives a reload.
 *  `target` is the open drawer (board back on screen) or null (board hidden). */
export function reflectTaskFocus(target: TaskTarget | null, title?: string | null): void {
  reflectPath(target, title, 'replace');
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
  // PRIMA la URL, poi gli eventi. L'ordine è load-bearing quando la board non è
  // ancora montata — il caso della cronologia delle notifiche, dove il click
  // parte dalla colonna e non da una board già aperta.
  //
  // `topics:open-task` lo ascolta la board GLOBALE, cioè un componente che in
  // quel momento non esiste: l'evento cade nel vuoto e `topics:open-utility`
  // monta la pane un istante dopo, quando l'unica cosa che il drawer può
  // leggere è `currentTaskTarget()` — la URL. Senza questa riga il pannello si
  // apriva e restava sulla lista, senza drawer, e il click della notifica non
  // portava «alla cosa». Con la board già aperta non cambia niente: l'evento
  // arriva comunque e `reflectPath` non spinge un duplicato.
  reflectTaskOpen(target);
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } }));
  window.dispatchEvent(new CustomEvent('topics:open-task', { detail: target }));
}


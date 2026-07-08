/**
 * Durable origin map for PROJECT browser panes: contextId → { projectPath, url }.
 *
 * WHY THIS EXISTS (structural fix, 2026-07-08)
 * A browser pane opened INSIDE a project persists its url ONLY in that project's
 * layout snapshot (`topics-project-panes-<hash>`, written via
 * `useProjectLayout.updatePane`) — NEVER in the global `usePaneStore`
 * (`persistBrowserPaneUrl` no-ops for non-store project panes). On close the
 * pane is STRIPPED from that snapshot (+ browser-tombstoned), so the url then
 * survives only on the bounded `closedStack` (50 entries, FIFO). A browser
 * pinned long ago — or one whose close record got corrupted to a
 * non-project/non-browser shape — is EVICTED from that stack, leaving the bare
 * `browser:<ctx>` pin (localStorage `pinnedItems`) with NO project and NO url.
 * Reopening it via its "Fissati" row then falls to a STANDALONE about:blank pane,
 * out of its project — the reported bug.
 *
 * This store is the durable, closedStack-INDEPENDENT association. It is written
 * on EVERY project-browser navigation (the single `updatePane` url choke-point)
 * and — unlike the snapshot — is NOT cleared on close, so `openBrowserPane` can
 * always route a pinned browser back into its owning project with its last url.
 * localStorage (device-local, survives reload/restart), matching the pins it
 * serves (`pinnedItems` is also localStorage-only). Bounded LRU so it can never
 * grow without limit.
 */

import type { ClosedTabRecord } from './closedTabRecord';

const KEY = 'topics-browser-origin-v1';
/** LRU cap. Each entry is tiny (a url + a path); 200 covers any realistic pin set. */
const MAX = 200;

export interface BrowserOrigin {
  projectPath: string;
  url: string;
  title?: string;
  /** last-write epoch ms — LRU eviction key. */
  ts: number;
}

type OriginMap = Record<string, BrowserOrigin>;

function read(): OriginMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as OriginMap) : {};
  } catch {
    return {};
  }
}

function write(map: OriginMap): void {
  try {
    // Bound to the MAX most-recently-written entries (LRU by ts).
    const entries = Object.entries(map);
    if (entries.length > MAX) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      map = Object.fromEntries(entries.slice(0, MAX));
    }
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* localStorage may be full or unavailable — origin is best-effort. */
  }
}

/**
 * Record (or refresh) a project browser's durable origin. Called from
 * `useProjectLayout.updatePane` on every url write. `about:blank`/empty urls are
 * ignored so a dead/initial pane never overwrites a good origin. A later write
 * with no title KEEPS the prior title (merge semantics) — the reopened pane
 * re-derives its title from the loaded page anyway.
 */
export function recordBrowserOrigin(
  contextId: string,
  projectPath: string,
  url: string,
  title?: string,
): void {
  if (!contextId || !projectPath) return;
  if (!url || url === 'about:blank') return;
  const map = read();
  const prev = map[contextId];
  map[contextId] = {
    projectPath,
    url,
    title: title ?? prev?.title,
    ts: Date.now(),
  };
  write(map);
}

/** Look up a pinned/closed browser's durable origin by contextId. */
export function getBrowserOrigin(contextId: string): BrowserOrigin | null {
  if (!contextId) return null;
  return read()[contextId] ?? null;
}

/**
 * Resolve the durable project origin for a pinned browser paneId, for the
 * SIDEBAR row. A browser pinned INSIDE a project, once its tab is CLOSED, is
 * STRIPPED from the project snapshot — so the sidebar builder loses both the
 * `projectPath` (row leaks to the top-level Fissati block instead of nesting
 * under its project) AND the page title. This merges the two durable sources so
 * the row can be rebuilt:
 *   1. the origin store (`getBrowserOrigin`) — survives closedStack eviction,
 *      the freshest last-navigation snapshot → wins when present;
 *   2. the closedStack record for this exact pane — covers a pin closed before
 *      the store captured it (e.g. never re-navigated after the store shipped);
 *      its record is still on the bounded stack right after close.
 * Returns null for a bare pin with neither source (genuinely unrecoverable —
 * the url was never stored outside the ephemeral snapshot/stack).
 */
export function resolvePinnedBrowserOrigin(
  paneId: string,
  closedTabs: ClosedTabRecord[],
): BrowserOrigin | null {
  const contextId = paneId.startsWith('browser:') ? paneId.slice('browser:'.length) : paneId;
  const stored = getBrowserOrigin(contextId);
  if (stored?.projectPath) return stored;
  const rec = closedTabs.find(
    (r) =>
      r.pane?.id === paneId &&
      r.level === 'project' &&
      !!r.projectPath &&
      r.pane?.type === 'browser',
  );
  if (rec?.projectPath) {
    return {
      projectPath: rec.projectPath,
      url: typeof rec.pane.url === 'string' ? rec.pane.url : '',
      title: typeof rec.pane.title === 'string' ? rec.pane.title : undefined,
      ts: rec.closedAt || 0,
    };
  }
  return null;
}

/** Drop a contextId's origin (e.g. when its pin is removed). Best-effort. */
export function clearBrowserOrigin(contextId: string): void {
  if (!contextId) return;
  const map = read();
  if (contextId in map) {
    delete map[contextId];
    write(map);
  }
}

/**
 * Session-scoped bridge for the PROJECT-NOT-OPEN case: when a pinned browser is
 * reopened but no ProjectWindow is mounted to claim the `reopen-closed-tab`
 * event, `openBrowserPane` opens the project AND parks the synthetic record here.
 * The ProjectWindow drains its queue on mount and restores the browser (with its
 * url) as soon as it exists. In-memory only — it bridges an async open→mount gap
 * within one session, not across reloads.
 */
const pendingReopens = new Map<string, ClosedTabRecord[]>();

export function enqueueProjectBrowserReopen(projectPath: string, record: ClosedTabRecord): void {
  const list = pendingReopens.get(projectPath) ?? [];
  // De-dup by pane id so a double-click can't queue the same reopen twice.
  if (list.some(r => r.pane.id === record.pane.id)) return;
  list.push(record);
  pendingReopens.set(projectPath, list);
}

export function drainProjectBrowserReopens(projectPath: string): ClosedTabRecord[] {
  const list = pendingReopens.get(projectPath);
  if (!list || list.length === 0) return [];
  pendingReopens.delete(projectPath);
  return list;
}

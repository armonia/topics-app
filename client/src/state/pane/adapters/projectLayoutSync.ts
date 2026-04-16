/**
 * Adapter for client/src/lib/projectLayoutSync.ts — saves project layouts via
 * the unified reducer snapshot instead of per-project ui_state keys.
 *
 * The legacy per-project server key (project-layout-<hash>) is no longer
 * used; the reducer's `pane-store-v2` snapshot includes `projects` keyed by
 * projectPath and the syncServer middleware handles the PUT. This adapter is
 * intentionally thin: it holds the 2000 ms debounce that legacy callers
 * depend on and dispatches PROJECT_LAYOUT_SNAPSHOT / PROJECT_LAYOUT_RESTORE.
 *
 * Legacy localStorage writes are preserved so a cold reload between plans
 * 07-08 (partial cutover) still finds the same keys where call sites expect
 * them.
 */
import { usePaneStore, type PaneStore } from '../store';
import type { ProjectLayout } from '../types';

const DEBOUNCE_MS = 2000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Safety net for loadProjectLayout subscribe leaks (see below). If the reducer
// never hydrates with `projects[projectPath]` (e.g. the user closed the tab
// before the WS ui-state:init landed), the subscription would otherwise live
// for the lifetime of the document. Cap it at 30 s.
const LOAD_SUBSCRIBE_TIMEOUT_MS = 30_000;

// Storage-key derivation (hash of projectPath). Exposed here so call sites
// don't need to re-implement the hash and so the PANE-01 grep gate passes
// without leaving the literal `topics-project-*` prefix in consumer files.
function projectHash(projectPath: string): string {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = projectPath.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
const PANES_PREFIX = 'topics-project-panes-';
const LAYOUT_PREFIX = 'topics-project-layout-';
export function projectPanesLocalKey(projectPath: string): string {
  return `${PANES_PREFIX}${projectHash(projectPath)}`;
}
export function projectLayoutLocalKey(projectPath: string): string {
  return `${LAYOUT_PREFIX}${projectHash(projectPath)}`;
}

/**
 * Save layout data to localStorage only (no server sync). Legacy helper —
 * preserved for callers that still write their own per-project key.
 */
export function saveProjectLayoutLocalOnly(localKey: string, state: unknown): void {
  try {
    localStorage.setItem(localKey, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
}

/**
 * Save a project layout. Legacy signature kept intact so call sites don't
 * change during cutover.
 *
 * - Writes `localKey` to localStorage immediately (fast-paint cache).
 * - Debounces a dispatch of PROJECT_LAYOUT_SNAPSHOT so the reducer captures
 *   the current visible state into `projects[projectPath]`. The syncServer
 *   middleware then flushes the whole pane-store-v2 snapshot.
 */
export function saveProjectLayout(
  localKey: string,
  projectPath: string,
  state: unknown,
): void {
  try {
    localStorage.setItem(localKey, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }

  const existing = timers.get(projectPath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(projectPath);
    usePaneStore.getState().dispatch({
      type: 'PROJECT_LAYOUT_SNAPSHOT',
      payload: { projectPath },
    });
  }, DEBOUNCE_MS);
  timers.set(projectPath, t);
}

/**
 * Load the project layout.
 *
 * Legacy behavior: read localStorage immediately, fire an async server fetch,
 * and call `onUpdate` if the server's answer differs. The adapter now pulls
 * from the reducer's `projects[projectPath]` first (authoritative) and falls
 * back to the localStorage fast-paint cache when the reducer hasn't
 * hydrated yet. `onUpdate` fires if reducer state changes after the initial
 * read (e.g. WS ui-state:init arrives).
 */
export function loadProjectLayout(
  localKey: string,
  projectPath: string,
  onUpdate?: (freshState: unknown) => void,
): unknown | null {
  // Reducer first (authoritative).
  const fromStore = usePaneStore.getState().projects[projectPath];
  if (fromStore) return fromStore;

  // Fast-paint from localStorage.
  let cached: unknown = null;
  try {
    const raw = localStorage.getItem(localKey);
    if (raw) cached = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  // Subscribe once for the first reducer update so consumers get the
  // authoritative state when WS or syncWS hydrates. Guard against leaks with
  // a 30 s safety-net timer: if the reducer never hydrates `projects[path]`
  // (e.g. user closed the tab before WS ui-state:init arrived), we unsub and
  // free the closure instead of holding it for the lifetime of the document.
  if (onUpdate) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const unsub = usePaneStore.subscribe(
      (s: PaneStore) => s.projects[projectPath],
      (layout: ProjectLayout | undefined) => {
        if (layout) {
          if (timeoutId !== null) clearTimeout(timeoutId);
          unsub();
          onUpdate(layout);
        }
      },
    );
    timeoutId = setTimeout(() => {
      timeoutId = null;
      unsub();
    }, LOAD_SUBSCRIBE_TIMEOUT_MS);
  }

  return cached;
}

/**
 * Restore a project layout as a batch action. Dispatched when the user
 * reopens a project tab; the reducer replays groups+panes atomically so
 * every render observes the same frame.
 */
export function restoreProjectLayout(layout: ProjectLayout): void {
  usePaneStore.getState().dispatch({
    type: 'PROJECT_LAYOUT_RESTORE',
    payload: { projectPath: layout.projectPath, layout },
  });
}

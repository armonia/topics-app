/**
 * Adapter for project-window layout persistence.
 *
 * History: this module used to dispatch a debounced PROJECT_LAYOUT_SNAPSHOT
 * into the pane-store reducer's `state.projects[path]` so the layout could
 * sync cross-device via the pane-store-v2 server snapshot. That capture
 * was wrong-scope (it snapshotted the GLOBAL App-level pane state, not the
 * project's inner React state — see projectPersistence.ts:91-99 for the
 * footgun trail), so consumers had to silently filter out the result. The
 * dispatch + the matching `projects` field in selectSyncableSnapshot were
 * effectively dead data spamming the server with garbage.
 *
 * This adapter is now a thin localStorage wrapper. Cross-device project
 * layout sync is a TODO that needs a properly-shaped server channel
 * mirroring the project-window's inner state (panes/groups/rows).
 */
import type { ProjectLayout } from '../types';

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
 * Writes `localKey` to localStorage immediately. Previously also dispatched
 * a debounced PROJECT_LAYOUT_SNAPSHOT into the pane-store reducer's
 * `state.projects[projectPath]`, but that snapshot captured the GLOBAL
 * App-level pane state instead of the project's inner React state — wrong
 * shape for ever restoring a ProjectWindow's panes (consumers had to
 * silently filter it out, see projectPersistence.ts:91-99). The dispatch
 * was also serialised onto the server via `selectSyncableSnapshot` and
 * roundtripped on every WS hydrate, wasting bandwidth on data that nothing
 * could ever consume.
 *
 * Cross-device project layout sync remains a TODO — when implemented, it
 * should snapshot the ProjectWindow's inner React state (panes/groups/rows
 * managed by useProjectLayout) into a dedicated server key, NOT into the
 * App-level pane store.
 */
export function saveProjectLayout(
  localKey: string,
  projectPath: string,
  state: unknown,
): void {
  // Suppress unused-args lint while keeping the signature for legacy callers.
  void projectPath;
  try {
    localStorage.setItem(localKey, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
}

/**
 * Load the project layout.
 *
 * Returns the synchronous localStorage cache for `localKey`. The previous
 * implementation also read `usePaneStore.getState().projects[projectPath]`
 * and subscribed for cross-device updates, but the pane-store's
 * `state.projects` field captured the wrong scope (App-level pane state,
 * not the project's inner React state) so consumers had to silently filter
 * the result anyway. With PROJECT_LAYOUT_SNAPSHOT no longer dispatched
 * (see saveProjectLayout above), `state.projects[path]` is always empty
 * and the subscription is dead — both are removed here. The `onUpdate`
 * callback is kept for API compatibility but is now never invoked from
 * this path; cross-device project layout sync is a TODO that needs a
 * properly-shaped server channel.
 */
export function loadProjectLayout(
  localKey: string,
  _projectPath: string,
  _onUpdate?: (freshState: unknown) => void,
): unknown | null {
  void _projectPath;
  void _onUpdate;
  try {
    const raw = localStorage.getItem(localKey);
    if (raw) return JSON.parse(raw);
  } catch {
    /* corrupt entry — fall through to null */
  }
  return null;
}

/**
 * @deprecated never invoked — kept as a stub so any straggling caller doesn't
 * fail to import. The PROJECT_LAYOUT_RESTORE reducer path is dead because the
 * snapshot path that fed it captured the wrong scope (App-level pane state,
 * not project-inner state). Project window layouts are restored from
 * localStorage by useProjectPersistenceLoad, not via this dispatch.
 */
export function restoreProjectLayout(_layout: ProjectLayout): void {
  void _layout;
  // intentional no-op; see comment above.
}

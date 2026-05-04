import type { PaneState, PaneAction } from '../types';

/**
 * Both PROJECT_LAYOUT_SNAPSHOT and PROJECT_LAYOUT_RESTORE are now no-ops.
 *
 * Historical context: the SNAPSHOT case captured the global App-level pane
 * state under `state.projects[projectPath]` so it could ride along on the
 * pane-store-v2 server snapshot for cross-device sync. But the captured
 * shape was wrong for the consumer (the project's inner React state lives
 * outside the global pane store), so consumers had to silently filter the
 * result and the field was dead data — see projectLayoutSync.ts header for
 * the full trail.
 *
 * Adapters no longer dispatch these action types. Action constants are kept
 * in PaneAction for back-compat with any straggling caller; they are
 * silently ignored here.
 */
export function projectsReducer(_state: PaneState, _action: PaneAction): void {
  void _state;
  void _action;
  // intentionally empty
}

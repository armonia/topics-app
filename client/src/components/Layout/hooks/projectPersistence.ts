/**
 * Project-window persistence helpers — shared between
 * `useProjectPersistenceLoad` and `useProjectPersistenceSave`.
 *
 * Extracted from `ProjectWindow.tsx` (Commit 6 of the four-hook refactor)
 * to invert the upside-down dependency: previously the hooks imported from
 * the component, now the component (and the hooks) import from this shared
 * module.
 *
 * Owns:
 *  - localStorage key derivation (tab state + layout state).
 *  - PersistedTabState / PersistedLayoutState / PersistedState shapes.
 *  - `stripWrapperPaneId` — defensive filter so the project's own wrapper
 *    pane never gets persisted as one of its own children.
 *  - `subscribeToProjectLayout` — async hydration subscription wrapper.
 *  - `loadPersistedState` — sync read at mount + async subscribe.
 *  - `_chatSyncComplete` gate set + `markChatSyncComplete` /
 *    `savePersistedTabState` / `savePersistedLayoutState` save fns.
 */
import type { Pane, PaneGroup, GroupLayoutRow } from '../../../types';
import {
  createPaneId,
  saveProjectLayout,
  loadProjectLayout,
  saveProjectLayoutLocalOnly,
  projectPanesLocalKey,
  projectLayoutLocalKey,
} from '../../../state/pane/adapters';

// --- Storage keys ---

export function storageKey(projectPath: string): string {
  return projectPanesLocalKey(projectPath);
}

/** localStorage-only key for layout data (splits, groups, sidebar) */
export function layoutStorageKey(projectPath: string): string {
  return projectLayoutLocalKey(projectPath);
}

// --- Persisted state shapes ---

/** Server-synced: tab identity only */
export interface PersistedTabState {
  nonChatPanes: Pane[];
  openChatTopicIds?: string[];
  activeChatTopicId?: string;
}

/** Local-only: layout structure */
export interface PersistedLayoutState {
  groups?: PaneGroup[];
  rows?: GroupLayoutRow[];
  rowHeights?: number[];
  sidebarCollapsed?: boolean;
}

/** Combined state for loading */
export interface PersistedState extends PersistedTabState, PersistedLayoutState {}

/** Drop the project's own wrapper pane from a flat list — it must never be
 * embedded as one of its own children (would resurface on reload as a
 * phantom unkillable tab). Centralized so all sites that need this
 * filter (load, useState seed, persist effect) stay in sync. */
export function stripWrapperPaneId<T extends { id: string }>(
  panes: T[],
  projectPath: string,
): T[] {
  const wrapperId = createPaneId('project', projectPath);
  return panes.filter(p => p.id !== wrapperId);
}

/** Subscribe to async hydration of `projects[path]` from the pane reducer
 * (WS init, cross-device sync). Wraps `loadProjectLayout`'s callback param
 * with shape-detection so callers always receive a `PersistedTabState`,
 * never the foreign top-level reducer shape. */
export function subscribeToProjectLayout(
  projectPath: string,
  onUpdate: (fresh: PersistedTabState) => void,
): void {
  loadProjectLayout(
    storageKey(projectPath),
    projectPath,
    (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const r = raw as Record<string, unknown>;
      if (Array.isArray(r.nonChatPanes)) {
        onUpdate(raw as PersistedTabState);
        return;
      }
      // The other shape this used to handle — `{ panes: Record<id, Pane>,
      // groups, … }` — is the PROJECT_LAYOUT_SNAPSHOT capture of the
      // GLOBAL pane store. The project window manages its inner panes in
      // React state OUTSIDE of `state.panes`, so that snapshot is never
      // an authoritative source for this project's inner tabs. Treating
      // it as one resurrected phantom panes (or wiped real ones) on every
      // reload. We now silently ignore it — the localStorage `nonChatPanes`
      // shape remains the only legitimate hydration source.
    },
  );
}

export function loadPersistedState(
  projectPath: string,
  onUpdate?: (fresh: PersistedTabState) => void,
): PersistedState | null {
  // Read tab state directly from this project's localStorage key. We used to
  // go through `loadProjectLayout`, which preferred the pane-store reducer's
  // `projects[path]` snapshot — but that snapshot uses a completely different
  // shape. The localStorage tab key is the canonical source of truth for this
  // window's child panes; the server fetch via `onUpdate` still races against
  // it and overrides if newer.
  let tabState: PersistedTabState | null = null;
  try {
    const raw = localStorage.getItem(storageKey(projectPath));
    if (raw) tabState = JSON.parse(raw) as PersistedTabState;
  } catch {}
  if (onUpdate) subscribeToProjectLayout(projectPath, onUpdate);

  let layout: PersistedLayoutState | null = null;
  try {
    const lraw = localStorage.getItem(layoutStorageKey(projectPath));
    if (lraw) layout = JSON.parse(lraw);
  } catch {}
  if (!tabState) return layout ? { nonChatPanes: [], ...layout } : null;
  return { ...tabState, ...layout };
}

// --- Chat-sync gate ---
// Track which projects have completed their initial chat sync.
// Until sync completes, persistence is suppressed to prevent empty overwrites.
const _chatSyncComplete = new Set<string>();
export function markChatSyncComplete(projectPath: string): void {
  _chatSyncComplete.add(projectPath);
}

export function savePersistedTabState(
  projectPath: string,
  state: PersistedTabState,
): void {
  // Guard: suppress ALL persistence until the initial chat sync has completed.
  // This prevents the mount→render→persist race that overwrites saved chat IDs
  // with empty arrays before the sync effect has run.
  if (!_chatSyncComplete.has(projectPath)) {
    return; // Don't persist anything yet — wait for chat sync
  }
  saveProjectLayout(storageKey(projectPath), projectPath, state);
}

export function savePersistedLayoutState(
  projectPath: string,
  state: PersistedLayoutState,
): void {
  saveProjectLayoutLocalOnly(layoutStorageKey(projectPath), state);
}

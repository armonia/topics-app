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
  unsubscribeProjectLayout,
  saveProjectLayoutLocalOnly,
  projectPanesLocalKey,
  projectLayoutLocalKey,
} from '../../../state/pane/adapters';
import { normalizeWidths } from '../gridWidths';

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
  /** Which split cell was focused, so a reload restores the focused tab
   *  instead of defaulting to the first cell. Per-cell active tab already
   *  lives in PaneGroup.activePaneId; this records WHICH cell had focus. */
  focusedGroupId?: string | null;
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

/** Tear down the cross-device subscription registered by
 *  `subscribeToProjectLayout`. Call from the load hook's effect cleanup so a
 *  closed/switched project stops holding a live callback + WS fan-out slot. */
export function unsubscribeFromProjectLayout(projectPath: string): void {
  unsubscribeProjectLayout(storageKey(projectPath));
}

/**
 * Repair a persisted project layout before it seeds React state. The standalone
 * grid sanitises every row on load (sanitizeRow in usePanelGridPersistence); the
 * project path used to trust localStorage VERBATIM, so a corrupt payload —
 * NaN/0/Infinity widths, widths shorter/longer than groupIds, rowHeights of a
 * different length than rows — flowed straight into state (and GroupLayout then
 * rendered `width: NaN%`, collapsing a cell). Here we coerce/renormalise widths
 * to match each row's groupIds, drop empty rows, and align rowHeights to the
 * survivors. Untouched when `rows` is absent (nothing persisted yet).
 */
function sanitizeLayout(layout: PersistedLayoutState | null): PersistedLayoutState | null {
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.rows)) return layout;
  const rows = layout.rows
    .filter((r): r is GroupLayoutRow => !!r && Array.isArray((r as GroupLayoutRow).groupIds))
    .map(r => {
      const groupIds = r.groupIds.filter((id): id is string => typeof id === 'string');
      const rawW = Array.isArray(r.widths) ? r.widths : [];
      const widths = normalizeWidths(
        groupIds.map((_, i) => {
          const w = rawW[i];
          return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1 / Math.max(1, groupIds.length);
        }),
      );
      return { ...r, groupIds, widths };
    })
    .filter(r => r.groupIds.length > 0);
  const rawH = Array.isArray(layout.rowHeights) ? layout.rowHeights : [];
  const rowHeights = normalizeWidths(
    rows.map((_, i) => {
      const h = rawH[i];
      return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 1;
    }),
  );
  return { ...layout, rows, rowHeights };
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
    if (lraw) layout = sanitizeLayout(JSON.parse(lraw));
  } catch {}
  if (!tabState) return layout ? { nonChatPanes: [], ...layout } : null;
  return { ...tabState, ...layout };
}

// --- Chat-sync gate ---
// Track which projects have completed their initial chat sync.
// Until sync completes, the SERVER push is suppressed to prevent empty
// `openChatTopicIds` arrays from clobbering server-side state during the
// brief mount→render→persist race. localStorage is NOT gated — it's a
// same-device cache and MUST reflect every edit so a refresh during the
// gate window still restores the latest layout.
//
// History: the gate previously suppressed *all* persistence (including
// localStorage). That meant any edit made before chat-sync fired was lost
// on refresh — surfacing as "the layout I see after refresh is different
// from what I just had". Splitting the gate to cover only the server PUT
// keeps the original race-prevention intent without the data-loss tail.
const _chatSyncComplete = new Set<string>();
export function markChatSyncComplete(projectPath: string): void {
  _chatSyncComplete.add(projectPath);
}

export function savePersistedTabState(
  projectPath: string,
  state: PersistedTabState,
): void {
  // ALWAYS write localStorage immediately. A refresh during the chat-sync
  // gate window still gets the most recent state.
  saveProjectLayoutLocalOnly(storageKey(projectPath), state);
  // Server PUT (via the PROJECT_LAYOUT_SNAPSHOT debounce inside
  // `saveProjectLayout`) is gated until chat-sync completes — that's the
  // path that the original race-protection cared about.
  if (!_chatSyncComplete.has(projectPath)) return;
  saveProjectLayout(storageKey(projectPath), projectPath, state);
}

export function savePersistedLayoutState(
  projectPath: string,
  state: PersistedLayoutState,
): void {
  saveProjectLayoutLocalOnly(layoutStorageKey(projectPath), state);
}

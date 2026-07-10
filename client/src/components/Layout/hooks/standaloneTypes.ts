/**
 * Shared types for the StandaloneChatGroup hooks. Extracted from
 * `client/src/components/Layout/StandaloneChatGroup.tsx` during the
 * usePaneOrdering / useActivePaneState / usePaneLifecycle refactor
 * (PLAN v2: .planning/refactor/StandaloneChatGroup/PLAN.md).
 *
 * Do NOT add behavior here — types only. Hooks own their own logic.
 */

import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { Topic, WSMessage, PaneType, PanelTab } from '../../../types';

// ---------------------------------------------------------------------------
// usePaneOrdering — Hook 1
// ---------------------------------------------------------------------------

export interface UsePaneOrderingArgs {
  topicIds: string[];
  persistOrder: boolean;
  onClosePanel: (paneId: string, onCommit?: () => void) => void;
  onFocusPanel: (paneId: string) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  pendingBrowserPane?: string | null;
  onPendingBrowserPaneConsumed?: () => void;
  onUtilityPaneChange?: (has: boolean) => void;
  onOpenBrowserContextIds?: (ids: string[]) => void;
  panelInitialTab?: Record<string, PanelTab>;
  onPanelInitialTabConsumed?: (topicId: string) => void;
  /** Focused panel id from props. The hook DERIVES `activePaneId` internally
   *  (memo over validatedOrderedIds + focusedPanelId). Path 4 cycle break. */
  focusedPanelId: string | null;
  /** Component-local UI setter for navigateUrl propagation from WS handler.
   *  Component-local UI-state setter passed downward (not cross-hook setter
   *  sharing — see PLAN Q4 / VERIFY D1). */
  onBrowserNavigateUrl: (url: string | null) => void;
}

export interface UsePaneOrderingReturn {
  state: {
    orderedIds: string[];
    /** Raw user-pinned set; consumers should prefer `derived.effectivePinnedIds`. */
    pinnedIds: Set<string>;
  };
  derived: {
    validatedOrderedIds: string[];
    /** Reference-stable when contents unchanged (ISSUE 23). */
    effectivePinnedIds: Set<string>;
    /** Derived inside this hook to break the cycle with useActivePaneState
     *  (PLAN v2 / VERIFY D6). */
    activePaneId: string | null;
  };
  refs: {
    /** READ-ONLY ref mirror of `effectivePinnedIds`. */
    pinnedIdsRef: MutableRefObject<Set<string>>;
  };
  ops: {
    /** Replace the whole order (used by drag-reorder in PaneTabBar). */
    reorder: (newPaneIds: string[]) => void;
    /** Append a paneId to the user-pinned set. */
    pin: (paneId: string) => void;
    /** Browser-pane singleton. Find existing or create+focus. Returns the
     *  resulting paneId. When `contextId` is provided AND no exact-match pane
     *  exists but a browser pane DOES exist, the existing pane is
     *  re-identified to the new contextId. */
    ensureBrowserPane: (contextId?: string) => string;
    /** Append a session-viewer pane and focus it. */
    openSessionViewerPane: (sessionKey: string) => string;
    /** Remove a locally-managed pane (browser or session-viewer) from
     *  orderedIds. Does NOT call onClosePanel — caller decides. */
    removeLocalPane: (paneId: string) => void;
    /** Batch-remove locally-managed panes. */
    removeLocalPanes: (paneIds: string[]) => void;
  };
}

// ---------------------------------------------------------------------------
// useActivePaneState — Hook 3 (consumes ordering.derived.activePaneId per Path 4)
// ---------------------------------------------------------------------------

export interface UseActivePaneStateArgs {
  validatedOrderedIds: string[];
  activePaneId: string | null;
  topics: Record<string, Topic>;
}

export interface UseActivePaneStateReturn {
  activePaneId: string | null;
  activeIsBrowser: boolean;
  activeIsTerminal: boolean;
  activeIsSessionViewer: boolean;
  activeIsProject: boolean;
  activeIsUtility: boolean;
  activeSessionKey: string | null;
  activeProjectPath: string | null;
  activeUtilityType: string | null;
  draftTopics: Record<string, Topic>;
  activeTopic: Topic | null;
  browserContextId: string;
  browserContextIdRef: MutableRefObject<string>;
}

// ---------------------------------------------------------------------------
// usePaneLifecycle — Hook 2 (action handlers)
// ---------------------------------------------------------------------------

export interface UsePaneLifecycleArgs {
  ordering: UsePaneOrderingReturn;
  active: UseActivePaneStateReturn;
  topics: Record<string, Topic>;
  topicIds: string[];
  gridItemKey: string;
  onClosePanel: (paneId: string, onCommit?: () => void) => void;
  onFocusPanel: (paneId: string) => void;
  onSplitPane?: (topicId: string, direction: 'right' | 'down') => void;
  onUnsolo?: (topicId: string) => void;
  /** Returns the new pane id (or null on failure) so handleAddPane can route
   *  the pane into the split cell whose "+" was clicked. Legacy void-returning
   *  callers stay assignable. */
  onCreateTerminal?: (type: 'shell' | 'claude-code' | 'codex' | 'opencode', skipPermissions?: boolean) => void | Promise<string | null>;
  /** Merge a pane into this group's split cell (PanelGrid.handleMergeIntoCell).
   *  Used by handleAddPane when `gridItemKey` is a solo cell — without it a
   *  pane created from a split cell's "+" lands in the main standalone pool. */
  onMergeIntoCell?: (paneId: string, targetPrimary: string, insertIdx?: number) => void;
  /** Persist a tab reorder upstream (App.openPanels for the main pool).
   *  Without it the reorder lives only in usePaneOrdering's local state and
   *  is silently lost on reload — unlike the identical gesture in projects. */
  onPersistReorder?: (newPaneIds: string[]) => void;
  claudeSkipPermissions: boolean;
  stopSession: (sessionKey: string) => boolean;
}

export interface UsePaneLifecycleHandlers {
  handleReorderPanes: (newPaneIds: string[]) => void;
  handlePinPane: (paneId: string) => void;
  handleAddPane: (type: PaneType, subType?: string) => Promise<void>;
  handleClosePane: (paneId: string) => void;
  handleStopStreaming: (paneId: string) => void;
  handleOpenSessionViewer: (sessionKey: string) => void;
  handleSettings: (paneId: string) => void;
  handlePopOut: (paneId: string) => void;
  handleSplitRight: (paneId: string) => void;
  handleSplitDown: (paneId: string) => void;
  handleDetach: ((paneId: string) => void) | undefined;
  handleUnsolo: ((paneId: string) => void) | undefined;
  handleCloseOthers: (keepPaneId: string) => void;
  isSplittable: (id: string) => boolean;
}

export interface UsePaneLifecycleReturn {
  settingsTopicId: string | null;
  setSettingsTopicId: Dispatch<SetStateAction<string | null>>;
  handlers: UsePaneLifecycleHandlers;
}

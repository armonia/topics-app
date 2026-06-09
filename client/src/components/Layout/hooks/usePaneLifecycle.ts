/**
 * usePaneLifecycle — Hook 2 of the StandaloneChatGroup refactor (PLAN v2).
 *
 * Owns action handlers exposed to <PaneTabBar> and the JSX. Receives
 * `ordering.ops` and `active` to avoid setter sharing (CRITIQUE B2/B10).
 * The browser singleton flows through `ordering.ops.ensureBrowserPane`;
 * close-others bulk removal flows through `ordering.ops.removeLocalPanes`.
 *
 * Cross-group drag stays in the component (CRITIQUE B9 decision).
 */

import { useCallback, useMemo, useState } from 'react';
import type { PaneType } from '../../../types';
import {
  isBrowserPaneId,
  isTerminalPaneId,
  isSessionViewerPaneId,
  isDraftPaneId,
  getBrowserContextFromPaneId,
  getTerminalSessionFromPaneId,
} from '../../../state/pane/adapters';
import { isUtilityPanelId } from '../UtilityPanel';
import { primaryFromSoloCellKey } from '../soloCells';
import type { UsePaneLifecycleArgs, UsePaneLifecycleReturn } from './standaloneTypes';

const isNativeApp = typeof window !== 'undefined' && !!(window as Window & { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers;

/**
 * Per-pane-kind close-side-effect descriptor. Keeps handleClosePane +
 * handleCloseOthers data-driven instead of three near-duplicated branches
 * with subtle differences in which side effects fire and whether focus
 * restoration is needed.
 *
 *   matches      — pane-id prefix check (isBrowserPaneId, etc.)
 *   sideEffect   — fire-and-forget server DELETE etc.; called with the
 *                  pane id once per close. Returning null means no side
 *                  effect (e.g. session-viewer is purely client-side).
 *   localManaged — `true` for panes whose lifecycle is owned by the
 *                  local ordering store; close means removeLocalPane +
 *                  onClosePanel + focus restore. `false` for panes that
 *                  flow entirely through `onClosePanel` (chat, terminal).
 */
interface PaneKindHandler {
  matches: (paneId: string) => boolean;
  sideEffect: ((paneId: string) => void) | null;
  localManaged: boolean;
}

const PANE_KIND_HANDLERS: PaneKindHandler[] = [
  {
    matches: isBrowserPaneId,
    sideEffect: (id) => {
      const ctx = getBrowserContextFromPaneId(id);
      if (ctx) fetch(`/api/browsers/${encodeURIComponent(ctx)}`, { method: 'DELETE' }).catch(() => {});
    },
    localManaged: true,
  },
  {
    matches: isSessionViewerPaneId,
    sideEffect: null,
    localManaged: true,
  },
  {
    matches: isTerminalPaneId,
    sideEffect: (id) => {
      const sessionId = getTerminalSessionFromPaneId(id);
      if (sessionId) fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    },
    localManaged: false,
  },
];

function findHandler(paneId: string): PaneKindHandler | undefined {
  return PANE_KIND_HANDLERS.find((h) => h.matches(paneId));
}

export function usePaneLifecycle(args: UsePaneLifecycleArgs): UsePaneLifecycleReturn {
  const {
    ordering, active,
    topics, gridItemKey,
    onClosePanel, onFocusPanel, onCloseMultiplePanels,
    onSplitPane, onUnsolo,
    onCreateTerminal, onMergeIntoCell, claudeSkipPermissions,
    stopSession,
  } = args;
  const { validatedOrderedIds } = ordering.derived;
  const { activePaneId } = active;

  // Settings modal trigger.
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  const handleReorderPanes = useCallback((newPaneIds: string[]) => {
    ordering.ops.reorder(newPaneIds);
  }, [ordering.ops]);

  const handlePinPane = useCallback((paneId: string) => {
    ordering.ops.pin(paneId);
  }, [ordering.ops]);

  const handleAddPane = useCallback(async (type: PaneType, subType?: string) => {
    if (type === 'browser') {
      // Group-local singleton — already lands in THIS group's tab bar.
      ordering.ops.ensureBrowserPane();
    } else if (type === 'terminal') {
      const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
      // App-level creation appends the pane to openPanels, which PanelGrid
      // places in the main 'standalone' cell. When the "+" that was clicked
      // belongs to a SPLIT cell ('solo:<primary>'), re-target the new pane
      // into that cell — otherwise the tab visibly opens in the OTHER split
      // group's tab bar.
      const paneId = await onCreateTerminal?.(termType, claudeSkipPermissions);
      const targetPrimary = primaryFromSoloCellKey(gridItemKey);
      if (paneId && targetPrimary && onMergeIntoCell) {
        onMergeIntoCell(paneId, targetPrimary);
      }
    }
  }, [ordering.ops, claudeSkipPermissions, onCreateTerminal, gridItemKey, onMergeIntoCell]);

  const handleClosePane = useCallback((paneId: string) => {
    // PANE_KIND_HANDLERS centralises the side effects + local-vs-store
    // distinction. Per kind:
    //   browser  → localManaged + server DELETE; on close drop from local
    //              ordering FIRST (so the tab bar updates without waiting
    //              for the store→openPanels round trip), then call
    //              onClosePanel (purges App.openPanels + persisted state
    //              so the closed tab doesn't reappear on reload), then
    //              fire the DELETE. Refocus the next pane if the closed
    //              one was active.
    //   session-viewer → same shape as browser minus the server DELETE
    //              (purely client-side, no resource to release).
    //   terminal → store-managed; fire the server DELETE and let
    //              onClosePanel handle the rest. No refocus — the
    //              parent's close-cascade does it.
    //   chat (default) → onClosePanel only.
    const handler = findHandler(paneId);
    if (!handler) { onClosePanel(paneId); return; }

    if (handler.localManaged) ordering.ops.removeLocalPane(paneId);
    // Defer the server-side DELETE to the pending-action commit (3s after the
    // user clicks X). Firing it inline would kill the PTY immediately and the
    // xterm pane would print "[Session ended]" while the close countdown is
    // still painting — looking to the user like the timer didn't apply.
    onClosePanel(
      paneId,
      handler.sideEffect ? () => handler.sideEffect!(paneId) : undefined,
    );
    if (handler.localManaged && activePaneId === paneId) {
      const remaining = validatedOrderedIds.filter((id) => id !== paneId);
      if (remaining.length > 0) onFocusPanel(remaining[0]);
    }
  }, [ordering.ops, activePaneId, validatedOrderedIds, onFocusPanel, onClosePanel]);

  const handleStopStreaming = useCallback((paneId: string) => {
    const topic = topics[paneId];
    if (topic) {
      const isFirst = stopSession(topic.sessionKey);
      if (isFirst) onClosePanel(paneId);
    }
  }, [topics, stopSession, onClosePanel]);

  const handleOpenSessionViewer = useCallback((sessionKey: string) => {
    ordering.ops.openSessionViewerPane(sessionKey);
  }, [ordering.ops]);

  const handleSettings = useCallback((paneId: string) => {
    setSettingsTopicId(paneId);
  }, []);

  const handlePopOut = useCallback((paneId: string) => {
    const url = `${window.location.origin}?topic=${paneId}`;
    if (isNativeApp) {
      window.open(url, `topic-${paneId}`, 'width=900,height=700');
    } else {
      window.open(url, `topic-${paneId}`);
    }
    onClosePanel(paneId);
  }, [onClosePanel]);

  // Determine if a pane can be split into its own grid cell.
  //
  // Soft rules:
  //   - Utility panes and unsaved draft panes can never be split (their
  //     state model doesn't survive the move out of the standalone group).
  //   - A pane already in its own solo cell can't be split again — it's
  //     already as far out as it can go in the current grid model.
  //
  // Single-tab split is allowed: the standalone group is permitted to
  // become temporarily empty while the moved pane lands in its own
  // cell next to it. PanelGrid's empty-group rendering handles the
  // transient state, and the user can immediately drag another tab
  // into it or open a new chat. (Previously we required >=2 splittable
  // panes, which made "Split right" silently disappear from the right-
  // click menu when a user had a single chat open — the most common case
  // and the moment they're most likely to want to split.)
  const isSplittable = useCallback((id: string) => {
    if (isUtilityPanelId(id) || isDraftPaneId(id)) return false;
    if (gridItemKey.startsWith('solo:')) return false;
    return validatedOrderedIds.some(pid =>
      pid === id && !isUtilityPanelId(pid) && !isDraftPaneId(pid)
    );
  }, [gridItemKey, validatedOrderedIds]);

  const handleSplitRight = useCallback((paneId: string) => {
    if (!onSplitPane || !isSplittable(paneId)) return;
    onSplitPane(paneId, 'right');
  }, [onSplitPane, isSplittable]);

  const handleSplitDown = useCallback((paneId: string) => {
    if (!onSplitPane || !isSplittable(paneId)) return;
    onSplitPane(paneId, 'down');
  }, [onSplitPane, isSplittable]);

  const handleDetach = useMemo(() => {
    if (!onSplitPane) return undefined;
    return (paneId: string) => {
      if (!isSplittable(paneId)) return;
      onSplitPane(paneId, 'right');
    };
  }, [onSplitPane, isSplittable]);

  const handleUnsolo = useMemo(() => {
    if (!onUnsolo) return undefined;
    return (paneId: string) => {
      onUnsolo(paneId);
    };
  }, [onUnsolo]);

  // ISSUE 22 fix: "Close Others" — batch-close multiple panels atomically.
  // Uses the same PANE_KIND_HANDLERS table as handleClosePane so the
  // "local vs store-managed" partition is consistent. Side effects from
  // each kind still fire (server DELETEs for browser + terminal).
  const handleCloseOthers = useCallback((keepPaneId: string) => {
    const toClose = validatedOrderedIds.filter((id) => id !== keepPaneId);
    if (toClose.length === 0) return;

    // Partition by localManaged. Local panes go through ordering.ops; the
    // store-managed ones flow through onCloseMultiplePanels (atomic batch
    // when available) or onClosePanel per id.
    const localToClose: string[] = [];
    const parentToClose: string[] = [];
    for (const id of toClose) {
      const h = findHandler(id);
      if (h?.localManaged) localToClose.push(id);
      else parentToClose.push(id);
    }

    if (localToClose.length > 0) {
      ordering.ops.removeLocalPanes(localToClose);
    }
    // Fire kind-specific side effects (server DELETEs etc.) regardless of
    // which partition the pane went into.
    for (const id of toClose) findHandler(id)?.sideEffect?.(id);

    if (parentToClose.length > 0 && onCloseMultiplePanels) {
      onCloseMultiplePanels(parentToClose);
    } else {
      for (const id of parentToClose) onClosePanel(id);
    }

    onFocusPanel(keepPaneId);
  }, [validatedOrderedIds, ordering.ops, onCloseMultiplePanels, onClosePanel, onFocusPanel]);

  return {
    settingsTopicId,
    setSettingsTopicId,
    handlers: {
      handleReorderPanes,
      handlePinPane,
      handleAddPane,
      handleClosePane,
      handleStopStreaming,
      handleOpenSessionViewer,
      handleSettings,
      handlePopOut,
      handleSplitRight,
      handleSplitDown,
      handleDetach,
      handleUnsolo,
      handleCloseOthers,
      isSplittable,
    },
  };
}

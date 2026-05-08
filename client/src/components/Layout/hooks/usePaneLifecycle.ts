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
import type { UsePaneLifecycleArgs, UsePaneLifecycleReturn } from './standaloneTypes';

const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

export function usePaneLifecycle(args: UsePaneLifecycleArgs): UsePaneLifecycleReturn {
  const {
    ordering, active,
    topics, gridItemKey,
    onClosePanel, onFocusPanel, onCloseMultiplePanels,
    onSplitPane, onUnsolo,
    onCreateTerminal, claudeSkipPermissions,
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
      ordering.ops.ensureBrowserPane();
    } else if (type === 'terminal') {
      const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
      onCreateTerminal?.(termType, claudeSkipPermissions);
    }
  }, [ordering.ops, claudeSkipPermissions, onCreateTerminal]);

  const handleClosePane = useCallback((paneId: string) => {
    if (isBrowserPaneId(paneId)) {
      ordering.ops.removeLocalPane(paneId);
      const paneContextId = getBrowserContextFromPaneId(paneId);
      if (paneContextId) {
        fetch(`/api/browsers/${encodeURIComponent(paneContextId)}`, { method: 'DELETE' }).catch(() => {});
      }
      if (activePaneId === paneId) {
        const remaining = validatedOrderedIds.filter(id => id !== paneId);
        if (remaining.length > 0) onFocusPanel(remaining[0]);
      }
    } else if (isSessionViewerPaneId(paneId)) {
      ordering.ops.removeLocalPane(paneId);
      if (activePaneId === paneId) {
        const remaining = validatedOrderedIds.filter(id => id !== paneId);
        if (remaining.length > 0) onFocusPanel(remaining[0]);
      }
    } else if (isTerminalPaneId(paneId)) {
      const sessionId = getTerminalSessionFromPaneId(paneId);
      if (sessionId) {
        fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      onClosePanel(paneId);
    } else {
      onClosePanel(paneId);
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
    isNativeApp
      ? window.open(url, `topic-${paneId}`, 'width=900,height=700')
      : window.open(url, `topic-${paneId}`);
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
  const handleCloseOthers = useCallback((keepPaneId: string) => {
    const toClose = validatedOrderedIds.filter(id => id !== keepPaneId);
    if (toClose.length === 0) return;

    const localToClose = toClose.filter(id => isBrowserPaneId(id) || isSessionViewerPaneId(id));
    if (localToClose.length > 0) {
      ordering.ops.removeLocalPanes(localToClose);
      for (const id of localToClose) {
        if (isBrowserPaneId(id)) {
          const ctx = getBrowserContextFromPaneId(id);
          if (ctx) fetch(`/api/browsers/${encodeURIComponent(ctx)}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    }

    const parentToClose = toClose.filter(id => !isBrowserPaneId(id) && !isSessionViewerPaneId(id));
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

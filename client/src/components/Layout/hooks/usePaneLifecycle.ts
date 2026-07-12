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
  getBrowserContextFromPaneId,
  getTerminalSessionFromPaneId,
} from '../../../state/pane/adapters';
import { primaryFromSoloCellKey } from '../soloCells';
import { canSplitPane, standaloneSplitSurface } from '../splitRules';
import { clearBrowserSpawner } from '../../../state/browserSpawner';
import { normalizeTerminalAgent } from '../../../lib/terminalAgents';
import type { UsePaneLifecycleArgs, UsePaneLifecycleReturn } from './standaloneTypes';
import { popOutTopic } from '../../../lib/popOutTopic';

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
      if (ctx) {
        fetch(`/api/browsers/${encodeURIComponent(ctx)}`, { method: 'DELETE' }).catch(() => {});
        // Clear the spawner relationship so the "opened a browser" tab cue
        // disappears once the browser is closed (registry isn't auto-pruned).
        clearBrowserSpawner(ctx);
      }
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
    onClosePanel, onFocusPanel,
    onSplitPane, onUnsolo,
    onCreateTerminal, onMergeIntoCell, onPersistReorder, claudeSkipPermissions,
    stopSession,
  } = args;
  const { validatedOrderedIds } = ordering.derived;
  const { activePaneId } = active;

  // Settings modal trigger.
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  const handleReorderPanes = useCallback((newPaneIds: string[]) => {
    ordering.ops.reorder(newPaneIds);
    // Persist upstream too — the local ordering state alone doesn't survive
    // a reload (App.openPanels is what the boot path reads back).
    onPersistReorder?.(newPaneIds);
  }, [ordering.ops, onPersistReorder]);

  const handlePinPane = useCallback((paneId: string) => {
    ordering.ops.pin(paneId);
  }, [ordering.ops]);

  const handleAddPane = useCallback(async (type: PaneType, subType?: string) => {
    if (type === 'browser') {
      // Group-local singleton — but "this group" is the MAIN standalone pool:
      // the pane persists to group:default and PanelGrid files it into the
      // pool's tab bar. When the "+" belongs to a split cell, re-target the
      // pane into that cell, mirroring the terminal branch below.
      const paneId = ordering.ops.ensureBrowserPane();
      const browserTarget = primaryFromSoloCellKey(gridItemKey);
      if (paneId && browserTarget && onMergeIntoCell) {
        onMergeIntoCell(paneId, browserTarget);
      }
    } else if (type === 'terminal') {
      const termType = normalizeTerminalAgent(subType);
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
    } else if (type === 'board') {
      // Utility pane (`__board__`) — owned by the App-level lifecycle hook
      // (handleOpenAsPage). Event-based like `topics:open-project-picker`, so
      // every "+" host opens it identically with no prop-threading.
      window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } }));
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

    // Defer BOTH the local-ordering drop AND the server-side DELETE to the
    // pending-action commit (3s after the X). The old flow dropped the tab
    // from the local ordering UPFRONT ("so the tab bar updates without
    // waiting") — but that erased the very tab that paints the countdown
    // fill, while the CELL stayed in the layout until commit: a ghost pane
    // with an invisible timer for 3s, reported live as "closing a
    // floating-split tab takes forever to settle". Keeping the tab in place
    // makes browser/viewer closes read exactly like chat closes (visible 3s
    // fill on the tab, then the whole cell leaves in one step); cancelling
    // the countdown leaves everything untouched. The server DELETE stays at
    // commit too — inline it would kill the PTY immediately and the xterm
    // pane would print "[Session ended]" mid-countdown.
    onClosePanel(paneId, () => {
      if (handler.localManaged) ordering.ops.removeLocalPane(paneId);
      handler.sideEffect?.(paneId);
    });
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
    // Close the source pane only if a window actually opened — see popOutTopic.
    void popOutTopic(paneId).then((opened) => {
      if (opened) onClosePanel(paneId);
    });
  }, [onClosePanel]);

  // Determine if a pane can be split into its own grid cell — delegated to
  // the SHARED canSplitPane rule (splitRules.ts), the single source of truth
  // both surfaces' menus, drags and handlers gate on:
  //
  //   - the main pool is always splittable (single-tab split auto-spawns a
  //     draft companion in PanelGrid.handleSplitPane so the result is two
  //     visible cells);
  //   - a solo split cell is splittable only when it holds MORE than one tab
  //     (the lone tab has nothing left to split away from; a multi-tab
  //     member splits out into its own cell, like the drag path);
  //   - utility panes and drafts are no longer special-cased: utility panes
  //     render fine as solo cells, and draft cells survive promotion via the
  //     'topics:pane-id-remap' remap in PanelGrid — the drag path always
  //     allowed both, so the menu now agrees with it.
  const isSplittable = useCallback((id: string) => {
    if (!validatedOrderedIds.includes(id)) return false;
    return canSplitPane({
      surface: standaloneSplitSurface(gridItemKey),
      groupSize: validatedOrderedIds.length,
    });
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

  // "Close Others" — same close path as handleClosePane, applied per pane.
  // Local panes (browser/session-viewer) are batch-removed from the ordering
  // store first so the tab bar collapses instantly, but EVERY pane still goes
  // through onClosePanel: that purges App.openPanels + the persisted store
  // (otherwise local panes resurrect on reload) and defers each server-side
  // DELETE into the pending-action commit, keeping the close countdown
  // cancellable exactly like a single close.
  const handleCloseOthers = useCallback((keepPaneId: string) => {
    const toClose = validatedOrderedIds.filter((id) => id !== keepPaneId);
    if (toClose.length === 0) return;

    const localToClose = toClose.filter((id) => findHandler(id)?.localManaged);
    if (localToClose.length > 0) ordering.ops.removeLocalPanes(localToClose);

    for (const id of toClose) {
      const h = findHandler(id);
      onClosePanel(id, h?.sideEffect ? () => h.sideEffect!(id) : undefined);
    }

    onFocusPanel(keepPaneId);
  }, [validatedOrderedIds, ordering.ops, onClosePanel, onFocusPanel]);

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

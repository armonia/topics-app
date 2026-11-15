import { useCallback, type RefObject } from 'react';
import { enqueuePendingAction, tickPendingAction, cancelPendingAction } from '../contexts/PendingActionContext';
import { flushPaneStoreNow } from '../state/pane/middleware';
import { createPaneId } from '../state/pane/adapters';
import type { useBrowserContexts } from '../hooks/useBrowserContexts';
import type { UsePanelLifecycleReturn } from '../hooks/usePanelLifecycle';
import type { Topic } from '../types';

type PanelHandlers = UsePanelLifecycleReturn['handlers'];

interface DeferredActionsArgs {
  topics: Record<string, Topic>;
  topicsRef: RefObject<Record<string, Topic>>;
  focusedPanelId: string | null;
  visiblePanels: string[];
  openPanels: string[];
  projectOpenPanes: Record<string, string[]>;
  handleClosePanel: PanelHandlers['handleClosePanel'];
  handleFocusPanel: PanelHandlers['handleFocusPanel'];
  handleArchiveProject: PanelHandlers['handleArchiveProject'];
  handleCloseTerminal: PanelHandlers['handleCloseTerminal'];
  archiveTopic: (topicId: string, archive: boolean) => Promise<boolean>;
  browserCtx: ReturnType<typeof useBrowserContexts>;
  sidebarIsPinned: (id: string) => boolean;
  sidebarTogglePin: (id: string) => void;
}

/**
 * The soft-destructive actions of the app root (Things3-style pending flow)
 * and the pin toggle that archives a closed chat when it is unpinned.
 */
export function useDeferredActions({
  topics, topicsRef, focusedPanelId, visiblePanels, openPanels, projectOpenPanes,
  handleClosePanel, handleFocusPanel, handleArchiveProject, handleCloseTerminal,
  archiveTopic, browserCtx, sidebarIsPinned, sidebarTogglePin,
}: DeferredActionsArgs) {
  // ── Pending-action wrappers (Things3-style soft-destructive flow) ──
  // Each soft-destructive action (close tab, archive topic, archive project)
  // gets two entry points:
  //   1. The default user-facing button → `*Deferred` wrapper, which queues
  //      a PendingAction toast. Nothing commits until the user ticks the
  //      checkbox + the 3s countdown elapses.
  //   2. The right-click "now" variant → calls the raw handler directly,
  //      bypassing the countdown for power users who know what they want.
  // The raw handlers (handleClosePanel, archiveTopic, handleArchiveProject)
  // remain available for both cases.
  // Helper, enqueue + auto-tick, so the countdown starts on the very first
  // click of the X / archive button. The user's "tick the checkbox" gesture
  // becomes the click itself; cancellation is a re-click on the now-filled
  // checkbox (rendered inline by the PaneTabBar / TopicItem callsites that
  // subscribe to PendingAction state). No bottom-right toast.
  const enqueueAndTick = useCallback((args: Parameters<typeof enqueuePendingAction>[0]) => {
    enqueuePendingAction(args);
    tickPendingAction(args.key);
  }, []);

  // Immediate close ("Close now"): defuse a deferred close still counting
  // down before closing, otherwise the pending commit re-fires
  // handleClosePanel at T+3s (double pushUndo + re-run archive side effects).
  // Mirrors the project-level guard in useProjectLayout.handleClosePaneNow.
  // Memoized so renderGroupForKey in PanelGrid doesn't regenerate per render.
  // A pinned tab CLOSES like all the others.
  //
  // On 03/08 the pin was a lock: closing is a withdrawal (the chat is
  // archived, the session retired), so pinning had to be able to say "not this
  // one", and the ban lived here on the ACTION to cover keyboard, middle click
  // and "close the others" too. Reversed on 06/08: "pinned tabs should still be
  // closable but stay pinned and therefore reopenable until you remove the pin".
  //
  // It holds without the lock because the withdrawal deletes nothing: the chat
  // is archived, but the `pinnedIds` escape of buildSidebarItems keeps its tile
  // among the Pinned even when archived, and reopening it unarchives it. The pin
  // goes back to being what it looks like, a shortcut that stays, instead of
  // asking you to dismantle the shortcut to do the most common thing you do with it.

  const handleClosePanelImmediate = useCallback((topicId: string) => {
    cancelPendingAction(`close-tab:${topicId}`);
    handleClosePanel(topicId);
  }, [handleClosePanel]);

  const handleClosePanelDeferred = useCallback((topicId: string, onCommit?: () => void) => {
    const topic = topics[topicId];
    const label = topic?.name || topicId.replace(/^[a-z]+:/, '') || 'Tab';
    // Pre-shift focus to the tab that WILL receive focus on commit, so the
    // user already sees the destination while the 3s progress runs (the
    // commit path in usePanelLifecycle uses the same same-index-clamped
    // rule). Only relevant when this pane was the focused one, closing a
    // background tab must not steal focus from where the user is currently
    // looking. Same-index (clamped) matches the project groups' rule: focus
    // the tab that slides into the closed tab's slot, not the last pane in
    // openPanels, which can be an unrelated split cell appended later.
    // Spaces: the pre-shift runs on the VISIBLE set, pre-focusing a pane
    // hidden in another space would switch the whole window mid-countdown.
    let focusBeforeClose: string | null = null;
    if (focusedPanelId === topicId) {
      const idx = visiblePanels.indexOf(topicId);
      const remaining = visiblePanels.filter(id => id !== topicId);
      const nextFocus = remaining.length > 0 ? remaining[Math.min(idx, remaining.length - 1)] : null;
      if (nextFocus) {
        focusBeforeClose = topicId;
        handleFocusPanel(nextFocus);
      }
    }
    enqueueAndTick({
      key: `close-tab:${topicId}`,
      kind: 'close-tab',
      label,
      color: topic?.color,
      // Run the upstream commit (handleClosePanel, drops the pane from the
      // store + openPanels) BEFORE the kind-specific side effect (e.g. server
      // DELETE for terminal/browser). Order matters: pane has to unmount
      // first so the xterm cleanup goes through `intentionalClose=true` and
      // doesn't paint "[Session ended]" when the PTY exits.
      commit: () => { handleClosePanel(topicId); onCommit?.(); },
      // Restore focus if the user cancels mid-countdown, without this, the
      // tab they pressed cancel on isn't the one in front anymore. We only
      // restore when we actually shifted (focusBeforeClose is non-null),
      // otherwise this becomes a no-op refocus of an unrelated pane.
      onCancel: focusBeforeClose
        ? () => handleFocusPanel(focusBeforeClose!)
        : undefined,
    });
  }, [topics, handleClosePanel, enqueueAndTick, focusedPanelId, visiblePanels, handleFocusPanel]);

  const handleArchiveTopicDeferred = useCallback((topicId: string, archive: boolean): Promise<boolean> => {
    const topic = topicsRef.current[topicId];
    // A server-registered global coordinator is durable. This guard covers
    // stale UI affordances as well as the normal visible archive controls;
    // the server remains authoritative if an older client still sends a call.
    if (topic?.isGlobalOrchestrator) return Promise.resolve(false);
    // Unarchive (archive=false) is restorative, commit immediately.
    if (!archive) return archiveTopic(topicId, false);
    const label = topic?.name || topicId;
    enqueueAndTick({
      key: `archive-topic:${topicId}`,
      kind: 'archive-topic',
      label,
      color: topic?.color,
      commit: async () => {
        if (!topicsRef.current[topicId]?.isGlobalOrchestrator) {
          await archiveTopic(topicId, true);
        }
      },
    });
    return Promise.resolve(true);
  }, [topicsRef, archiveTopic, enqueueAndTick]);

  const handleArchiveProjectDeferred = useCallback((projectPath: string, archive: boolean): Promise<boolean> => {
    if (!archive) return handleArchiveProject(projectPath, false);
    const label = projectPath.split('/').filter(Boolean).pop() || projectPath;
    enqueueAndTick({
      key: `archive-project:${projectPath}`,
      kind: 'archive-project',
      label,
      commit: async () => { await handleArchiveProject(projectPath, true); },
    });
    return Promise.resolve(true);
  }, [handleArchiveProject, enqueueAndTick]);

  // Pin/unpin (Pinned). Unpinning a CLOSED chat archives it so it falls back
  // to the 2-state model (closed ⟺ archived) instead of becoming a phantom
  // non-archived tab-less topic; unpinning an OPEN one just drops the glyph.
  // Projects are pure pin removal (their row visibility is gate-driven).
  // RULING 2.2 (binding): the liveness check runs on the FULL openPanels set,
  // NEVER visiblePanels, so unpinning a chat living in a hidden Space must
  // not archive an open tab. Project-internal opens count only through a LIVE
  // project tab (owningRenderedProject pattern): projectOpenPanes is
  // upsert-only, and a stale entry from a closed project must not make the
  // unpin skip the archive.
  /**
   * «Does unpinning this chat archive it too?», the question the menu must be
   * able to ask BEFORE writing its label.
   *
   * It is the exact condition of `handleTogglePin` below, extracted and not
   * copied: two copies diverge, and a menu entry that promises less than it
   * does is the same defect as the drag preview that promised a row that was
   * then deleted.
   */
  const unpinAlsoArchives = useCallback((id: string): boolean => {
    if (
      !sidebarIsPinned(id) ||
      id.startsWith('project:') ||
      id.startsWith('terminal:') ||
      id.startsWith('browser:')
    ) return false;
    const topic = topicsRef.current[id];
    if (!topic || topic.archived || topic.isGlobalOrchestrator) return false;
    const chatPaneId = createPaneId('chat', id);
    const openTopLevel = openPanels.includes(id);
    const openInLiveProject = Object.entries(projectOpenPanes).some(([pp, ids]) =>
      (ids.includes(chatPaneId) || ids.includes(id)) &&
      openPanels.includes(createPaneId('project', pp)),
    );
    return !openTopLevel && !openInLiveProject;
  }, [sidebarIsPinned, topicsRef, openPanels, projectOpenPanes]);
  const handleTogglePin = useCallback((id: string) => {
    // Chat-only unpin-while-closed archive semantics. Projects (`project:<path>`),
    // terminals (`terminal:<id>`) and browsers (`browser:<ctx>`) don't archive on
    // unpin, none is an archivable topic record, so those prefixes skip this
    // branch and just toggle the pin. (A bare topicId has no prefix → chat.)
    if (unpinAlsoArchives(id)) void archiveTopic(id, true);
    sidebarTogglePin(id);
  }, [unpinAlsoArchives, sidebarTogglePin, archiveTopic]);

  // Sidebar close handlers, same Things3 pattern. The raw close function
  // is server-touching (DELETE on terminal sessions / browser contexts) so
  // we wrap it in the 3 s soft window. Right-click bypasses (touch
  // overflow menu) still call the raw handlers directly.
  const handleCloseTerminalDeferred = useCallback((sessionId: string, sessionName?: string) => {
    enqueueAndTick({
      key: `close-terminal:${sessionId}`,
      kind: 'close-terminal',
      label: sessionName || 'Terminal',
      commit: async () => { await handleCloseTerminal(sessionId); },
    });
  }, [handleCloseTerminal, enqueueAndTick]);

  const handleCloseBrowserDeferred = useCallback((contextId: string) => {
    enqueueAndTick({
      key: `close-browser:${contextId}`,
      kind: 'close-browser',
      label: 'Browser',
      commit: async () => {
        // Three writes, in order:
        //
        //  1. `handleClosePanel(browser:${contextId})`, drops the pane
        //     id from `openPanels` and dispatches `CLOSE_PANE` to the
        //     pane-store so the React subtree unmounts (which in turn
        //     destroys the WebContentsView via `useNativeBrowser`'s
        //     cleanup). Has to be first: tearing down the context
        //     before the renderer is gone leaves a dangling viewId
        //     for one frame.
        //
        //  2. `flushPaneStoreNow()`, bypass the 500 ms debounce on
        //     `/api/ui-state/pane-store-v2` and PUT the new snapshot
        //     synchronously. Without this, a fast Cmd+R while the
        //     debounce is still buffering means the server snapshot
        //     still has `browser:${contextId}` in it; the next boot
        //     hydrates that snapshot, `<RemoteBrowserPanel>` mounts,
        //     `useNativeBrowser` calls `api.create(contextId)`, and
        //     Electron re-creates the partition session from disk,
        //     "ressuscitating" the tab the user just closed.
        //     `flushPaneStoreNow` returns a promise we don't await
        //     (fire-and-forget, the keepalive/beacon path picks up
        //     any retry on pagehide).
        //
        //  3. `browserCtx.closeContext(contextId)`, server DELETE
        //     for the context. Final because it's the destructive
        //     action and we want every layer above to be quiescent
        //     before the context teardown actually runs.
        handleClosePanel(`browser:${contextId}`);
        void flushPaneStoreNow();
        await browserCtx.closeContext(contextId);
      },
    });
  }, [browserCtx, enqueueAndTick, handleClosePanel]);

  return {
    handleClosePanelImmediate, handleClosePanelDeferred,
    handleArchiveTopicDeferred, handleArchiveProjectDeferred,
    unpinAlsoArchives, handleTogglePin,
    handleCloseTerminalDeferred, handleCloseBrowserDeferred,
  };
}

import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType } from '../../types';
import { LazyPane } from './LazyPane';
import { useTopics } from '../../contexts/TopicsContext';
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { GroupLayout } from './GroupLayout';
import { ChatPane } from '../Chat/ChatPane';
import { topicsApi } from '../../lib/api';
import {
  createPaneId,
  getTerminalSessionFromPaneId,
  getBrowserContextFromPaneId,
  isTaskWorkspacePath,
  useClosedTabs,
} from '../../state/pane/adapters';
import { isRealUrl, shouldPersistBrowserTitle } from '../../state/pane/browserPaneUrl';
import { computeProjectGridWeight, setProjectGridWeight, clearProjectGridWeight } from '../../state/projectGridWeights';
import { sendFocusTopic, sendBlur } from '../../lib/focusMessaging';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { useProjectPersistenceLoad } from './hooks/useProjectPersistenceLoad';
import { useProjectLayout } from './hooks/useProjectLayout';
import { useProjectChatSync } from './hooks/useProjectChatSync';
import { useProjectPersistenceSave } from './hooks/useProjectPersistenceSave';

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));
const FileExplorer = lazy(() => import('../Project/FileExplorer').then(m => ({ default: m.FileExplorer })));
const FilePane = lazy(() => import('../Editor/FilePane').then(m => ({ default: m.FilePane })));
const GitChanges = lazy(() => import('../Project/GitChanges').then(m => ({ default: m.GitChanges })));
const ActivityPane = lazy(() => import('../Sidebar/ActivityPane').then(m => ({ default: m.ActivityPane })));
const JournalPane = lazy(() => import('../Journal/JournalPane').then(m => ({ default: m.JournalPane })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const KanbanBoardPane = lazy(() => import('../Board/KanbanBoardPane').then(m => ({ default: m.KanbanBoardPane })));
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ProcessLogPane = lazy(() => import('../Project/ProcessLogPane').then(m => ({ default: m.ProcessLogPane })));


// --- ProjectWindowPane: self-contained project content (no header/chrome) ---

export interface ProjectWindowPaneProps {
  projectPath: string;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage?: (sk: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sk: string, messageId: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  pendingPane?: PaneType;
  pendingTerminalSessionId?: string;
  pendingTerminalType?: 'shell' | 'claude-code' | 'codex' | 'opencode';
  onPendingPaneConsumed?: () => void;
  // groupId = the tab bar whose "+ new chat" was clicked, so the chat lands there
  onNewChat?: (groupId?: string) => void;
  // Navigate to a specific topic inside the project (from external focus)
  pendingFocusTopicId?: string | null;
  // Group the pending-focus chat should land in (mixed-group placement)
  pendingFocusTargetGroupId?: string;
  onPendingFocusConsumed?: () => void;
  // Report which topic is currently active in this project window
  onActiveTopicChange?: (topicId: string | null) => void;
  // Report all open pane IDs inside this project (for sidebar filtering)
  onOpenPanesChange?: (paneIds: string[]) => void;
}

export function ProjectWindowPane({
  projectPath, focusedPanelId,
  onFocusPanel, onClosePanel: _onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  pendingPane, pendingTerminalSessionId, pendingTerminalType, onPendingPaneConsumed, onNewChat,
  pendingFocusTopicId, pendingFocusTargetGroupId, onPendingFocusConsumed,
  onActiveTopicChange, onOpenPanesChange,
}: ProjectWindowPaneProps) {
  // Load persisted state (fast-paint from localStorage; server fetch triggers onUpdate)
  const loaded = useProjectPersistenceLoad({ projectPath });

  // Topics from TopicsContext — was a drilled prop.
  const topics = useTopics();

  // The pane id this ProjectWindow renders under at the parent layout level.
  // Computed once per projectPath; used wherever we need to compare against
  // the wrapper (focus checks, "open me at top level", strip-from-children).
  const wrapperPaneId = useMemo(() => createPaneId('project', projectPath), [projectPath]);

  // TASK WORKSPACE: this "project window" is really a task's own workspace (a
  // per-task cwd under …/workspace/tasks/<id8>). Label it with the task title —
  // the standalone agent topic bound to this exact path carries `topic.name` =
  // the task title — instead of the opaque <id8> folder name. Memoized so the
  // O(topics) scan runs only when the path or the topic set changes.
  const taskDisplayName = useMemo(() => {
    if (!isTaskWorkspacePath(projectPath)) return undefined;
    return Object.values(topics).find((t) => t.projectPath === projectPath && t.standalone)?.name;
  }, [projectPath, topics]);


  // --- Recently closed tabs ---
  const { pushClosedTab, removeClosedTab } = useClosedTabs();

  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);
  const [claudeSkipPermissions] = useClaudeSkipPermissions();

  // URL to push into RemoteBrowserPanel.navigateUrl when the server (or a
  // local /browser slash command) requests a navigation. Set by the browser
  // listener inside `useProjectLayout`; cleared by RemoteBrowserPanel once
  // it has consumed the URL. Mirrors the same `browserNavigateUrl` pattern
  // used by `StandaloneChatGroup` — without this, the bug from PR #18/#19
  // (browser:navigate broadcast lands but no pane opens) surfaces whenever
  // the user is inside a ProjectWindow — i.e. almost always.
  const [browserNavigateUrl, setBrowserNavigateUrl] = useState<string | null>(null);

  // --- Layout (state + handlers + file events) ---
  const layout = useProjectLayout({
    projectPath,
    topics,
    initial: loaded.initial,
    focusedPanelId,
    pendingPane,
    pendingTerminalSessionId,
    pendingTerminalType,
    onPendingPaneConsumed,
    pendingFocusTopicId,
    pendingFocusTargetGroupId,
    onPendingFocusConsumed,
    onWSMessage,
    claudeSkipPermissions,
    onFocusPanel: () => onFocusPanel(wrapperPaneId),
    onNewChat,
    pushClosedTab,
    removeClosedTab,
    onOpenPanesChange,
    isSessionStreaming,
    stopSession,
    onOpenPaneSettings: setSettingsTopicId,
    gateRefs: loaded.gateRefs,
    onBrowserNavigateUrl: setBrowserNavigateUrl,
  });
  const { panes, groups, rows, rowHeights, focusedGroupId, sidebarCollapsed } = layout.state;

  // Publish this project's internal split extent (leaf columns/rows) into the
  // module registry so the STANDALONE grid can weight this project's cell when
  // the user double-clicks an outer divider to equalize — see projectGridWeights.
  // Keyed by projectPath; cleared on unmount / path change so a closed project
  // never lingers with a stale weight.
  useEffect(() => {
    setProjectGridWeight(projectPath, computeProjectGridWeight(rows));
    return () => clearProjectGridWeight(projectPath);
  }, [projectPath, rows]);
  const { setRows, setRowHeights, setSidebarCollapsed } = layout.setters;
  const pinPaneById = layout.handlers.pinPaneById;
  const handleOpenFile = layout.handlers.openFile;
  const handleOpenProcessLog = layout.handlers.openProcessLog;
  const handleAddPaneToGroup = layout.handlers.addToGroup;
  const handleAddPaneWhenEmpty = layout.handlers.addWhenEmpty;
  const handleActivatePane = layout.handlers.activate;
  const handleClosePane = layout.handlers.close;
  const handleClosePaneImmediate = layout.handlers.closeNow;
  const handleReorderGroupPanes = layout.handlers.reorderGroupPanes;
  const handleMovePaneBetweenGroups = layout.handlers.moveBetweenGroups;
  const handleSplitGroup = layout.handlers.splitGroup;
  const handleReorderRows = layout.handlers.reorderRows;
  const handlePinPane = layout.handlers.pinPane;
  const handlePaneSettings = layout.handlers.paneSettings;
  const handlePanePopOut = layout.handlers.panePopOut;
  const updatePane = layout.handlers.updatePane;
  const availableTypesForGroup = layout.helpers.availableTypesForGroup;

  // --- Chat sync (chat-pane reconciliation against topic list) ---
  const chatSync = useProjectChatSync({
    projectPath,
    topics,
    initial: loaded.initial,
    panes,
    groups,
    focusedGroupId,
    applyChatReconciliation: layout.applyChatReconciliation,
    reopenChatPane: layout.reopenChatPane,
    gateRefs: loaded.gateRefs,
    markChatSyncDone: loaded.markChatSyncDone,
  });
  const { activeTopicId } = chatSync;

  // Wire server-hydrate (single callback, no bus). chat-sync owns the
  // reconciliation policy; loaded owns the subscribe/userEditedRef gate.
  useEffect(() => {
    loaded.setOnServerHydrate(chatSync.onServerHydrate);
    return () => loaded.setOnServerHydrate(null);
  }, [loaded, chatSync.onServerHydrate]);

  // Report active topic changes to parent (for sidebar highlighting)
  useEffect(() => {
    onActiveTopicChange?.(activeTopicId);
  }, [activeTopicId, onActiveTopicChange]);

  // Mark active topic as read when it changes within the project
  const isProjectFocused = focusedPanelId === wrapperPaneId;
  useEffect(() => {
    if (!isProjectFocused) return;
    if (activeTopicId) {
      topicsApi.markRead(activeTopicId).catch(() => {});
      sendFocusTopic(sendWS, activeTopicId);
    } else {
      // Active pane is non-chat (terminal, browser, etc.) — clear server focus
      sendBlur(sendWS);
    }
  }, [activeTopicId, isProjectFocused, sendWS]);

  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) map[p.id] = p.topicId;
    }
    return map;
  }, [panes]);
  const contextPercent = useMultiContextPercent(paneToTopicMap, onWSMessage);

  // Project rollup (loading + notifications) is computed centrally from the
  // global signals store now — no per-window report-up needed.

  // Two sources for the tab "in progress" spinner — chat panes
  // streaming an LLM, terminal panes producing pty output. See
  // StandaloneChatGroup for the full rationale; the project window
  // mirrors the same wiring so terminal tabs inside a project pulse
  // the same way as terminal tabs at top-level.
  const handleStopStreaming = layout.handlers.stopStreaming;

  // The Context Inspector is a popover owned by the active topic's composer
  // (`ChatInput`); it listens for `chat-input:toggle-context` itself. This
  // window only needs to fire that event from its header context ring.
  const toggleContextInspector = useCallback(() => {
    if (!activeTopicId) return;
    window.dispatchEvent(new CustomEvent('chat-input:toggle-context', { detail: { topicId: activeTopicId } }));
  }, [activeTopicId]);

  // Listen for global Cmd+1-9 events that resolve to a pane inside this
  // project. We find which group owns the paneId and activate it. The event
  // is keyed by projectPath so projects in split view ignore each other's
  // hits.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectPath?: string; paneId?: string } | undefined;
      if (!detail || detail.projectPath !== projectPath || !detail.paneId) return;
      // Find which group contains this pane (panes can live in any group).
      const owningGroup = groups.find(g => g.paneIds.includes(detail.paneId!));
      if (!owningGroup) return;
      handleActivatePane(owningGroup.id, detail.paneId);
    };
    window.addEventListener('global-tab:focus-inner', handler);
    return () => window.removeEventListener('global-tab:focus-inner', handler);
  }, [projectPath, groups, handleActivatePane]);

  // Persist tab identity to the server (cross-device sync) and layout to
  // localStorage only, on every layout/chat change.
  useProjectPersistenceSave({
    projectPath,
    panes,
    groups,
    rows,
    rowHeights,
    sidebarCollapsed,
    activeChatTopicId: activeTopicId ?? undefined,
    focusedGroupId,
    onOpenPanesChange,
  });

  const handleNewChatInGroup = useCallback((groupId: string) => {
    // Pass the clicked group's id so the new chat lands as a tab in THAT group
    // (even a terminal/utility group), instead of the type-affinity fallback
    // that would split a new chat column. Empty id (empty-state button) → no
    // target → reopenChatPane's normal fallback chain.
    onNewChat?.(groupId);
  }, [onNewChat]);


  const renderPane = useCallback((pane: Pane, isFocused: boolean, isVisible: boolean) => {
    switch (pane.type) {
      case 'chat': {
        const topic = pane.topicId ? topics[pane.topicId] : null;
        if (!topic) return <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">Topic not found</div>;
        const wrappedSendMessage = pane.preview
          ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
              pinPaneById(pane.id);
              return sendMessage(sk, content, options);
            }
          : sendMessage;
        return (
          <ChatPane
            topic={topic}
            isFocused={isFocused && focusedPanelId === wrapperPaneId}
            getSessionMessages={getSessionMessages}
            isSessionLoading={isSessionLoading}
            isSessionStreaming={isSessionStreaming}
            stopSession={stopSession}
            sendMessage={wrappedSendMessage}
            editMessage={editMessage}
            regenerateMessage={regenerateMessage}
            deleteMessage={deleteMessage}
            switchBranch={switchBranch}
            loadHistory={loadHistory}
            chatError={chatError}
            sendWS={sendWS}
            onWSMessage={onWSMessage}
            onUpdateTopic={onUpdateTopic}
            onOpenFile={handleOpenFile}
          />
        );
      }
      case 'browser':
        return (
          <LazyPane>
            {/* `isVisible` drives WebContentsView visibility — see the
                same prop in StandaloneChatGroup.renderPaneBody for the
                full rationale. The keep-alive wrapper in GroupLayout is
                what hides this pane via display:none, but the OS-level
                native browser overlay can't observe that.
                `navigateUrl` is set whenever the server broadcasts
                `browser:navigate` or a local `browser:open-and-navigate`
                fires inside this project; cleared by the panel once
                consumed. Gated on `isVisible` so an inactive browser pane
                doesn't steal navigation from the focused one. */}
            <RemoteBrowserPanel
              // The contextId MUST be the one encoded in the pane id (term-<id>
              // for a terminal-opened pane, topic.id for a chat-opened one) so the
              // native CDP target registers under the SAME id the agent's
              // browser_observe/act/eval resolve to — otherwise tools hit an
              // invisible Playwright phantom. Was hardcoded to projectPath, which
              // (a) never matched the agent's contextId and (b) contains slashes
              // that broke the /api/browsers/:id/cdp-target route (404 → no
              // registration). Fall back to projectPath only for a legacy pane id
              // with no encoded context.
              contextId={getBrowserContextFromPaneId(pane.id) ?? projectPath}
              isVisible={isVisible}
              // Restore the project browser tab to its last page after a restart
              // (mount-only). pane.url round-trips via projectLayoutSync. Guard
              // with isRealUrl so a persisted chrome-error: page doesn't restore.
              initialUrl={isRealUrl(pane.url) ? pane.url : undefined}
              navigateUrl={isVisible && browserNavigateUrl ? browserNavigateUrl : undefined}
              onNavigateConsumed={isVisible ? () => setBrowserNavigateUrl(null) : undefined}
              // Persist each navigation onto the project pane for next restart.
              // isRealUrl == the standalone path's guard (browserPaneUrl.ts) — it
              // also drops chrome-error: pages, which the old inline check missed.
              onUrlChange={(u) => { if (isRealUrl(u) && u !== pane.url) updatePane(pane.id, { url: u }); }}
              // Label the project browser tab with the live page title (gated so
              // a manual rename — titleSource='user' — survives navigation).
              onTitleChange={(t) => { if (shouldPersistBrowserTitle(pane.title, pane.titleSource, t)) updatePane(pane.id, { title: t.trim(), titleSource: 'auto' }); }}
              onFocusPanel={onFocusPanel}
              topics={topics}
              // A click inside the native pane never reaches React, so activate
              // this pane's tab via the same fresh-`groups` handler the global
              // inner-tab focus uses (avoids a stale-closure group lookup here).
              onSelfFocus={() => window.dispatchEvent(new CustomEvent('global-tab:focus-inner', { detail: { projectPath, paneId: pane.id } }))}
            />
          </LazyPane>
        );
      case 'terminal': {
        const sessionId = getTerminalSessionFromPaneId(pane.id);
        if (!sessionId) return null;
        return (
          <LazyPane>
            <SingleTerminalPane sessionId={sessionId} isActive={isVisible} />
          </LazyPane>
        );
      }
      case 'file':
        return pane.filePath ? (
          <LazyPane>
            <FilePane
              filePath={pane.filePath}
              projectPath={projectPath}
              diff={pane.diff}
              diffProjectPath={pane.diffProjectPath}
              onPin={pane.preview ? () => pinPaneById(pane.id) : undefined}
            />
          </LazyPane>
        ) : null;
      case 'files':
        return (
          <LazyPane>
            <FileExplorer projectPath={projectPath} />
          </LazyPane>
        );
      case 'git':
        return (
          <LazyPane>
            <GitChanges projectPath={projectPath} />
          </LazyPane>
        );
      case 'activity':
        return (
          <LazyPane>
            <ActivityPane />
          </LazyPane>
        );
      case 'journal':
        return (
          <LazyPane>
            <JournalPane />
          </LazyPane>
        );
      case 'agents':
        return (
          <LazyPane>
            <AgentsPane onNavigateToTopic={(topicId) => onFocusPanel(topicId)} onMessage={onWSMessage} />
          </LazyPane>
        );
      case 'dashboard':
        return (
          <LazyPane>
            <DashboardPane onMessage={onWSMessage} />
          </LazyPane>
        );
      case 'kanban':
        return (
          <LazyPane>
            <KanbanBoardPane
              projectPath={projectPath}
              onMessage={onWSMessage}
              onOpenTopic={chatSync.reopenTopic}
            />
          </LazyPane>
        );
      case 'process-log':
        return pane.processId ? (
          <LazyPane>
            <ProcessLogPane processId={pane.processId} scriptName={pane.title} />
          </LazyPane>
        ) : null;
      default:
        return null;
    }
  }, [
    topics, focusedPanelId, projectPath, wrapperPaneId,
    getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
    sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
    handleOpenFile, pinPaneById, onFocusPanel, browserNavigateUrl, chatSync.reopenTopic,
  ]);

  return (
    <>
      {/* data-testid: the e2e suite scopes "project window's own tabs" queries
          to this wrapper (grid-split flatten invariant). It used to live on the
          long-dead ProjectWindow wrapper component — matching nothing — which
          made that oracle silently vacuous. */}
      <div data-testid="project-window" className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        <ProjectSidebar
          projectPath={projectPath}
          displayName={taskDisplayName}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
          onOpenFile={handleOpenFile}
          onWSMessage={onWSMessage}
          onOpenProcessLog={handleOpenProcessLog}
        />
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <GroupLayout
            panes={panes}
            groups={groups}
            rows={rows}
            rowHeights={rowHeights}
            focusedGroupId={focusedGroupId}
            // Tab-drag scope: tabs may only move between groups of THIS project.
            dndScope={projectPath}
            // App-level focus signal: PaneTabBar uses this to render a
            // dimmed-active state for the focused group's active tab when
            // the project itself sits next to a sibling in App split view
            // and the user is interacting with that sibling.
            isAppFocused={isProjectFocused}
            onActivatePane={handleActivatePane}
            onClosePane={handleClosePane}
            onClosePaneImmediate={handleClosePaneImmediate}
            onAddPaneToGroup={handleAddPaneToGroup}
            onNewChatInGroup={onNewChat ? handleNewChatInGroup : undefined}
            onAddPaneWhenEmpty={handleAddPaneWhenEmpty}
            onReorderGroupPanes={handleReorderGroupPanes}
            onMovePaneBetweenGroups={handleMovePaneBetweenGroups}
            onSplitGroup={handleSplitGroup}
            onReorderRows={handleReorderRows}
            onUpdateRows={setRows}
            onUpdateRowHeights={setRowHeights}
            renderPane={renderPane}
            availableTypesForGroup={availableTypesForGroup}
            contextPercent={contextPercent}
            onContextRingClick={toggleContextInspector}
            onStopStreaming={handleStopStreaming}
            onSettings={handlePaneSettings}
            onPopOut={handlePanePopOut}
            onPinPane={handlePinPane}
            // Tab-level rename parity: chat → canonical topic update; browser →
            // pin pane.title with titleSource='user' (project panes persist via
            // updatePane, not the global store, so we can't use the store helper).
            onRenameChat={(tid, name) => { void onUpdateTopic(tid, { name }); }}
            onRenameBrowser={(id, name) => updatePane(id, { title: name, titleSource: 'user' })}
          />
        </div>
      </div>
      {settingsTopicId && topics[settingsTopicId] && (
        <Suspense fallback={null}>
          <TopicSettingsModal
            topic={topics[settingsTopicId]}
            isOpen={!!settingsTopicId}
            onClose={() => setSettingsTopicId(null)}
            onUpdate={onUpdateTopic}
          />
        </Suspense>
      )}
    </>
  );
}

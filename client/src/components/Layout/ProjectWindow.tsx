import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { pinKeyFromPaneId } from '../../state/pane/adapters/paneConfig';
import type { TerminalAgentType } from '../../../../shared/terminal-session-types';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, CompactionMarker } from '../../types';
import { LazyPane } from './LazyPane';
import { useTopics } from '../../contexts/TopicsContext';
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { GroupLayout } from './GroupLayout';
import { ChatPane } from '../Chat/ChatPane';
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
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { useProjectPersistenceLoad } from './hooks/useProjectPersistenceLoad';
import { useProjectLayout } from './hooks/useProjectLayout';
import { useProjectChatSync } from './hooks/useProjectChatSync';
import { useProjectPersistenceSave } from './hooks/useProjectPersistenceSave';
import type { SendMessageOptions } from '@/hooks/useChat';
import { missionPrompt, type Mission } from '../../lib/missions';
import { pickMissionSession } from '../../lib/missionTarget';

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));
const FileExplorer = lazy(() => import('../Project/FileExplorer').then(m => ({ default: m.FileExplorer })));
const FilePane = lazy(() => import('../Editor/FilePane').then(m => ({ default: m.FilePane })));
const GitChanges = lazy(() => import('../Project/GitChanges').then(m => ({ default: m.GitChanges })));
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
  getCompactionMarkers?: (sk: string) => CompactionMarker[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  wasSessionStopped: (sk: string) => boolean;
  stopSession: (sk: string) => Promise<boolean>;
  sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage?: (sk: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sk: string, messageId: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: Record<string, string | null>;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  pendingPane?: PaneType;
  pendingTerminalSessionId?: string;
  pendingTerminalType?: TerminalAgentType;
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
  /**
   * Il pin della sidebar, passato di sopra e inoltrato al `GroupLayout`.
   *
   * Serve perché dentro un progetto le cose fissabili sono DUE — il progetto e
   * la singola tab — e finora il menu non ne offriva nessuna: `PaneTabBar`
   * nasconde la voce quando l'ospite non cabla `onToggleFissato`, e nessun
   * ospite di progetto lo cablava.
   */
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
  /**
   * Is this project window the ACTIVE top-level tab? The host keeps every
   * visited window mounted behind `display:none`, and a hidden DOM subtree is
   * invisible to the panes inside it: without this flag the window kept telling
   * its own active pane "you are visible", so a background project's browser
   * pane stayed an unhidden WKWebView — a live page burning rAF and RAM behind
   * a tab nobody is looking at — and its terminal stayed on the foreground
   * poll cadence. Defaults true so a host that never hides is unaffected.
   */
  isVisible?: boolean;
}

export function ProjectWindowPane({
  projectPath, focusedPanelId,
  onFocusPanel, onClosePanel: _onClosePanel,
  getSessionMessages, getCompactionMarkers, isSessionLoading, isSessionStreaming, wasSessionStopped, stopSession,
  sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  pendingPane, pendingTerminalSessionId, pendingTerminalType, onPendingPaneConsumed, onNewChat,
  pendingFocusTopicId, pendingFocusTargetGroupId, onPendingFocusConsumed,
  onActiveTopicChange, onOpenPanesChange, onToggleFissato, isFissato, isVisible: windowVisible = true,
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
  //
  // TARGETED: carries the destination pane id alongside the url. The old
  // string-only state fanned out to EVERY visible browser pane (the isVisible
  // gate assumed tab semantics — one visible browser at a time), so with
  // splits N panes navigated in lockstep: a leftover browser tab from an
  // archived topic shadow-followed every terminal-driven navigation ("two
  // tabs on the same site"). paneId absent = legacy broadcast, old behavior.
  const [browserNavigate, setBrowserNavigate] = useState<{ url: string; paneId?: string } | null>(null);

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
    onBrowserNavigateUrl: (url, paneId) => setBrowserNavigate({ url, paneId }),
  });
  const { panes, groups, rows, rowHeights, focusedGroupId, sidebarCollapsed } = layout.state;

  /**
   * IL POSTO DELLA BARRA CHIUSA, dentro la riga delle tab.
   *
   * Un nodo solo, creato qui e passato a due componenti: `GroupLayout` lo
   * AGGANCIA in testa alla prima barra, `ProjectSidebar` ci SCRIVE dentro col
   * suo portale quando è collassata. Chiusa, la barra di progetto smette di
   * essere una colonna verticale con un filo laterale e diventa una fila di
   * card in linea con le tab.
   *
   * Un `HTMLElement` e non uno stato con una ref: il nodo esiste già al primo
   * render, quindi non c'è il fotogramma in cui la rail vecchia compare e poi
   * sparisce. `useMemo` con dipendenze vuote e non `useRef` perché serve un
   * valore stabile da PASSARE, non da leggere.
   */
  const railSlot = useMemo(() => document.createElement('div'), []);

  // Publish this project's internal split extent (leaf columns/rows) into the
  // module registry so the STANDALONE grid can weight this project's cell when
  // the user double-clicks an outer divider to equalize — see projectGridWeights.
  // Keyed by projectPath; cleared on unmount / path change so a closed project
  // never lingers with a stale weight.
  //
  // Keyed on the EXTENT, not on `rows`. A divider drag inside this window
  // rebuilds `rows` (new widths, same shape), which re-ran this effect, and the
  // cleanup's `clear` announced a change the registry then had to un-say. What
  // heard it was PanelGrid's auto-rebalance, which flattened the outer grid's
  // row heights to an equal split: resize a split in one project, lose the
  // sizing of every window around it.
  const gridWeight = useMemo(() => computeProjectGridWeight(rows), [rows]);
  useEffect(() => {
    setProjectGridWeight(projectPath, gridWeight);
    return () => clearProjectGridWeight(projectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the extent IS the payload: depending on the `gridWeight` object would re-run on every rows rebuild, which is the bug this avoids
  }, [projectPath, gridWeight.cols, gridWeight.rows]);
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
      // Il solo ping di focus: `sendWS` ci attacca da sé l'azzeramento locale e
      // la POST di lettura, ma solo se c'è davvero qualcosa di non letto.
      sendFocusTopic(sendWS, activeTopicId);
    } else {
      // Active pane is non-chat (terminal, browser, etc.) — clear server focus
      sendBlur(sendWS);
    }
  }, [activeTopicId, isProjectFocused, sendWS]);


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

  /**
   * UNA MISSIONE ALLA SESSIONE LATERALE.
   *
   * Tre gesti in uno, e sono tutti gesti che esistevano già: si sceglie la chat
   * di progetto (`pickMissionSession`), le si mette il testo nella bozza —
   * `draft:<topicId>`, la stessa che ChatPane salva e ricarica da sola — e la si
   * apre accanto alla board (`reopenTopic`, la stessa chiamata di quando si
   * clicca una sessione). Nessun tipo di sessione nuovo, nessuna route: la
   * missione è testo davanti a una chat normale.
   *
   * A MANDARE È L'UMANO. Non è timidezza: la missione dà compiti IN PIÙ, e una
   * board da cui partono turni al click è di nuovo il posto da cui si lavora —
   * l'esatta cosa che questa feature non deve diventare.
   *
   * Se c'è già una bozza, la missione si ACCODA invece di sostituirla: quel
   * testo è lavoro di qualcuno, e cancellarlo per un click su un menu sarebbe
   * un furto silenzioso.
   */
  const startMission = useCallback((mission: Mission): string | null => {
    const topicId = pickMissionSession({ projectPath, topics, panes, groups, focusedGroupId });
    if (!topicId) return 'Nessuna chat di progetto a cui dare la missione: aprine una e riprova.';
    const text = missionPrompt(mission, projectPath.split('/').filter(Boolean).pop() || projectPath);
    let seeded = text;
    try {
      const existing = localStorage.getItem(`draft:${topicId}`) || '';
      seeded = existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text;
      localStorage.setItem(`draft:${topicId}`, seeded);
    } catch { /* private mode: la bozza vive comunque nell'evento qui sotto */ }
    // La pane può essere GIÀ montata su quel topic, e in quel caso l'effetto che
    // rilegge la bozza (dipende da `topic.id`) non riparte: senza questo evento
    // la missione resterebbe scritta su localStorage e invisibile.
    window.dispatchEvent(new CustomEvent('topics:seed-composer', { detail: { topicId, text: seeded } }));
    chatSync.reopenTopic(topicId);
    return null;
  }, [projectPath, topics, panes, groups, focusedGroupId, chatSync]);

  const handleNewChatInGroup = useCallback((groupId: string) => {
    // Pass the clicked group's id so the new chat lands as a tab in THAT group
    // (even a terminal/utility group), instead of the type-affinity fallback
    // that would split a new chat column. Empty id (empty-state button) → no
    // target → reopenChatPane's normal fallback chain.
    onNewChat?.(groupId);
  }, [onNewChat]);


  const renderPane = useCallback((pane: Pane, isFocused: boolean, isVisible: boolean) => {
    // `isVisible` from GroupLayout means "active tab of its group" — it knows
    // nothing about the tab strip ABOVE this window. `onScreen` is the real
    // thing: active tab here AND this whole window on screen. Only the panes
    // that own an OS-level view (browser) or a cadence (terminal) use it —
    // navigation stays on `isVisible`, because a background window must still
    // be able to open and drive a browser pane for its agent.
    const onScreen = isVisible && windowVisible;
    switch (pane.type) {
      case 'chat': {
        const topic = pane.topicId ? topics[pane.topicId] : null;
        if (!topic) return <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">Topic not found</div>;
        const wrappedSendMessage = pane.preview
          ? async (sk: string, content: string, options?: SendMessageOptions) => {
              pinPaneById(pane.id);
              return sendMessage(sk, content, options);
            }
          : sendMessage;
        return (
          <ChatPane
            topic={topic}
            isFocused={isFocused && focusedPanelId === wrapperPaneId}
            getSessionMessages={getSessionMessages}
            getCompactionMarkers={getCompactionMarkers}
            isSessionLoading={isSessionLoading}
            isSessionStreaming={isSessionStreaming}
            wasSessionStopped={wasSessionStopped}
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
              // `onScreen`, not `isVisible`: the native view has to be hidden
              // when this WINDOW is behind another top-level tab too, not only
              // when the pane is behind a sibling tab in its own group.
              isVisible={onScreen}
              // Restore the project browser tab to its last page after a restart
              // (mount-only). pane.url round-trips via projectLayoutSync. Guard
              // with isRealUrl so a persisted chrome-error: page doesn't restore.
              initialUrl={isRealUrl(pane.url) ? pane.url : undefined}
              navigateUrl={isVisible && browserNavigate && (!browserNavigate.paneId || browserNavigate.paneId === pane.id) ? browserNavigate.url : undefined}
              onNavigateConsumed={isVisible ? () => setBrowserNavigate(null) : undefined}
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
            <SingleTerminalPane sessionId={sessionId} isActive={onScreen} />
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
              onStartMission={startMission}
            />
          </LazyPane>
        );
      case 'process-log':
        return pane.processId ? (
          <LazyPane>
            <ProcessLogPane processId={pane.processId} scriptName={pane.title} onMessage={onWSMessage} />
          </LazyPane>
        ) : null;
      default:
        return null;
    }
  }, [
    topics, focusedPanelId, projectPath, wrapperPaneId,
    getSessionMessages, getCompactionMarkers, isSessionLoading, isSessionStreaming, wasSessionStopped, stopSession,
    sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
    handleOpenFile, pinPaneById, onFocusPanel, browserNavigate, chatSync.reopenTopic, updatePane,
    windowVisible, startMission,
  ]);

  return (
    <>
      {/* data-testid: the e2e suite scopes "project window's own tabs" queries
          to this wrapper (grid-split flatten invariant). It used to live on the
          long-dead ProjectWindow wrapper component — matching nothing — which
          made that oracle silently vacuous. */}
      {/* data-project-path: senza, "project-window" identifica il TIPO di
          finestra ma non QUALE, e con due progetti affiancati un'asserzione
          come «il diff è nella finestra giusta» non è nemmeno esprimibile —
          si può solo contare. È il gancio che rende verificabile lo scoping
          per progetto (tests/e2e/diff-project-scope.spec.ts). */}
      <div data-testid="project-window" data-project-path={projectPath} className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        <ProjectSidebar
          projectPath={projectPath}
          displayName={taskDisplayName}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
          onOpenFile={handleOpenFile}
          onWSMessage={onWSMessage}
          onOpenProcessLog={handleOpenProcessLog}
          inlineSlot={railSlot}
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
            // L'ospite delle tab, per «Copia link»: senza, un file aperto qui
            // dentro non avrebbe un link (il suo pane id è sorteggiato a ogni
            // apertura, l'indirizzo è progetto + path) e una pane browser
            // perderebbe l'hint `?in=` che dice DOVE riaprirla.
            linkContext={{ projectPath }}
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
            onContextRingClick={toggleContextInspector}
            onStopStreaming={handleStopStreaming}
            onSettings={handlePaneSettings}
            onPopOut={handlePanePopOut}
            onPinPane={handlePinPane}
            onToggleFissato={onToggleFissato}
            isFissato={isFissato}
            // La chiave con cui la sidebar conosce QUESTO progetto. Si ricava
            // dall'id di pane invece di comporre a mano `project:<path>`: la
            // forma grezza e quella codificata divergono, ed è già costato una
            // volta (vedi `pinKeyFromPaneId`).
            projectPinKey={pinKeyFromPaneId(wrapperPaneId)}
            // Tab-level rename parity: chat → canonical topic update; browser →
            // pin pane.title with titleSource='user' (project panes persist via
            // updatePane, not the global store, so we can't use the store helper).
            onRenameChat={(tid, name) => { void onUpdateTopic(tid, { name }); }}
            onRenameBrowser={(id, name) => updatePane(id, { title: name, titleSource: 'user' })}
            leadingSlot={railSlot}
            // La finestra di progetto vive SOTTO la tab del progetto nella barra
            // dell'app: la sua prima riga di chrome non ripete l'aria che quella
            // sopra ha gia messo. Vedi CHROME_BAR_SUB.
            subordinate
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

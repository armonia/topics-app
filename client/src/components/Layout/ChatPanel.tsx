import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { Settings, Pin, X, ExternalLink, Layers, ArrowLeft, Crown, Globe } from 'lucide-react';
import { useSpawnedBrowser } from '../../state/browserSpawner';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelTab } from '../../types';
import { TopicIcon } from '@/lib/topicIcons';
import { topicsApi, commandApi } from '../../lib/api';
import { sendFocusTopic } from '../../lib/focusMessaging';
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ContextInspector = lazy(() => import('../Context/ContextInspector').then(m => ({ default: m.ContextInspector })));
import { CommandMenu } from '../Shared/CommandMenu';
import { ChatPane } from '../Chat/ChatPane';
import { MasterBoardStrip } from '../Board/MasterBoardStrip';
import { useContextInspector } from '../../hooks/useContextInspector';

const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

const CONTEXT_INSPECTOR_KEY = 'topics-context-inspector-open';

interface ChatPanelProps {
  topic: Topic; isFocused: boolean; onFocus: () => void; onClose: () => void;
  onDragStart: (e: React.DragEvent) => void; onToggleSidebar?: () => void; isDragOver: boolean;
  getSessionMessages: (sk: string) => ChatMessage[]; isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean; sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  /**
   * Abort the in-flight assistant turn for `sessionKey`. Returns true iff
   * the chat was a brand-new throwaway (one-user-message thread) — the
   * caller may then discard the topic. Threaded through to `ChatInput` so
   * the unified composer button can offer Stop without going through the
   * sidebar `TopicItem` route. See `composerAction.ts`.
   */
  stopSession: (sk: string) => boolean;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>; chatError: string | null;
  sendWS: (msg: WSMessage) => void; onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  initialTab?: PanelTab;
  onInitialTabConsumed?: () => void;
  /** Replace the default left side (icon/name/drag) with custom content (e.g. tab bar) */
  headerLeft?: React.ReactNode;
  /** Hide the close button in header (useful when tabs already have close) */
  showCloseButton?: boolean;
  /** External toggle for context inspector (from tab ring click) */
  contextOpen?: boolean;
  onToggleContext?: () => void;
  /** Callback to open a session-viewer pane for a spawned agent */
  onOpenSessionViewer?: (sessionKey: string) => void;
  /** Local handler that opens / focuses a tab. Threaded down so the
   *  Master strip can jump to any session reliably (works for
   *  project-scoped topics too, unlike a bare sendFocusTopic which is
   *  presence-only). */
  onFocusPanel?: (topicId: string) => void;
  /** Id of the open Master pane (if any). Used to render a "← Master"
   *  back affordance in non-Master panes so the user can return with
   *  one click after jumping out from the Master strip. */
  masterPaneId?: string | null;
  /** Skip the header entirely — used when StandaloneChatGroup renders a
   *  single shared header above a keep-alive ladder of pane bodies. The
   *  body still renders banners, ChatPane, and the context inspector
   *  slide-out; only the header chrome (icon/name, sidebar toggle,
   *  context-inspector button, settings button, close button) is omitted.
   *  Settings, pop-out, and close are reachable via the parent's tab
   *  bar / context menu instead. */
  bodyOnly?: boolean;
}

export function ChatPanel({
  topic, isFocused, onFocus, onClose, onDragStart, onToggleSidebar, isDragOver,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession, sendMessage, editMessage, switchBranch, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic, initialTab, onInitialTabConsumed,
  headerLeft, showCloseButton = true,
  contextOpen: externalContextOpen, onToggleContext: externalToggleContext,
  onOpenSessionViewer,
  onFocusPanel,
  masterPaneId,
  bodyOnly = false,
}: ChatPanelProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 1024);
  useEffect(() => { const h = () => { setIsMobile(window.innerWidth < 768); setIsNarrow(window.innerWidth < 1024); }; window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  const [showSettings, setShowSettings] = useState(false);
  const [showContextInternal, setShowContextInternal] = useState(() => {
    try { return localStorage.getItem(CONTEXT_INSPECTOR_KEY) === 'true'; } catch { return false; }
  });
  // Use external state if provided, otherwise internal
  const showContext = externalContextOpen !== undefined ? externalContextOpen : showContextInternal;
  const setShowContext = externalToggleContext
    ? (_v: boolean | ((prev: boolean) => boolean)) => externalToggleContext()
    : setShowContextInternal;
  // Persist context inspector state
  useEffect(() => {
    try { localStorage.setItem(CONTEXT_INSPECTOR_KEY, String(showContext)); } catch {}
  }, [showContext]);

  // Listen for context-ring clicks coming from this panel's ChatInput. Each
  // event carries its topicId so panels in split view ignore events meant for
  // a sibling.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { topicId?: string } | undefined;
      if (!detail || detail.topicId !== topic.id) return;
      setShowContext(prev => !prev);
    };
    window.addEventListener('chat-input:toggle-context', handler);
    return () => window.removeEventListener('chat-input:toggle-context', handler);
  }, [topic.id, setShowContext]);

  // Consume initial tab override
  useEffect(() => {
    if (initialTab && initialTab !== 'browser') {
      onInitialTabConsumed?.();
    }
  }, [initialTab, onInitialTabConsumed]);
  const [suggestedProject, setSuggestedProject] = useState<string | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandResult, setCommandResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Keep hook alive for potential inspector use (skip for draft topics)
  const isDraft = topic.id.startsWith('draft:');
  useContextInspector(isDraft ? null : topic.id);

  // Jump-to-browser affordance: surfaces a header button when this topic
  // has previously spawned a browser pane via /browser <url> or the LLM
  // browser tool. Null when no spawn has happened — hides the button.
  const spawnedBrowserCtx = useSpawnedBrowser(isDraft ? null : topic.id);

  const currentMessages = getSessionMessages(topic.sessionKey);

  useEffect(() => { if (isFocused && !isDraft) { topicsApi.markRead(topic.id).catch(() => {}); sendFocusTopic(sendWS, topic.id); } }, [isFocused, isDraft, topic.id, sendWS]);

  const addSystemMessage = useCallback((content: string) => { fetch(`/api/topics/${topic.id}/system-message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }).then(() => loadHistory(topic.sessionKey)); }, [topic.id, topic.sessionKey, loadHistory]);
  const handleCommandStatus = useCallback(async () => { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); addSystemMessage(r.output || 'Status retrieved'); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey, addSystemMessage]);
  const handleCommandClear = useCallback(async () => { if (!window.confirm('Clear conversation? A backup will be saved.')) return; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey, loadHistory]);
  const handleCommandModel = useCallback(async (model: string) => { setCommandLoading(true); try { await commandApi.setModel(topic.sessionKey, model); addSystemMessage(`Model set to: ${model}`); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey, addSystemMessage]);
  const handleCommandReasoning = useCallback(async () => { setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey); setCommandResult({ type: 'success', message: r.message || 'Reasoning toggled' }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey]);
  useEffect(() => { if (commandResult) { const t = setTimeout(() => setCommandResult(null), 5000); return () => clearTimeout(t); } }, [commandResult]);

  const pinnedMessages = currentMessages.filter(m => (topic.pinnedMessages || []).includes(m.id));


  const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

  return (
    <>
      <div role="region" aria-label={`${topic.name} panel`} className={`relative flex flex-col flex-1 min-h-0 bg-surface overflow-hidden transition-all duration-100 ${isDragOver ? 'bg-primary/3' : ''}`} onClick={onFocus}>
        {/* Header — skipped in `bodyOnly` mode (parent owns it). On mobile
            with tabs: floating overlay with blur for scroll-through effect. */}
        {!bodyOnly && <div className={`flex items-center ${headerLeft
          ? 'pr-0 h-12 md:h-10 md:border-b md:border-app-border'
          : 'gap-1.5 px-2 border-b border-app-border h-10'
        } select-none flex-shrink-0 bg-surface app-drag-region`}>
          {onToggleSidebar && !headerLeft && <SidebarToggleButton onClick={onToggleSidebar} />}
          {headerLeft ? (
            <div className="flex-1 flex items-center min-w-0 overflow-visible app-no-drag" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
              {headerLeft}
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0 cursor-grab active:cursor-grabbing app-no-drag" draggable onDragStart={onDragStart}>
              <span className="leading-none flex items-center justify-center w-6 h-6 flex-shrink-0"><TopicIcon name={topic.icon} size={16} color={topic.color || undefined} /></span>
              <span className="text-[14px] font-medium truncate text-app-text" style={{ maxWidth: 'min(200px, 40vw)' }}>{topic.name}</span>
              {currentMessages.length > 0 && (
                <span className="text-[10px] text-app-text-muted tabular-nums ml-1">{currentMessages.length} msg</span>
              )}
            </div>
          )}
          {!headerLeft && <div className="flex-1" />}
          {/* Jump-to-spawned-browser — visible only when this chat has
              previously opened a browser pane (tracked in browserSpawner).
              Focuses the browser pane id `browser:<contextId>` and emits a
              `browser:reflow-request` event so NativeBrowserPlaceholder
              re-issues setBounds immediately. The reflow side-effect is
              the practical fix for the intermittent white-screen on focus
              (CSS transition outpaces the polling window in the placeholder). */}
          {!headerLeft && spawnedBrowserCtx && onFocusPanel && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFocusPanel(`browser:${spawnedBrowserCtx}`);
                window.dispatchEvent(new CustomEvent('browser:reflow-request', {
                  detail: { contextId: spawnedBrowserCtx },
                }));
              }}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors app-no-drag"
              title="Vai al browser aperto da questa chat"
              aria-label="Vai al browser"
              data-testid="chat-jump-to-browser"
            >
              <Globe size={14} />
            </button>
          )}
          {/* Context Inspector toggle — hidden when headerLeft has rings */}
          {!headerLeft && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowContext(!showContext); }}
              className={`${'w-7 h-7'} flex items-center justify-center rounded transition-colors app-no-drag ${
                showContext
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-app-hover text-app-text-tertiary hover:text-app-text'
              }`}
              title="Context Inspector"
              aria-label="Context Inspector"
            >
              <Layers size={14} />
            </button>
          )}
          {!headerLeft && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setShowSettings(true); }} className={`${'w-7 h-7'} flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors app-no-drag`} title="Topic settings" aria-label="Topic settings"><Settings size={14} /></button>
              {!isMobile && <CommandMenu onStatus={handleCommandStatus} onClear={handleCommandClear} onModel={handleCommandModel} onReasoning={handleCommandReasoning} isLoading={commandLoading} />}
              {pinnedMessages.length > 0 && <button onClick={(e) => { e.stopPropagation(); }} className={`${'w-7 h-7'} flex items-center justify-center rounded hover:bg-app-hover text-yellow-500/70 hover:text-yellow-500 transition-colors app-no-drag`} title={`${pinnedMessages.length} pinned`} aria-label={`${pinnedMessages.length} pinned messages`}><Pin size={14} /></button>}
              {!isMobile && <button onClick={(e) => { e.stopPropagation(); const url = `${window.location.origin}?topic=${topic.id}`; isNativeApp ? window.open(url, `topic-${topic.id}`, 'width=900,height=700') : window.open(url, `topic-${topic.id}`); onClose(); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors app-no-drag" title="Pop out to new window" aria-label="Pop out to new window"><ExternalLink size={14} /></button>}
            </>
          )}
          {showCloseButton && <button onClick={(e) => { e.stopPropagation(); onClose(); }} className={`${'w-7 h-7'} flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors app-no-drag`} title="Close panel" aria-label="Close panel"><X size={14} /></button>}
        </div>}

        {/* Banners */}
        {suggestedProject && (
          <div className="px-3 py-2 bg-primary/10 border-b border-primary/20 flex items-center gap-3 flex-shrink-0">
            <div className="flex-1 min-w-0"><div className="text-[12px] font-medium text-primary">Link to a project?</div><div className="text-[11px] text-app-text-secondary truncate">{suggestedProject}</div></div>
            <button onClick={() => { onUpdateTopic(topic.id, { projectPath: suggestedProject }); setSuggestedProject(null); }} className="px-3 py-1 text-[11px] bg-primary text-white rounded-md hover:bg-primary-hover transition-colors">Link</button>
            <button onClick={() => setSuggestedProject(null)} className="px-2 py-1 text-[11px] text-app-text-muted hover:text-app-text transition-colors">Skip</button>
          </div>
        )}
        {commandResult && (
          <div className={`px-3 py-2 border-b flex items-center gap-2 flex-shrink-0 transition-all ${commandResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
            <div className={`text-[12px] flex-1 whitespace-pre-wrap font-mono ${commandResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{commandResult.message}</div>
            <button onClick={() => setCommandResult(null)} className="text-app-text-muted hover:text-app-text p-1"><X size={12} /></button>
          </div>
        )}

        {/* Main Content with optional Context Inspector slide-out */}
        <div className="flex-1 flex min-h-0 overflow-hidden relative">
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              <ChatPane
                topic={topic}
                isFocused={isFocused}
                getSessionMessages={getSessionMessages}
                isSessionLoading={isSessionLoading}
                isSessionStreaming={isSessionStreaming}
                stopSession={stopSession}
                sendMessage={sendMessage}
                editMessage={editMessage}
                switchBranch={switchBranch}
                loadHistory={loadHistory}
                chatError={chatError}
                sendWS={sendWS}
                onWSMessage={onWSMessage}
                onUpdateTopic={onUpdateTopic}
                onOpenSessionViewer={onOpenSessionViewer}
                masterPaneId={masterPaneId}
                onFocusPanel={onFocusPanel}
                aboveInputSlot={topic.agentTeamRole === 'lead' ? (
                  /* MASTER-01 (Variant A) — Master Topics get the board
                     strip pinned just above the input so orchestration
                     context stays visible while typing. */
                  <MasterBoardStrip
                    onMessage={onWSMessage}
                    onJumpToTopic={(id) => {
                      // Open / focus locally — handleFocusPanel knows how to
                      // route project-scoped topics correctly. Falls back to
                      // sendFocusTopic for presence if not wired in.
                      if (onFocusPanel) onFocusPanel(id);
                      else sendFocusTopic(sendWS, id);
                    }}
                    onAskMaster={(prompt) => { sendMessage(topic.sessionKey, prompt); }}
                    lastAssistantMessage={(() => {
                      const msgs = getSessionMessages(topic.sessionKey);
                      for (let i = msgs.length - 1; i >= 0; i--) {
                        if (msgs[i].role === 'assistant') return msgs[i].content;
                      }
                      return undefined;
                    })()}
                    isMasterStreaming={isSessionStreaming(topic.sessionKey)}
                  />
                ) : undefined}
              />
            </div>
          </div>

          {/* Context Inspector slide-out — bottom sheet on mobile, overlay when narrow, side panel when wide */}
          {showContext && (
            <div className={`overflow-hidden transition-all duration-200 ${
              isMobile
                ? 'absolute bottom-0 left-0 right-0 z-40 h-[50vh] rounded-t-xl shadow-lg border-t border-app-border bottom-sheet bg-surface'
                : isNarrow
                  ? 'absolute inset-0 z-40'
                  : 'w-[320px] flex-shrink-0'
            }`}>
              {isMobile && (
                <div className="flex items-center justify-between px-4 py-2 border-b border-app-border bg-surface rounded-t-xl flex-shrink-0">
                  <span className="text-[13px] font-medium text-app-text">Context</span>
                  <button
                    onClick={() => setShowContext(false)}
                    className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-app-hover text-app-text-muted"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <Suspense fallback={LazySpinner}>
                <ContextInspector
                  topic={topic}
                  isOpen={showContext}
                  onClose={() => setShowContext(false)}
                  onUpdateTopic={onUpdateTopic}
                  onMessage={onWSMessage}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
      {showSettings && <Suspense fallback={null}><TopicSettingsModal topic={topic} isOpen={showSettings} onClose={() => setShowSettings(false)} onUpdate={onUpdateTopic} /></Suspense>}
    </>
  );
}

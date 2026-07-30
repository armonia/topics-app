import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { Settings, Pin, X, ExternalLink, Layers, Globe, Cloud } from 'lucide-react';
import { useSpawnedBrowser } from '../../state/browserSpawner';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { SessionActivityBar } from '../Shared/SessionActivity';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelTab, CompactionMarker } from '../../types';
import { commandApi } from '../../lib/api';
import { sendFocusTopic } from '../../lib/focusMessaging';
import { useConfirm } from '../../hooks/useConfirm';
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
import { CommandMenu } from '../Shared/CommandMenu';
import { ChatPane } from '../Chat/ChatPane';
import { AuraWave } from '../AuraWave';
import { useContextInspector } from '../../hooks/useContextInspector';
import { popOutTopic, canPopOut } from '../../lib/popOutTopic';
import { useTopicLoading, useTopicWatching } from '@/state/signals';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '@/lib/settings';
import { DRAG_REGION, NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { useSessionMessages } from '../../state/useSessionMessages';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ChatPanelProps {
  topic: Topic; isFocused: boolean; onFocus: () => void; onClose: () => void;
  onDragStart: (e: React.DragEvent) => void; onToggleSidebar?: () => void; isDragOver: boolean;
  getSessionMessages: (sk: string) => ChatMessage[]; getCompactionMarkers?: (sk: string) => CompactionMarker[]; isSessionLoading: (sk: string) => boolean;
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
  regenerateMessage?: (sk: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sk: string, messageId: string) => Promise<boolean>;
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
  /** Callback to open a session-viewer pane for a spawned agent */
  onOpenSessionViewer?: (sessionKey: string) => void;
  /** Local handler that opens / focuses a tab. Threaded down so the
   *  Master strip can jump to any session reliably (works for
   *  project-scoped topics too, unlike a bare sendFocusTopic which is
   *  presence-only). */
  onFocusPanel?: (topicId: string) => void;
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
  getSessionMessages, getCompactionMarkers, isSessionLoading, isSessionStreaming, stopSession, sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic, initialTab, onInitialTabConsumed,
  headerLeft, showCloseButton = true,
  onOpenSessionViewer,
  onFocusPanel,
  bodyOnly = false,
}: ChatPanelProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => { setIsMobile(window.innerWidth < 768); }; window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  const [showSettings, setShowSettings] = useState(false);

  // The Context Inspector now lives as a popover inside the composer
  // (`ChatInput`). This panel's header button just fires the shared
  // `chat-input:toggle-context` event; the matching ChatInput opens the popover.
  const openContextInspector = useCallback(() => {
    window.dispatchEvent(new CustomEvent('chat-input:toggle-context', { detail: { topicId: topic.id } }));
  }, [topic.id]);

  // Consume initial tab override
  useEffect(() => {
    if (initialTab && initialTab !== 'browser') {
      onInitialTabConsumed?.();
    }
  }, [initialTab, onInitialTabConsumed]);
  const [suggestedProject, setSuggestedProject] = useState<string | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const confirm = useConfirm();
  const [commandResult, setCommandResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Keep hook alive for potential inspector use (skip for draft topics)
  const isDraft = topic.id.startsWith('draft:');
  useContextInspector(isDraft ? null : topic.id);

  // Jump-to-browser affordance: surfaces a header button when this topic
  // has previously spawned a browser pane via /browser <url> or the LLM
  // browser tool. Null when no spawn has happened — hides the button.
  const spawnedBrowserCtx = useSpawnedBrowser(isDraft ? null : topic.id);

  // Come in `ChatPane`: iscrizione alla singola sessione, perche' la radice non
  // si sveglia piu' a ogni token. Vedi state/useSessionMessages.ts.
  const currentMessages = useSessionMessages(topic.sessionKey, getSessionMessages);

  // Solo il ping di focus: l'azzeramento locale e la POST di lettura li fa
  // `sendWS`, e solo quando c'è davvero qualcosa di non letto.
  useEffect(() => { if (isFocused && !isDraft) { sendFocusTopic(sendWS, topic.id); } }, [isFocused, isDraft, topic.id, sendWS]);

  const addSystemMessage = useCallback((content: string) => { fetch(`/api/topics/${topic.id}/system-message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }).then(() => loadHistory(topic.sessionKey)); }, [topic.id, topic.sessionKey, loadHistory]);
  const handleCommandStatus = useCallback(async () => { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); addSystemMessage(r.output || 'Status retrieved'); } catch (e: unknown) { setCommandResult({ type: 'error', message: errorMessage(e) }); } finally { setCommandLoading(false); } }, [topic.sessionKey, addSystemMessage]);
  const handleCommandClear = useCallback(async () => { if (!await confirm({ title: 'Clear conversation?', body: 'A backup will be saved.', confirmLabel: 'Clear' })) return; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); } catch (e: unknown) { setCommandResult({ type: 'error', message: errorMessage(e) }); } finally { setCommandLoading(false); } }, [topic.sessionKey, loadHistory, confirm]);
  const handleCommandModel = useCallback(async (model: string) => { setCommandLoading(true); try { await commandApi.setModel(topic.sessionKey, model); addSystemMessage(`Model set to: ${model}`); } catch (e: unknown) { setCommandResult({ type: 'error', message: errorMessage(e) }); } finally { setCommandLoading(false); } }, [topic.sessionKey, addSystemMessage]);
  const handleCommandReasoning = useCallback(async () => { setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey); setCommandResult({ type: 'success', message: r.message || 'Reasoning toggled' }); } catch (e: unknown) { setCommandResult({ type: 'error', message: errorMessage(e) }); } finally { setCommandLoading(false); } }, [topic.sessionKey]);
  useEffect(() => { if (commandResult) { const t = setTimeout(() => setCommandResult(null), 5000); return () => clearTimeout(t); } }, [commandResult]);

  const pinnedMessages = currentMessages.filter(m => (topic.pinnedMessages || []).includes(m.id));

  // "Working" glow — the SAME condition the sidebar green row uses
  // (useTopicLoading = live stream OR hydrated mid-reply OR active agent), so
  // the ring and the sidebar dot can never disagree about whether a chat is
  // working. Gated behind the `workingGlow` app setting (default ON); read via
  // the settings-change event so a toggle applies live without a prop drill.
  const isWorking = useTopicLoading(topic.id);
  const [workingGlowEnabled, setWorkingGlowEnabled] = useState(() => loadSettings().workingGlow);
  useEffect(() => {
    const reload = () => setWorkingGlowEnabled(loadSettings().workingGlow);
    window.addEventListener(SETTINGS_CHANGED_EVENT, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reload);
      window.removeEventListener('storage', reload);
    };
  }, []);
  // The ring element exists in the DOM ONLY while working (conditional render,
  // not display:none) — zero cost when idle, per the perf rationale in index.css.
  const showWorkingRing = isWorking && workingGlowEnabled;
  const isWatching = useTopicWatching(topic.id);

  return (
    <>
      <div data-testid="chat-panel" role="region" aria-label={`${topic.name} panel`} className={`relative flex flex-col flex-1 min-h-0 bg-surface overflow-hidden transition-colors duration-100 ${isDragOver ? 'bg-primary/3' : ''}`} onClick={onFocus}>
        {/* Apple-Intelligence "working" glow — a thin rotating ring hugging the
            pane edge while the session streams. Rendered only when working so
            it costs nothing at rest; transform-only animation (see index.css).
            aria-hidden: purely decorative. Muted when watching (Monitor armed). */}
        {showWorkingRing && <AuraWave activityId={topic.sessionKey} muted={isWatching} />}
        {/* Header — skipped in `bodyOnly` mode (parent owns it). On mobile
            with tabs: floating overlay with blur for scroll-through effect. */}
        {!bodyOnly && <div className={`flex items-center ${headerLeft
          ? 'pr-0 h-12 md:h-10 md:border-b md:border-app-border'
          : 'gap-1.5 px-2 border-b border-app-border h-10'
        } select-none flex-shrink-0 bg-surface app-drag-region`} {...DRAG_REGION}>
          {onToggleSidebar && !headerLeft && <SidebarToggleButton onClick={onToggleSidebar} />}
          {headerLeft ? (
            <div className="flex-1 flex items-center min-w-0 overflow-visible app-no-drag" {...NO_DRAG_REGION} onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
              {headerLeft}
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1" {...NO_DRAG_REGION}><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0 cursor-grab active:cursor-grabbing app-no-drag" {...NO_DRAG_REGION} draggable onDragStart={onDragStart}>
              <span className="text-[14px] font-medium truncate text-app-text" style={{ maxWidth: 'min(200px, 40vw)' }}>{topic.name}</span>
              {topic.provider === 'openclaw' && (
                <span className="text-[11px] px-1 py-px rounded bg-primary/10 text-primary font-medium flex items-center gap-0.5 flex-shrink-0" title="Cloud (OpenClaw)">
                  <Cloud size={10} /> Cloud
                </span>
              )}
              {currentMessages.length > 0 && (
                <span className="text-[11px] text-app-text-muted tabular-nums ml-1">{currentMessages.length} msg</span>
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
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors app-no-drag" {...NO_DRAG_REGION}
              title="Vai al browser aperto da questa chat"
              aria-label="Vai al browser"
              data-testid="chat-jump-to-browser"
            >
              <Globe size={14} />
            </button>
          )}
          {/* Context Inspector toggle — hidden when headerLeft has rings.
              Opens the composer's context popover via the shared event. */}
          {!headerLeft && (
            <button
              onClick={(e) => { e.stopPropagation(); openContextInspector(); }}
              className={`${'w-7 h-7'} flex items-center justify-center rounded transition-colors app-no-drag hover:bg-app-hover text-app-text-tertiary hover:text-app-text`} {...NO_DRAG_REGION}
              title="Context Inspector"
              aria-label="Context Inspector"
            >
              <Layers size={14} />
            </button>
          )}
          {!headerLeft && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setShowSettings(true); }} className={`${'w-7 h-7'} flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors app-no-drag`} {...NO_DRAG_REGION} title="Topic settings" aria-label="Topic settings"><Settings size={14} /></button>
              {!isMobile && <CommandMenu onStatus={handleCommandStatus} onClear={handleCommandClear} onModel={handleCommandModel} onReasoning={handleCommandReasoning} isLoading={commandLoading} />}
              {pinnedMessages.length > 0 && <button onClick={(e) => { e.stopPropagation(); }} className={`${'w-7 h-7'} flex items-center justify-center rounded hover:bg-app-hover text-yellow-500/70 hover:text-yellow-500 transition-colors app-no-drag`} {...NO_DRAG_REGION} title={`${pinnedMessages.length} pinned`} aria-label={`${pinnedMessages.length} pinned messages`}><Pin size={14} /></button>}
              {!isMobile && <button onClick={(e) => { e.stopPropagation(); void popOutTopic(topic.id).then((opened) => { if (opened) onClose(); }); }} disabled={!canPopOut} className="w-7 h-7 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors app-no-drag disabled:opacity-40 disabled:cursor-not-allowed" {...NO_DRAG_REGION} title="Sposta in una nuova finestra" aria-label="Sposta in una nuova finestra"><ExternalLink size={14} /></button>}
            </>
          )}
          {showCloseButton && <button onClick={(e) => { e.stopPropagation(); onClose(); }} className={`${'w-7 h-7'} flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors app-no-drag`} {...NO_DRAG_REGION} title="Close panel" aria-label="Close panel"><X size={14} /></button>}
        </div>}

        {/* Mobile "what is this session doing" strip — front-and-centre on the
            small screen (the sidebar list carries it on desktop). Self-hides when
            the session is idle. */}
        {isMobile && <SessionActivityBar subjectId={topic.id} />}

        {/* Banners */}
        {suggestedProject && (
          <div className="px-3 py-2 bg-primary/10 border-b border-primary/20 flex items-center gap-3 flex-shrink-0">
            {/* Same real project favicon as the sidebar / tab bar; icon-less
                projects render nothing (no fake folder glyph). */}
            <ProjectFavicon path={suggestedProject} size={16} className="flex-shrink-0" />
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
                getCompactionMarkers={getCompactionMarkers}
                isSessionLoading={isSessionLoading}
                isSessionStreaming={isSessionStreaming}
                stopSession={stopSession}
                sendMessage={sendMessage}
                editMessage={editMessage}
                regenerateMessage={regenerateMessage}
                deleteMessage={deleteMessage}
                switchBranch={switchBranch}
                loadHistory={loadHistory}
                chatError={chatError}
                sendWS={sendWS}
                onWSMessage={onWSMessage}
                onUpdateTopic={onUpdateTopic}
                onOpenSessionViewer={onOpenSessionViewer}
              />
            </div>
          </div>
        </div>
      </div>
      {showSettings && <Suspense fallback={null}><TopicSettingsModal topic={topic} isOpen={showSettings} onClose={() => setShowSettings(false)} onUpdate={onUpdateTopic} /></Suspense>}
    </>
  );
}

import { useState, useEffect, useRef, useCallback, useMemo, memo, Suspense } from 'react';
import { useLocale, useT } from '../../hooks/useT';
import { SwapFreezeLabel } from '../Shared/SwapFreezeLabel';
import { useSwapFreeze } from '../../state/swapFreeze';
import { TopicBrowserReopen } from '../Browser/TopicBrowserReopen';
import { TopicBrowserWindow, useTopicBrowserPresence, usePaneWindowDoor, hasTopicBrowserWindow, DEFAULT_EXPANDED_WIDTH, useTopicBrowserInset } from '../Browser/topicBrowserWindowLazy';
import { isOwnFrame } from '@/state/wsIdentity';
import { adoptLegacyQueue, clearQueue, getQueue, releaseHold, removeTurn, updateTurn, useChatQueue } from '@/state/chatQueue';
import { Pin } from 'lucide-react';
import { requestScrollToMessage } from '../../state/scrollToMessage';
import { requestHistoryCompletion } from '../../state/historyCompleteness';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, CompactionMarker } from '../../types';
import type { SendMessageOptions, StopSessionOptions } from '../../hooks/useChat';
import { uploadApi, filesApi, autoNameApi, memoryApi, topicsApi, apiErrorCode } from '../../lib/api';
import { useComposerDock } from './useComposerDock';
import { composerMayTakeFocus } from './composerFocus';
import { markDraftTouched, setDraftDirty } from '../../state/draftPane';
import { ChatEmptyState } from './ChatEmptyState';
import { readDraft, saveDraft } from './chatDraft';
import { forkModeFor } from '../../../../shared/chat-fork';
import { useConfirm } from '../../hooks/useConfirm';
import { chatAcceptsFileDrag, watchFileDragEnd } from './chatFileDrop';
import { readPictureSize, sizesByPath, type PendingSize } from './attachmentSizes';
import { dragLeftHost } from '../../lib/dragLeave';
import { errMessage } from '../../lib/errMessage';
import { BAND_OWN_PROPERTY } from '../../lib/selectionStyles';
import { sendFocusTopic } from '../../lib/focusMessaging';
import type { MentionedFile } from './FileMentionMenu';
import { PinnedMessages } from './PinnedMessages';
import { MessageList } from './MessageList';
import { invokedName } from './commandMap';
import { CommandAnswerCard } from './CommandAnswerCard';
import type { CommandAnswer } from '../../lib/commandAnswer';
import { ChatInput, type ComposerControls } from './ChatInput';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useComposerPicks } from './useComposerPicks';
import { useChatPlanAndGoal } from './useChatPlanAndGoal';
import { useCommandAnswerEffects, useSlashCommandHandler } from './chatSlashCommands';
import { TodoStrip } from './TodoStrip';
import { GoalBar } from './GoalBar';
import { PlanApprovalBar } from './PlanApprovalBar';
import { useGoal } from '@/hooks/useGoal';
import { SubAgentsStrip } from './SubAgentsStrip';
import { TaskCardStrip } from './TaskCardStrip';
import { TaskWorkFoldContext } from './taskWorkFoldContext';
import { ChatTopicContext } from './chatTopicContext';
import { useTopicTask } from '../../state/taskSessions';
import { ChangedFilesStrip } from './ChangedFilesStrip';
import { UnsentStrip } from './UnsentStrip';
import { selectLatestTodo } from './selectLatestTodo';
import { useVoiceRecording } from './useVoiceRecording';
import { usePaneStore } from '../../state/pane/store';
import { createPaneId } from '../../state/pane/adapters';
import { useToast } from '../Shared/Toast';
import { getProvidersSnapshotState } from '../../lib/providersSnapshotStore';
import { topicsRoutingBlocked } from '../../lib/topicsRoutingGate';
import { copyText } from '../../lib/clipboard';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { isDraftTopicId } from '../../lib/composerMemory';
import { usePaneHold } from '../../state/pane/residency/holds';
import { useSessionMessages } from '../../state/useSessionMessages';
import { SideQuestionPanel } from './SideQuestionPanel';
import { useSideQuestion } from './useSideQuestion';
import { useSessionFlagValue } from '../../state/sessionFlags';
import { loadDraftAttachments, saveDraftAttachments } from '../../state/draftAttachments';
import { useServedFromCache } from '../../state/historyFromCache';
import { holdTopic } from '../../state/topicSubscriptions';
import { apiFetch } from '../../lib/shell/net';
import { FindBar } from '../Shared/FindBar';
import { FindPaneContext, useFindPaneId } from '../../state/findRegistry';
import { useChatFinder } from './useChatFinder';


export interface ChatPaneProps {
  topic: Topic;
  isFocused: boolean;
  getSessionMessages: (sk: string) => ChatMessage[];
  getCompactionMarkers?: (sk: string) => CompactionMarker[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  /** Vero se il turno l'ha fermato l'umano: cambia cosa dice il composer quando non arriva risposta. */
  wasSessionStopped: (sk: string) => boolean;
  /**
   * Stop the in-flight assistant turn for this session. Threaded down to
   * `ChatInput` so the unified composer button can present "Stop" when the
   * agent owns the turn. See `composerAction.ts` for the decision rules
   * and `stopSessionPolicy.ts` for the wipe-safety guard.
   */
  stopSession: (sk: string, opts?: StopSessionOptions) => Promise<boolean>;
  sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  /** Send/queue errors keyed by sessionKey: this pane shows only its own. */
  chatError: Record<string, string | null>;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  // Interaction with adjacent panes
  onOpenFile?: (path: string) => void;
  onNavigateBrowser?: (url: string) => void;
  // Branching
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage?: (sk: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sk: string, messageId: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  /**
   * Mount the topic's browser window on THIS pane instead of leaving it to a
   * parent.
   *
   * The window belongs to the topic, not to the shell that draws it: a topic
   * of a project is a topic, and the approved choice 5 of the change says the
   * bar carries "the topic's sheets, the project's ones from the +". But the
   * standalone shell puts `ChatPanel` above this pane and mounts the window
   * there, over the header too. Two mounts for one topic would mean two
   * `RemoteBrowserPanel` fighting over one native view, which is the very
   * thing the one-page-one-place invariant forbids. So whoever has NO
   * `ChatPanel` above (the project window) says so here.
   */
  ownsBrowserWindow?: boolean;
}

/** Riferimento stabile per il caso normale (nessun messaggio appuntato): senza,
 *  ogni render passerebbe un array nuovo a `PinnedMessages`. */
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Quante volte «invia subito» ripropone il drenaggio, e ogni quanto.
 *
 * Non è un'attesa attiva su una condizione qualunque: è la finestra fra lo stop
 * che è tornato e il turno fermato che ha finito di smontarsi, che dura un
 * battito. Il tetto c'è perché un ciclo senza fine su una sessione che per
 * qualche ragione resta occupata sarebbe peggio del problema: la coda in quel
 * caso resta dov'è, visibile, e parte con il messaggio dopo.
 */
const QUEUE_KICK_ATTEMPTS = 6;
const QUEUE_KICK_RETRY_MS = 150;

function ChatPaneComponent({
  topic, isFocused,
  getSessionMessages, getCompactionMarkers, isSessionLoading, isSessionStreaming, wasSessionStopped, stopSession, sendMessage, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic,
  onOpenFile: _onOpenFile, onNavigateBrowser: _onNavigateBrowser,
  editMessage, regenerateMessage, deleteMessage, switchBranch,
  ownsBrowserWindow,
}: ChatPaneProps) {
  const tr = useT();
  const locale = useLocale();
  /** A command of this chat is stopped: the pane says so above the composer. */
  const swapFreeze = useSwapFreeze({ topicId: topic.id });
  const toast = useToast();
  // Declared on the wire for as long as this pane is mounted. A window hears
  // the per-token frames of a turn only for the topics it declares
  // (`server/lib/ws-topic-routing.ts`), and it declares its open PANES: a chat
  // inside a project pane is not one, so it heard its own turn only while it
  // was the focused topic (card 1fc3a9fa). Not tied to visibility: a hidden
  // pane stays mounted and keeps receiving its messages, and the person reads
  // them on coming back.
  useEffect(() => holdTopic(topic.id), [topic.id]);
  const isGlobalOrchestrator = topic.isGlobalOrchestrator === true;
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => setIsMobile(window.innerWidth < 768); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  const draftKey = `draft:${topic.id}`;

  // The draft is read while rendering, never in an effect after the commit. An
  // effect can run a task later, and a keystroke that lands in between was
  // overwritten by the draft saved before it: the chat opened, took the typed
  // text, and its Enter sent nothing (CHAT-COMPOSER-02). When this pane is
  // handed another topic, that topic's draft is set in the render that brings it.
  const [message, setMessage] = useState(() => readDraft(draftKey));
  const [draftTopicId, setDraftTopicId] = useState(topic.id);
  if (draftTopicId !== topic.id) {
    setDraftTopicId(topic.id);
    setMessage(readDraft(draftKey));
  }
  // The caret, one frame after the commit that put the draft in the field:
  // setSelectionRange against an empty value would clamp it.
  useEffect(() => {
    const raf = requestAnimationFrame(() => restoreCursor(`chat:${topic.id}`, textareaRef.current));
    return () => cancelAnimationFrame(raf);
  }, [topic.id]);
  // Persist draft to localStorage
  useEffect(() => {
    saveDraft(draftKey, message);
  }, [message, draftKey]);

  /**
   * Text put in THIS chat's draft while the chat is already mounted: today, a
   * mission picked from the board next to it (`ProjectWindow`). The draft is
   * read when the pane mounts or changes topic, so an open pane would never
   * read it again, and the mission would sit in localStorage without ever
   * showing. The focus goes with it: the text is in front of the person who
   * sends it, and sending is theirs.
   */
  //
  // `mode: 'append'` adds the text at the end of the draft instead of replacing
  // it: «Send to agent» under a command run (CHAT-RUN-04), which names the chat
  // by its `sessionKey`, the one id a message knows. Nothing is sent.
  useEffect(() => {
    const onSeed = (e: Event) => {
      const detail = (e as CustomEvent).detail as { topicId?: string; sessionKey?: string; text?: string; mode?: 'replace' | 'append' } | undefined;
      if (!detail?.text || (detail.topicId !== topic.id && detail.sessionKey !== topic.sessionKey)) return;
      const text = detail.text;
      if (detail.mode === 'append') setMessage((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${text}` : text));
      else setMessage(text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('topics:seed-composer', onSeed);
    return () => window.removeEventListener('topics:seed-composer', onSeed);
  }, [topic.id, topic.sessionKey]);
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; mimeType: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  /**
   * Gli allegati in attesa seguono il testo: se la frase torna dopo un F5, deve
   * tornare anche la foto di cui parla. Stanno in IndexedDB e non in
   * localStorage perche' sono blob, e il perche' per esteso e' in
   * `state/draftAttachments.ts`.
   *
   * Il ripristino e' asincrono, quindi porta con se' il topic per cui e'
   * partito: cambiando chat in fretta, la risposta lenta della prima non deve
   * atterrare nel composer della seconda. E non sovrascrive allegati gia'
   * presenti: chi ha appena incollato qualcosa vince sul deposito.
   */
  const attachmentsHydrated = useRef<string | null>(null);
  useEffect(() => {
    const forTopic = topic.id;
    attachmentsHydrated.current = null;
    let annullato = false;
    void loadDraftAttachments(forTopic).then(({ images, files }) => {
      if (annullato || forTopic !== topic.id) return;
      if (images.length > 0) setPendingImages(prev => (prev.length > 0 ? prev : images));
      if (files.length > 0) setPendingFiles(prev => (prev.length > 0 ? prev : files));
      attachmentsHydrated.current = forTopic;
    });
    return () => { annullato = true; };
  }, [topic.id]);

  useEffect(() => {
    // Non si scrive prima di aver letto: senza questa guardia il primo giro,
    // con gli stati ancora vuoti, cancellerebbe il deposito che sta per essere
    // ripristinato.
    if (attachmentsHydrated.current !== topic.id) return;
    // Se non ci stanno, l'utente lo deve sapere ADESSO, non scoprirlo dopo un
    // ricaricamento: il difetto che questo meccanismo chiude e' proprio una
    // perdita silenziosa, e ripeterla al bordo del tetto sarebbe la stessa cosa
    // con un numero diverso. `saveDraftAttachments` risponde `false` solo in
    // quel caso, e cancella la riga invece di tenerne una a meta'.
    void saveDraftAttachments(topic.id, pendingImages, pendingFiles).then((ok) => {
      if (!ok) toast.error(tr('chat.attachment.tooLarge'));
    });
  }, [topic.id, pendingImages, pendingFiles, toast, tr]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  // Una BOZZA vuota si chiude da sé quando smetti di guardarla, e questa riga
  // è la sola cosa che le impedisce di portarsi via del lavoro: allegati e
  // immagini incollate vivono in memoria, non su localStorage, quindi chi
  // decide la chiusura (usePanelLifecycle) non potrebbe vederli. Vedi
  // `state/draftPane.ts`.
  // Nessuna pulizia allo smontaggio, di proposito: una pane non davanti può
  // essere smontata, e proprio in quell'istante qualcuno sta decidendo se
  // chiuderla. Dimenticare qui vorrebbe dire farlo decidere sul solo testo
  // salvato, cioè su una bozza con un'immagine incollata dentro e nient'altro
  // che sembrerebbe vuota. Il registro lo svuota chi chiude o promuove.
  useEffect(() => {
    if (!topic.id.startsWith('draft:')) return;
    setDraftDirty(
      topic.id,
      message.trim().length > 0 || pendingFiles.length > 0 || pendingImages.length > 0 || mentionedFiles.length > 0,
    );
  }, [topic.id, message, pendingFiles.length, pendingImages.length, mentionedFiles.length]);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  // The list of pinned messages, opened from the line above the messages (CMDUI-10).
  const [showPinned, setShowPinned] = useState(false);
  const [autoNameTriggered, setAutoNameTriggered] = useState(false);
  const [, setCommandLoading] = useState(false);
  /**
   * The answer of a command: a card at the end of the conversation, a state
   * of THIS SCREEN (CMDUI-04). Never saved, never in the history sent to the
   * engine, gone on reload. It closes with its X, with the next message, or
   * when another command replaces it: no timer. It used to be a strip a timer
   * closed after five seconds, fourteen lines of `/help` included.
   */
  const [commandAnswer, setCommandAnswer] = useState<CommandAnswer | null>(null);
  /** The title of the card the running command fills: `/name`, set as the command is read. */
  const commandTitleRef = useRef('');
  /** The command's words in the card: a sentence, or a refusal. */
  const setCommandResult = useCallback((r: { type: 'success' | 'error'; message: string; action?: CommandAnswer['action'] } | null) => {
    setCommandAnswer(r ? { kind: r.type === 'error' ? 'error' : 'text', title: commandTitleRef.current, body: r.message, ...(r.action ? { action: r.action } : {}) } : null);
  }, []);
  /**
   * A compaction waiting for its outcome: the marker count before it, how many
   * messages the chat had, whether its turn has been seen running.
   */
  /** What the engine said about the last `/compact` (its command answer). */
  const compactSaidRef = useRef<string | null>(null);
  const compactWatchRef = useRef<{ before: number; messagesBefore: number; sawIdle: boolean; sawTurn: boolean } | null>(null);
  /** The composer's doors to its own controls, for a typed `/model`, `/effort` or `/context`. */
  const composerControlsRef = useRef<ComposerControls | null>(null);
  const confirm = useConfirm();
  /**
   * La coda del turno NON vive più qui.
   *
   * Stava in uno stato di questo componente, con chiave per-topic e un effetto
   * che la drenava: quindi funzionava solo a pane montata, scattava al mount,
   * due finestre sullo stesso topic spedivano lo stesso messaggio due volte, e
   * soprattutto lo stop — che è pur sempre «lo streaming è finito» — la faceva
   * PARTIRE. Adesso è un modulo solo (`state/chatQueue.ts`), la sessione è la
   * chiave, e chi drena è `useChat`. Qui resta la vista: badge, correzione,
   * cestino.
   */
  const messageQueue = useChatQueue(topic.sessionKey);
  useEffect(() => { adoptLegacyQueue(topic.sessionKey, topic.id); }, [topic.sessionKey, topic.id]);
  // Cross-tab sync della bozza (la coda si sincronizza da sé, nel suo modulo).
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === draftKey) setMessage(e.newValue || '');
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [draftKey]);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  // Niente sfratto mentre c'è roba non ancora salvata da nessuna parte. Bozza,
  // coda e scroll sono già persistiti e sopravvivono da soli; questi tre no, e
  // uno smontaggio li perderebbe in silenzio.
  usePaneHold(pendingImages.length > 0 || pendingFiles.length > 0 || editingMessage !== null);
  const { fastMode, providerOverride, providerOnly, effort, topicsRouting, autonomy, setAutonomy, isDraftTopic, handleTopicsRoutingChange, handleProviderOverrideChange, handleProviderOnlyChange, handleEffortChange, defaultProviderLabel, pinnedModel, toggleFastMode, handleAutonomyChange } = useComposerPicks({ topic, onUpdateTopic, toast });
  const [othersTyping, setOthersTyping] = useState(false);
  const [othersTypingText, setOthersTypingText] = useState('');
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const paneRootRef = useRef<HTMLDivElement>(null);
  // The topic's browser window, when no `ChatPanel` above is already drawing
  // it. Expanded it takes width away from this pane ALONE: the padding lives
  // inside the pane, so the grid keeps tiling the columns it always tiled, and
  // the clamp is the chat minimum of THIS pane, not of the whole window.
  // ONE expression, two consumers: how much room to cede, and whether the
  // openings of this conversation land in the window instead of the layout.
  // Two copies of this rule is how one of them ends up wrong.
  const browserWindowTopicId = ownsBrowserWindow && !isMobile && !isDraftTopicId(topic.id) ? topic.id : '';
  const browserWindow = useTopicBrowserPresence(browserWindowTopicId);
  // The pane always offers its door to agent opens. A first clicked link still
  // belongs to the project layout (`LINK-TAB-02`). See `usePaneWindowDoor`.
  usePaneWindowDoor(browserWindowTopicId, browserWindow);
  const requestedBrowserInset = browserWindow.mode === 'exp'
    ? (browserWindow.expandedWidth ?? DEFAULT_EXPANDED_WIDTH)
    : 0;
  // Measured, not stated in CSS: below a usable area the window falls back to
  // floating and this has to be zero, which a stylesheet cannot decide.
  const browserInset = useTopicBrowserInset(paneRootRef, requestedBrowserInset);
  // L'invito della chat vuota sta DENTRO il blocco misurato, ma non deve
  // contare nella centratura: si misura a parte per poterlo scalare.
  const greetingRef = useRef<HTMLDivElement>(null);

  // Persist the caret/selection of the chat composer so a hot reload (bundle-rev
  // or dev HMR) restores it exactly, not just the draft text. Listeners live here
  // (ChatPane owns textareaRef) so ChatInput's JSX stays untouched.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const k = `chat:${topic.id}`;
    const save = () => writeCursor(k, ta.selectionStart, ta.selectionEnd);
    const active = () => markActiveComposer(k);
    ta.addEventListener('keyup', save);
    ta.addEventListener('click', save);
    ta.addEventListener('select', save);
    ta.addEventListener('input', save);
    ta.addEventListener('focus', active);
    return () => {
      ta.removeEventListener('keyup', save);
      ta.removeEventListener('click', save);
      ta.removeEventListener('select', save);
      ta.removeEventListener('input', save);
      ta.removeEventListener('focus', active);
    };
  }, [topic.id]);

  // PANE-03 scroll-restore wiring (review I1). The pane id mirrors the
  // convention used by createPaneId('chat', topic.id) = `chat:${topic.id}`;
  // we read the undo-captured scrollOffset at mount (and on topic switch),
  // then persist scroll updates via the device-local setter that bypasses
  // lastSeq (no sync write per scroll tick).
  const paneId = createPaneId('chat', topic.id);
  // Seeds synchronously at mount AND on paneId change; subscribes if the pane
  // entity hasn't hydrated yet (round-7 audit fix). The previous version only
  // seeded via useState initializer, so on topic switch within the same
  // component instance (StandaloneChatGroup re-renders ChatPane without
  // remount), initialScrollOffset stayed populated with the FIRST topic's
  // value. The stale read short-circuited the subscribe effect and silently
  // broke scroll-restore for the new topic. Now we re-read from the store at
  // the top of the effect whenever paneId changes, then only subscribe if the
  // new pane entity hasn't arrived yet.
  const [initialScrollOffset, setInitialScrollOffset] = useState<number | undefined>(
    () => usePaneStore.getState().panes[paneId]?.scrollOffset,
  );
  useEffect(() => {
    // On paneId change: re-seed synchronously from the store. If the new pane
    // entity is already present, we use its value and skip the subscription.
    const current = usePaneStore.getState().panes[paneId]?.scrollOffset;
    setInitialScrollOffset(current);
    if (current !== undefined) return;
    const unsub = usePaneStore.subscribe(
      (s) => s.panes[paneId]?.scrollOffset,
      (offset) => {
        if (offset !== undefined) {
          setInitialScrollOffset(offset);
          unsub();
        }
      },
    );
    return unsub;
  }, [paneId]);
  const handleScrollOffsetChange = useCallback((top: number) => {
    usePaneStore.getState().setPaneScrollOffset(paneId, top);
  }, [paneId]);

  // Iscrizione a QUESTA sessione. Prima bastava chiamare `getSessionMessages`
  // perche' i messaggi erano stato di `App`, quindi ogni token ri-renderizzava
  // tutto l'albero e questa riga veniva rivalutata per forza. Adesso la radice
  // non si sveglia piu' — ed e' il punto — quindi l'aggiornamento deve arrivare
  // qui per iscrizione, o la chat resterebbe ferma.
  const currentMessages = useSessionMessages(topic.sessionKey, getSessionMessages);
  // Sticky current-todo strip (CHAT-TODO-01): mirror the latest TodoWrite above
  // the composer so the plan stays visible while typing.
  const latestTodo = useMemo(() => selectLatestTodo(currentMessages), [currentMessages]);
  // 3.4 — l'obiettivo della topic. Quando c'è, è LUI la superficie del piano:
  // vedi l'intestazione di GoalBar per il perché non convivono.
  // The registry-backed coordinator intentionally has no per-topic goal or
  // checkpoint lifecycle. Passing null prevents invisible 403 probes against
  // routes that are correctly reserved for ordinary project conversations.
  const {
    goal,
    declare: declareGoal,
    close: closeGoal,
    promote: promoteGoal,
    stopLoop: stopGoalLoop,
  } = useGoal(isGlobalOrchestrator ? null : topic.id, onWSMessage);
  const currentMarkers = getCompactionMarkers?.(topic.sessionKey);

  // Subscribed to THIS session's flags: a turn starting or ending in another
  // chat no longer reaches this pane, nor `App` above it (`sessionFlags.ts`).
  const currentLoading = useSessionFlagValue(topic.sessionKey, isSessionLoading);
  const currentStreaming = useSessionFlagValue(topic.sessionKey, isSessionStreaming);
  const currentStoppedByUser = useSessionFlagValue(topic.sessionKey, wasSessionStopped);
  // ⌘F inside this chat (CHAT-FIND-01): the pane's id from its host, or the
  // topic's when it is drawn somewhere that is not a pane (the board drawer).
  const findPaneId = useFindPaneId() ?? topic.id;
  useChatFinder({ paneId: findPaneId, topicId: topic.id, sessionKey: topic.sessionKey, messages: currentMessages, streaming: currentStreaming, paneRootRef });

  useCommandAnswerEffects({ topic, tr, currentMarkers, currentStreaming, compactWatchRef, compactSaidRef, setCommandAnswer });


  const { isRecording, recordingTime, voiceUploading, startRecording, stopRecording, formatRecordingTime } = useVoiceRecording(sendMessage, topic.sessionKey, currentStreaming, useCallback((m: string) => toast.error(m), [toast]));
  const isUploading = uploading || voiceUploading;

  // Scroll management is handled entirely by Virtuoso in MessageList
  // (followOutput="smooth" for new items, explicit scrollToIndex for streaming updates)
  //
  // `historyProbed` esiste per una ragione sola: senza, il composer sfarfalla a
  // OGNI apertura di chat. Al primo render i messaggi sono `[]` e
  // `currentLoading` è ancora false — `loadHistory` parte da questo effetto,
  // cioè dopo il primo paint — quindi qualunque chat, anche piena, sembrerebbe
  // vuota per un frame: il composer salterebbe al centro e tornerebbe giù. Una
  // BOZZA non ha storia da caricare, quindi nasce già sondata (ed è l'unico
  // caso in cui il centro si vede subito, che è poi quello che conta).
  const [historyProbed, setHistoryProbed] = useState(() => topic.id.startsWith('draft:'));
  useEffect(() => {
    let alive = true;
    setReplyingTo(null);
    setAutoNameTriggered(false);
    // A draft is not asked for its history either. The read found nothing, but
    // it raised `currentLoading` for its round trip, and that alone un-centred
    // the composer: measured on ⌘T, the new chat painted with the composer at
    // the bottom and the loading skeleton, then slid up to the centre while its
    // greeting faded out and back in (chat-first-send-smooth).
    if (topic.id.startsWith('draft:')) { setHistoryProbed(true); return; }
    setHistoryProbed(false);
    void loadHistory(topic.sessionKey)
      .catch(() => false)
      .finally(() => { if (alive) setHistoryProbed(true); });
    return () => { alive = false; };
  }, [topic.sessionKey, topic.id, loadHistory]);
  // `preventScroll` perché il composer è ancorato in fondo alla pane ed è già
  // in vista: lo scroll-into-view implicito di `focus()` non lo sposta di un
  // pixel, ma per stabilirlo il browser deve calcolare il layout di tutti gli
  // antenati scrollabili — inclusa la lista virtualizzata dei messaggi. A ogni
  // cambio di tab era lavoro buttato, e sulla lista poteva pure strattonare la
  // posizione di scroll.
  // …e soprattutto: il fuoco al composer si dà solo se NESSUNO se l'è preso nel
  // frattempo. Questo `setTimeout` arrivava buono per tutti, e 50 ms dopo il
  // click strappava il fuoco a qualunque cosa l'utente avesse appena aperto:
  // misurato sul picker del modello, il campo di ricerca del popover lo prendeva
  // a 25 ms e il composer se lo riprendeva a 29 ms, quindi le frecce finivano
  // nella textarea e la navigazione da tastiera del picker NON FUNZIONAVA
  // (`picker-keyboard-nav.spec.ts` lo dava «flaky»: era rotto, e passava solo
  // quando la corsa andava per il verso giusto).
  // La regola è "non rubare": si fotografa chi ha il fuoco quando la pane
  // diventa attiva e, allo scadere, si procede solo se non è cambiato nulla.
  // Copre il caso voluto (clic sulla tab o sull'area messaggi ⇒ scrivi subito,
  // il fuoco lì non l'ha spostato nessuno) senza toccare quello in cui l'utente
  // ha deliberatamente messo il fuoco altrove.
  useEffect(() => {
    if (!isFocused) return;
    const at = document.activeElement;
    // A control of this pane that already holds the focus (a fold header
    // toggled from the keyboard, whose click activated the pane) keeps it.
    if (!composerMayTakeFocus(at, paneRootRef.current)) return;
    const t = setTimeout(() => {
      if (document.activeElement !== at) return;
      textareaRef.current?.focus({ preventScroll: true });
    }, 50);
    // Il timer non veniva nemmeno annullato: cambiando tab in fretta restavano
    // in volo focus() diretti a una pane che non è più quella davanti.
    return () => clearTimeout(t);
  }, [isFocused]);

  // Where the composer sits (centred when the chat is empty) and how it moves:
  // `useComposerDock`.
  const { inputAreaHeight, paneHeight, composerCentered, composerOffset, showGreeting, composerResizeRef, startDescent, settleDescent, bornFromDraft } = useComposerDock({
    topicId: topic.id, paneRootRef, inputAreaRef, greetingRef, textareaRef, isFocused, historyProbed, loading: currentLoading, messageCount: currentMessages.length,
  });
  // Mark topic as read when this chat pane gains focus (covers ProjectWindow usage)
  // Solo il ping di focus: l'azzeramento locale e la POST di lettura li fa
  // `sendWS`, e solo quando c'è davvero qualcosa di non letto.
  useEffect(() => { if (isFocused && topic.id) { sendFocusTopic(sendWS, topic.id); } }, [isFocused, topic.id, sendWS]);

  // After first assistant response, call server auto-name for project path detection
  // Skip for draft topics (not yet persisted on server)
  const isDraft = topic.id.startsWith('draft:');
  useEffect(() => {
    if (isDraft || autoNameTriggered || currentStreaming) return;
    const aMsgs = currentMessages.filter(m => m.role === 'assistant' && m.content.trim() !== '');
    const isDefaultName = topic.name === 'New Chat' || topic.name.startsWith('New ');
    if (aMsgs.length >= 1 && isDefaultName) {
      setAutoNameTriggered(true);
      autoNameApi.autoName(topic.id).then(r => {
        if (r.suggestedProject && !topic.projectPath) {
          onUpdateTopic(topic.id, { projectPath: r.suggestedProject });
        }
      }).catch((err) => console.warn('[AutoName] failed for topic', topic.id, err));
    }
  }, [isDraft, currentMessages, currentStreaming, topic.id, topic.name, topic.projectPath, autoNameTriggered, onUpdateTopic]);

  // Un frame per TASTO era il comportamento di prima: `handleKeyDown` chiamava
  // questa a ogni keydown, e ogni frame veniva ritrasmesso a tutti i client
  // focussati sulla topic, ognuno dei quali faceva un setState e riarmava un
  // timer da 2 s. Su una digitazione normale sono ~5 frame al secondo per
  // carattere-al-decimo-di-secondo, per niente: l'indicatore dice «sta
  // scrivendo», non COSA, e mezzo secondo di risoluzione basta.
  const lastTypingSentRef = useRef(0);
  const TYPING_THROTTLE_MS = 500;
  const sendTyping = useCallback((text?: string) => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    sendWS({ type: 'typing', topicId: topic.id, text: text || '' });
  }, [sendWS, topic.id]);

  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      // Il proprio eco NON accende l'indicatore. Il server esclude gia' la socket
      // mittente, ma quel filtro non copre il caso in cui lo STESSO utente ha la
      // topic aperta due volte (l'app desktop piu' una scheda su localhost, due
      // finestre, la PWA sul telefono): li' ognuno vedeva «qualcuno sta
      // scrivendo» mentre a scrivere era lui. Il frame porta `clientId` proprio
      // per questo, ed era inutilizzato.
      if (msg.type === 'typing' && msg.topicId === topic.id && !isOwnFrame((msg as { clientId?: string }).clientId)) {
        setOthersTyping(true); setOthersTypingText(msg.text || '');
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => { setOthersTyping(false); setOthersTypingText(''); }, 2000);
      }
    });
    return () => { unsub(); if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current); };
  }, [onWSMessage, topic.id]);

  // L'auto-crescita del campo di testo sta in ChatInput, non qui: dipende anche
  // dalla LARGHEZZA del campo, che cambia quando i controlli scendono sulla
  // seconda riga — e quella condizione la conosce solo il composer. Misurata da
  // qui, l'altezza restava quella calcolata alla larghezza di prima e sotto il
  // testo avanzava una riga vuota.

  const uploadFiles = useCallback(async (files: File[]) => {
    const uploaded: { file: File; path: string }[] = []; const failed: string[] = [];
    for (const f of files) { try { const r = await uploadApi.uploadFile(f); uploaded.push({ file: f, path: r.path }); } catch (e) { console.error('[ChatPane] file upload failed:', f.name, e); failed.push(f.name); } }
    if (failed.length > 0) toast.error(`Upload failed: ${failed.join(', ')}`);
    return uploaded;
  }, [toast]);

  // The turn `/goal <text>` starts, with the composer's options of THIS render
  // (fast mode, model override). A ref because the slash handler is a
  // callback memoized on fewer deps than those options.
  const sendMessageRef = useRef<((text: string) => Promise<unknown>) | null>(null);

  // «Fork into a new chat» and `/fork [text]`: one call for both doors
  // (CHAT-FORK-04). The branch opens as a permanent tab with the focus, through
  // the funnel every other surface uses, and the text is its first message on
  // the ordinary send path. A refusal says why and opens nothing.
  const forkHere = useCallback(async (prompt?: string) => {
    try {
      const branch = await topicsApi.fork(topic.id, { name: tr('chat.fork.name', { name: topic.name }) });
      const text = prompt?.trim();
      // With a first message the copied history is read BEFORE the send and
      // before the pane exists: the send claims the session for its stream,
      // and the pane's own read on mount then steps aside until the turn ends
      // (useChat `loadHistory`), which left the branch showing only the new
      // prompt for the whole turn.
      if (text) await loadHistory(branch.sessionKey);
      window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: branch.id, topic: branch, mode: 'permanent', reveal: true } }));
      if (text) await sendMessage(branch.sessionKey, text);
    } catch (e) {
      const key = ({ turn_in_progress: 'chat.fork.busy', fork_unsupported: 'chat.fork.unsupported', nothing_to_fork: 'chat.fork.nothing' } as Record<string, string>)[apiErrorCode(e) ?? ''];
      setCommandResult({ type: 'error', message: key ? tr(key) : errMessage(e) });
    }
  }, [topic.id, topic.name, sendMessage, loadHistory, tr, setCommandResult]);
  const handleFork = useCallback(() => { void forkHere(); }, [forkHere]);
  // The ACP agents keep their conversation outside Topics; no pinned provider = the server decides.
  const canFork = !isGlobalOrchestrator && (!topic.provider || forkModeFor(topic.provider) !== null);

  const sideQuestion = useSideQuestion({ topic, loadHistory, sendMessage, getSessionMessages, tr });
  const askSideQuestion = sideQuestion.ask;

  // Export the ACTIVE thread as a Markdown download. Client-side on purpose:
  // currentMessages already IS the active branch view the user is looking at.
  const handleExportConversation = useCallback(() => {
    const lines: string[] = [`# ${topic.name}`, ''];
    for (const m of currentMessages) {
      const who = m.role === 'user' ? 'You' : 'Assistant';
      const when = m.timestamp ? ` · ${new Date(m.timestamp).toLocaleString()}` : '';
      lines.push(`### ${who}${when}`, '', m.content || '', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (topic.name || 'conversation').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'conversation';
    a.href = url;
    a.download = `${safeName} ${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [currentMessages, topic.name]);

  /** `toggleFastMode` is declared further down: `/fast on|off` reaches it through here. */
  const toggleFastModeRef = useRef<(() => void) | null>(null);
  const handleSlashCommand = useSlashCommandHandler({
    topic, tr, locale, isGlobalOrchestrator, loadHistory, goal, declareGoal, closeGoal, confirm, sendMessage,
    getCompactionMarkers, forkHere, askSideQuestion, currentMessages, currentStreaming, handleExportConversation,
    setCommandResult, setCommandAnswer, setCommandLoading, commandTitleRef, composerControlsRef, compactSaidRef,
    compactWatchRef, sendMessageRef, toggleFastModeRef, fastMode, onUpdateTopic,
  });

  toggleFastModeRef.current = toggleFastMode;

  const { pendingPlan, planBusy, handlePlanDecision, handlePlanChoiceFromBar, handleGoalClose, handleGoalEdit, handleGoalStopLoop, handleGoalPromote } = useChatPlanAndGoal({
    topic, tr, toast, currentMessages, currentStreaming, currentLoading, autonomy, setAutonomy, sendMessage,
    closeGoal, declareGoal, stopGoalLoop, promoteGoal,
  });



  const handleRetry = useCallback(() => {
    // A row steered into a turn was already read by it: Retry resends what opened the turn.
    const lastUserMsg = [...currentMessages].reverse().find(m => m.role === 'user' && !m.blocks?.some(b => b.kind === 'steered'));
    if (!lastUserMsg) return;
    const opts: { provider?: string; model?: string } = {};
    if (!isGlobalOrchestrator && providerOverride) {
      opts.provider = providerOverride.provider;
      opts.model = providerOverride.model;
    }
    sendMessage(topic.sessionKey, lastUserMsg.content, Object.keys(opts).length ? opts : undefined);
  }, [currentMessages, sendMessage, topic.sessionKey, providerOverride, isGlobalOrchestrator]);

  // The brain button has no spinner and no "saved" state, so a swallowed 500
  // drew exactly the same screen as a success: the person believed the snippet
  // was in memory and it was nowhere. Both outcomes speak now, and the server's
  // own sentence wins over the fallback.
  const handleRememberMessage = useCallback(async (msg: ChatMessage) => {
    const snippet = msg.content.length > 300 ? msg.content.slice(0, 300) + '...' : msg.content;
    try {
      await memoryApi.appendToTopic(topic.id, snippet);
      toast.success(tr('chat.remember.saved'));
    } catch (err) {
      toast.error(errMessage(err) || tr('chat.remember.failed'));
    }
  }, [topic.id, toast, tr]);

  // Regenerate: fork a sibling assistant branch under the same user message
  // and re-stream (the general "try again", not just the ⚠️-error retry). The
  // old reply stays reachable via the branch arrows. Wired only while not
  // streaming — see the MessageList prop below.
  const handleRegenerateMessage = useCallback((msg: ChatMessage) => {
    if (!regenerateMessage) return;
    void regenerateMessage(topic.sessionKey, msg.id);
  }, [regenerateMessage, topic.sessionKey]);

  // Delete (message + descendant branches). Confirmation is the two-click arm
  // in MessageBubble; here we just fire and let the returned thread replace
  // the session state (useChat.deleteMessage).
  const handleDeleteMessage = useCallback((msg: ChatMessage) => {
    if (!deleteMessage) return;
    void deleteMessage(topic.sessionKey, msg.id);
  }, [deleteMessage, topic.sessionKey]);


  const handleEditMessage = useCallback((msg: ChatMessage) => {
    setEditingMessage(msg);
    setMessage(msg.content);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [setMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setMessage('');
  }, [setMessage]);

  const handleSubmitEdit = useCallback(async () => {
    if (!editingMessage || !editMessage || !message.trim()) return;
    const content = message.trim();
    setEditingMessage(null);
    setMessage('');
    await editMessage(topic.sessionKey, editingMessage.id, content);
  }, [editingMessage, editMessage, message, topic.sessionKey, setMessage]);

  const handleSwitchBranch = useCallback(async (messageId: string, branchIndex: number) => {
    if (!switchBranch) return;
    await switchBranch(topic.sessionKey, messageId, branchIndex);
  }, [switchBranch, topic.sessionKey]);

  useEffect(() => {
    if (!isFocused || isGlobalOrchestrator) return;
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'u') {
        e.preventDefault();
        fileInputRef.current?.click();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isFocused, isGlobalOrchestrator]);

  // The coordinator deliberately has no per-topic attachment or file-context
  // surface.  Clear any transient state if a live topic projection changes
  // into the server-registered role, instead of leaving invisible files queued
  // for the next send.
  useEffect(() => {
    if (!isGlobalOrchestrator) return;
    setPendingFiles([]);
    setPendingImages([]);
    setMentionedFiles([]);
  }, [isGlobalOrchestrator]);

  const resizeImageToBase64 = useCallback((file: File, maxDim = 1568): Promise<{ dataUrl: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { const s = Math.min(1, maxDim / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); const ctx = c.getContext('2d'); if (!ctx) { reject(new Error('No canvas context')); return; } ctx.drawImage(img, 0, 0, c.width, c.height); const mt = file.type === 'image/png' ? 'image/png' : 'image/jpeg'; resolve({ dataUrl: c.toDataURL(mt, mt === 'image/jpeg' ? 0.85 : undefined), mimeType: mt }); URL.revokeObjectURL(img.src); };
      img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')); };
      img.src = URL.createObjectURL(file);
    });
  }, []);

  /**
   * Le opzioni del turno così come sono ADESSO nel composer.
   *
   * Un posto solo, perché servono a due strade: l'invio diretto e l'accodamento
   * mentre l'agente risponde. Quando ne esisteva una copia sola — dentro il ramo
   * dell'invio — i messaggi accodati partivano nudi, e Plan Mode si perdeva in
   * silenzio col badge ancora accesso.
   */
  const currentSendOptions = (): SendMessageOptions | undefined => {
    // The registry-backed coordinator's provider/profile is chosen by the
    // server. A stale normal-topic preference must not piggyback on a global
    // Kanban turn while the client is reconnecting or hydrating.
    if (isGlobalOrchestrator) return undefined;
    const opts: SendMessageOptions = {};
    // Fast Mode is the per-turn signal the server uses to pick the provider's
    // native fast model (see openspec `chat-fast-mode`). We send it whenever the
    // toggle is ON — picker (`opts.model`) and persisted `topic.model` still win,
    // the server enforces priority.
    if (fastMode) opts.fastMode = true;
    if (providerOverride) {
      opts.provider = providerOverride.provider;
      opts.model = providerOverride.model;
    } else if (isDraftTopic && providerOnly) {
      // A draft's first turn creates the topic with no engine: the engine it
      // chose goes with the turn (the server takes a provider alone), and the
      // promotion writes it on the topic.
      opts.provider = providerOnly;
    }
    return Object.keys(opts).length ? opts : undefined;
  };
  sendMessageRef.current = (text: string) => sendMessage(topic.sessionKey, text, currentSendOptions());

  const messageInField = message;
  /** `typed`: the text to send instead of the field's (a command picked from the «/» menu). */
  const handleSendMessage = async (e?: React.SubmitEvent, typed?: string) => {
    if (e) e.preventDefault();
    // Edit mode: submit the edit
    if (editingMessage && typed === undefined) {
      await handleSubmitEdit();
      return;
    }
    const message = typed ?? messageInField;
    if (!message.trim() && pendingFiles.length === 0 && pendingImages.length === 0) return;
    // MSEL-06: lo switch non blocca piu' l'invio. Resta la chat legacy legata al motore stesso col motore giu', dove un «diretto» non esiste. Lo snapshot si legge senza abbonarsi (un hook qui ridisegnerebbe ChatPane a ogni push). allow-italian: perche' si legge lo store invece dell'hook
    if (topicsRoutingBlocked(topicsRouting, providerOverride, defaultProviderLabel, getProvidersSnapshotState().snapshot)) {
      toast.error(tr('chat.topicsEngine.down'));
      return;
    }
    let finalMessage = message.trim();
    // I comandi col cancelletto NON si accodano: `/model`, `/effort`, `/goal`,
    // `/clear` agiscono sulla sessione, non sono un turno da spedire. Il ramo
    // dell'accodamento stava PRIMA di questo controllo, quindi uno slash scritto
    // mentre l'agente rispondeva finiva in coda e poi partiva come testo — il
    // modello si vedeva arrivare «/model opus» come domanda.
    if (finalMessage.startsWith('/')) { if (await handleSlashCommand(finalMessage)) { setMessage(''); return; } }
    // A result that stays until it is closed also goes when the next message
    // is written: it answered the previous command, not this one. A running
    // compaction keeps its notice.
    if (!compactWatchRef.current) setCommandAnswer(null);
    // Da qui in giù si COMPONE, sempre: allegati, immagini, file citati con @ e
    // la citazione della risposta. Prima questa parte stava dopo il `return`
    // dell'accodamento, quindi un messaggio scritto mentre l'agente rispondeva
    // partiva nudo — e uno di sole immagini non partiva affatto. Chi decide se
    // spedire adesso o mettere in coda è `sendMessage` (`state/chatQueue.ts`),
    // che riceve il messaggio già completo.
    // AN INVOCATION TAKES NO QUOTE (CMDUI-07): the engine reads a command only
    // at the very start of the message, so a quote in front turned `/new`
    // into prose (measured: `> first message\n\n/new` reached the CLI). The
    // quote stays armed for the next message.
    const invocation = invokedName(finalMessage) !== null;
    const curFiles = [...pendingFiles], curImages = [...pendingImages], curReply = invocation ? null : replyingTo, curMentioned = [...mentionedFiles];
    setMessage(''); setPendingFiles([]); setPendingImages([]); setMentionedFiles([]); if (!invocation) setReplyingTo(null);
    // The sizes of the attached pictures, read while they upload: the bubble draws them in their box (`attachmentSizes.ts`).
    const sized: PendingSize[] = [];
    if (curFiles.length > 0 || curImages.length > 0) {
      setUploading(true);
      try {
        if (curFiles.length > 0) { const reading = new Map(curFiles.map(f => [f, readPictureSize(f)])); const uploaded = await uploadFiles(curFiles); for (const u of uploaded) sized.push([u.path, reading.get(u.file)!]); finalMessage = uploaded.map(u => `[Attached file: ${u.path}]`).join('\n') + (finalMessage ? '\n' + finalMessage : ''); }
        if (curImages.length > 0) {
          const urls: string[] = []; let imgFailCount = 0;
          for (const img of curImages) {
            try {
              const reading = readPictureSize(img.dataUrl);
              const res = await apiFetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: img.dataUrl, mimeType: img.mimeType }) });
              if (res.ok) { const url = (await res.json()).url; urls.push(url); sized.push([url, reading]); } else { imgFailCount++; console.error('[ChatPane] image upload failed:', res.status, res.statusText); }
            } catch (e) { imgFailCount++; console.error('[ChatPane] image upload failed:', e); }
          }
          if (imgFailCount > 0) toast.error(`${imgFailCount} image${imgFailCount > 1 ? 's' : ''} failed to upload`);
          if (urls.length > 0) finalMessage = urls.map(u => `[Attached file: ${u}]`).join('\n') + (finalMessage ? '\n' + finalMessage : '');
        }
      } finally { setUploading(false); }
    }
    if (curMentioned.length > 0) {
      const parts: string[] = [];
      for (const mf of curMentioned) { try { const c = await filesApi.content(mf.path); parts.push(`<file path="${mf.path}">\n${c.length > 10000 ? c.slice(0, 10000) + '\n...(truncated)' : c}\n</file>`); } catch { parts.push(`<file path="${mf.path}">\n(Error reading file)\n</file>`); } }
      finalMessage = `[Context files]\n${parts.join('\n\n')}\n[/Context files]\n\n${finalMessage}`;
    }
    if (curReply) { const qt = curReply.content.length > 120 ? curReply.content.slice(0, 120) + '...' : curReply.content; finalMessage = qt.split('\n').map(l => `> ${l}`).join('\n') + '\n\n' + finalMessage; }

    // Instant auto-name: set title from first message text immediately
    if (finalMessage && currentMessages.length === 0 && (topic.name === 'New Chat' || topic.name.startsWith('New '))) {
      const raw = message.trim().replace(/https?:\/\/\S+/g, '').replace(/[#*_`~[\]()]/g, '').replace(/\s+/g, ' ').trim();
      if (raw.length > 0) {
        const words = raw.split(' ').filter(w => w.length > 0);
        let autoTitle = words.slice(0, 5).join(' ');
        if (autoTitle.length > 40) autoTitle = autoTitle.slice(0, 40).trim() + '…';
        autoTitle = autoTitle.charAt(0).toUpperCase() + autoTitle.slice(1);
        onUpdateTopic(topic.id, { name: autoTitle });
      }
    }

    if (finalMessage) {
      if (isDraft) startDescent();
      const mediaSizes = await sizesByPath(sized);
      const sendOptions = currentSendOptions();
      await sendMessage(topic.sessionKey, finalMessage, mediaSizes ? { ...sendOptions, mediaSizes } : sendOptions);
      if (isDraft) settleDescent();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } sendTyping(message); };
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isGlobalOrchestrator) {
      const f = Array.from(e.target.files || []);
      if (f.length > 0) setPendingFiles(prev => [...prev, ...f]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const removePendingFile = (i: number) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i));

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (isGlobalOrchestrator) return;
    const items = Array.from(e.clipboardData.items); const imgs: File[] = [], others: File[] = [];
    for (const item of items) { if (item.kind === 'file') { const f = item.getAsFile(); if (f) { if (f.type.startsWith('image/')) { imgs.push(f); } else { others.push(f); } } } }
    if (imgs.length > 0) {
      e.preventDefault();
      // `allSettled` and not `all`: the default is already prevented, so the
      // clipboard has nowhere else to land. With `all`, a single image the
      // decoder refuses (`img.onerror`) rejected the whole batch into an empty
      // catch, and the paste left NOTHING on screen: not the other images, not
      // the text. The readable ones go in, and the toast names what was dropped.
      void Promise.allSettled(imgs.map(f => resizeImageToBase64(f))).then(results => {
        const ready = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
        if (ready.length > 0) setPendingImages(prev => [...prev, ...ready]);
        const dropped = imgs.filter((_, i) => results[i]?.status === 'rejected').map(f => f.name || f.type);
        if (dropped.length > 0) toast.error(tr('chat.paste.imageFailed', { files: dropped.join(', ') }));
      });
    }
    if (others.length > 0) { e.preventDefault(); setPendingFiles(prev => [...prev, ...others]); }
  }, [resizeImageToBase64, isGlobalOrchestrator, toast, tr]);

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    // D15: our own drags belong to the layout's drop zones, see chatFileDrop.
    if (!chatAcceptsFileDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isGlobalOrchestrator) setFileDragOver(true);
  }, [isGlobalOrchestrator]);
  const handleFileDragLeave = useCallback((e: React.DragEvent) => { if (!chatAcceptsFileDrag(e.dataTransfer.types)) return; e.preventDefault(); e.stopPropagation(); if (dragLeftHost(e.currentTarget, e)) setFileDragOver(false); }, []);
  const handleFileDrop = useCallback((e: React.DragEvent) => {
    if (!chatAcceptsFileDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);
    if (isGlobalOrchestrator) return;
    const f = Array.from(e.dataTransfer.files);
    if (f.length > 0) setPendingFiles(prev => [...prev, ...f]);
  }, [isGlobalOrchestrator]);
  // A drag that ends anywhere else never reaches the two handlers above: see watchFileDragEnd.
  useEffect(() => {
    if (!fileDragOver) return;
    return watchFileDragEnd(window, () => setFileDragOver(false));
  }, [fileDragOver]);

  // Ref-stable so `MessageBubble`'s memo holds during streaming. These are
  // passed to EVERY visible bubble via MessageList → itemContent; when they were
  // plain functions their identity changed on every streaming token, breaking
  // the shallow memo and re-parsing every visible message's markdown per chunk.
  // With stable identities only the growing last bubble (whose `msg` object
  // actually changes) re-renders.
  const handleCopyMessage = useCallback(async (msg: ChatMessage) => {
    if (await copyText(msg.content)) {
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId(null), 2000);
    } else {
      toast.error(tr('browser.menu.copyFailed'));
    }
  }, [toast, tr]);
  const handleTogglePin = useCallback(async (msg: ChatMessage) => { const pinned = topic.pinnedMessages || []; const newPinned = pinned.includes(msg.id) ? pinned.filter(id => id !== msg.id) : [...pinned, msg.id]; await onUpdateTopic(topic.id, { pinnedMessages: newPinned }); }, [topic.pinnedMessages, topic.id, onUpdateTopic]);
  const isImageFile = (f: File) => f.type.startsWith('image/');
  // Per ID e non per posizione: correggere il secondo mentre il primo parte non
  // deve toccare il messaggio sbagliato. (Il badge del composer ragionava per
  // indice — è stato tolto, vedi `QueuedTurns`.)
  const handleUpdateQueueItem = useCallback((id: string, content: string) => {
    updateTurn(topic.sessionKey, id, content);
  }, [topic.sessionKey]);
  const handleRemoveQueueItem = useCallback((id: string) => {
    removeTurn(topic.sessionKey, id);
  }, [topic.sessionKey]);
  const handleClearQueue = useCallback(() => clearQueue(topic.sessionKey), [topic.sessionKey]);
  /**
   * «Invia subito»: non aspettare la fine del turno, falla partire ORA.
   *
   * Sono tre mosse, e nessuna delle tre è di troppo.
   *
   *  1. **Fermare.** Finché il turno è in volo il server risponde 409 a un
   *     secondo turno sulla stessa sessione: prima si chiude quello aperto.
   *  2. **Togliere il freno.** Lo stop ne alza uno DUREVOLE apposta perché la
   *     fine di uno stream non faccia ripartire la coda da sola (`holdQueue`
   *     in `state/chatQueue.ts`): era il guasto per cui «ferma» faceva PARTIRE
   *     il messaggio dopo. Qui è l'umano a chiedere il contrario, quindi il
   *     freno va tolto a mano.
   *  3. **Chiedere il drenaggio.** E questa è la mossa che non si vede: il
   *     drenaggio automatico è appeso alla FINE di uno stream riuscito, e un
   *     abort non ci passa (esce dal ramo `AbortError` di `performSend`).
   *     Senza questa riga la coda resterebbe ferma fino al prossimo messaggio
   *     scritto a mano. Si chiede all'ingresso pubblico con un testo vuoto:
   *     `enqueueTurn` scarta le stringhe vuote, quindi non accoda niente, e
   *     `decideSend` fa partire la testa della coda (`queue-then-drain`).
   *
   * Il giro serve perché lo stop può tornare un istante prima che il turno
   * fermato abbia finito di smontarsi: finché la sessione risulta occupata la
   * richiesta non fa nulla e la coda resta lunga uguale, che è il segnale per
   * riprovare. Poche volte e poi basta: se non riparte, la coda è ancora tutta
   * lì, visibile come bolle «da inviare» nel trascritto, e il messaggio
   * successivo la fa partire comunque.
   *
   * La richiesta NON si aspetta, e non è pigrizia: sul ramo che drena,
   * `sendMessage` restituisce la promessa del turno INTERO, che dura minuti.
   * Aspettarla vorrebbe dire scambiare «il turno è finito» per «la coda non è
   * partita» e rispedire. Quello che si guarda è la coda: se si accorcia, la
   * testa è uscita.
   */
  const handleSendQueueNow = useCallback(async () => {
    // Nothing in flight, nothing to stop: a stop on an idle session would
    // paint "stopped by you" and propose wiping a chat that is not running.
    // This is the stranded case (queue survived a reload, or a turn that ended
    // while this client was not listening): only the hold and the kick apply.
    // Only the turn, to send the correction: the sub-agents it delegated to
    // keep working. The tree stops on the explicit Stop alone.
    if (currentStreaming) await stopSession(topic.sessionKey, { sendNow: true });
    releaseHold(topic.sessionKey);
    for (let tentativo = 0; tentativo < QUEUE_KICK_ATTEMPTS; tentativo++) {
      const prima = getQueue(topic.sessionKey).length;
      if (prima === 0) return;
      void sendMessage(topic.sessionKey, '').catch(() => {});
      await new Promise((r) => setTimeout(r, QUEUE_KICK_RETRY_MS));
      if (getQueue(topic.sessionKey).length < prima) return;
    }
  }, [stopSession, sendMessage, topic.sessionKey, currentStreaming]);
  // Terza scansione dell'intera cronologia a ogni flush dello streaming, per un
  // pannello che quasi sempre è chiuso e quasi sempre dà lo stesso risultato:
  // l'insieme dei messaggi appuntati cambia solo quando qualcuno clicca la
  // puntina, non a ogni token.
  const pinnedIds = topic.pinnedMessages;
  // The count comes from the topic, not from the rows on screen: a long chat
  // opens on its last page, and a pin older than that page is still in the
  // agent's context (CMDUI-10).
  const pinnedCount = pinnedIds?.length ?? 0;
  const pinnedMessages = useMemo(
    () => (pinnedIds?.length ? currentMessages.filter((m) => pinnedIds.includes(m.id)) : EMPTY_MESSAGES),
    [currentMessages, pinnedIds],
  );

  /**
   * Is this chat the session of a board task? Then its transcript has a second
   * reader (whoever approves it) and the machine work of each turn folds into
   * one accordion, while the words stay in plain sight. Same index that feeds
   * the strip above, so it costs no request of its own.
   */
  const foldTaskWork = !!useTopicTask(topic.id);

  /**
   * THE ROWS ON SCREEN ARE THE ONES THIS DEVICE ALREADY HAD.
   *
   * `loadHistory` falls back to the local copy when its fetch fails, and it
   * keeps doing so: that is what stops the transcript from emptying out on a
   * hiccup of the boot. What it may not do is stay quiet about it, and it did,
   * for as long as the flag it raises had no reader anywhere in the repo. One
   * line, with the way to ask again, so a person can tell yesterday's answers
   * from this minute's. The socket gate lives inside the hook, see
   * `state/historyFromCache.ts`.
   */
  const servedFromCache = useServedFromCache(topic.sessionKey);

  /**
   * The chat's state: its goal (or the agent's todo list), the work running
   * now, the checkpoints, the files it wrote. Drawn at the end of the
   * transcript, after the last message (chat-strips-in-transcript): what they
   * say belongs to the conversation, not to the send, and docked over the
   * composer they stayed hooked to it however far up one read (Attilio, 08/10:
   * «dovrebbero restare a fondo chat»). A chat with no messages (empty, or its
   * history still on the way) has no transcript to hold them: there they stay
   * in the composer's block.
   */
  const strips = (
    <>
      {!isGlobalOrchestrator && goal ? (
        <GoalBar
          goal={goal}
          fallback={latestTodo ?? undefined}
          onClose={(status) => { void handleGoalClose(status); }}
          onEdit={handleGoalEdit}
          onStopLoop={() => { void handleGoalStopLoop(); }}
          onPromote={() => { void handleGoalPromote(); }}
        />
      ) : (
        latestTodo && <TodoStrip snapshot={latestTodo} />
      )}
      {!isGlobalOrchestrator && <SubAgentsStrip topicId={topic.id} />}
      {!isGlobalOrchestrator && <CheckpointTimeline topicId={topic.id} onRollback={() => loadHistory(topic.sessionKey)} />}
      {/* What the agent wrote in this conversation, counted from its own write
          tool calls: silent in a chat that wrote nothing. Hidden for the
          coordinator, which by invariant has no project path and no worktree:
          its rows would have no tree to open a diff against. */}
      {!isGlobalOrchestrator && <ChangedFilesStrip key={topic.id} topic={topic} onWSMessage={onWSMessage} />}
    </>
  );
  const stripsInTranscript = currentMessages.length > 0;

  return (
    <div
      ref={paneRootRef}
      // Whose conversation this subtree is: `openLink` walks up from the clicked
      // anchor to find out which topic's window may claim the link.
      data-chat-topic-id={topic.id}
      data-find-pane={findPaneId}
      // `chrome-passthrough-y` and not `overflow-hidden`: the transcript inside
      // rises by the height of the chrome bar and has to be PAINTED up there,
      // not just laid out there. The horizontal containment is unchanged. See
      // the block on `.chrome-passthrough-y` in index.css.
      // `swap-ice-ring`: two pixels of ice along the pane's edge while one of
      // its commands is stopped. A ring and not a veil: the pane stays usable,
      // and it is the one surface where a person can still write.
      className={`relative flex flex-col min-w-0 min-h-0 chrome-passthrough-y flex-1 w-full max-w-full${swapFreeze ? ' swap-ice-ring' : ''}`}
      data-swap-frozen={swapFreeze ? 'true' : undefined}
      style={browserInset ? { paddingRight: `${browserInset}px` } : undefined}
      // Un clic QUALUNQUE dentro la pane la rende tua: da lì in poi una chat
      // nuova non si richiude più da sola. In cattura, perché deve valere anche
      // per i clic che un figlio si tiene per sé. Vedi `state/draftPane.ts`.
      onPointerDownCapture={() => markDraftTouched(topic.id)}
      onKeyDownCapture={() => markDraftTouched(topic.id)}
    >
      {ownsBrowserWindow && hasTopicBrowserWindow(browserWindow) && (
        <Suspense fallback={null}>
          {/* The browser in this chat's window is a pane of its own for
              find: it must not register under this chat's id. */}
          <FindPaneContext.Provider value={null}>
            <TopicBrowserWindow topicId={topic.id} areaRef={paneRootRef} projectPath={topic.projectPath ?? undefined} />
          </FindPaneContext.Provider>
        </Suspense>
      )}
      {ownsBrowserWindow && hasTopicBrowserWindow(browserWindow) && browserWindow.mode === 'hidden' && (
        <TopicBrowserReopen topicId={topic.id} />
      )}
      {/* The find bar sits in the column's flow, above the transcript. */}
      <FindBar paneId={findPaneId} />
      {/* Il verso di ritorno: questa chat è la SESSIONE di un task? Allora da
          qui si torna alla sua SCHEDA, che è dove si decide. Muta in ogni
          altra chat. */}
      <TaskCardStrip topicId={topic.id} />
      {/* The strip of what this topic touched used to sit here, between the
          task card and the transcript, and for a while above the tab bar. It
          now lives in the bottom block, right above the composer
          (`ChangedFilesStrip` below): what the topic wrote is read where the
          next message is written. */}
      {servedFromCache && (
        <div
          data-testid="chat-cached-history-notice"
          className="chat-measure px-3 py-1 flex items-center gap-1.5 flex-shrink-0 text-mini text-amber-600 dark:text-amber-400"
        >
          {/* A dot and not an icon component: it is the same six-pixel signal
              the status bar uses for a data notice, and at this size a glyph
              would carry more weight than the sentence next to it. */}
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-500" aria-hidden="true" />
          <span className="truncate">{tr('chat.cachedHistory.notice')}</span>
          <button
            type="button"
            data-testid="chat-cached-history-retry"
            className="underline underline-offset-2 hover:no-underline flex-shrink-0"
            onClick={() => { void loadHistory(topic.sessionKey); }}
          >
            {tr('chat.cachedHistory.retry')}
          </button>
        </div>
      )}
      {/* What stays in the agent's context, said where it is read (CMDUI-10):
          «Appunta» put messages there and nothing showed it. */}
      {pinnedCount > 0 && (
        <button
          type="button"
          data-testid="chat-pinned-line"
          aria-expanded={showPinned}
          onClick={() => {
            // Pins older than the loaded page: the list asks for the rest of
            // the thread, as a jump to an older message does.
            if (!showPinned && pinnedMessages.length < pinnedCount) void requestHistoryCompletion(topic.sessionKey, 'apply');
            setShowPinned((v) => !v);
          }}
          className="chat-measure px-3 py-1 flex items-center gap-1.5 flex-shrink-0 text-mini text-app-text-secondary hover:text-app-text text-left"
        >
          <Pin size={12} className="text-yellow-500 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{tr(pinnedCount === 1 ? 'chat.pinned.lineOne' : 'chat.pinned.lineMany', { n: pinnedCount })}</span>
        </button>
      )}
      <PinnedMessages
        show={showPinned && pinnedCount > 0}
        pinnedMessages={pinnedMessages}
        notLoaded={pinnedCount - pinnedMessages.length}
        onGoTo={(id) => { setShowPinned(false); requestScrollToMessage(topic.id, id); }}
        onUnpin={(m) => { void handleTogglePin(m); }}
      />
      <TaskWorkFoldContext.Provider value={foldTaskWork}>
      <ChatTopicContext.Provider value={topic.id}>
      <MessageList isMobile={isMobile} topic={topic} currentMessages={currentMessages} compactionMarkers={currentMarkers} currentLoading={currentLoading} currentStreaming={currentStreaming} copiedMsgId={copiedMsgId} fileDragOver={fileDragOver} chatContainerRef={chatContainerRef} messagesEndRef={messagesEndRef} onReply={setReplyingTo} onCopy={handleCopyMessage} onTogglePin={handleTogglePin} onFileDragOver={handleFileDragOver} onFileDragLeave={handleFileDragLeave} onFileDrop={handleFileDrop} onPlanDecision={handlePlanDecision} onRemember={isGlobalOrchestrator ? undefined : handleRememberMessage} onEdit={!isGlobalOrchestrator && editMessage ? handleEditMessage : undefined} onRegenerate={!isGlobalOrchestrator && regenerateMessage && !currentStreaming ? handleRegenerateMessage : undefined} onFork={canFork ? handleFork : undefined} onDeleteMessage={!isGlobalOrchestrator && deleteMessage && !currentStreaming ? handleDeleteMessage : undefined} onSwitchBranch={!isGlobalOrchestrator && switchBranch ? handleSwitchBranch : undefined} onMessage={onWSMessage} onRetry={handleRetry} inputAreaHeight={inputAreaHeight} composerResizeRef={composerResizeRef} composerCentered={composerCentered} bornFromDraft={bornFromDraft} initialScrollOffset={initialScrollOffset} onScrollOffsetChange={handleScrollOffsetChange} queuedTurns={messageQueue} onUpdateQueued={handleUpdateQueueItem} onRemoveQueued={handleRemoveQueueItem} onClearQueue={handleClearQueue} onSendQueueNow={handleSendQueueNow} queueBusy={currentStreaming} footerStrips={stripsInTranscript ? strips : null} />
      </ChatTopicContext.Provider>
      </TaskWorkFoldContext.Provider>
      {/* The composer docks at the bottom with only its natural margin — no
          home-indicator reservation (the user wants minimal bottom space), so it
          reaches the bottom edge and the OS indicator simply overlays it. */}
      {/* `chat-measure` caps and CENTRES the whole bottom block (the composer
          and what belongs to the send above it) on the list's column. With
          `left-0 right-0` the position is over-constrained and the utility's
          auto margins resolve it, so the block centres instead of widening.
          `inputAreaHeight` still measures right: the ResizeObserver reads
          `contentRect.height`, the height, not the width. */}
      <div
        ref={inputAreaRef}
        data-testid="chat-input-area"
        data-composer-centered={composerCentered ? 'true' : 'false'}
        className={`absolute bottom-0 left-0 right-0 chat-measure${composerCentered ? '' : ' composer-dock-slide'}`}
        style={{
          ...(composerOffset ? { transform: `translateY(-${composerOffset}px)` } : null),
          // The root pads ITSELF, but an absolutely positioned child is laid
          // out against the PADDING box, so the composer ignored that padding
          // and sat under the expanded window, send button included. It has to
          // be told the same inset directly.
          //
          // `width: auto` IS LOAD-BEARING, and `right` alone does nothing
          // without it: `chat-measure` sets `width: 100%`, and an absolute box
          // with `left`, `width` AND `right` all set is over-constrained — in
          // LTR the one the browser throws away is `right`. Measured at 1280 in
          // a project pane, with the inline `right: 480px` in place and no
          // `width`: composer 480..1280, send button 1229..1261, and
          // `elementFromPoint` on its center answering `topic-browser-window`.
          // TOPIC-BROWSER-01q is that measurement.
          ...(browserInset ? { right: `${browserInset}px`, width: 'auto' } : null),
        }}
      >
        {showGreeting && (
          <div ref={greetingRef}>
            <ChatEmptyState
              topic={topic}
              paneHeight={paneHeight}
              fading={!composerCentered}
              onPick={(msg) => { setMessage(msg); textareaRef.current?.focus(); }}
            />
          </div>
        )}
        {pendingPlan && (
          <PlanApprovalBar
            busy={planBusy}
            onApprove={() => handlePlanChoiceFromBar(true)}
            onReject={() => handlePlanChoiceFromBar(false)}
          />
        )}
        {!stripsInTranscript && strips}
        {/* FROZEN: the line sits IN FLOW above the composer, never over it. An
            overlaid strip would cover the one control a person can still use
            while the command is stopped, and writing in the chat is exactly
            what stays possible. */}
        {swapFreeze && <SwapFreezeLabel freeze={swapFreeze} className="mx-2 mb-1 self-start" />}
        {/* What this chat wrote and never reached the server: in flow, right
            above the composer that would send it again, never over it. */}
        <UnsentStrip sessionKey={topic.sessionKey} />
        {commandAnswer && <CommandAnswerCard answer={commandAnswer} isMobile={isMobile} onDismiss={() => { if (commandAnswer.kind === 'running') compactWatchRef.current = null; setCommandAnswer(null); }} />}
        {sideQuestion.state && <SideQuestionPanel state={sideQuestion.state} onClose={sideQuestion.close} tr={tr} />}
        <ChatInput onRunCommand={(text) => { void handleSendMessage(undefined, text); }} autonomy={autonomy} onAutonomyChange={handleAutonomyChange} isMobile={isMobile} isFocused={isFocused} topic={topic} currentMessages={currentMessages} currentStreaming={currentStreaming} stoppedByUser={currentStoppedByUser} message={message} setMessage={setMessage} pendingFiles={pendingFiles} pendingImages={pendingImages} setPendingImages={setPendingImages} uploading={isUploading} replyingTo={replyingTo} setReplyingTo={setReplyingTo} isRecording={isRecording} recordingTime={recordingTime} fileInputRef={fileInputRef} textareaRef={textareaRef} onSubmit={handleSendMessage} onStop={() => { void stopSession(topic.sessionKey); }} onKeyDown={handleKeyDown} onFileSelect={handleFileSelect} removePendingFile={removePendingFile} onPaste={handlePaste} startRecording={startRecording} stopRecording={stopRecording} formatRecordingTime={formatRecordingTime} isImageFile={isImageFile} chatError={chatError[topic.sessionKey] ?? null} sendMessageDirect={async (c: string) => {
          // Passa dall'imbuto degli slash: il bottone «Compact now» e
          // l'azione dell'anello mandavano `/compact` come messaggio nudo,
          // quindi non vedevano il banner di stato ne' l'esito. Ora le tre
          // strade (comando digitato, bottone, anello) fanno la stessa cosa.
          if (c.startsWith('/') && (await handleSlashCommand(c))) return true;
          return sendMessage(topic.sessionKey, c);
        }} othersTyping={othersTyping} othersTypingText={othersTypingText} mentionedFiles={mentionedFiles} setMentionedFiles={setMentionedFiles} fastMode={fastMode} onToggleFastMode={toggleFastMode} editingMessage={editingMessage} onCancelEdit={handleCancelEdit} onExportConversation={currentMessages.length > 0 ? handleExportConversation : undefined} providerOverride={providerOverride} onProviderOverrideChange={handleProviderOverrideChange} onProviderOnlyChange={handleProviderOnlyChange} topicsRouting={topicsRouting} onTopicsRoutingChange={handleTopicsRoutingChange} effort={effort} onEffortChange={handleEffortChange} defaultProviderLabel={defaultProviderLabel} pinnedModel={pinnedModel} onUpdateTopic={onUpdateTopic} onMessage={onWSMessage} controlsRef={composerControlsRef} />
        {/* The phone's button row, when this chat owns its band (`bandOwned` in
            App): a box at the foot of the block and not a padding, because the
            block's height is read from `contentRect`, which leaves padding out.
            Counted there, the band reaches every reader of that height at once:
            the transcript's trailing spacer (so it scrolls down to the glass
            and its last message still ends above the composer), the ink mask,
            the centred composer of an empty chat and the jump-to-bottom
            button. 0px off the phone, in a project window and with the
            keyboard open (the row is gone, and so is its height). */}
        <div aria-hidden="true" data-testid="chat-band-spacer" style={{ height: `var(${BAND_OWN_PROPERTY}, 0px)` }} />
      </div>
    </div>
  );
}

/**
 * Custom memo comparator so a streaming chunk in ONE pane stops re-rendering
 * every OTHER (idle) ChatPane subtree.
 *
 * `useChat.getSessionMessages` is `useCallback(_, [messages])`, so it rebinds on
 * every streaming token — even for panes whose own session didn't change. A
 * default shallow memo would therefore never hold. We shallow-compare all props
 * EXCEPT `getSessionMessages`, and for that one compare the RESOLVED per-session
 * array instead of the function identity. That array is ref-stable per session
 * (getSessionMessages caches by source-array identity), so:
 *   - a chunk in another pane leaves THIS pane's resolved array untouched → skip;
 *   - a chunk in THIS pane's own session changes its array → re-render.
 * `isSessionLoading`/`isSessionStreaming`/`wasSessionStopped` are stable
 * readers of the flag store now (`state/sessionFlags.ts`), and the pane
 * subscribes to its own session's flags; they are still resolved for THIS
 * pane's sessionKey and compared as booleans, so a caller that hands in a
 * wrapper per render does not defeat the memo.
 *
 * Any genuine prop change (topic rename, focus, chatError, ProjectWindow's
 * per-render wrappedSendMessage for preview panes) fails the shallow pass →
 * re-render, so no pane goes stale.
 */
const RESOLVED_KEYS = new Set<keyof ChatPaneProps>([
  'getSessionMessages',
  'isSessionLoading',
  'isSessionStreaming',
  'wasSessionStopped',
]);
function chatPanePropsEqual(prev: ChatPaneProps, next: ChatPaneProps): boolean {
  const keys = new Set<keyof ChatPaneProps>([
    ...(Object.keys(prev) as (keyof ChatPaneProps)[]),
    ...(Object.keys(next) as (keyof ChatPaneProps)[]),
  ]);
  for (const k of keys) {
    if (RESOLVED_KEYS.has(k)) continue; // compared via resolved per-session values below
    if (prev[k] !== next[k]) return false;
  }
  // Reached only when topic (and thus sessionKey) is identical across renders.
  const sk = prev.topic.sessionKey;
  return (
    prev.getSessionMessages(sk) === next.getSessionMessages(sk) &&
    prev.isSessionLoading(sk) === next.isSessionLoading(sk) &&
    prev.isSessionStreaming(sk) === next.isSessionStreaming(sk) &&
    prev.wasSessionStopped(sk) === next.wasSessionStopped(sk)
  );
}

export const ChatPane = memo(ChatPaneComponent, chatPanePropsEqual);

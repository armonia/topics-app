import { useState, useEffect, useRef, useCallback, useMemo, memo, Suspense } from 'react';
import { useT } from '../../hooks/useT';
import { SwapFreezeLabel } from '../Shared/SwapFreezeLabel';
import { useSwapFreeze } from '../../state/swapFreeze';
import { TopicBrowserReopen } from '../Browser/TopicBrowserReopen';
import { TopicBrowserWindow, useTopicBrowserPresence, usePaneWindowDoor, hasTopicBrowserWindow, DEFAULT_EXPANDED_WIDTH, useTopicBrowserInset } from '../Browser/topicBrowserWindowLazy';
import { isOwnFrame } from '@/state/wsIdentity';
import { adoptLegacyQueue, clearQueue, getQueue, releaseHold, removeTurn, updateTurn, useChatQueue } from '@/state/chatQueue';
import { X } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, CompactionMarker } from '../../types';
import type { SendMessageOptions } from '../../hooks/useChat';
import { uploadApi, filesApi, autoNameApi, commandApi, memoryApi, topicsApi, chatApi, apiErrorCode, type CommandResult } from '../../lib/api';
import { useComposerDock } from './useComposerDock';
import { composerMayTakeFocus } from './composerFocus';
import { markDraftTouched, setDraftDirty } from '../../state/draftPane';
import { ChatEmptyState } from './ChatEmptyState';
import { findPendingPlan, planApprovalMessage } from './planDetection';
import { clearAskDraft, readAskDraft } from './askDraft';
import { PLAN_APPROVAL_QUESTION, PLAN_APPROVE_LABEL, PLAN_EDIT_KEY, PLAN_REJECT_LABEL } from '../../../../shared/plan-decision';
import { forkModeFor } from '../../../../shared/chat-fork';
import { useConfirm } from '../../hooks/useConfirm';
import { chatAcceptsFileDrag } from './chatFileDrop';
import { dragLeftHost } from '../../lib/dragLeave';
import { errMessage } from '../../lib/errMessage';
import { BAND_OWN_PROPERTY } from '../../lib/selectionStyles';
import { sendFocusTopic } from '../../lib/focusMessaging';
import type { MentionedFile } from './FileMentionMenu';
import { PinnedMessages } from './PinnedMessages';
import { MessageList } from './MessageList';
import { offeredSlashCommands } from './slashCommands';
import { ChatInput, type ComposerControls } from './ChatInput';
import { cliRefusedCommand, isClearCommand, topicsHomeCommand } from './cliRefused';
import { shortcut } from '../../lib/shortcutLabel';
import { openUserMenu } from '../../lib/openUserMenu';
import { CheckpointTimeline } from './CheckpointTimeline';
import { restoreLastTurnCheckpoint, RestoreRefusedError } from '../../hooks/useCheckpoints';
import { rewindFailureText } from './checkpointPlan';
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
import {
  autonomyKey,
  effortKey,
  isDraftTopicId,
  providerOverrideKey,
  rememberAutonomySelection,
  rememberEffort,
  rememberProviderSelection,
  safeStore,
  sameSelection,
  seedAutonomy,
  seedEffort,
  seedProviderOverride,
} from '../../lib/composerMemory';
import { usePaneHold } from '../../state/pane/residency/holds';
import { useSessionMessages } from '../../state/useSessionMessages';
import { useSessionFlagValue } from '../../state/sessionFlags';
import { loadDraftAttachments, saveDraftAttachments } from '../../state/draftAttachments';
import { useServedFromCache } from '../../state/historyFromCache';
import { holdTopic } from '../../state/topicSubscriptions';
import { apiFetch } from '../../lib/shell/net';

/**
 * The text `/help` prints, DERIVED from the composer's own menu.
 *
 * It used to be a second hand-written array right here, and the two drifted the
 * way two hand-kept lists always do: `/help` named ten commands while the menu
 * offered more. The one place a user goes to ask "what can I type here" gave
 * the shorter, older answer — and there is no way to notice, because both
 * lists look complete on their own.
 *
 * A FUNCTION and not a constant, because the array carries i18n KEYS: the text
 * only exists once a language is chosen, and it changes when the language does.
 * The command itself is not translated, it is what one types.
 */
const slashCommandsHelp = (tr: (key: string) => string, provider: string | null) =>
  offeredSlashCommands(provider).map((c) => `${c.cmd}: ${tr(c.descriptionKey)}`);

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The sentence of each `/project` refusal, by the code the route answers with. */
const PROJECT_ERROR_KEY: Record<string, string> = {
  project_name_required: 'chat.project.usageCreate',
  project_name_invalid: 'chat.project.nameInvalid',
  project_exists: 'chat.project.exists',
  project_target_required: 'chat.project.usageOpen',
  project_not_found: 'chat.project.notFound',
};

/** What `/project` answered, as lines in the reader's language. */
function projectInfoLines(r: CommandResult & { code?: string; name?: string; path?: string | null; projects?: string[]; moreProjects?: number }, tr: Translate): string[] {
  if (r.code === 'project_created') return [tr('chat.project.created', { name: r.name ?? '', path: r.path ?? '' })];
  if (r.code === 'project_opened') return [tr('chat.project.opened', { path: r.path ?? '' })];
  const lines = [r.path ? tr('chat.project.current', { path: r.path }) : tr('chat.project.none')];
  const projects = r.projects ?? [];
  if (projects.length > 0) {
    lines.push('', tr('chat.project.workspace'));
    for (const p of projects) lines.push(`  ${p.split('/').pop() || p} · ${p}`);
    if (r.moreProjects) lines.push(tr('chat.project.more', { count: r.moreProjects }));
  }
  return lines;
}

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
  stopSession: (sk: string) => Promise<boolean>;
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
  // Session viewer
  /** Optional content rendered inside the floating input bar, just above
   *  CheckpointTimeline + ChatInput. Used by Master Topic panes to mount
   *  the board strip so it stays visible while typing. */
  aboveInputSlot?: React.ReactNode;
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
  aboveInputSlot, ownsBrowserWindow,
}: ChatPaneProps) {
  const tr = useT();
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

  const [message, setMessage] = useState(() => {
    try { return localStorage.getItem(draftKey) || ''; } catch { return ''; }
  });
  // Restore draft + caret on topic switch / mount. The caret restore is deferred
  // one frame so it runs after the setMessage re-render commits the text into the
  // textarea — otherwise setSelectionRange would clamp against an empty value.
  useEffect(() => {
    try { setMessage(localStorage.getItem(`draft:${topic.id}`) || ''); } catch { setMessage(''); }
    const raf = requestAnimationFrame(() => restoreCursor(`chat:${topic.id}`, textareaRef.current));
    return () => cancelAnimationFrame(raf);
  }, [topic.id]);
  // Persist draft to localStorage
  useEffect(() => {
    try { if (message) localStorage.setItem(draftKey, message); else localStorage.removeItem(draftKey); } catch {}
  }, [message, draftKey]);

  /**
   * Qualcuno ha messo del testo nella bozza di QUESTA chat mentre era già
   * montata — oggi: una missione scelta dalla board accanto (`ProjectWindow`).
   * L'effetto qui sopra che rilegge `draft:<id>` dipende da `topic.id`, quindi
   * su una pane già aperta non ripartirebbe e la missione resterebbe scritta su
   * localStorage senza comparire mai. Il fuoco va con essa: il testo è davanti
   * a chi lo deve mandare, e a mandarlo è lui.
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
  const [showPinned] = useState(false);
  const [autoNameTriggered, setAutoNameTriggered] = useState(false);
  const [, setCommandLoading] = useState(false);
  /**
   * The answer of a typed command. `stays`: it does not close by itself. Only a
   * one-line confirmation (model, effort, browser opening) closes after five
   * seconds; a timer used to close every result, so a fifteen-line `/help`, a
   * four-line `/rewind` report and the «compacting» notice of an operation
   * that takes minutes were all gone before anyone had read them.
   */
  const [commandResult, setCommandResult] = useState<{ type: 'success' | 'error'; message: string; stays?: boolean } | null>(null);
  /**
   * A compaction waiting for its outcome: the marker count before it, how many
   * messages the chat had, whether its turn has been seen running.
   */
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
  // Il «Plan Mode» stava qui: uno stato in localStorage, per-dispositivo, che
  // spediva un flag per-turno e finiva in un blocco di prompt che nessuno faceva
  // rispettare. Il piano adesso è UN livello di autonomia (`ask`), persistito
  // sul topic e passato alla CLI come `--permission-mode plan`; la route inietta
  // lo stesso blocco quando quel livello è attivo. Vedi `handleAutonomyChange`.
  // Fast Mode toggle (openspec change `chat-fast-mode`). Two sources of truth:
  //   1. `topic.fastMode` (server, persisted, synced cross-window via WS).
  //   2. `localStorage["fastMode:<topic.id>"]` — used purely to avoid a flash
  //      of the OFF state during the first render before the topic prop
  //      hydrates from the API.
  // On mount we prefer the server value when present; otherwise localStorage.
  // On every toggle we write both AND optimistically POST to the server.
  const [fastMode, setFastMode] = useState<boolean>(() => {
    if (typeof topic.fastMode === 'boolean') return topic.fastMode;
    try { return localStorage.getItem(`fastMode:${topic.id}`) === 'true'; } catch { return false; }
  });
  // Reconcile if the server-pushed topic.fastMode diverges (cross-window sync,
  // or app boot order where topic arrives after first paint). When the topic
  // has NO explicit server value (undefined — never toggled there), re-seed
  // from THAT topic's own localStorage: the old boolean-only guard skipped
  // this case, so an in-place switch from a fastMode:true topic carried
  // `true` into topics che non l'avevano mai acceso.
  useEffect(() => {
    if (typeof topic.fastMode === 'boolean') {
      if (topic.fastMode !== fastMode) {
        setFastMode(topic.fastMode);
        try { localStorage.setItem(`fastMode:${topic.id}`, String(topic.fastMode)); } catch {}
      }
    } else {
      try { setFastMode(localStorage.getItem(`fastMode:${topic.id}`) === 'true'); }
      catch { setFastMode(false); }
    }
    // `fastMode` (lo stato locale) non è una dipendenza: questo effetto
    // riconcilia dal SERVER verso il locale, e metterlo fra le dipendenze lo
    // farebbe ripartire subito dopo ogni toggle dell'utente — cioè rispondere a
    // un click ri-applicando il valore vecchio. Gli ingressi sono il valore
    // spinto dal server e l'identità del topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.fastMode, topic.id]);
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
  // The door, on the pane's own terms: a window that already exists. This pane
  // is also the chat of a PROJECT window, whose layout is where a first link of
  // that conversation belongs (`LINK-TAB-02`). See `usePaneWindowDoor`.
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

  // Chiude il banner della compattazione con l'esito VERO, quando il marcatore
  // arriva. `stream:compaction` porta i token prima/dopo, quindi si puo' dire
  // quanto e' stato liberato invece di un generico «fatto».
  //
  // THE TURN ENDING WITHOUT A MARKER IS AN OUTCOME TOO. The CLI answers a
  // compaction it cannot do («Not enough messages to compact.») with a
  // message and the end of the turn, and no marker. The watch used to wait
  // for a marker only, with a cap checked only when markers changed: the
  // «compacting» notice never turned into the failure, and the watch never
  // closed.
  useEffect(() => {
    const w = compactWatchRef.current;
    if (!w) return;
    const markers = currentMarkers ?? [];
    if (markers.length > w.before) {
      compactWatchRef.current = null;
      const last = markers[markers.length - 1];
      const pre = last?.preTokens;
      const post = last?.postTokens;
      setCommandResult({
        type: 'success',
        message:
          typeof pre === 'number' && typeof post === 'number'
            ? tr('chat.compact.done', { before: pre.toLocaleString(), after: post.toLocaleString() })
            : tr('chat.compact.doneNoCount'),
      });
      return;
    }
    // A turn already running when `/compact` was sent is not the compaction's:
    // the outcome is the end of a turn that STARTED after an idle moment.
    if (currentStreaming) { if (w.sawIdle) w.sawTurn = true; return; }
    if (!w.sawTurn) { w.sawIdle = true; return; }
    compactWatchRef.current = null;
    // The reason is what the CLI said in that turn, when it said something.
    const said = currentMessages.slice(w.messagesBefore).filter((m) => m.role === 'assistant' && m.content?.trim()).at(-1)?.content.trim();
    setCommandResult({
      type: 'error',
      stays: true,
      message: said ? tr('chat.compact.notDone', { reason: said }) : tr('chat.compact.notDoneNoReason'),
    });
  }, [currentMarkers, currentStreaming, currentMessages, tr]);

  // Picker keeps a simple local override per pane. On first paint we seed it
  // from the topic's persisted `provider`/`model` (set previously via PATCH);
  // after that, picking a model is purely local — we no longer auto-PATCH on
  // every click. This avoids the draft→real promotion flash where the topic
  // id changes mid-flight and async state updates raced the chat submit.
  //
  // Cross-window sync stays available via the read path (next page load picks
  // up `topic.model` from the server). A future revisit can add per-window
  // live sync when we have a deliberate UX for it.
  // Da dove parte il picker: quello che il topic PERSISTE, poi la scelta fatta
  // su questa bozza, poi l'ultima scelta fatta su qualunque chat. La regola sta
  // in `lib/composerMemory.ts`, con i suoi test: le bozze non hanno riga sul
  // server, e quest'ordine si era gia' sbagliato una volta.
  const [providerOverride, setProviderOverride] = useState<{ provider: string; model: string } | null>(
    () => seedProviderOverride({
      topicId: topic.id,
      topicProvider: topic.provider,
      topicModel: topic.model,
      store: safeStore(),
    }),
  );
  // Mirror state into a ref so the session-switch effect can read the latest
  // override without listing it as a dep (which would re-run the reseed every
  // time the user picks a model — the opposite of what we want).
  const providerOverrideRef = useRef(providerOverride);
  useEffect(() => { providerOverrideRef.current = providerOverride; }, [providerOverride]);

  // Per-topic effort-tier override (migration 033). Same draft-aware pattern as
  // the provider/model override above: real topics read `topic.effort` (kept in
  // sync via the `topic:updated` broadcast); drafts have no server row yet, so
  // the pick lives in localStorage until the draft is promoted.
  const [effort, setEffort] = useState<string | null>(
    () => seedEffort({ topicId: topic.id, topicEffort: topic.effort, store: safeStore() }),
  );
  const effortRef = useRef(effort);
  useEffect(() => { effortRef.current = effort; }, [effort]);

  // AICTRL-01 routing switch. No draft-only path (unlike provider/model
  // above): a fresh draft simply keeps the default (off) until sent, since
  // there is no server row to reload it from before that.
  const [topicsRouting, setTopicsRouting] = useState<boolean | null>(topic.topicsRouting ?? null);
  useEffect(() => { setTopicsRouting(topic.topicsRouting ?? null); }, [topic.id, topic.topicsRouting]);
  const handleTopicsRoutingChange = useCallback((next: boolean) => {
    setTopicsRouting(next);
    if (isDraftTopicId(topic.id)) return;
    void onUpdateTopic(topic.id, { topicsRouting: next });
  }, [onUpdateTopic, topic.id]);

  // Livello di autonomia — STESSO pattern di provider/model, Fast Mode ed effort,
  // ed era l'unico dei quattro selettori del composer a non averlo. Leggeva
  // `topic.autonomyLevel` diretto e faceva PATCH incondizionata: su una chat
  // NUOVA il topic è sintetico (`draft:<uuid>`, coniato in
  // `state/pane/adapters/paneConfig.ts`) e sul server non esiste, quindi la PATCH
  // non poteva che fallire — e l'utente vedeva «Non sono riuscito a cambiare
  // l'autonomia» a ogni tentativo di scegliere prima di scrivere il primo
  // messaggio. Misurato nel log di prod: `PATCH /api/topics/draft:a7bfeee2-…`.
  const [autonomy, setAutonomy] = useState<import('../../types').AutonomyLevel | null>(() => {
    const seeded = seedAutonomy({ topicId: topic.id, topicAutonomy: topic.autonomyLevel, store: safeStore() });
    return seeded === 'ask' || seeded === 'auto-apply' || seeded === 'yolo' ? seeded : null;
  });
  const autonomyRef = useRef(autonomy);
  useEffect(() => { autonomyRef.current = autonomy; }, [autonomy]);
  // Il topic reale può cambiare autonomia da un'ALTRA finestra (broadcast
  // `topic:updated`): la fonte di verità resta il server, il locale è solo la
  // scelta fatta qui e non ancora persistita.
  useEffect(() => {
    if (topic.autonomyLevel) setAutonomy(topic.autonomyLevel);
  }, [topic.autonomyLevel]);
  // Keep local effort in sync when the server row updates (cross-window sync,
  // or our own PATCH echoed back via topic:updated).
  useEffect(() => {
    if (!isDraftTopicId(topic.id)) setEffort(topic.effort ?? null);
  }, [topic.effort, topic.id]);
  // Track the previous topic id so we can detect a draft → real promotion vs
  // a genuine session switch.
  const prevTopicIdRef = useRef(topic.id);
  // Latest fastMode read by the promotion effect below. Captured in a ref so
  // we don't have to put `fastMode` in the effect deps (it'd refire on every
  // toggle and re-PUT the same value). The ref is updated by another effect.
  const fastModeRef = useRef(false);
  useEffect(() => { fastModeRef.current = fastMode; }, [fastMode]);

  useEffect(() => {
    const prevId = prevTopicIdRef.current;
    prevTopicIdRef.current = topic.id;
    const wasDraft = isDraftTopicId(prevId);
    const isNowReal = !isDraftTopicId(topic.id);
    if (wasDraft && isNowReal && prevId !== topic.id) {
      // Draft → real promotion: the user's pick from the draft phase must
      // survive (server just created the real topic with NULL provider/model
      // because the PATCH was gated while still a draft). Keep the override
      // in local state AND persist it to the new topic id now.
      const pick = providerOverrideRef.current;
      if (pick) {
        void onUpdateTopic(topic.id, { provider: pick.provider, model: pick.model });
      }
      // The draft pick was persisted under the draft id (see
      // handleProviderOverrideChange); the real topic now carries it on the
      // server, so drop the stale draft key (mirrors the fastMode migration
      // below).
      safeStore().removeItem(providerOverrideKey(prevId));
      // Same story for Fast Mode (openspec change `chat-fast-mode`). The
      // composer toggle wrote to `fastMode:draft:abc` and skipped the PUT
      // (drafts have no server-side row to PUT to). Now that the real topic
      // exists, persist the bit to its id, migrate the localStorage key
      // (old key kept for one render in case another component still reads
      // it; cleaned up on next mount), and broadcast via PUT for
      // cross-window sync.
      if (fastModeRef.current) {
        void onUpdateTopic(topic.id, { fastMode: true });
        try {
          localStorage.setItem(`fastMode:${topic.id}`, 'true');
          localStorage.removeItem(`fastMode:${prevId}`);
        } catch {}
      }
      // Same migration for the per-topic effort override (migration 033).
      if (effortRef.current) {
        void onUpdateTopic(topic.id, { effort: effortRef.current });
        const store = safeStore();
        store.setItem(effortKey(topic.id), effortRef.current);
        store.removeItem(effortKey(prevId));
      }
      // Stessa migrazione per l'autonomia. Senza, una scelta fatta sulla bozza
      // («Libero» prima di scrivere) veniva persa alla promozione e la chat
      // partiva sul default — cioè il selettore prometteva qualcosa che il
      // primo turno non rispettava.
      if (autonomyRef.current) {
        void onUpdateTopic(topic.id, { autonomyLevel: autonomyRef.current });
        try {
          localStorage.setItem(autonomyKey(topic.id), autonomyRef.current);
          localStorage.removeItem(autonomyKey(prevId));
        } catch {}
      }
      return;
    }
    // Una BOZZA non ha riga sul server: qui non c'è niente da cui riseminare, e
    // riseminare comunque voleva dire azzerare la scelta appena fatta. Succedeva
    // davvero: `onUpdateTopic` è fra le dipendenze e per le bozze il gruppo di
    // chat ne passa una NUOVA a ogni render (`isDraft ? async () => null : ...`,
    // StandaloneChatGroup), quindi l'effetto ripartiva da solo e rimetteva il
    // modello di default sotto le dita di chi l'aveva appena cambiato. La
    // scelta della bozza vive nello stato locale e in localStorage finché la
    // promozione non la porta sul topic reale.
    if (isDraftTopicId(topic.id)) return;
    // Genuine session switch — reseed from whatever the new topic persists.
    const seeded = seedProviderOverride({
      topicId: topic.id,
      topicProvider: topic.provider,
      topicModel: topic.model,
      store: safeStore(),
    });
    // Stesso valore, oggetto nuovo: assegnarlo sarebbe un render in più per
    // niente (e con una dipendenza instabile, un render a ogni render).
    setProviderOverride((prev) => (sameSelection(prev, seeded) ? prev : seeded));
  }, [topic.sessionKey, topic.id, topic.provider, topic.model, onUpdateTopic]);

  const isDraftTopic = isDraftTopicId(topic.id);
  const handleProviderOverrideChange = useCallback((next: { provider: string; model: string } | null) => {
    setProviderOverride(next);
    // Aggiorna la "memoria globale" dell'ultima selezione: le chat nuove la
    // leggono in inizializzazione e partono gia' con il modello giusto. Tornare
    // al default dell'app la CANCELLA — è una scelta anche quella, e tenersi il
    // modello vecchio lo farebbe ricomparire nella chat dopo.
    rememberProviderSelection(safeStore(), next);
    if (isDraftTopic) {
      // No server row to PATCH yet — persist the pick device-locally (same
      // approach as Fast Mode for drafts) so it survives a reload before the
      // draft is promoted on send. The promotion effect above migrates it to
      // the real topic id + the server and clears this key.
      const store = safeStore();
      if (next) store.setItem(providerOverrideKey(topic.id), JSON.stringify(next));
      else store.removeItem(providerOverrideKey(topic.id));
      return;
    }
    // Best-effort persist so a reload (or another pane on the same topic) sees
    // the same selection. Failures are non-fatal — the local state still
    // drives the next chat request.
    void onUpdateTopic(topic.id, {
      provider: next?.provider ?? null,
      model: next?.model ?? null,
    });
  }, [isDraftTopic, onUpdateTopic, topic.id]);

  const handleEffortChange = useCallback((next: string | null) => {
    setEffort(next);
    // Stessa memoria del modello: l'ultima scelta vale per le chat nuove, e
    // rimettere il default del provider la cancella.
    rememberEffort(safeStore(), next);
    if (isDraftTopic) {
      // No server row yet — persist device-locally; the promotion effect above
      // migrates it to the real topic id on first send.
      const store = safeStore();
      if (next) store.setItem(effortKey(topic.id), next);
      else store.removeItem(effortKey(topic.id));
      return;
    }
    // Persist through the topic PATCH; the server forces an idle CLI respawn so
    // the new tier applies on the next turn, and broadcasts topic:updated for
    // cross-window sync.
    void onUpdateTopic(topic.id, { effort: next });
  }, [isDraftTopic, onUpdateTopic, topic.id]);

  // Da cosa EREDITA questa chat quando non c'è un override completo. Il caso
  // che conta è stretto ma reale: `providerOverride` esiste solo se il topic ha
  // provider E model, quindi qui resta il topic che ha scelto il provider e non
  // il modello (lo fanno il dispatcher e il bridge MCP) — il picker risolve
  // allora il modello di default di QUEL provider invece del primo pronto.
  //
  // Sopra questo gradino c'è il default dell'app, e NON si passa da qui: il
  // picker e il SessionConfigPopover sono già abbonati allo stesso snapshot e
  // `resolveEffectiveProvider` ripiega da sé sulla riga con `isDefault`, che è
  // lo stesso valore di `snapshot.defaultProvider`. Passarlo come prop sarebbe
  // la stessa informazione presa due volte, al prezzo di un abbonamento allo
  // snapshot dentro ChatPane — che si ridisegnerebbe a ogni push (lo stato
  // della fast mode ne manda uno a ogni inizio e fine turno).
  const defaultProviderLabel = topic.provider ?? undefined;
  // MSEL-06: with no runtime pinned the server judges the route on the
  // topic's model (`/model`), so the chip and the band are given it too.
  const pinnedModel = topic.provider ? null : topic.model ?? null;

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
    const paths: string[] = []; const failed: string[] = [];
    for (const f of files) { try { const r = await uploadApi.uploadFile(f); paths.push(r.path); } catch (e) { console.error('[ChatPane] file upload failed:', f.name, e); failed.push(f.name); } }
    if (failed.length > 0) toast.error(`Upload failed: ${failed.join(', ')}`);
    return paths;
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
  }, [topic.id, topic.name, sendMessage, loadHistory, tr]);
  const handleFork = useCallback(() => { void forkHere(); }, [forkHere]);
  // Openclaw and the ACP agents keep their conversation outside Topics; no pinned provider = the server decides.
  const canFork = !isGlobalOrchestrator && (!topic.provider || forkModeFor(topic.provider) !== null);

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

  const handleSlashCommand = useCallback(async (text: string): Promise<boolean> => {
    const cmd = text.toLowerCase().trim();
    if (isGlobalOrchestrator && cmd.startsWith('/')) {
      setCommandResult({ type: 'error', message: tr('chat.orchestrator.slashBlocked') });
      return true;
    }
    // The provider the topic DECLARES (CMD-08), the same one the menu is
    // filtered by (`ChatInput`): the refusals and the /new alias below are
    // Claude Code's, and other providers run those names themselves.
    const declared = topic.provider || getProvidersSnapshotState().snapshot?.providers.find((p) => p.isDefault)?.name || null;
    if (cmd === '/status' || cmd.startsWith('/status ')) { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); setCommandResult({ type: 'success', message: r.output || 'Status retrieved' }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    // `/context` opens the inspector the ring opens. It used to print the
    // envelope's own estimate in a banner while the ring, one row below, read
    // the model's real count: two answers to one question, the banner the
    // wrong one.
    // A draft has no ring and no inspector yet: say so instead of nothing.
    if (cmd === '/context') { if (isDraftTopicId(topic.id)) { setCommandResult({ type: 'success', message: tr('chat.context.draft') }); return true; } setCommandResult(null); composerControlsRef.current?.openContext(); return true; }
    // `/new` and `/reset` are Claude Code's own aliases of `/clear`: forwarded,
    // the live process forgot while the screen kept the history and Topics
    // kept the old session id for the next `--resume`. On openclaw they are
    // the gateway's own reset and travel as typed (`isClearCommand`).
    if (isClearCommand(cmd, declared)) { if (!await confirm({ title: tr('chat.clear.title'), body: tr('chat.clear.body'), confirmLabel: tr('chat.clear.confirm') })) return true; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); setCommandResult({ type: 'success', message: tr('chat.clear.done') }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    // The typed level travels (`/reasoning off`); bare, the gateway toggles.
    if (cmd === '/reasoning' || cmd.startsWith('/reasoning ')) { const level = text.trim().slice('/reasoning'.length).trim() || undefined; setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey, level); setCommandResult({ type: 'success', message: r.message || tr('chat.command.reasoningToggled') }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/help' || cmd.startsWith('/help ')) { setCommandResult({ type: 'success', message: slashCommandsHelp(tr, declared).join('\n'), stays: true }); return true; }
    if (cmd === '/fork' || cmd.startsWith('/fork ')) { await forkHere(text.trim().slice('/fork'.length)); return true; }

    // `/rewind` is answered here rather than forwarded, because forwarding it
    // does NOTHING and says nothing about it.
    //
    // The CLI marks the command `supportsNonInteractive: false` in its own
    // registry: it is a TUI screen, and Topics runs the CLI with `--print`. But
    // `rewind` is in the server's `CLI_BUILTINS` allowlist, so the message was
    // being delivered faithfully to a process that discards it. No error, no
    // log — you type `/rewind`, nothing happens, and there is nothing to read
    // about why.
    //
    // Now it does the thing: it restores the automatic checkpoint taken before
    // the last turn (`server/services/turn-checkpoints.ts`).
    //
    // WHAT IT SAYS, and why every line of it is there. It reports the file
    // counts, it names the branch HEAD is still on — because the old manual
    // rollback used to leave the repository detached and say nothing — and it
    // states outright that the CONVERSATION did not move. That last line is not
    // filler: "your files are back" and "the chat is back" are two different
    // promises, Topics only keeps the first, and a user who assumes the second
    // discovers the mismatch later, at the worst possible moment.
    if (cmd === '/rewind' || cmd.startsWith('/rewind ') || cmd === '/checkpoint') {
      setCommandLoading(true);
      try {
        const r = await restoreLastTurnCheckpoint(topic.id);
        const when = r.checkpoint.createdAt ? new Date(r.checkpoint.createdAt).toLocaleTimeString() : '';
        setCommandResult({
          type: 'success',
          stays: true,
          message: [
            `Albero ripristinato al checkpoint «${r.checkpoint.label}»${when ? ` (${when})` : ''}.`,
            `${r.restored} file rimessi a posto, ${r.removed} creati dal turno rimossi.`,
            r.branch ? `HEAD è ancora su ${r.branch}: nessun detached HEAD.` : 'Attenzione: HEAD era già staccato prima del ripristino.',
            'La CONVERSAZIONE non è tornata indietro: sono i file a essere tornati com\'erano. Per tagliare anche la chat, usa la striscia dei checkpoint sopra il composer.',
          ].join('\n'),
        });
      } catch (e) {
        // A refusal names its blocker in the user's language; the route's own
        // «no project folder» answer says that; anything else (a 500, the
        // network) is said as it is (`rewindFailureText`).
        setCommandResult({
          type: 'error',
          message: rewindFailureText({
            blockedBy: e instanceof RestoreRefusedError ? e.blockedBy : undefined,
            code: apiErrorCode(e),
            message: errMessage(e),
          }, tr),
        });
      } finally {
        setCommandLoading(false);
      }
      return true;
    }

    // /compact — la compattazione ha un ESITO preciso, quindi merita una UI, non
    // uno spinner generico.
    //
    // Il lavoro lo fa la CLI (`/compact` e' un suo comando) e l'esito ha gia' la
    // sua rappresentazione: il divider «context compacted» con i token prima e
    // dopo, che arriva via `stream:compaction` e vive in `currentMarkers`. Quello
    // che mancava era il MEZZO: mandare il comando come un normale messaggio di
    // chat lo faceva sembrare un turno bloccato — l'utente vedeva «stream lento,
    // il provider e' ancora connesso», che e' l'indicatore d'attesa generico e
    // non dice niente di cosa stia succedendo. Segnalato dal vivo il 2026-08-02.
    //
    // Qui il comando viene INTERCETTATO: si dichiara subito cosa sta succedendo
    // e quanto puo' durare, si manda il testo alla CLI perche' faccia il lavoro,
    // e si lascia che sia il divider a raccontare il risultato. Non intercettarlo
    // e basta non funzionerebbe: senza `sendMessage` la CLI non compatta.
    if (cmd === '/compact') {
      const markersBefore = getCompactionMarkers?.(topic.sessionKey)?.length ?? 0;
      setCommandResult({
        type: 'success',
        stays: true,
        message: tr('chat.compact.running'),
      });
      void sendMessage(topic.sessionKey, '/compact').catch(() => {
        setCommandResult({ type: 'error', message: tr('chat.compact.failed') });
      });
      // Il marcatore arriva in modo asincrono (stream:compaction). Si aspetta il
      // suo incremento invece di dire «fatto» a caso: cosi' il banner riporta
      // l'esito VERO: il marcatore, oppure la fine del turno senza marcatore.
      compactWatchRef.current = { before: markersBefore, messagesBefore: currentMessages.length, sawIdle: !currentStreaming, sawTurn: false };
      return true;
    }

    // 3.4 — /goal: l'obiettivo della conversazione. Intercettato QUI, prima del
    // modello: è stato della topic, non un messaggio, e mandarlo all'agente
    // vorrebbe dire farglielo riscrivere in una forma che nessuno rilegge.
    if (cmd === '/goal' || cmd.startsWith('/goal ')) {
      const rest = text.slice('/goal'.length).trim();
      try {
        if (!rest) {
          setCommandResult(goal
            ? { type: 'success', message: tr('chat.goal.current', { goal: goal.content }) }
            : { type: 'error', message: tr('chat.goal.usage') });
          return true;
        }
        // allow-italian: 'fatto' is typed BY the user; the word is the input, not a label
        if (rest === 'fatto' || rest === 'done') {
          if (!goal) { setCommandResult({ type: 'error', message: tr('chat.goal.none') }); return true; }
          await closeGoal('achieved');
          setCommandResult({ type: 'success', message: tr('chat.goal.achieved', { goal: goal.content }) });
          return true;
        }
        if (rest === 'basta' || rest === 'stop') {
          if (!goal) { setCommandResult({ type: 'error', message: tr('chat.goal.none') }); return true; }
          await closeGoal('abandoned');
          setCommandResult({ type: 'success', message: tr('chat.goal.abandoned', { goal: goal.content }) });
          return true;
        }
        await declareGoal(rest);
        // No confirmation banner here: the bar above the composer and the
        // prompt itself already say it, a third copy in green monospace was
        // noise over the start of the turn.
        setCommandResult(null);
        // AND THE GOAL IS SENT, like Claude Code's `/goal`: declaring it is
        // asking for it. Only saving it left the chat idle until the person
        // wrote the same thing again as a message (23/09). The text goes as a
        // normal turn: the goal is already in the envelope of that turn
        // (`goalContextContent`), and the loop takes over from its end.
        void sendMessageRef.current?.(rest);
      } catch (e) {
        setCommandResult({ type: 'error', message: errMessage(e) });
      }
      return true;
    }
    // Bare `/model` and `/effort` open the controls that already do this,
    // one row below the field. Forwarded, `/model` printed the CLI's English
    // usage with its own aliases, and `/effort` a red «Uso: /effort <…>».
    if (cmd === '/model') { setCommandResult(null); composerControlsRef.current?.openModel(); return true; }
    if (cmd.startsWith('/model ')) { const m = text.slice(7).trim(); if (!m) return false; setCommandLoading(true); try { const r = await commandApi.setModel(topic.sessionKey, m); setCommandResult({ type: 'success', message: r.pending ? tr('chat.command.modelSet', { model: m }) : r.message || `Model set to: ${m}` }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/effort') { setCommandResult(null); composerControlsRef.current?.openEffort(); return true; }
    // Bare `/mcp`, `/config` (with its alias `/settings`) and `/usage` (with
    // `/cost` and `/stats`) open where Topics keeps those things now
    // (SETHOME-01), on Claude Code only: with arguments, or on a provider with
    // its own commands under these names, they travel as typed
    // (`topicsHomeCommand`).
    const home = topicsHomeCommand(cmd, declared);
    if (home === 'tools') { setCommandResult(null); composerControlsRef.current?.openTools(); return true; }
    if (home === 'providers') { setCommandResult(null); composerControlsRef.current?.openProviders(); return true; }
    if (home === 'userMenu') { setCommandResult(null); openUserMenu(); return true; }
    if (cmd.startsWith('/effort ')) { const tier = text.slice(8).trim().toLowerCase(); if (!tier) return false; setCommandLoading(true); try { const r = await commandApi.setEffort(topic.sessionKey, tier); setCommandResult({ type: 'success', message: r.pending ? tr('chat.command.effortSet', { level: tier }) : r.message || `Effort set to: ${tier}` }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }

    // /project — info / create <name> / open <path-or-name>. The route answers
    // with a code and data, the sentence is written here in the reader's
    // language (it used to be the server's English, with emoji).
    if (cmd === '/project' || cmd.startsWith('/project ')) {
      const rest = text.trim().slice('/project'.length).trim();
      let sub: 'create' | 'open' | 'info' = 'info';
      let value = '';
      if (rest.startsWith('create ')) { sub = 'create'; value = rest.slice(7).trim(); }
      else if (rest === 'create') { setCommandResult({ type: 'error', message: tr('chat.project.usageCreate') }); return true; }
      else if (rest.startsWith('open ')) { sub = 'open'; value = rest.slice(5).trim(); }
      else if (rest === 'open') { setCommandResult({ type: 'error', message: tr('chat.project.usageOpen') }); return true; }
      setCommandLoading(true);
      try {
        const r = await commandApi.project(topic.sessionKey, sub, value || undefined);
        const info = projectInfoLines(r, tr);
        setCommandResult({ type: 'success', message: info.join('\n'), stays: info.length > 1 });
      } catch (e) {
        const key = PROJECT_ERROR_KEY[apiErrorCode(e) ?? ''];
        setCommandResult({ type: 'error', message: key ? tr(key, { value }) : errMessage(e) });
      } finally { setCommandLoading(false); }
      return true;
    }

    // Phase 30 BROWSER-CHAT-04 — /browser <url> opens or focuses the topic's
    // browser pane and navigates. Intercepted BEFORE LLM dispatch.
    // Bare, it is what picking the menu row sends (`/browser ` trimmed): it
    // used to miss this branch and reach the model with the context preamble.
    if (cmd === '/browser') { setCommandResult({ type: 'error', message: tr('chat.browser.usage') }); return true; }
    if (cmd.startsWith('/browser ')) {
      const url = text.trim().slice('/browser '.length).trim();
      // Normalize: prepend https:// when no protocol given.
      const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`;
      // Loosely-coupled signal: layout layer listens for browser:open-and-navigate
      // and ensureBrowserPane + navigates. Mirrors the existing browser:navigate
      // CustomEvent pattern used by server-driven detection.
      // `source` is what tells this apart from the OTHER producer of the same
      // event (the task drawer): only the command typed in the composer is an
      // explicit request to LOOK, so only it opens the topic's window expanded.
      // See the handler in `usePaneOrdering` (effect 8b).
      window.dispatchEvent(new CustomEvent('browser:open-and-navigate', {
        detail: { topicId: topic.id, url: normalized, source: 'slash-command' },
      }));
      setCommandResult({ type: 'success', message: tr('chat.command.openingBrowser', { url: normalized }) });
      return true;
    }

    // Phase 30 BROWSER-CHAT-04 — @browser <prompt> is a user-side mnemonic.
    // No special parsing: the message flows to the LLM normally, and since
    // browserTools are registered for SDK providers (claude/openai), the model
    // sees them and decides when to call. Returning false lets sendMessage
    // dispatch the original text to the chat pipeline.

    // The Claude Code commands that cannot run where Topics runs the CLI
    // (CMD-06): answered here, saying what to use in Topics instead
    // (`cliRefused.ts`). They used to reach the CLI, which can only answer
    // «/X isn't available in this environment.», in English, as the agent.
    const refusedCli = cliRefusedCommand(text, declared);
    if (refusedCli) {
      // An empty chat has nothing to download: the sentence must not say it started.
      const exportsNothing = refusedCli.answer.action === 'export' && currentMessages.length === 0;
      if (refusedCli.answer.action === 'export' && !exportsNothing) handleExportConversation();
      setCommandResult({ type: 'success', stays: true, message: tr(exportsNothing ? 'chat.cliRefused.exportEmpty' : refusedCli.answer.key, { name: refusedCli.name, reopen: shortcut('T', { shift: true }), palette: shortcut('K'), close: shortcut('W') }) });
      return true;
    }

    return false;
  }, [topic.sessionKey, topic.id, topic.provider, isGlobalOrchestrator, loadHistory, goal, declareGoal, closeGoal, confirm, sendMessage, getCompactionMarkers, tr, forkHere, currentMessages, currentStreaming, handleExportConversation]);

  // Toggle Fast Mode. Updates: (1) local state for immediate UI feedback,
  // (2) localStorage for cold-boot hydration, (3) server via PUT so other
  // windows of the same topic sync via the `topic:updated` WS broadcast.
  // The PUT is fire-and-forget — UI doesn't wait. If it fails, the next
  // topic hydration corrects the divergence (see the reconciliation effect
  // above keyed on `topic.fastMode`).
  const toggleFastMode = useCallback(() => {
    // Side effects MUST live outside the setState callback — in React 18
    // Strict Mode the updater is invoked twice during development, which
    // would double-fire `onUpdateTopic` and double-write localStorage. The
    // setter itself is dedupe-safe (Object.is), but the side effects aren't.
    const next = !fastModeRef.current;
    setFastMode(next);
    fastModeRef.current = next;
    try { localStorage.setItem(`fastMode:${topic.id}`, String(next)); } catch {}
    // Draft topics aren't persisted yet — skip the PUT (would 404). Local
    // state is sufficient until the draft is promoted; the promotion effect
    // above migrates the bit to the new real topic id once it exists.
    if (!topic.id.startsWith('draft:')) {
      void onUpdateTopic(topic.id, { fastMode: next });
    }
  }, [topic.id, onUpdateTopic]);

  /**
   * La decisione presa sul piano che il turno ha proposto senza poterlo
   * consegnare (plan mode senza `ExitPlanMode` — vedi server/lib/plan-approval.ts).
   *
   * Approvare ALZA l'autonomia della chat ad `auto-apply`, e resta lì. Non è
   * una scorciatoia: `--permission-mode` è un flag di SPAWN, quindi ogni
   * cambio fa ripartire la sessione CLI. Concederlo «solo per questo turno»
   * vorrebbe dire due respawn per ogni approvazione e una corsa con te se nel
   * frattempo tocchi il selettore — mentre così il cambio è UNO, visibile nel
   * selettore, e reversibile quando vuoi. L'opzione lo dice a chiare lettere
   * prima che tu la scelga.
   */
  // Il piano che aspetta una risposta, se c'è: alimenta la barra sopra il
  // composer. Stessa lettura del pannello inline (`findPendingAsk`), così le
  // due superfici non possono dire cose diverse — più il ripiego sul piano
  // scritto solo in prosa, che di riga a cui appendersi non ne ha
  // (`findPendingPlan`). In entrambi i casi la scelta è la stessa e fa la
  // stessa cosa.
  const pendingPlan = useMemo(
    () => findPendingPlan({
      messages: currentMessages,
      autonomy,
      busy: currentStreaming || currentLoading,
    }),
    [currentMessages, autonomy, currentStreaming, currentLoading],
  );
  const [planBusy, setPlanBusy] = useState(false);

  const handlePlanDecision = useCallback(async (approved: boolean, editedPlan?: string) => {
    if (!approved) {
      sendMessage(topic.sessionKey, 'Piano rifiutato. Proponi un\'altra strada, sempre senza toccare niente.');
      return;
    }
    try {
      await topicsApi.update(topic.id, { autonomyLevel: 'auto-apply' });
      // Il selettore deve mostrare il livello VERO subito: approvare un piano
      // alza l'autonomia e ci resta, e leggerlo dal `topic` significherebbe
      // aspettare il giro di broadcast.
      setAutonomy('auto-apply');
    } catch {
      // Se l'autonomia non si è alzata, mandare il messaggio farebbe ripartire
      // il turno nella stessa trappola: meglio dirlo e non fingere.
      toast.error('Non sono riuscito ad alzare l\'autonomia: il piano non parte.');
      return;
    }
    // A plan corrected by hand goes out instead of the one the model wrote,
    // and the message says it REPLACES it: the session that resumes still
    // holds its own (`planApprovalMessage`).
    sendMessage(topic.sessionKey, planApprovalMessage(editedPlan));
  }, [sendMessage, topic.sessionKey, topic.id, toast]);

  /** La scelta presa dalla barra sopra il composer: registra la risposta —
   *  così il pannello inline si chiude e la riga smette di aspettare — e poi
   *  fa quello che fa il pannello. Una strada sola per due superfici. */
  const handlePlanChoiceFromBar = useCallback(async (approved: boolean) => {
    if (!pendingPlan || planBusy) return;
    setPlanBusy(true);
    // The correction written in the panel counts from here too. Two surfaces
    // approving the same plan with different texts run, in silence, the
    // version nobody chose.
    const edited = pendingPlan.toolCallId
      ? readAskDraft(pendingPlan.toolCallId)?.planText?.trim() || undefined
      : undefined;
    try {
      // Un piano scritto solo in prosa non ha una riga che aspetta: non c'è
      // niente da chiudere, e postare una risposta a un tool inesistente
      // tornerebbe 404 mandando in errore una scelta che è invece valida.
      if (pendingPlan.toolCallId) {
        await chatApi.toolResponse(topic.sessionKey, pendingPlan.toolCallId, {
          kind: 'questions',
          answers: { [PLAN_APPROVAL_QUESTION]: approved ? PLAN_APPROVE_LABEL : PLAN_REJECT_LABEL },
          ...(edited ? { metadata: { [PLAN_EDIT_KEY]: edited } } : {}),
          submittedAt: new Date().toISOString(),
        });
        // This branch never goes through `submitAndForget`, which is where
        // the draft is cleared: without this the correction would sit there
        // for seven days under a question already answered (ASK-07).
        clearAskDraft(pendingPlan.toolCallId);
      }
      await handlePlanDecision(approved, edited);
    } catch {
      toast.error('Non sono riuscito a registrare la scelta. Riprova.');
    } finally {
      setPlanBusy(false);
    }
  }, [pendingPlan, planBusy, topic.sessionKey, handlePlanDecision, toast]);

  /** Cambia quanto può fare da sé questa chat. La PATCH forza il respawn della
   *  sessione CLI (`--permission-mode` è un flag di spawn), quindi la scelta
   *  vale dal turno successivo — è il server a occuparsene. */
  const handleAutonomyChange = useCallback(async (level: import('../../types').AutonomyLevel) => {
    setAutonomy(level);
    // Remembered as the last choice of ANY chat, same scheme as
    // provider/model and effort, so a new chat inherits it instead of always
    // starting from the app default.
    rememberAutonomySelection(safeStore(), level);
    if (isDraftTopic) {
      // Nessuna riga sul server da PATCHare: la bozza esiste solo qui. Si
      // persiste device-locale come provider/model, Fast Mode ed effort, e
      // l'effetto di promozione qui sopra la porta sul topic vero.
      try { localStorage.setItem(autonomyKey(topic.id), level); } catch { /* storage negato */ }
      return;
    }
    try {
      await topicsApi.update(topic.id, { autonomyLevel: level });
    } catch {
      // Il locale torna indietro: lasciarlo avanti mostrerebbe un livello che
      // il prossimo turno non userà.
      setAutonomy(topic.autonomyLevel ?? null);
      toast.error('Non sono riuscito a cambiare l\'autonomia.');
    }
  }, [isDraftTopic, topic.id, topic.autonomyLevel, toast]);

  // THE GOAL BAR'S ACTIONS SPEAK.
  //
  // `useGoal` does no optimistic update (a decision, see its docstring): with no
  // error on screen a refusal from the server drew the bar IDENTICAL to before,
  // which is also how a success draws it. A failed write now says so, and on the
  // rename the error is RE-THROWN towards `GoalBar`, because the edit field
  // stays open only if it sees the rejection.
  const handleGoalClose = useCallback(async (status: 'achieved' | 'abandoned') => {
    try {
      await closeGoal(status);
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.closeFailed'));
    }
  }, [closeGoal, toast, tr]);

  const handleGoalEdit = useCallback(async (content: string) => {
    try {
      await declareGoal(content);
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.editFailed'));
      throw err;
    }
  }, [declareGoal, toast, tr]);

  const handleGoalStopLoop = useCallback(async () => {
    try {
      await stopGoalLoop();
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.actionFailed'));
    }
  }, [stopGoalLoop, toast, tr]);

  const handleGoalPromote = useCallback(async () => {
    try {
      await promoteGoal();
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.actionFailed'));
    }
  }, [promoteGoal, toast, tr]);

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...currentMessages].reverse().find(m => m.role === 'user');
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

  // Only a one-line confirmation closes by itself (see `commandResult`).
  useEffect(() => {
    if (!commandResult || commandResult.stays || commandResult.type !== 'success' || commandResult.message.includes('\n')) return;
    const t = setTimeout(() => setCommandResult(null), 5000);
    return () => clearTimeout(t);
  }, [commandResult]);
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
    }
    return Object.keys(opts).length ? opts : undefined;
  };
  sendMessageRef.current = (text: string) => sendMessage(topic.sessionKey, text, currentSendOptions());

  const handleSendMessage = async (e?: React.SubmitEvent) => {
    if (e) e.preventDefault();
    // Edit mode: submit the edit
    if (editingMessage) {
      await handleSubmitEdit();
      return;
    }
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
    if (!compactWatchRef.current) setCommandResult(null);
    // Da qui in giù si COMPONE, sempre: allegati, immagini, file citati con @ e
    // la citazione della risposta. Prima questa parte stava dopo il `return`
    // dell'accodamento, quindi un messaggio scritto mentre l'agente rispondeva
    // partiva nudo — e uno di sole immagini non partiva affatto. Chi decide se
    // spedire adesso o mettere in coda è `sendMessage` (`state/chatQueue.ts`),
    // che riceve il messaggio già completo.
    const curFiles = [...pendingFiles], curImages = [...pendingImages], curReply = replyingTo, curMentioned = [...mentionedFiles];
    setMessage(''); setPendingFiles([]); setPendingImages([]); setMentionedFiles([]); setReplyingTo(null);
    if (curFiles.length > 0 || curImages.length > 0) {
      setUploading(true);
      try {
        if (curFiles.length > 0) { const paths = await uploadFiles(curFiles); finalMessage = paths.map(p => `[Attached file: ${p}]`).join('\n') + (finalMessage ? '\n' + finalMessage : ''); }
        if (curImages.length > 0) {
          const urls: string[] = []; let imgFailCount = 0;
          for (const img of curImages) {
            try {
              const res = await apiFetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: img.dataUrl, mimeType: img.mimeType }) });
              if (res.ok) urls.push((await res.json()).url); else { imgFailCount++; console.error('[ChatPane] image upload failed:', res.status, res.statusText); }
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
      await sendMessage(topic.sessionKey, finalMessage, currentSendOptions());
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
    if (currentStreaming) await stopSession(topic.sessionKey);
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

  return (
    <div
      ref={paneRootRef}
      // Whose conversation this subtree is: `openLink` walks up from the clicked
      // anchor to find out which topic's window may claim the link.
      data-chat-topic-id={topic.id}
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
          <TopicBrowserWindow topicId={topic.id} areaRef={paneRootRef} projectPath={topic.projectPath ?? undefined} />
        </Suspense>
      )}
      {ownsBrowserWindow && hasTopicBrowserWindow(browserWindow) && browserWindow.mode === 'hidden' && (
        <TopicBrowserReopen topicId={topic.id} />
      )}
      {commandResult && (
        <div data-testid="chat-command-result" data-result-type={commandResult.type} className={`chat-measure px-3 py-2 border-b flex items-center gap-2 flex-shrink-0 transition-all ${commandResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <div className={`text-compact flex-1 whitespace-pre-wrap font-mono ${commandResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{commandResult.message}</div>
          <button aria-label={tr('chat.command.dismiss')} onClick={() => setCommandResult(null)} className="text-app-text-muted hover:text-app-text p-1">
            <X size={12} />
          </button>
        </div>
      )}
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
      <PinnedMessages show={showPinned} pinnedMessages={pinnedMessages} />
      <TaskWorkFoldContext.Provider value={foldTaskWork}>
      <ChatTopicContext.Provider value={topic.id}>
      <MessageList isMobile={isMobile} topic={topic} currentMessages={currentMessages} compactionMarkers={currentMarkers} currentLoading={currentLoading} currentStreaming={currentStreaming} copiedMsgId={copiedMsgId} fileDragOver={fileDragOver} chatContainerRef={chatContainerRef} messagesEndRef={messagesEndRef} onReply={setReplyingTo} onCopy={handleCopyMessage} onTogglePin={handleTogglePin} onFileDragOver={handleFileDragOver} onFileDragLeave={handleFileDragLeave} onFileDrop={handleFileDrop} onPlanDecision={handlePlanDecision} onRemember={isGlobalOrchestrator ? undefined : handleRememberMessage} onEdit={!isGlobalOrchestrator && editMessage ? handleEditMessage : undefined} onRegenerate={!isGlobalOrchestrator && regenerateMessage && !currentStreaming ? handleRegenerateMessage : undefined} onFork={canFork ? handleFork : undefined} onDeleteMessage={!isGlobalOrchestrator && deleteMessage && !currentStreaming ? handleDeleteMessage : undefined} onSwitchBranch={!isGlobalOrchestrator && switchBranch ? handleSwitchBranch : undefined} onMessage={onWSMessage} onRetry={handleRetry} inputAreaHeight={inputAreaHeight} composerResizeRef={composerResizeRef} composerCentered={composerCentered} bornFromDraft={bornFromDraft} initialScrollOffset={initialScrollOffset} onScrollOffsetChange={handleScrollOffsetChange} queuedTurns={messageQueue} onUpdateQueued={handleUpdateQueueItem} onRemoveQueued={handleRemoveQueueItem} onClearQueue={handleClearQueue} onSendQueueNow={handleSendQueueNow} queueBusy={currentStreaming} />
      </ChatTopicContext.Provider>
      </TaskWorkFoldContext.Provider>
      {/* The composer docks at the bottom with only its natural margin — no
          home-indicator reservation (the user wants minimal bottom space), so it
          reaches the bottom edge and the OS indicator simply overlays it. */}
      {/* `chat-measure` qui capa e CENTRA in un colpo solo tutto il blocco di
          fondo — GoalBar, TodoStrip, SubAgentsStrip, la timeline dei
          checkpoint, il composer e con lui il box della coda — sulla stessa
          colonna della lista. Con `left-0 right-0` il posizionamento è
          sovra-vincolato e lo risolvono i margini auto dell'utility, quindi il
          blocco si centra invece di allargarsi. `inputAreaHeight` continua a
          misurare giusto: il ResizeObserver legge `contentRect.height`, che è
          l'altezza, non la larghezza. */}
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
        {!isGlobalOrchestrator && <SubAgentsStrip topicSessionKey={topic.sessionKey} />}
        {aboveInputSlot}
        {!isGlobalOrchestrator && <CheckpointTimeline topicId={topic.id} onRollback={() => loadHistory(topic.sessionKey)} />}
        {/* What the agent wrote in this conversation, counted from its own
            write tool calls: silent in a chat that wrote nothing. Hidden for the
            coordinator, which by invariant has no project path and no worktree:
            its rows would have no tree to open a diff against. */}
        {!isGlobalOrchestrator && <ChangedFilesStrip key={topic.id} topic={topic} onWSMessage={onWSMessage} />}
        {/* FROZEN: the line sits IN FLOW above the composer, never over it. An
            overlaid strip would cover the one control a person can still use
            while the command is stopped, and writing in the chat is exactly
            what stays possible. */}
        {swapFreeze && <SwapFreezeLabel freeze={swapFreeze} className="mx-3 mb-1 self-start" />}
        {/* What this chat wrote and never reached the server: in flow, right
            above the composer that would send it again, never over it. */}
        <UnsentStrip sessionKey={topic.sessionKey} />
        <ChatInput autonomy={autonomy} onAutonomyChange={handleAutonomyChange} isMobile={isMobile} isFocused={isFocused} topic={topic} currentMessages={currentMessages} currentStreaming={currentStreaming} stoppedByUser={currentStoppedByUser} message={message} setMessage={setMessage} pendingFiles={pendingFiles} pendingImages={pendingImages} setPendingImages={setPendingImages} uploading={isUploading} replyingTo={replyingTo} setReplyingTo={setReplyingTo} isRecording={isRecording} recordingTime={recordingTime} fileInputRef={fileInputRef} textareaRef={textareaRef} onSubmit={handleSendMessage} onStop={() => { void stopSession(topic.sessionKey); }} onKeyDown={handleKeyDown} onFileSelect={handleFileSelect} removePendingFile={removePendingFile} onPaste={handlePaste} startRecording={startRecording} stopRecording={stopRecording} formatRecordingTime={formatRecordingTime} isImageFile={isImageFile} chatError={chatError[topic.sessionKey] ?? null} sendMessageDirect={async (c: string) => {
          // Passa dall'imbuto degli slash: il bottone «Compact now» e
          // l'azione dell'anello mandavano `/compact` come messaggio nudo,
          // quindi non vedevano il banner di stato ne' l'esito. Ora le tre
          // strade (comando digitato, bottone, anello) fanno la stessa cosa.
          if (c.startsWith('/') && (await handleSlashCommand(c))) return true;
          return sendMessage(topic.sessionKey, c);
        }} othersTyping={othersTyping} othersTypingText={othersTypingText} mentionedFiles={mentionedFiles} setMentionedFiles={setMentionedFiles} fastMode={fastMode} onToggleFastMode={toggleFastMode} editingMessage={editingMessage} onCancelEdit={handleCancelEdit} onExportConversation={currentMessages.length > 0 ? handleExportConversation : undefined} providerOverride={providerOverride} onProviderOverrideChange={handleProviderOverrideChange} topicsRouting={topicsRouting} onTopicsRoutingChange={handleTopicsRoutingChange} effort={effort} onEffortChange={handleEffortChange} defaultProviderLabel={defaultProviderLabel} pinnedModel={pinnedModel} onUpdateTopic={onUpdateTopic} onMessage={onWSMessage} controlsRef={composerControlsRef} />
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

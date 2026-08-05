import { useState, useEffect, useRef, useCallback, useId, useMemo, lazy, Suspense } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { X, Paperclip, Mic, MicOff, Volume2, VolumeX, Send, Square, MessageSquare, Phone, PhoneOff, MoreHorizontal, ClipboardList, Zap, Trash2, Cpu, Brain, HelpCircle, Users, Pause, Play, UserPlus, FolderOpen, Globe, Download, Gauge, Target, ChevronsDownUp } from 'lucide-react';
import { decideComposerAction } from './composerAction';
import { canAnswerWithText, findPendingAsk } from '../../state/pendingAsk';
import type { Topic, ChatMessage, UpdateTopicRequest, WSMessage } from '../../types';
import { ImageThumbnail } from '../MessageContent';
import { useSpeechToText, useTextToSpeech, useVoiceCall } from '../../hooks/useSpeech';
import { FileMentionMenu, FilePill, type MentionedFile } from './FileMentionMenu';
import { ContextPills } from './ContextPills';
import { useContextFileTokens } from './useContextFileTokens';
import { basename } from '../../lib/path-utils';
import { topicsApi, uploadApi, slashCommandsApi, type CustomSlashCommand } from '../../lib/api';
import { SessionConfigPopover } from './SessionConfigPopover';
import { ProviderModelPicker } from './ProviderModelPicker';
import { ContextRing } from '../Shared/ContextRing';
import { useContextInspector } from '../../hooks/useContextInspector';
import { useRealContext, formatTokens } from '../../hooks/useRealContext';
import { POPOVER_PANEL, POPOVER_SHEET, Z_POPOVER, Z_POPOVER_SCRIM } from '@/lib/popoverStyles';
import { useDismissable } from '@/hooks/useDismissable';
import { chatFocus } from '../../state/chatFocus';
import { Menu } from '../Shared/Menu';
import { SpinnerFallback } from '../Shared/Spinner';

// Lazily loaded — the inspector pulls in memory/openclaw hooks; keep it out of
// the composer's initial bundle and only fetch it the first time the popover opens.
const ContextInspector = lazy(() => import('../Context/ContextInspector').then(m => ({ default: m.ContextInspector })));

// Available slash commands
const SLASH_COMMANDS = [
  { cmd: '/status', label: 'Status', description: 'Show session status', icon: Zap },
  { cmd: '/context', label: 'Context', description: 'Show context-window usage (tokens, budget, sources)', icon: Gauge },
  // La compattazione esisteva già e l'app ne disegna anche l'esito (i divider
  // «context compacted», partitionMarkers.ts), ma l'UNICO modo di lanciarla era
  // il bottone «Compact now» dentro l'avviso del contesto — che compare solo
  // sopra soglia e sparisce appena lo si chiude. Non c'era nessun modo
  // permanente di chiederla, e in `/help` non era nemmeno nominata.
  //
  // Non serve un gestore lato client: `handleSlashCommand` non lo intercetta,
  // quindi il messaggio passa dritto alla CLI, che `/compact` lo conosce da sé.
  // È esattamente quello che fa il bottone (`sendMessageDirect('/compact')`).
  // Mettendolo qui diventa una voce di prima classe in tutte e due le
  // superfici che questo elenco alimenta: l'autocompletamento con `/` e il
  // menu overflow, che è sempre raggiungibile.
  { cmd: '/compact', label: 'Compact', description: 'Compatta il contesto ora (riassume la storia e libera spazio)', icon: ChevronsDownUp },
  { cmd: '/clear', label: 'Clear', description: 'Clear conversation', icon: Trash2 },
  { cmd: '/model', label: 'Model', description: 'Change model (e.g. /model claude-opus-5[1m])', icon: Cpu },
  { cmd: '/effort', label: 'Effort', description: 'Set reasoning effort (low|medium|high|xhigh|max)', icon: Brain },
  { cmd: '/reasoning', label: 'Reasoning', description: 'Toggle reasoning (openclaw) / → /effort on claude-code', icon: Brain },
  { cmd: '/agents', label: 'Agents', description: 'List agent profiles', icon: Users },
  { cmd: '/pause', label: 'Pause', description: 'Pause agent (@name)', icon: Pause },
  { cmd: '/resume', label: 'Resume', description: 'Resume agent (@name)', icon: Play },
  { cmd: '/assign', label: 'Assign', description: 'Assign task (@name task)', icon: UserPlus },
  { cmd: '/project', label: 'Project', description: 'Create or open a project', icon: FolderOpen },
  { cmd: '/browser', label: 'Browser', description: 'Open browser tab and navigate (e.g. /browser https://example.com)', icon: Globe },
  { cmd: '/goal', label: 'Goal', description: "Obiettivo della chat: /goal <testo> · /goal fatto · /goal basta", icon: Target },
  { cmd: '/help', label: 'Help', description: 'Show available commands', icon: HelpCircle },
];

// ---- Overflow Menu (slash commands + voice tools) ----

function OverflowMenu({
  isCallActive, isRecording, isListening, isSpeaking, autoTTS,
  voiceCallSupported, sttSupported, currentStreaming, uploading,
  toggleCall, startRecording: _startRecording, stopRecording: _stopRecording, toggleListening, stopSpeaking, setAutoTTS,
  onSlashCommand,
  onExport,
}: {
  isCallActive: boolean; isRecording: boolean; isListening: boolean; isSpeaking: boolean; autoTTS: boolean;
  voiceCallSupported: boolean; sttSupported: boolean; currentStreaming: boolean; uploading: boolean;
  toggleCall: () => void; startRecording: () => void; stopRecording: () => void;
  toggleListening: () => void; stopSpeaking: () => void; setAutoTTS: React.Dispatch<React.SetStateAction<boolean>>;
  onSlashCommand: (cmd: string) => void;
  /** Export the conversation as a Markdown download (absent → row hidden). */
  onExport?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const anyActive = isCallActive || isRecording || isListening || isSpeaking || autoTTS;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
          anyActive
            ? 'text-primary bg-primary/10'
            : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
        }`}
        title="Tools & commands"
        aria-label="Tools & commands"
      >
        <MoreHorizontal size={16} />
      </button>
      {/* Migrated to the canonical Menu primitive (flip-above + clamp +
          reposition + dismiss are inherited for free; align="right" matches
          the old right-0 anchoring). restoreFocus=false preserves the
          pre-migration behavior of not stealing focus back on dismiss. */}
      <Menu open={open} anchorRef={triggerRef} onClose={() => setOpen(false)} align="right" minWidth={220} restoreFocus={false}>
        {/* Slash commands */}
        {SLASH_COMMANDS.map((cmd) => {
          const Icon = cmd.icon;
          return (
            <button
              key={cmd.cmd}
              type="button"
              onClick={() => { onSlashCommand(cmd.cmd); setOpen(false); }}
              className="w-full px-3 py-1.5 text-left grid grid-cols-[14px_auto_1fr] gap-x-2.5 items-baseline text-[12px] transition-colors hover:bg-app-hover text-app-text"
            >
              <Icon size={14} className="text-app-text-muted" />
              <span className="font-mono text-primary text-[11px] whitespace-nowrap">{cmd.cmd}</span>
              <span className="text-[11px] text-app-text-muted text-right truncate">{cmd.description}</span>
            </button>
          );
        })}

        {/* Divider */}
        <div className="h-px bg-app-border my-1" />

        {/* Voice tools */}
        {voiceCallSupported && (
          <button
            type="button"
            onClick={() => { toggleCall(); setOpen(false); }}
            className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
              isCallActive ? 'text-red-500' : 'text-app-text'
            }`}
            disabled={uploading}
          >
            {isCallActive ? <PhoneOff size={14} /> : <Phone size={14} />}
            {isCallActive ? 'End call' : 'Voice call'}
            <span className="ml-auto text-[11px] text-app-text-muted">⌘⇧C</span>
          </button>
        )}
        {sttSupported && !isCallActive && (
          <button
            type="button"
            onClick={() => { toggleListening(); setOpen(false); }}
            className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
              isListening ? 'text-green-500' : 'text-app-text'
            }`}
            disabled={currentStreaming || uploading}
          >
            {isListening ? <MicOff size={14} /> : <MessageSquare size={14} />}
            {isListening ? 'Stop dictation' : 'Dictation mode'}
            <span className="ml-auto text-[11px] text-app-text-muted">⌘⇧D</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (isSpeaking) stopSpeaking(); else setAutoTTS(prev => !prev);
            setOpen(false);
          }}
          className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
            isSpeaking || autoTTS ? 'text-blue-500' : 'text-app-text'
          }`}
        >
          {isSpeaking || autoTTS ? <Volume2 size={14} /> : <VolumeX size={14} />}
          {isSpeaking ? 'Stop speaking' : autoTTS ? 'Auto-TTS (ON)' : 'Auto-TTS'}
          <span className="ml-auto text-[11px] text-app-text-muted">⌘⇧S</span>
        </button>
        {onExport && (
          <>
            <div className="h-px bg-app-border my-1" />
            <button
              type="button"
              onClick={() => { onExport(); setOpen(false); }}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover text-app-text"
              data-testid="chat-export-conversation"
            >
              <Download size={14} />
              Export conversation
              <span className="ml-auto text-[11px] text-app-text-muted">.md</span>
            </button>
          </>
        )}
      </Menu>
    </>
  );
}

// ---- Message Queue Badge (clickable popover) ----
//
// The queue is a `string[]` owned by the parent ChatPane (mirrored to
// localStorage). This component just renders the badge + popover; mutations
// flow back through the callbacks so the parent keeps a single source of
// truth and the auto-dispatch effect on `messageQueue` keeps firing on
// stream:end. Each row is a small auto-resizing textarea so users can edit
// the queued prompt before it ships, plus an X to drop it. Outside-click
// closes the popover (mirrors OverflowMenu).

function MessageQueueBadge({
  queue,
  onUpdateItem,
  onRemoveItem,
  onClear,
}: {
  queue: string[];
  onUpdateItem: (index: number, content: string) => void;
  onRemoveItem: (index: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const count = queue.length;

  // Close the popover when the queue empties (last message dispatched while
  // open). Without this the panel lingers as an empty box until clicked away.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded converging close: only runs when the queue is empty AND the popover is open, sets open=false once and then the guard prevents re-firing
    if (count === 0 && open) setOpen(false);
  }, [count, open]);

  // Unified dismissal: capture-phase outside-pointer + Escape close. The
  // wrapper holds BOTH the toggle badge and the popover panel, so clicks on
  // either stay "inside" and don't self-dismiss.
  useDismissable({
    open,
    onClose: () => setOpen(false),
    refs: [popoverRef],
  });

  return (
    <div className="relative px-3 pb-1.5" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        data-testid="message-queue-badge"
        className="text-[11px] text-orange-500 hover:text-orange-600 flex items-center gap-1.5 transition-colors"
        title={open ? 'Hide queued messages' : 'Show queued messages'}
        aria-expanded={open}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
        ({count} message{count > 1 ? 's' : ''} queued)
        <span className="text-app-text-muted">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className={`absolute bottom-full left-3 right-3 mb-1 ${POPOVER_PANEL} max-h-[60vh] overflow-y-auto`} style={{ zIndex: Z_POPOVER }}>
          <div className="sticky top-0 bg-surface dark:bg-app-panel border-b border-app-border px-3 py-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-app-text">
              Queued message{count > 1 ? 's' : ''} ({count})
            </span>
            <button
              type="button"
              onClick={() => { onClear(); setOpen(false); }}
              className="text-[11px] text-app-text-muted hover:text-red-500 transition-colors"
              title="Clear all queued messages"
            >
              Clear all
            </button>
          </div>
          <ul className="py-1.5">
            {queue.map((content, idx) => (
              <QueuedRow
                key={idx}
                index={idx}
                content={content}
                onChange={(next) => onUpdateItem(idx, next)}
                onRemove={() => onRemoveItem(idx)}
              />
            ))}
          </ul>
          {/* La riga di prima diceva «Sent automatically when the current
              response finishes», e dal 30/07 non è più tutta la verità: lo stop
              TIENE la coda invece di farla partire (vedi `state/chatQueue.ts`).
              Dirlo qui evita che «ferma» sembri «cancella». */}
          <div className="px-3 pb-2 pt-1 text-[11px] text-app-text-muted">
            Sent when the current turn ends. Stop keeps them here.
          </div>
        </div>
      )}
    </div>
  );
}

function QueuedRow({
  index,
  content,
  onChange,
  onRemove,
}: {
  index: number;
  content: string;
  onChange: (next: string) => void;
  onRemove: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow textarea so multi-line queued prompts are visible without scroll.
  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, []);
  useEffect(() => { resize(); }, [content, resize]);

  return (
    <li data-testid="queued-message" className="px-3 py-1.5 grid grid-cols-[20px_1fr_auto] gap-2 items-start group">
      <span className="text-[11px] font-mono text-app-text-muted pt-1.5 select-none">{index + 1}.</span>
      <textarea
        ref={taRef}
        value={content}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        className="resize-none w-full text-[12px] leading-snug px-2 py-1 rounded-md bg-app-hover/40 border border-transparent focus:border-app-border-input focus:bg-surface focus:outline-none text-app-text"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={onRemove}
        className="w-6 h-6 mt-0.5 flex items-center justify-center rounded-md text-app-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors opacity-60 group-hover:opacity-100"
        title="Remove from queue"
        aria-label={`Remove queued message ${index + 1}`}
      >
        <X size={12} />
      </button>
    </li>
  );
}

// ---- ChatInput ----

interface ChatInputProps {
  isMobile: boolean;
  /**
   * True only for the pane that owns the keyboard. The voice chords below are
   * `window`-level, and every open chat pane mounts a ChatInput — ungated, one
   * ⌘⇧R started a recording in EVERY pane at once (N mic streams, N voice
   * notes). Same gate as ChatPane's ⌘U handler.
   */
  isFocused: boolean;
  topic: Topic;
  currentMessages: ChatMessage[];
  currentStreaming: boolean;
  /** Il turno l'ha fermato l'umano (e non ne è ripartito un altro). */
  stoppedByUser?: boolean;
  message: string;
  setMessage: (v: string) => void;
  pendingFiles: File[];
  pendingImages: { dataUrl: string; mimeType: string }[];
  setPendingImages: React.Dispatch<React.SetStateAction<{ dataUrl: string; mimeType: string }[]>>;
  uploading: boolean;
  replyingTo: ChatMessage | null;
  setReplyingTo: (v: ChatMessage | null) => void;
  isRecording: boolean;
  recordingTime: number;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (e?: React.SubmitEvent) => void;
  /**
   * Abort the in-flight assistant turn. Wired to `useChat.stopSession` via
   * `ChatPane`. The unified composer button calls this when the agent owns
   * the turn AND the composer is empty (see `composerAction.ts`).
   */
  onStop: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removePendingFile: (index: number) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  startRecording: () => void;
  stopRecording: () => void;
  formatRecordingTime: (s: number) => string;
  isImageFile: (f: File) => boolean;
  chatError: string | null;
  sendMessageDirect: (content: string) => Promise<boolean>;
  messageQueue: string[];
  onUpdateQueueItem: (index: number, content: string) => void;
  onRemoveQueueItem: (index: number) => void;
  onClearQueue: () => void;
  othersTyping: boolean;
  othersTypingText: string;
  mentionedFiles: MentionedFile[];
  setMentionedFiles: React.Dispatch<React.SetStateAction<MentionedFile[]>>;
  planMode?: boolean;
  onTogglePlanMode?: () => void;
  /** Export the conversation as Markdown (composer ⋯ menu row). */
  onExportConversation?: () => void;
  /**
   * Fast Mode toggle (openspec change `chat-fast-mode`). When ON, the chat
   * route uses the provider's native fast model (haiku / gpt-4o-mini / …).
   * Independent of plan mode — both can be ON simultaneously. Persisted
   * per-topic on the server; the toggle is positioned between Plan mode
   * and the Context ring in the composer's left tool cluster.
   */
  fastMode?: boolean;
  onToggleFastMode?: () => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  providerOverride?: { provider: string; model: string } | null;
  onProviderOverrideChange?: (override: { provider: string; model: string } | null) => void;
  /** Per-topic effort-tier override (migration 033). null = provider default. */
  effort?: string | null;
  onEffortChange?: (effort: string | null) => void;
  defaultProviderLabel?: string;
  onOpenSettings?: () => void;
  /**
   * Context Inspector plumbing. The inspector now renders as a popover anchored
   * to the composer's context ring (was a docked side panel owned by the parent
   * layout). Both come straight from `ChatPane` (`onUpdateTopic` + `onWSMessage`).
   */
  onUpdateTopic?: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function ChatInput({
  isMobile,
  isFocused,
  topic,
  currentMessages,
  currentStreaming,
  stoppedByUser = false,
  message,
  setMessage,
  pendingFiles,
  pendingImages,
  setPendingImages,
  uploading,
  replyingTo,
  setReplyingTo,
  isRecording,
  recordingTime,
  fileInputRef,
  textareaRef,
  onSubmit,
  onStop,
  onKeyDown: parentOnKeyDown,
  onFileSelect,
  removePendingFile,
  onPaste,
  startRecording,
  stopRecording,
  formatRecordingTime,
  isImageFile,
  chatError,
  sendMessageDirect,
  messageQueue,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onClearQueue,
  othersTyping,
  othersTypingText,
  mentionedFiles,
  setMentionedFiles,
  planMode,
  onTogglePlanMode,
  onExportConversation,
  fastMode,
  onToggleFastMode,
  editingMessage,
  onCancelEdit,
  providerOverride,
  onProviderOverrideChange,
  effort,
  onEffortChange,
  defaultProviderLabel,
  onOpenSettings,
  onUpdateTopic,
  onMessage,
}: ChatInputProps) {
  const tr = useT();
  // Context pills state. Excluded pills derive from the topic's SERVER-side
  // disabledContextSources (id format `file:<path>` — the same channel the
  // Context inspector and the envelope assembler use, and the only one the
  // send path respects). This used to be a LOCAL Set nothing ever read at
  // send time: the pill greyed out but the file was injected into the model
  // context anyway, and the ✕ button only greyed it too instead of removing.
  const contextFilePaths = topic.contextFiles || [];
  const excludedContextPaths = useMemo(
    () => new Set(
      (topic.disabledContextSources || [])
        .filter(id => id.startsWith('file:'))
        .map(id => id.slice('file:'.length)),
    ),
    [topic.disabledContextSources],
  );

  // Context budget ring — sits left of the model selector. Drafts have no
  // server-side topic yet, so skip the analysis call until promotion.
  const isDraftTopic = topic.id.startsWith('draft:');
  const { budgetPercent, sources: contextSources } = useContextInspector(isDraftTopic ? null : topic.id);
  // Proiezione delle sources che l'inspector ha GIA' scaricato: nessuna seconda
  // richiesta, e i token per file sono quelli veri invece di una stringa in
  // prosa raschiata con una regex.
  const contextTokenMap = useContextFileTokens(contextSources);

  // Il ring mostra due numeri diversi, e finora ne mostrava solo il secondo:
  //   • `realContext` = quanto ha in pancia il modello ADESSO, misurato sulla
  //     sua ultima chiamata. È la domanda che l'umano si fa a ogni turno;
  //   • `budgetPercent` = il preventivo dell'envelope che iniettiamo NOI
  //     (memory, prompt, file, pinned). Utile, ma è un'altra domanda — e
  //     mostrarla da sola sotto l'etichetta "Context" faceva credere che
  //     fosse la prima.
  // Quando la misura reale esiste vince lei; il preventivo resta dentro il
  // Context Inspector, dove è etichettato per quello che è.
  const realContext = useRealContext(isDraftTopic ? null : topic.sessionKey, onMessage);
  const ringPercent = realContext ? realContext.percent : budgetPercent;
  // Il tooltip dell'anello è dove vive il segnale di COSTO quando non merita un
  // riquadro (vedi `contextNotice`): ambra sull'anello senza una riga che dica
  // perché è un colore che l'umano non può interpretare.
  const ringCostHint =
    realContext && realContext.level !== 'ok' && (realContext.reason ?? 'window') === 'cost'
      ? '\nOgni chiamata al modello rilegge questi token: è il costo per risposta, non un problema di capienza.'
      : '';
  const ringTitle = realContext
    ? `Contesto del modello: ${formatTokens(realContext.used)} / ${realContext.estimated ? '≈' : ''}${formatTokens(realContext.size)} (${realContext.percent}%)${realContext.model ? ` — ${realContext.model}` : ''}${ringCostHint}`
    : `Contesto iniettato (stima): ${budgetPercent}%`;

  // Preavviso di compaction. Oggi la compaction si scopre a cose fatte, dal
  // divider; con la misura reale diventa prevedibile — ed è l'unico momento in
  // cui l'umano può ancora scegliere (compattare adesso, o aprire una chat
  // nuova e tenersi questa intatta).
  // La chiusura è per livello, non per sempre: chi archivia l'avviso al 72%
  // non sta dicendo "non avvisarmi più" per quando arriverà al 93%.
  // Il latch del dismiss è PER MOTIVO, non solo per livello.
  //
  // Da quando `critical` ha due trigger ortogonali — finestra piena (percentuale) e
  // prompt costoso per chiamata (assoluto) — un solo latch li confondeva: zittire
  // l'avviso di costo a 400k su un milione (40%, che si vede quasi subito) spegneva
  // per sempre anche l'allarme vero di finestra piena a 900k, che è l'unico che non
  // si può perdere. Due allarmi diversi, due latch.
  const [dismissed, setDismissed] = useState<Record<'window' | 'cost', 'warn' | 'critical' | null>>(
    { window: null, cost: null },
  );
  useEffect(() => { setDismissed({ window: null, cost: null }); }, [topic.sessionKey]);
  const contextNotice = (() => {
    if (!realContext || realContext.level === 'ok') return null;
    const rank = { ok: 0, warn: 1, critical: 2 } as const;
    // `reason` assente = payload di un server più vecchio: si degrada a "window",
    // che è il comportamento storico.
    const reason = realContext.reason ?? 'window';
    const level = realContext.level as 'warn' | 'critical';
    // Un riquadro con due bottoni è un'INTERRUZIONE: si spende solo dove c'è
    // davvero una scelta da fare. Il costo per chiamata a livello `warn` — 200k
    // su una finestra da un milione, cioè il 20% — non lo è: è lo stato normale
    // di qualunque sessione di lavoro dopo mezz'ora, quindi l'avviso stava
    // addosso praticamente sempre e ha smesso di voler dire qualcosa (chiesto
    // tre volte «ma che significa?», che è la misura del fallimento). Quel
    // segnale resta dove non costa attenzione: l'anello ambra e il suo tooltip.
    // Il riquadro torna a 400k, dove compattare si ripaga sul serio.
    if (reason === 'cost' && level === 'warn') return null;
    if (rank[level] <= rank[dismissed[reason] ?? 'ok']) return null;
    // Rosso vuol dire «stai per perdere pezzi di conversazione», e a farlo è
    // solo la finestra che finisce. Un prompt caro resta ambra anche a livello
    // critico: costa di più, non rompe niente.
    return { ...realContext, reason, level, severe: level === 'critical' && reason === 'window' };
  })();
  const dismissNotice = (n: { reason: 'window' | 'cost'; level: 'warn' | 'critical' }) =>
    setDismissed((prev) => ({ ...prev, [n.reason]: n.level }));

  // Context Inspector popover. Anchored to the ring button below; dismisses on
  // outside-pointer / Escape via the shared useDismissable contract (the ring
  // ref is in `refs` so clicking it to close doesn't immediately re-open).
  const [showContextPopover, setShowContextPopover] = useState(false);
  const contextBtnRef = useRef<HTMLButtonElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  useDismissable({
    open: showContextPopover,
    onClose: () => setShowContextPopover(false),
    refs: [contextBtnRef, contextPopoverRef],
  });
  const handleContextRingClick = useCallback(() => {
    if (isDraftTopic) return;
    setShowContextPopover(v => !v);
  }, [isDraftTopic]);

  // External triggers (the per-pane header "Context Inspector" button in the
  // various layouts) still reach the inspector through this window event — they
  // just toggle THIS composer's popover now instead of a docked side panel.
  useEffect(() => {
    const handler = (e: Event) => {
      if (isDraftTopic) return;
      const detail = (e as CustomEvent).detail as { topicId?: string } | undefined;
      if (detail?.topicId && detail.topicId !== topic.id) return;
      setShowContextPopover(v => !v);
    };
    window.addEventListener('chat-input:toggle-context', handler);
    return () => window.removeEventListener('chat-input:toggle-context', handler);
  }, [topic.id, isDraftTopic]);

  // Position the desktop popover above the ring button, right-clamped to the
  // viewport (mirrors ProviderModelPicker's placement math).
  const contextPos = showContextPopover && !isMobile && contextBtnRef.current
    ? (() => {
        const rect = contextBtnRef.current.getBoundingClientRect();
        return {
          bottom: window.innerHeight - rect.top + 6,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 396)),
        };
      })()
    : null;

  const handleToggleContext = useCallback((path: string, currentlyExcluded: boolean) => {
    const sourceId = `file:${path}`;
    const current = topic.disabledContextSources || [];
    const next = currentlyExcluded
      ? current.filter(id => id !== sourceId)
      : [...current, sourceId];
    // Persist through the topic PATCH — the topic:updated broadcast flows the
    // new state back into this prop (and every other window/inspector).
    topicsApi.update(topic.id, { disabledContextSources: next }).catch(err => {
      console.warn('[ChatInput] toggle context source failed:', err);
    });
  }, [topic.id, topic.disabledContextSources]);

  const handleRemoveContext = useCallback((path: string) => {
    uploadApi.deleteContextFile(topic.id, path).catch(err => {
      console.warn('[ChatInput] remove context file failed:', err);
    });
  }, [topic.id]);

  // Slash command menu state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [slashFilter, setSlashFilter] = useState('');
  const slashMenuRef = useRef<HTMLDivElement>(null);
  // The user's custom commands/skills (/vai, /commit, /recap, …) for
  // autocomplete. Fetched once; the headless CLI expands them on send.
  const [customCmds, setCustomCmds] = useState<CustomSlashCommand[]>([]);
  useEffect(() => {
    let alive = true;
    slashCommandsApi.list().then((c) => { if (alive) setCustomCmds(c); }).catch(() => { /* best-effort */ });
    return () => { alive = false; };
  }, []);
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState<number>(-1);

  // C'è una domanda a schermo a cui il testo scritto qui può rispondere?
  // `sendMessage` in quel caso instrada il testo alla domanda invece di
  // accodarlo (`state/pendingAsk.ts`): il composer lo deve DIRE, altrimenti
  // l'invio fa una cosa diversa da quella che il bottone promette.
  const awaitingAnswer = useMemo(
    () => canAnswerWithText(findPendingAsk(currentMessages)),
    [currentMessages],
  );

  // Speech-to-text and TTS hooks
  const { isListening, transcript, isSupported: sttSupported, toggleListening, clearTranscript } = useSpeechToText();
  const { speak, stop: stopSpeaking, isSpeaking } = useTextToSpeech();
  const [autoTTS, setAutoTTS] = useState(false);
  // Last message id auto-spoken, so the effect below never re-speaks the same
  // message when `currentMessages`/`currentStreaming` re-fire for other reasons.
  const spokenIdRef = useRef<string | null>(null);
  
  // Voice Call Mode
  const { isCallActive, callStatus, isSupported: voiceCallSupported, toggleCall } = useVoiceCall(
    sendMessageDirect,
    currentMessages,
    currentStreaming
  );

  // Global keyboard shortcuts for voice features — focused pane only (see the
  // `isFocused` prop doc: these are window-level and every pane mounts one).
  useEffect(() => {
    if (!isFocused) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      
      if (isMod && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        if (isRecording) stopRecording(); else startRecording();
        return;
      }
      if (isMod && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        if (voiceCallSupported) toggleCall();
        return;
      }
      if (isMod && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (sttSupported && !isCallActive) toggleListening();
        return;
      }
      // Shift+Cmd+S ("Speak"). Shift+Cmd+T is the app's "reopen closed tab"
      // chord (handled globally in useKeyboardShortcuts), so auto-TTS stays here.
      // Mirror the overflow-menu button: stop when currently speaking, else toggle.
      if (isMod && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        if (isSpeaking) stopSpeaking(); else setAutoTTS(prev => !prev);
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isFocused, toggleCall, toggleListening, voiceCallSupported, sttSupported, isCallActive, isRecording, startRecording, stopRecording, isSpeaking, stopSpeaking]);

  // Sync transcript to message input. `message`/`setMessage` are intentionally
  // read as a snapshot only when a new `transcript` arrives — the guard plus
  // the immediate clearTranscript() make message-change re-runs a safe no-op.
  useEffect(() => {
    if (transcript) {
      setMessage(message + ' ' + transcript);
      clearTranscript();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only when a new transcript arrives; including `message` would re-fire on every keystroke (no-op due to the transcript guard, but pointless), and `setMessage` is a stable parent setter
  }, [transcript, clearTranscript]);

  // Reset the auto-TTS guard when switching topics so the first assistant
  // message in the newly-focused topic is spoken even if it shares no id state.
  useEffect(() => {
    spokenIdRef.current = null;
  }, [topic.id]);

  // Auto-TTS for new assistant messages. Guarded by `spokenIdRef` so the same
  // message is never spoken twice when this effect re-runs for other reasons.
  useEffect(() => {
    if (!autoTTS) return;
    const lastMsg = currentMessages[currentMessages.length - 1];
    if (lastMsg?.role === 'assistant' && !currentStreaming && lastMsg.content && lastMsg.id !== spokenIdRef.current) {
      spokenIdRef.current = lastMsg.id;
      const textToSpeak = lastMsg.content.slice(0, 500);
      speak(textToSpeak);
    }
  }, [currentMessages, currentStreaming, autoTTS, speak]);

  // `chat:insert-text` / `chat:attach-image` sono BROADCAST su window: le sente
  // ogni ChatInput montato, e le pane nascoste restano montate. Il registro
  // dice quale composer è il destinatario (l'ultimo usato) — vedi chatFocus.
  const composerId = useId();
  useEffect(() => {
    chatFocus.register(composerId);
    return () => chatFocus.unregister(composerId);
  }, [composerId]);
  useEffect(() => {
    if (isFocused) chatFocus.focus(composerId);
  }, [isFocused, composerId]);

  // Phase 30 BROWSER-CHAT-04 — listen for chat:insert-text custom events
  // dispatched by SelectElementOverlay (Cmd+Shift+E pick) and other loosely
  // coupled producers. Inserts the provided text into the chat input prefixed
  // with a blank line if there's existing content, then focuses the textarea.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ text?: string }>;
      const incoming = ce.detail?.text;
      if (!incoming || !chatFocus.isRecipient(composerId)) return;
      setMessage(message ? `${message}\n\n${incoming}` : incoming);
      textareaRef.current?.focus();
    };
    window.addEventListener('chat:insert-text', handler as EventListener);
    return () => window.removeEventListener('chat:insert-text', handler as EventListener);
  }, [message, setMessage, textareaRef, composerId]);

  // 4.2 — stessa strada per le IMMAGINI: il click-to-edit allega il ritaglio
  // dell'elemento selezionato. Entra in `pendingImages`, cioè nella stessa coda
  // di un incolla — così parte con l'invio e si toglie con la solita ×, senza
  // un secondo percorso di allegati da tenere in vita.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ dataUrl?: string; mimeType?: string }>;
      const dataUrl = ce.detail?.dataUrl;
      if (!dataUrl || !chatFocus.isRecipient(composerId)) return;
      setPendingImages(prev => [...prev, { dataUrl, mimeType: ce.detail?.mimeType || 'image/png' }]);
    };
    window.addEventListener('chat:attach-image', handler as EventListener);
    return () => window.removeEventListener('chat:attach-image', handler as EventListener);
  }, [setPendingImages, composerId]);

  // Built-in app commands (handled by the composer) + the user's custom
  // commands/skills (which fall through to the child, expanded by the CLI).
  // Built-in wins on a name clash. The menu render only reads {cmd, description}.
  const allSlashCommands = useMemo(() => {
    const builtin = SLASH_COMMANDS.map((c) => ({ cmd: c.cmd, description: c.description }));
    const builtinNames = new Set(builtin.map((c) => c.cmd));
    const custom = customCmds
      .map((c) => ({ cmd: '/' + c.name, description: c.description || (c.kind === 'skill' ? 'Skill' : 'Comando') }))
      .filter((c) => !builtinNames.has(c.cmd));
    return [...builtin, ...custom];
  }, [customCmds]);

  const filteredSlashCommands = allSlashCommands.filter(c =>
    c.cmd.toLowerCase().startsWith(slashFilter.toLowerCase())
  );

  // Unified dismissal for the slash-command menu: capture-phase outside-pointer
  // + Escape close. The textarea stays "inside" (arrow/Enter selection is
  // handled by handleKeyDown) and the caret is left untouched.
  useDismissable({
    open: showSlashMenu && filteredSlashCommands.length > 0,
    onClose: () => { setShowSlashMenu(false); setSlashFilter(''); },
    refs: [textareaRef, slashMenuRef],
    restoreFocus: false,
  });

  const handleMentionSelect = useCallback((file: MentionedFile) => {
    if (mentionStartPos >= 0) {
      const before = message.substring(0, mentionStartPos);
      const afterAtQuery = message.substring(mentionStartPos);
      const spaceIdx = afterAtQuery.indexOf(' ');
      const after = spaceIdx >= 0 ? afterAtQuery.substring(spaceIdx) : '';
      setMessage(before + after);
    }
    if (!mentionedFiles.some(f => f.path === file.path)) {
      setMentionedFiles(prev => [...prev, file]);
    }
    setShowMentionMenu(false);
    setMentionFilter('');
    setMentionStartPos(-1);
    textareaRef.current?.focus();
  }, [mentionStartPos, message, mentionedFiles, setMessage, setMentionedFiles, textareaRef]);

  const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setMessage(value);
    
    if (value.startsWith('/') && !value.includes(' ')) {
      setShowSlashMenu(true);
      setSlashFilter(value);
      setSlashMenuIndex(0);
      setShowMentionMenu(false);
    } else {
      setShowSlashMenu(false);
      setSlashFilter('');
    }

    // Detect @ trigger for a FILE mention
    {
      let atPos = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        if (value[i] === '@') {
          if (i === 0 || /\s/.test(value[i - 1])) {
            atPos = i;
          }
          break;
        }
        if (/\s/.test(value[i])) break;
      }

      if (atPos >= 0) {
        const query = value.substring(atPos + 1, cursorPos);

        // Show file mention menu if project path exists
        if (topic.projectPath) {
          setShowMentionMenu(true);
          setMentionFilter(query);
          setMentionMenuIndex(0);
          setMentionStartPos(atPos);
        }
      } else {
        if (topic.projectPath) {
          setShowMentionMenu(false);
          setMentionFilter('');
          setMentionStartPos(-1);
        }
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle file @-mention menu navigation
    if (showMentionMenu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionMenuIndex(i => i + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionMenuIndex(i => Math.max(0, i - 1)); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const menuEl = document.querySelector('[data-mention-menu]');
        if (menuEl) {
          const selectedBtn = menuEl.querySelector(`[data-mention-idx="${mentionMenuIndex}"]`) as HTMLButtonElement;
          selectedBtn?.click();
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowMentionMenu(false); setMentionStartPos(-1); return; }
    }

    // Handle slash menu navigation
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashMenuIndex(i => (i + 1) % filteredSlashCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashMenuIndex(i => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const selected = filteredSlashCommands[slashMenuIndex];
        if (selected) { setMessage(selected.cmd + ' '); setShowSlashMenu(false); setSlashFilter(''); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowSlashMenu(false); return; }
    }
    
    parentOnKeyDown(e);
  };

  const hasAttachments = pendingImages.length > 0 || pendingFiles.length > 0;
  const hasContext = mentionedFiles.length > 0 || contextFilePaths.length > 0;

  return (
    <>
      {/* Status banners (outside floating card) */}
      {isCallActive && (
        <div className={`${isMobile ? 'mx-2' : 'mx-3'} mb-1 rounded-xl bg-gradient-to-r from-green-500/20 to-blue-500/20 border border-green-500/30 px-3 py-2 flex items-center gap-3 flex-shrink-0`}>
          <div className={`w-3 h-3 rounded-full ${
            callStatus === 'listening' ? 'bg-green-500 animate-pulse' :
            callStatus === 'processing' ? 'bg-yellow-500 animate-pulse' :
            callStatus === 'speaking' ? 'bg-blue-500 animate-pulse' :
            'bg-gray-400'
          }`} />
          <div className="flex-1">
            <div className="text-[12px] font-medium text-green-700 dark:text-green-300">Voice Call Active</div>
            <div className="text-[11px] text-app-text-secondary">
              {callStatus === 'listening' && 'Listening... speak now'}
              {callStatus === 'processing' && 'Processing your message...'}
              {callStatus === 'speaking' && 'Speaking response...'}
            </div>
          </div>
          <button onClick={toggleCall} className="px-3 py-1 text-[11px] bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors">End Call</button>
        </div>
      )}

      {/* Nessuna risposta dopo un messaggio tuo. La CAUSA non si legge dalla
          pagina: uno stop precoce cancella la bolla vuota e lascia esattamente
          la stessa forma di un turno mai arrivato. Senza distinguerle, premere
          «ferma» faceva comparire «la connessione può essersi interrotta» —
          il composer accusava la rete di una cosa che avevi appena fatto tu.
          Il caso «il turno è ancora vivo» non passa di qui: `currentStreaming`
          lo tiene acceso anche dopo un reload (vedi reconcileServerStreams). */}
      {!currentStreaming && currentMessages.length > 0 && currentMessages[currentMessages.length - 1]?.role === 'user' && (
        <div
          data-testid="no-reply-banner"
          data-reason={stoppedByUser ? 'stopped' : 'interrupted'}
          className={`${isMobile ? 'mx-2' : 'mx-3'} mb-1 rounded-xl px-3 py-2 flex items-center gap-2 flex-shrink-0 ${
            stoppedByUser
              ? 'bg-app-hover border border-app-border-light'
              : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40'
          }`}
        >
          <div className="flex-1 min-w-0">
            {stoppedByUser ? (
              <>
                <div className="text-[11px] text-app-text font-medium">{tr('chat.turnStopped')}</div>
                <div className="text-[11px] text-app-text-muted">{tr('chat.turnStopped.detail')}</div>
              </>
            ) : (
              <>
                <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">{tr('chat.noAnswer')}</div>
                <div className="text-[11px] text-amber-600 dark:text-amber-500">{tr('chat.noAnswer.detail')}</div>
              </>
            )}
          </div>
          <button
            onClick={() => { const lastMsg = currentMessages[currentMessages.length - 1]; if (lastMsg?.content) sendMessageDirect(lastMsg.content); }}
            className={`px-3 py-1.5 text-[11px] rounded-md transition-colors flex items-center gap-1 ${
              stoppedByUser
                ? 'bg-app-border text-app-text hover:bg-app-border-light'
                : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            <span>↻</span> {stoppedByUser ? 'Riprendi' : 'Riprova'}
          </button>
        </div>
      )}

      {/* Preavviso di compaction — la scelta si offre PRIMA, non dopo il divider */}
      {contextNotice && (
        <div
          data-testid="context-notice"
          data-context-level={contextNotice.level}
          className={`${isMobile ? 'mx-2' : 'mx-3'} mb-1 rounded-xl border px-3 py-2 flex items-center gap-2 flex-shrink-0 ${
            contextNotice.severe
              ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/40'
              : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40'
          }`}
        >
          <div className="flex-1 min-w-0">
            <div className={`text-[11px] font-medium ${contextNotice.severe ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {/* Due motivi, due frasi. Dire "quasi pieno — 47%" perché è scattata
                  la soglia assoluta è un avviso che non si può capire: su una
                  finestra da 1M il problema non è la capienza, è che ogni chiamata
                  rilegge per intero un prompt già enorme. */}
              {contextNotice.reason === 'cost'
                ? `Ogni risposta rilegge ${formatTokens(contextNotice.used)} token`
                : contextNotice.level === 'critical'
                  ? `Contesto quasi pieno — ${contextNotice.percent}%`
                  : `Contesto che si riempie — ${contextNotice.percent}%`}
            </div>
            <div className={`text-[11px] line-clamp-2 ${contextNotice.severe ? 'text-red-600 dark:text-red-500' : 'text-amber-600 dark:text-amber-500'}`}>
              {/* La seconda riga non ripete il numero della prima: dice COSA
                  comporta. Nel caso 'cost' la capienza non è il problema — nella
                  finestra ci sta — quindi si spiega la conseguenza vera, che è
                  il conto e la lentezza a ogni chiamata.
                  MAI `truncate` qui: era una spiegazione scritta per intero e poi
                  tagliata dal CSS a una riga, quindi di fatto una frase monca che
                  finiva su una virgola («…ci stanno (332k di 1.0M),») — il motivo
                  per cui non si capiva. Va a capo, con un tetto di due righe per
                  non spostare il composer. Il consiglio su cosa fare non ci sta:
                  lo dicono già i due bottoni qui accanto. */}
              {contextNotice.reason === 'cost'
                ? `Nella finestra ci stanno (${contextNotice.percent}% di ${contextNotice.estimated ? '≈' : ''}${formatTokens(contextNotice.size)}): il problema non è lo spazio, è che li ripaghi a ogni chiamata.`
                : `${formatTokens(contextNotice.used)} di ${contextNotice.estimated ? '≈' : ''}${formatTokens(contextNotice.size)} — compattare adesso costa meno dettaglio che a ridosso.`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { dismissNotice(contextNotice); void sendMessageDirect('/compact'); }}
            className={`px-2.5 py-1 text-[11px] text-white rounded-md transition-colors flex-shrink-0 ${contextNotice.severe ? 'bg-red-500 hover:bg-red-600' : 'bg-amber-500 hover:bg-amber-600'}`}
          >
            Compatta adesso
          </button>
          <button
            type="button"
            onClick={() => { dismissNotice(contextNotice); window.dispatchEvent(new CustomEvent('topics:new-chat')); }}
            className="px-2.5 py-1 text-[11px] rounded-md border border-app-border-light text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors flex-shrink-0"
          >
            Nuova chat
          </button>
          <button
            type="button"
            onClick={() => dismissNotice(contextNotice)}
            className="text-app-text-tertiary hover:text-app-text p-0.5 flex-shrink-0"
            title="Chiudi l'avviso"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* «Qualcuno sta scrivendo», SOPRA il composer e fuori dal flusso.
          Era un blocco in flusso che montava e smontava: ogni comparsa e ogni
          scomparsa spostava il composer e con lui la lista dei messaggi, e siccome
          l'indicatore si spegne 2 s dopo l'ultimo frame, digitare in due produceva
          un su-e-giù continuo — il «flasha» segnalato. Fuori dal flusso non può
          più muovere niente: appare sopra il bordo del composer e sparisce senza
          che nulla si sposti.
          Il contenitore esterno è `relative h-0`: nel flusso occupa ZERO, quindi
          non può spostare niente, e l'indicatore ci si ancora sopra. Serve un
          antenato posizionato e il root del composer è un Fragment, quindi il
          punto d'ancoraggio va creato qui invece di sperare in uno di sopra.
          `pointer-events-none`: è informazione, non un bersaglio — non deve mai
          rubare un click al composer che copre. */}
      <div className="relative h-0">
      {/* Il contenitore `h-0` resta sempre; il CONTENUTO no. Tenerlo montato e
          solo trasparente costava due cose reali: tre pallini `animate-bounce`
          che animavano per sempre in ogni chat aperta (lavoro del compositor a
          riposo), e tre elementi fantasma che l'audit geometrico misurava
          davvero — `chat-layout-audit` li ha beccati come near-miss di 0.6px,
          perche' li fotografava a meta' rimbalzo. Montare a condizione non
          rimette il layout shift: ad occupare spazio nel flusso e' il div `h-0`
          qui sopra, che non se ne va mai. */}
      {othersTyping && (
        <div
          data-testid="others-typing-indicator"
          className={`${isMobile ? 'mx-2' : 'mx-3'} absolute bottom-0 left-0 right-0 mb-1 px-3 flex items-center gap-2 pointer-events-none`}
        >
          <div className="flex gap-1 flex-shrink-0">
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <div className="text-[11px] text-app-text-secondary italic min-w-0 truncate">{othersTypingText || 'typing...'}</div>
        </div>
      )}
      </div>

      {/* Floating input card */}
      <form
        onSubmit={onSubmit}
        // @container: the action-bar row below keys its shrink/scroll
        // behavior off THIS element's width (the pane/tab), not the
        // viewport — panes can be resized far narrower than any viewport
        // breakpoint would ever fire at.
        className={`relative @container ${isMobile ? 'm-2' : 'm-3'} rounded-2xl shadow-md border ${planMode ? 'border-indigo-400 dark:border-indigo-500/50 focus-within:border-indigo-400' : 'border-app-border-light focus-within:border-primary'} bg-surface flex-shrink-0 transition-colors min-w-0 max-w-full`}
        style={{ maxWidth: '100%' }}
      >
        {isRecording ? (
          <div className="flex gap-2 items-center p-3">
            <div className="flex-1 flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-xl px-3 py-2.5">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-red-500 font-medium text-[12px]">Recording</span>
              <span className="text-red-400 font-mono text-[12px]">{formatRecordingTime(recordingTime)}</span>
            </div>
            <button type="button" onClick={stopRecording} className="bg-red-500 text-white px-4 py-2.5 rounded-xl hover:bg-red-600 transition-colors flex items-center gap-1.5 text-[12px] font-medium">
              Stop
            </button>
          </div>
        ) : (
          <>
            {/* Row 0: Attachments preview (inside card) */}
            {hasAttachments && (
              <div className="px-3 pt-2.5 flex flex-wrap gap-1.5">
                {pendingImages.map((img, index) => (
                  <div key={`img-${index}`} className="relative inline-block">
                    <img src={img.dataUrl} alt="Pasted image" className="h-[80px] max-w-[160px] object-cover rounded-lg border border-app-border-light" />
                    <button onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== index))} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600">×</button>
                  </div>
                ))}
                {pendingFiles.map((file, index) => (
                  <div key={`file-${index}`}>
                    {isImageFile(file) ? (
                      <ImageThumbnail file={file} onRemove={() => removePendingFile(index)} />
                    ) : (
                      <div className="relative flex items-center gap-1.5 bg-app-hover rounded-lg px-2 py-1 text-[11px]">
                        <Paperclip size={14} className="text-app-text-tertiary" />
                        <span className="max-w-24 truncate text-app-text-secondary">{file.name}</span>
                        <button onClick={() => removePendingFile(index)} className="ml-0.5 text-red-400 hover:text-red-500 font-bold text-xs">×</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Row 0a: Editing indicator (inside card) */}
            {editingMessage && (
              <div className="mx-3 mt-2 flex items-center gap-1.5">
                <div className="w-0.5 h-5 bg-amber-500 rounded-full flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                    Editing message
                  </div>
                </div>
                <button onClick={onCancelEdit} className="text-app-text-tertiary hover:text-app-text p-0.5" title="Cancel edit">
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Row 0b: Reply preview (inside card) */}
            {replyingTo && (
              <div className="mx-3 mt-2 flex items-center gap-1.5">
                <div className="w-0.5 h-5 bg-primary rounded-full flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-app-text-tertiary font-medium">
                    Replying to {replyingTo.role === 'user' ? 'yourself' : 'assistant'}
                  </div>
                  <div className="text-[11px] text-app-text-secondary truncate">
                    {replyingTo.content.slice(0, 80)}{replyingTo.content.length > 80 ? '…' : ''}
                  </div>
                </div>
                <button onClick={() => setReplyingTo(null)} className="text-app-text-tertiary hover:text-app-text p-0.5">
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Row 0c: Context pills (inside card) */}
            {hasContext && (
              <div className="px-3 mt-1.5 flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
                <span className="text-[11px] text-app-text-muted font-medium flex-shrink-0">Context</span>
                {contextFilePaths.length > 0 && (
                  <ContextPills
                    files={contextFilePaths.map(cf => ({
                      name: basename(cf) || cf,
                      path: cf,
                      tokens: contextTokenMap.get(cf),
                      type: cf.toLowerCase().includes('claude') ? 'claude' as const : 'context' as const,
                    }))}
                    excludedPaths={excludedContextPaths}
                    onToggle={handleToggleContext}
                    onRemove={handleRemoveContext}
                    compact
                  />
                )}
                {mentionedFiles.map((file, idx) => (
                  <FilePill
                    key={file.path}
                    file={file}
                    onRemove={() => setMentionedFiles(prev => prev.filter((_, i) => i !== idx))}
                  />
                ))}
              </div>
            )}

            {/* Row 1: Textarea (full width, borderless) */}
            <textarea
              ref={textareaRef}
              data-testid="chat-message-input"
              value={message}
              onChange={handleMessageChange}
              onKeyDown={handleKeyDown}
              onPaste={onPaste}
              aria-label={`Message input for ${topic.name}`}
              aria-describedby="chat-input-hint"
              placeholder={awaitingAnswer ? 'Rispondi alla domanda…' : replyingTo ? 'Reply...' : topic.projectPath ? 'Message... (@ to mention files)' : 'Message...'}
              className={`w-full px-3 ${hasAttachments || replyingTo || hasContext ? 'pt-1.5' : 'pt-3'} pb-1 bg-transparent text-app-text placeholder-app-placeholder resize-none overflow-y-auto focus:outline-none focus-visible:outline-none ${isMobile ? 'text-[16px]' : 'text-[13px]'}`}
              style={{ minHeight: '36px', maxHeight: '140px' }}
              rows={1}
              disabled={uploading}
            />
            <span id="chat-input-hint" className="sr-only">Press Enter to send, Shift+Enter for new line. Type / for commands.</span>

            {/* Row 2: Action bar */}
            <div className={`flex items-center gap-1 ${'px-1.5 pb-1.5'}`}>
              {/* Left: tools. min-w-0 lets this cluster shrink below its
                  content width; overflow-x-auto lets it scroll instead of
                  clipping (or pushing Send off-row) once a narrow pane can't
                  fit every icon.
                  Perche' scorra davvero, i bottoni dentro devono essere
                  `flex-shrink-0`: senza, il default `flex-shrink: 1` li
                  SCHIACCIAVA invece di farli traboccare — a 390px di viewport
                  i quadrati da 32px misuravano 20.9px (misurato da
                  `chat-layout-audit`, sotto il minimo WCAG 2.2 di 24px), con
                  l'icona da 16px in un box storto. Il contenitore prometteva
                  lo scroll e i figli non glielo lasciavano fare. */}
              <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto scrollbar-hide">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg text-app-text-muted hover:text-primary hover:bg-app-hover transition-all`}
                  title="Attach file (⌘U)"
                  aria-label="Attach file"
                  disabled={currentStreaming}
                >
                  <Paperclip size={16} />
                </button>
                <button
                  type="button"
                  onClick={onTogglePlanMode}
                  className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg transition-colors ${
                    planMode
                      ? 'text-indigo-500 bg-indigo-500/10'
                      : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={planMode ? 'Plan Mode ON' : 'Plan Mode OFF'}
                  aria-label="Toggle plan mode"
                >
                  <ClipboardList size={16} />
                </button>
                {onToggleFastMode && (
                  <button
                    type="button"
                    onClick={onToggleFastMode}
                    className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg transition-colors ${
                      fastMode
                        ? 'text-amber-500 bg-amber-500/10'
                        : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                    }`}
                    title={
                      fastMode
                        ? "Fast Mode ON — using the provider's fast model"
                        : 'Fast Mode OFF — using the topic’s default model'
                    }
                    aria-label="Toggle fast mode"
                    aria-pressed={!!fastMode}
                    data-testid="chat-input-fast-mode"
                  >
                    <Zap size={16} />
                  </button>
                )}
                {!isDraftTopic && (
                  <button
                    ref={contextBtnRef}
                    type="button"
                    onClick={handleContextRingClick}
                    className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg transition-colors ${
                      showContextPopover
                        ? 'bg-primary/10 text-primary'
                        : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                    }`}
                    title={ringTitle}
                    aria-label="Toggle context inspector"
                    aria-haspopup="dialog"
                    aria-expanded={showContextPopover}
                    data-testid="chat-input-context-ring"
                    data-context-percent={ringPercent}
                    data-context-source={realContext ? 'model' : 'envelope'}
                  >
                    <ContextRing percent={ringPercent} level={realContext?.level} size={14} />
                  </button>
                )}
                {onProviderOverrideChange && (
                  <ProviderModelPicker
                    override={providerOverride ?? null}
                    defaultProviderLabel={defaultProviderLabel}
                    onChange={onProviderOverrideChange}
                    onOpenSettings={onOpenSettings}
                  />
                )}
                {/* The knobs you change MID conversation, in their own surface:
                    effort used to be buried under a "Provider & model" trigger,
                    and autonomy (the permission mode) was reachable only from
                    the settings modal behind a tab right-click. */}
                <SessionConfigPopover
                  effort={effort ?? null}
                  onEffortChange={onEffortChange}
                  effortSupported={!!onEffortChange}
                  providerOverride={providerOverride ?? null}
                  defaultProviderLabel={defaultProviderLabel}
                />
              </div>

              {/* Right: voice + send. flex-shrink-0: Send/Stop must never be
                  the thing that gets squeezed on a narrow pane — the left
                  cluster scrolls instead. */}
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {/* Direct mic button — always visible on all screen sizes */}
                <button
                  type="button"
                  onClick={() => { if (isRecording) stopRecording(); else startRecording(); }}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                    isRecording ? 'bg-red-500 text-white animate-pulse' : 'text-app-text-tertiary hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={isRecording ? 'Stop recording (⌘⇧R)' : 'Record voice (⌘⇧R)'}
                  aria-label={isRecording ? 'Stop recording' : 'Record voice'}
                  disabled={currentStreaming || uploading}
                >
                  {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
                {!isMobile && (
                  <OverflowMenu
                    onExport={onExportConversation}
                    isCallActive={isCallActive}
                    isRecording={isRecording}
                    isListening={isListening}
                    isSpeaking={isSpeaking}
                    autoTTS={autoTTS}
                    voiceCallSupported={voiceCallSupported}
                    sttSupported={sttSupported}
                    currentStreaming={currentStreaming}
                    uploading={uploading}
                    toggleCall={toggleCall}
                    startRecording={startRecording}
                    stopRecording={stopRecording}
                    toggleListening={toggleListening}
                    stopSpeaking={stopSpeaking}
                    setAutoTTS={setAutoTTS}
                    onSlashCommand={(cmd) => {
                      setMessage(cmd + ' ');
                      textareaRef.current?.focus();
                    }}
                  />
                )}
                {/*
                  Unified composer button. The four states resolve via the
                  pure `decideComposerAction` helper so this JSX no longer
                  buries the rules in nested ternaries (the previous version
                  hand-coded the send / queue / disabled split inline and
                  had no notion of "stop"). Rules:

                    busy & empty   → Stop (abort the turn)
                    busy & filled  → Queue (orange Send; text auto-flushes
                                     when the stream ends, no token loss)
                    idle & filled  → Send
                    idle & empty   → Disabled

                  `Enter` keeps its existing semantics in `ChatPane.handleKeyDown`
                  (which calls `onSubmit` → `handleSendMessage`, and that
                  function already routes to the queue when streaming). Stop
                  is only reachable via click, never via the keyboard, so a
                  stray Enter can't accidentally cancel a turn.
                */}
                {(() => {
                  const hasContent =
                    message.trim().length > 0 ||
                    pendingFiles.length > 0 ||
                    pendingImages.length > 0;
                  const action = decideComposerAction({
                    busy: currentStreaming,
                    hasContent,
                    awaitingAnswer,
                  });

                  if (action.kind === 'stop') {
                    return (
                      <button
                        type="button"
                        onClick={onStop}
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-app-text/15 text-app-text hover:bg-app-text/25 transition-all"
                        title="Stop streaming"
                        aria-label="Stop streaming"
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    );
                  }

                  const isQueue = action.kind === 'queue';
                  // Ambra come la domanda a schermo: stesso colore, stessa cosa.
                  const isAnswer = action.kind === 'answer';
                  const isDisabled = action.kind === 'disabled' || uploading;

                  return (
                    <button
                      type="submit"
                      data-composer-action={action.kind}
                      disabled={isDisabled && !uploading}
                      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                        uploading
                          ? 'bg-primary text-white'
                          : isAnswer
                            ? 'bg-amber-500 text-white hover:bg-amber-600'
                            : isQueue
                              ? 'bg-orange-500 text-white hover:bg-orange-600'
                              : action.kind === 'send'
                                ? 'bg-primary text-white hover:bg-primary-hover'
                                : 'bg-transparent text-app-placeholder'
                      }`}
                      title={isAnswer ? 'Rispondi alla domanda (Enter)' : isQueue ? 'Queue message (Enter)' : 'Send (Enter)'}
                      aria-label={isAnswer ? 'Rispondi alla domanda' : isQueue ? 'Queue message' : 'Send message'}
                    >
                      {uploading ? (
                        <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                    </button>
                  );
                })()}
              </div>
            </div>

            {/* Popover menus (anchored to form) */}
            {showSlashMenu && filteredSlashCommands.length > 0 && (
              <div ref={slashMenuRef} role="listbox" className={`absolute bottom-full left-0 right-0 mb-1 ${POPOVER_PANEL} z-50 py-1.5 max-h-48 overflow-y-auto`}>
                {filteredSlashCommands.map((cmd, idx) => (
                  <button
                    key={cmd.cmd}
                    type="button"
                    role="option"
                    aria-selected={idx === slashMenuIndex}
                    onClick={() => {
                      setMessage(cmd.cmd + ' ');
                      setShowSlashMenu(false);
                      setSlashFilter('');
                      textareaRef.current?.focus();
                    }}
                    className={`w-full px-3 py-1.5 text-left grid grid-cols-[auto_1fr] gap-x-3 items-baseline transition-colors ${
                      idx === slashMenuIndex
                        ? 'bg-primary/10 text-app-text'
                        : 'text-app-text hover:bg-app-hover'
                    }`}
                  >
                    <span className="text-[12px] font-mono text-primary whitespace-nowrap">{cmd.cmd}</span>
                    <span className="text-[11px] text-app-text-muted truncate">{cmd.description}</span>
                  </button>
                ))}
              </div>
            )}

            {topic.projectPath && (
              <FileMentionMenu
                projectPath={topic.projectPath}
                visible={showMentionMenu}
                filter={mentionFilter}
                onSelect={handleMentionSelect}
                selectedIndex={mentionMenuIndex}
                onIndexChange={setMentionMenuIndex}
                onClose={() => { setShowMentionMenu(false); setMentionStartPos(-1); }}
                inputRef={textareaRef}
              />
            )}

            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileSelect} />
          </>
        )}
        {chatError && <div className="text-red-500 text-[11px] px-3 pb-1.5">{chatError}</div>}
        {messageQueue.length > 0 && (
          <MessageQueueBadge
            queue={messageQueue}
            onUpdateItem={onUpdateQueueItem}
            onRemoveItem={onRemoveQueueItem}
            onClear={onClearQueue}
          />
        )}
      </form>

      {/* Context Inspector popover — anchored to the ring on desktop, a bottom
          sheet on mobile. Replaces the old docked side panel; both trigger
          points (this ring + the per-pane header button) drive it. */}
      {showContextPopover && onUpdateTopic && !isMobile && contextPos && createPortal(
        <div
          ref={contextPopoverRef}
          data-popover="context-inspector"
          className={`fixed ${POPOVER_PANEL} flex flex-col overflow-hidden`}
          style={{
            zIndex: Z_POPOVER,
            bottom: contextPos.bottom,
            left: contextPos.left,
            width: 380,
            height: 'min(60vh, 560px)',
          }}
        >
          <Suspense fallback={<SpinnerFallback fill />}>
            <ContextInspector
              topic={topic}
              isOpen={showContextPopover}
              onClose={() => setShowContextPopover(false)}
              onUpdateTopic={onUpdateTopic}
              onMessage={onMessage}
              onCompact={isDraftTopic ? undefined : () => { void sendMessageDirect('/compact'); }}
            />
          </Suspense>
        </div>,
        document.body,
      )}
      {showContextPopover && onUpdateTopic && isMobile && createPortal(
        <>
          <div
            className="fixed inset-0 bg-black/40"
            style={{ zIndex: Z_POPOVER_SCRIM }}
            onClick={() => setShowContextPopover(false)}
          />
          <div
            ref={contextPopoverRef}
            data-popover="context-inspector"
            className={`fixed left-0 right-0 bottom-0 ${POPOVER_SHEET} flex flex-col overflow-hidden`}
            style={{ zIndex: Z_POPOVER, height: '70vh' }}
          >
            <Suspense fallback={<SpinnerFallback fill />}>
              <ContextInspector
                topic={topic}
                isOpen={showContextPopover}
                onClose={() => setShowContextPopover(false)}
                onUpdateTopic={onUpdateTopic}
                onMessage={onMessage}
                onCompact={isDraftTopic ? undefined : () => { void sendMessageDirect('/compact'); }}
              />
            </Suspense>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

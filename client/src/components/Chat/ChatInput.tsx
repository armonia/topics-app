import { useState, useEffect, useLayoutEffect, useRef, useCallback, useId, useMemo, lazy, Suspense } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { X, Paperclip, Mic, MicOff, Volume2, VolumeX, Send, Square, MessageSquare, Phone, PhoneOff, Plus, Zap, Download } from 'lucide-react';
import { decideComposerAction } from './composerAction';
import { SLASH_COMMANDS } from './slashCommands';
import { canAnswerWithText, findPendingAsk } from '../../state/pendingAsk';
import { useServerTurnAsked, useTopicLoading } from '../../state/signals';
import { turnLooksUnanswered, interruptedTurnOf, TURN_CAUSE_KEY } from './turnError';
import { useServerResume } from '../../hooks/useServerResume';
import type { Topic, ChatMessage, UpdateTopicRequest, WSMessage } from '../../types';
import { ImageThumbnail } from '../MessageContent';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { useTextToSpeech, useVoiceCall } from '../../hooks/useSpeech';
import { useDictation } from '../../hooks/useDictation';
import { DictationStrip } from './DictationStrip';
import { useToast } from '../Shared/Toast';
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
import { useSheetDrag } from '@/hooks/useSheetDrag';
import { SheetGrabber } from '@/components/Shared/SheetGrabber';
import { chatFocus } from '../../state/chatFocus';
import { Menu } from '../Shared/Menu';
import { Spinner, SpinnerFallback } from '../Shared/Spinner';
import { CHAT_STRIP } from '../../lib/chatStripStyles';
import { AutonomyPicker } from './AutonomyPicker';
import { fastModeUi } from '../../lib/fastMode';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { shortcut } from '../../lib/shortcutLabel';

// Lazily loaded — the inspector pulls in memory/openclaw hooks; keep it out of
// the composer's initial bundle and only fetch it the first time the popover opens.
const ContextInspector = lazy(() => import('../Context/ContextInspector').then(m => ({ default: m.ContextInspector })));


/**
 * Il vestito della card del composer — bordo, fondo, ombra, angoli.
 *
 * Vive in una costante perché lo portano DUE elementi che non possono essere lo
 * stesso: il campo di testo e, al suo posto, la barra rossa della
 * registrazione. Scritto due volte, il giorno che cambia l'angolo ne cambia uno
 * solo e la registrazione diventa un rettangolo con gli spigoli.
 */
const COMPOSER_CARD =
  'rounded-2xl shadow-md border border-app-border-light focus-within:border-primary bg-surface transition-colors';

// ---- Add Menu (allegati + voce + comandi) ----
//
// Era il menu «⋯» in fondo a destra, e conteneva SOLO i comandi e la voce.
// Adesso è il «+» in testa alla riga, ed è l'unico posto dove si aggiunge
// qualcosa alla conversazione: la graffetta e il microfono stavano fuori come
// due bottoni sciolti, in una riga che ne aveva sette e non diceva più quale
// fosse quello importante. Fuori restano i controlli che si LEGGONO a colpo
// d'occhio (fast mode, contesto, modello, effort, autonomia); qui dentro va
// quello che si fa una volta ogni tanto.
//
// Le AZIONI stanno in cima e i comandi sotto: il «+» lo apri per allegare un
// file, non per leggere l'elenco degli slash.

function AddMenu({
  isCallActive, isListening, isSpeaking, autoTTS,
  voiceCallSupported, sttSupported, currentStreaming, uploading,
  dictationBusy, dictationModel,
  toggleCall, toggleListening, stopSpeaking, setAutoTTS,
  onSlashCommand,
  onAttach,
  onExport,
}: {
  isCallActive: boolean; isListening: boolean; isSpeaking: boolean; autoTTS: boolean;
  voiceCallSupported: boolean; sttSupported: boolean; currentStreaming: boolean; uploading: boolean;
  /** Trascrizione in volo: la dettatura non si riapre finché non è rientrata. */
  dictationBusy: boolean;
  /** «elevenlabs scribe_v2» — chi sta ascoltando, nel tooltip. */
  dictationModel: string | null;
  toggleCall: () => void;
  toggleListening: () => void; stopSpeaking: () => void; setAutoTTS: React.Dispatch<React.SetStateAction<boolean>>;
  onSlashCommand: (cmd: string) => void;
  /** Apre il selettore di file (la vecchia graffetta). */
  onAttach: () => void;
  /** Export the conversation as a Markdown download (absent → row hidden). */
  onExport?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // `SLASH_COMMANDS` carries keys, not sentences: it is a module, so it is the
  // two places that DRAW that resolve them. This is one, the `/` menu below is
  // the other.
  const tr = useT();

  const anyActive = isCallActive || isListening || isSpeaking || autoTTS;
  const rowClass = 'w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover disabled:opacity-40 disabled:pointer-events-none';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="composer-add-menu"
        className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg transition-all ${
          open || anyActive
            ? 'text-primary bg-primary/10'
            : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
        }`}
        title="Allega, strumenti e comandi"
        // Il nome accessibile NON cambia col glifo: è il nome di questo menu da
        // quando esiste, ed è come lo trovano sia i lettori di schermo sia le
        // spec che ci passano per l'export.
        aria-label="Tools & commands"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={18} />
      </button>
      {/* Menu primitive: flip-above + clamp + reposition + dismiss inherited.
          `align="left"` perché il trigger adesso è il primo elemento della riga.
          restoreFocus=false preserva il comportamento storico di non riprendersi
          il fuoco alla chiusura. */}
      <Menu open={open} anchorRef={triggerRef} onClose={() => setOpen(false)} align="left" minWidth={230} restoreFocus={false}>
        {/* Allegare è la ragione per cui questo menu si apre: prima riga. */}
        <button
          type="button"
          onClick={() => { onAttach(); setOpen(false); }}
          className={`${rowClass} text-app-text`}
          disabled={currentStreaming}
          data-testid="composer-attach-file"
        >
          <Paperclip size={14} />
          Attach file
          <span className="ml-auto text-[11px] text-app-text-muted">{shortcut('U')}</span>
        </button>
        {/* «Registra voce» NON sta qui: è il tasto col microfono in fondo alla
            riga, l'unico ammesso prima dell'invio. Due porte per lo stesso
            gesto sono due posti dove cercarlo e uno di troppo da tenere in
            piedi. */}

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
            <span className="ml-auto text-[11px] text-app-text-muted">{shortcut('C', { shift: true })}</span>
          </button>
        )}
        {sttSupported && !isCallActive && (
          <button
            type="button"
            onClick={() => { toggleListening(); setOpen(false); }}
            className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
              isListening ? 'text-green-500' : 'text-app-text'
            }`}
            // La dettatura scrive nel composer, non parla con l'agente: uno
            // streaming in corso non è una ragione per impedirla — anzi, è
            // esattamente quando si prepara il messaggio dopo. Resta bloccata
            // solo mentre la trascrizione precedente è ancora in volo.
            disabled={dictationBusy}
            data-testid="composer-dictation"
            title={dictationModel ? `${tr('chat.dictation.listening')} · ${dictationModel}` : tr('chat.dictation.listening')}
          >
            {isListening ? <MicOff size={14} /> : <MessageSquare size={14} />}
            {isListening ? tr('chat.dictation.menuStop') : tr('chat.dictation.menuStart')}
            <span className="ml-auto text-[11px] text-app-text-muted">{shortcut('D', { shift: true })}</span>
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
          <span className="ml-auto text-[11px] text-app-text-muted">{shortcut('S', { shift: true })}</span>
        </button>
        {onExport && (
          <button
            type="button"
            onClick={() => { onExport(); setOpen(false); }}
            className={`${rowClass} text-app-text`}
            data-testid="chat-export-conversation"
          >
            <Download size={14} />
            Export conversation
            <span className="ml-auto text-[11px] text-app-text-muted">.md</span>
          </button>
        )}

        {/* Divider */}
        <div className="h-px bg-app-border my-1" />

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
              <span className="text-[11px] text-app-text-muted text-right truncate">{tr(cmd.descriptionKey)}</span>
            </button>
          );
        })}
      </Menu>
    </>
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
  othersTyping: boolean;
  othersTypingText: string;
  mentionedFiles: MentionedFile[];
  setMentionedFiles: React.Dispatch<React.SetStateAction<MentionedFile[]>>;
  /** Export the conversation as Markdown (composer ⋯ menu row). */
  onExportConversation?: () => void;
  /**
   * Fast Mode toggle (openspec change `chat-fast-mode`). When ON, the chat
   * route uses the provider's native fast model (haiku / gpt-4o-mini / …).
   * Persisted per-topic on the server; primo bottone del gruppo a sinistra
   * dopo la graffetta.
   */
  fastMode?: boolean;
  onToggleFastMode?: () => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  providerOverride?: { provider: string; model: string } | null;
  onProviderOverrideChange?: (override: { provider: string; model: string } | null) => void;
  /** Quanto può fare da sé la chat. Sempre in vista nel composer: decide
   *  `--permission-mode` della sessione, cioè se l'agente può toccare i file. */
  autonomy?: import('../../types').AutonomyLevel | null;
  onAutonomyChange?: (level: import('../../types').AutonomyLevel) => void;
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
  othersTyping,
  othersTypingText,
  mentionedFiles,
  setMentionedFiles,
  onExportConversation,
  fastMode,
  onToggleFastMode,
  editingMessage,
  onCancelEdit,
  providerOverride,
  onProviderOverrideChange,
  autonomy,
  onAutonomyChange,
  effort,
  onEffortChange,
  defaultProviderLabel,
  onOpenSettings,
  onUpdateTopic,
  onMessage,
}: ChatInputProps) {
  const tr = useT();
  const toast = useToast();
  /**
   * IL SECONDO TESTIMONE sul fatto che il turno sia vivo, e l'unico che
   * sopravvive a un ricarico: il registro del server, servito da
   * `GET /api/topics/streaming` (`useSignalsSync` lo interroga ogni 15 s) e
   * letto da qui attraverso `useTopicLoading`, che unisce lo stream live e
   * quello «idratato». `currentStreaming` da solo non basta — è memoria di
   * processo — ed è precisamente il buco da cui usciva «Nessuna risposta» su un
   * agente al lavoro. Vedi `turnLooksUnanswered`.
   */
  const serverTurnOpen = useTopicLoading(topic?.id);
  const serverTurnAsked = useServerTurnAsked();
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

  // Fast Mode: si mostra quello che la CLI DICHIARA, non quello che vorremmo.
  // Lo snapshot dei provider è già in memoria (store condiviso), quindi qui non
  // parte nessuna richiesta in più.
  const { snapshot: providersSnapshot } = useProvidersSnapshot();
  const fastUi = useMemo(
    () => fastModeUi({
      snapshot: providersSnapshot,
      providerOverride: providerOverride ?? null,
      requested: !!fastMode,
    }),
    [providersSnapshot, providerOverride, fastMode],
  );
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
  /**
   * The boot is resending the message by itself, right now.
   *
   * Kept apart from `interruptedTurn`, which goes null the moment the stream
   * starts: during a resume there IS a stream, so a banner hanging off that
   * memo would vanish exactly in the window this card is about.
   */
  const serverResuming = useServerResume(isDraftTopic ? null : topic.sessionKey, onMessage);
  const ringPercent = realContext ? realContext.percent : budgetPercent;
  // Il tooltip dell'anello è dove vive la SPIEGAZIONE, adesso che l'avviso è
  // una pastiglia da tre caratteri: un numero ambra accanto all'anello dice a
  // che punto siamo, il tooltip dice perché quel colore e cosa farci.
  //
  // La riga di base c'è SEMPRE, non solo sopra soglia, ed è un cambio voluto:
  // «ogni chiamata rilegge questi token» non è un allarme, è come funziona il
  // conto. Dirlo solo in ambra insegnava la regola nel momento peggiore per
  // impararla — e la conclusione (per il prodotto, il turno, la sessione) sta
  // nell'ispettore, a un click da qui.
  const ringCostHint = realContext
    ? realContext.level !== 'ok' && (realContext.reason ?? 'window') === 'cost'
      // Nessuna etichetta CITATA fra virgolette, e non è pignoleria: il bottone
      // dell'ispettore si chiamava «Compatta adesso», adesso si chiama
      // «Compatta», e in inglese «Compact». Una frase che promette un nome
      // esatto invecchia col nome — e queste stringhe non passano dall'i18n del
      // pannello, quindi nessun test le lega. Si dice DOVE si va, non come è
      // scritto sopra il bottone.
      ? '\nOgni chiamata a un tool rilegge questi token: è il costo per chiamata, non un problema di capienza. Apri l’ispettore per il conto e per compattare.'
      : realContext.level !== 'ok'
        ? '\nLa finestra si sta riempiendo: quando finisce, la conversazione viene compattata e si perde dettaglio. Apri l’ispettore per compattare adesso, quando costa meno.'
        : '\nOgni chiamata a un tool rilegge questi token: il costo è contesto × chiamate. Apri l’ispettore per il conto.'
    : '';
  const ringTitle = realContext
    ? `Contesto del modello: ${formatTokens(realContext.used)} / ${realContext.estimated ? '≈' : ''}${formatTokens(realContext.size)} (${realContext.percent}%)${realContext.model ? ` · ${realContext.model}` : ''}${ringCostHint}`
    : `Contesto iniettato (stima): ${budgetPercent}%`;

  // L'AVVISO DI CONTESTO, RIDOTTO A UN FATTO DERIVATO.
  //
  // Era uno stato: un riquadro che si apriva sopra il composer e un latch di
  // chiusura per motivo e per livello, perché un'interruzione larga quanto la
  // chat DEVE potersi zittire. La pastiglia accanto all'anello non interrompe
  // niente — sta dentro il bottone che già mostra la stessa misura — quindi non
  // c'è più niente da zittire, e con l'interruttore se ne vanno le due cose che
  // costava: uno stato per sessione da tenere allineato e la regola «il costo a
  // livello warn non merita il riquadro», che esisteva solo per non stare
  // addosso sempre. Adesso ogni livello non-`ok` si vede, perché vedersi costa
  // tre caratteri.
  //
  // Rosso vuol dire «stai per perdere pezzi di conversazione», e a farlo è solo
  // la finestra che finisce. Un prompt caro resta ambra anche a livello
  // critico: costa di più, non rompe niente.
  const contextNotice = (() => {
    if (!realContext || realContext.level === 'ok') return null;
    // `reason` assente = payload di un server più vecchio: si degrada a "window",
    // che è il comportamento storico.
    const reason = realContext.reason ?? 'window';
    const level = realContext.level as 'warn' | 'critical';
    return { ...realContext, reason, level, severe: level === 'critical' && reason === 'window' };
  })();

  // Context Inspector popover. Anchored to the ring button below; dismisses on
  // outside-pointer / Escape via the shared useDismissable contract (the ring
  // ref is in `refs` so clicking it to close doesn't immediately re-open).
  const [showContextPopover, setShowContextPopover] = useState(false);
  const contextBtnRef = useRef<HTMLButtonElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  const contextScrimRef = useRef<HTMLDivElement>(null);
  useDismissable({
    open: showContextPopover,
    onClose: () => setShowContextPopover(false),
    refs: [contextBtnRef, contextPopoverRef],
  });
  // Sul telefono l'ispettore è un foglio dal basso, e un foglio si spinge giù
  // col dito (hooks/useSheetDrag).
  useSheetDrag({
    enabled: showContextPopover && isMobile,
    sheetRef: contextPopoverRef,
    scrimRef: contextScrimRef,
    onClose: () => setShowContextPopover(false),
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
  //
  // La misura NON si fa nel corpo del render. Leggere `contextBtnRef.current`
  // durante il render è leggere un valore che a quel giro può ancora non
  // esistere: il primo render dopo l'apertura vedeva `null`, il popover non
  // veniva montato affatto, e ricompariva solo se qualcos'altro ri-renderizzava.
  // Qui il pannello si monta sempre e la POSIZIONE viene scritta sul nodo in un
  // layout effect — cioè a DOM pronto e prima che il browser dipinga. È anche il
  // motivo per cui non passa da uno stato: la posizione non decide cosa
  // renderizzare, quindi non deve costare un secondo render.
  const contextPopoverPanelRef = useRef<HTMLDivElement>(null);
  const contextPopoverOpen = showContextPopover && !!onUpdateTopic && !isMobile;
  useLayoutEffect(() => {
    if (!contextPopoverOpen) return;
    const place = () => {
      const anchor = contextBtnRef.current;
      const panel = contextPopoverPanelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 396))}px`;
      panel.style.visibility = 'visible';
    };
    place();
    // Il pannello si ridimensiona sotto al popover aperto (split trascinato,
    // finestra ridotta): senza questo il popover resta dov'era, staccato dal
    // suo bottone.
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [contextPopoverOpen]);

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

  /**
   * WAS THE LAST TURN INTERRUPTED, AND BY WHOM.
   *
   * The case "No answer" does not cover and cannot cover: that banner requires
   * the LAST message to be the user's, while a turn the watchdog killed leaves
   * its assistant bubble in place with everything it had written before dying.
   * Different shape, same question for whoever is watching: is it over, or am I
   * waiting for something that will never arrive?
   *
   * While the stream is alive nothing is said: the cause sits on a row the
   * server already closed, but a NEW turn on the same chat leaves it on the
   * page until the first new word lands.
   */
  const interruptedTurn = useMemo(() => {
    if (currentStreaming) return null;
    const last = currentMessages[currentMessages.length - 1];
    if (last?.role !== 'assistant') return null;
    return interruptedTurnOf(last);
  }, [currentMessages, currentStreaming]);

  /** What Retry resends: the last user message before the dead turn. */
  const lastUserText = useMemo(() => {
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role === 'user' && m.content?.trim()) return m.content;
    }
    return null;
  }, [currentMessages]);

  // Dettatura. Il testo entra AL CURSORE, non in coda: chi detta a metà di una
  // frase già scritta si aspetta che la voce continui da lì, ed è anche l'unico
  // modo per dettare due volte di seguito senza rimescolare l'ordine.
  const messageRef = useRef(message);
  useEffect(() => { messageRef.current = message; }, [message]);

  const insertDictated = useCallback((text: string) => {
    const ta = textareaRef.current;
    const current = messageRef.current;
    const at = ta && ta.selectionStart != null && document.activeElement === ta ? ta.selectionStart : current.length;
    const before = current.slice(0, at);
    const after = current.slice(at);
    const sepBefore = before && !/\s$/.test(before) ? ' ' : '';
    const sepAfter = after && !/^\s/.test(after) ? ' ' : '';
    const head = before + sepBefore + text;
    setMessage(head + sepAfter + after);
    // Il cursore va dopo il testo appena dettato — altrimenti la dettatura
    // successiva lo inserirebbe PRIMA di quella di un istante fa.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(head.length, head.length);
    });
  }, [setMessage, textareaRef]);

  const onDictationError = useCallback((m: string) => toast.error(m), [toast]);
  // Not an error: the text is in the field. But «it took 20 seconds» has a
  // reason, and the reason is the thing to fix (a dead cloud key, 2026-09-03).
  const onDictationNotice = useCallback((m: string) => toast.warning(m, 9000), [toast]);
  const {
    isListening,
    isTranscribing: isDictationTranscribing,
    isSupported: sttSupported,
    modelLabel: dictationModel,
    since: dictationSince,
    level: dictationLevel,
    toggle: toggleListening,
    cancel: cancelDictation,
  } = useDictation({ onText: insertDictated, onError: onDictationError, onNotice: onDictationNotice });

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

  // Escape mentre si detta CHIUDE il microfono buttando via l'audio. Senza,
  // l'unico modo di annullare era premere stop e poi cancellare a mano il testo
  // — e nel frattempo la trascrizione era già stata pagata.
  useEffect(() => {
    if (!isListening) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelDictation();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [isListening, cancelDictation]);

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
    const builtin = SLASH_COMMANDS.map((c) => ({ cmd: c.cmd, description: tr(c.descriptionKey) }));
    const builtinNames = new Set(builtin.map((c) => c.cmd));
    const custom = customCmds
      .map((c) => ({ cmd: '/' + c.name, description: c.description || (c.kind === 'skill' ? 'Skill' : 'Comando') }))
      .filter((c) => !builtinNames.has(c.cmd));
    return [...builtin, ...custom];
    // `tr` changes identity when the catalogue of the chosen language lands:
    // without it here the menu would keep the fallback language until something
    // else redrew it.
  }, [customCmds, tr]);

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

  // ── L'altezza del campo la decide il testo, non le righe ─────────────────
  //
  // Il campo nasce alto una riga e cresce con quello che scrivi, fino a 140px
  // (poi scorre). Stava in ChatPane, su `[message]`: è tornato qui perché
  // dipende anche dalla LARGHEZZA del campo, e quella la conosce solo il
  // composer. `useLayoutEffect` perché la correzione deve arrivare prima del
  // disegno, o si vede lampeggiare l'altezza vecchia.
  const MAX_COMPOSER_H = 140;
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, MAX_COMPOSER_H) + 'px';
  }, [message, textareaRef]);

  // …e quando la pane si allarga o si stringe. Trascinare un divisore o
  // rimpicciolire la finestra cambia quante righe occupa lo stesso testo, e
  // senza questo restava l'altezza della larghezza di prima: sotto il testo
  // avanzava il vuoto (o, stringendo, l'ultima riga finiva sotto il bordo).
  // Si reagisce alla sola LARGHEZZA: l'altezza la scriviamo noi qui dentro, e
  // ascoltarla sarebbe un anello che si rincorre.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let lastWidth = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = ta.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, MAX_COMPOSER_H) + 'px';
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [textareaRef]);

  return (
    <>
      {/* Status banners (outside floating card) */}
      {isCallActive && (
        <div className={`${CHAT_STRIP} bg-gradient-to-r from-green-500/20 to-blue-500/20 border border-green-500/30 px-3 py-2 flex items-center gap-3 flex-shrink-0`}>
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

      {/* Dettatura. La striscia esiste perché il microfono aperto è uno stato
          INVISIBILE: senza, l'unico segnale era il colore di una voce dentro un
          menu chiuso, e «perché non scrive niente?» non aveva risposta a schermo.
          Dice anche CHI sta ascoltando (provider + modello) e come si annulla. */}
      {(isListening || isDictationTranscribing) && !isCallActive && (
        <DictationStrip
          state={isDictationTranscribing ? 'transcribing' : 'listening'}
          since={dictationSince}
          level={dictationLevel}
          engine={dictationModel}
          hint={tr('chat.dictation.hint')}
          onStop={toggleListening}
        />
      )}

      {/* AN INTERRUPTED TURN IS AN EVENT, not a footnote.
          On 2026-09-03 the only sign of a turn closed by the watchdog was
          "[Response timed out]" appended at the bottom of a long message, and
          the chat looked "stuck with no feedback at all": the why was in the
          server log and there was no way out. Here the cause is the one the
          server wrote on the row (`cause`, the `stream:end` vocabulary), the
          sentence is ours and in the reader's language, and Retry resends the
          last message instead of leaving it to guesswork. It clears itself:
          the memo recomputes on the messages, and the first new row is not an
          interrupted turn any more. */}
      {(serverResuming || interruptedTurn) && (
        <div
          data-testid="turn-interrupted-banner"
          data-state={serverResuming ? 'resuming' : 'interrupted'}
          {...(interruptedTurn ? { 'data-cause': interruptedTurn.cause } : {})}
          className={`${CHAT_STRIP} px-3 py-2 flex items-center gap-2 flex-shrink-0 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40`}
        >
          {serverResuming && (
            <Spinner size="sm" tone="current" className="text-amber-600 dark:text-amber-500 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
              {tr(serverResuming ? 'chat.turnInterrupted.resuming' : 'chat.turnInterrupted')}
            </div>
            <div className="text-[11px] text-amber-600 dark:text-amber-500 truncate">
              {serverResuming
                ? tr('chat.turnInterrupted.resuming.detail')
                : interruptedTurn && tr(TURN_CAUSE_KEY[interruptedTurn.cause])}
            </div>
          </div>
          {/* NO RETRY WHILE A RESUME IS RUNNING. The button resends the same
              message, and the server is resending it already: the second turn
              would land on a chat that has one open (`stream_in_flight`) and
              be paid for twice. The button comes back by itself if the resume
              ends badly, because then this is an interrupted turn again. */}
          {!serverResuming && interruptedTurn && lastUserText && (
            <button
              data-testid="turn-interrupted-retry"
              onClick={() => { void sendMessageDirect(lastUserText); }}
              className="px-3 py-1.5 text-[11px] rounded-md transition-colors flex items-center gap-1 bg-amber-500 text-white hover:bg-amber-600"
            >
              <span>↻</span> {tr('chat.turnInterrupted.retry')}
            </button>
          )}
        </div>
      )}

      {/* Nessuna risposta dopo un messaggio tuo. La CAUSA non si legge dalla
          pagina: uno stop precoce cancella la bolla vuota e lascia esattamente
          la stessa forma di un turno mai arrivato. Senza distinguerle, premere
          «ferma» faceva comparire «la connessione può essersi interrotta» —
          il composer accusava la rete di una cosa che avevi appena fatto tu.

          E IL TURNO ANCORA VIVO NON DEVE PASSARE DI QUI. Il commento che stava
          qui sosteneva che `currentStreaming` bastasse «anche dopo un reload»:
          non è vero, e il 19/08 è arrivato il referto — messaggio inviato,
          finestra ricaricata, scatola ambra «la connessione può essersi
          interrotta» su un agente che stava lavorando. `currentStreaming` legge
          la mappa `streaming` di `useChat`, che è memoria di PROCESSO e muore
          col reload; `reconcileServerStreams` fa il verso opposto a quello che
          serviva (spegne gli spinner rimasti accesi, non li riaccende).
          Il secondo testimone è il registro del server, che sopravvive:
          `GET /api/topics/streaming` → `hydratedStreamTopics` → `useTopicLoading`.
          La regola sta in `turnLooksUnanswered`, con i suoi test. */}
      {turnLooksUnanswered({
        lastMessageIsUser: currentMessages[currentMessages.length - 1]?.role === 'user',
        locallyStreaming: currentStreaming,
        serverSaysOpen: serverTurnOpen,
        serverAsked: serverTurnAsked,
      }) && (
        <div
          data-testid="no-reply-banner"
          data-reason={stoppedByUser ? 'stopped' : 'interrupted'}
          className={`${CHAT_STRIP} px-3 py-2 flex items-center gap-2 flex-shrink-0 ${
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

      {/* IL PREAVVISO DI CONTESTO NON È PIÙ UNA STRISCIA.
          Era un riquadro colorato largo quanto la chat, con due bottoni e una
          spiegazione su due righe, incollato sopra il composer finché non lo si
          chiudeva a mano: per dire «questa conversazione si sta riempiendo»
          occupava lo spazio di un messaggio e spostava la conversazione ogni
          volta che compariva. Un avviso che ruba più spazio del contenuto è un
          avviso che si impara a chiudere senza leggerlo.
          Adesso vive ACCANTO ALL'ANELLO, che è già l'indicatore del contesto:
          una pastiglia con la percentuale (vedi `contextNotice` nella action
          bar più sotto). Le due vie d'uscita non sono sparite — «Compatta
          adesso» sta nell'ispettore, a un click dall'anello, che è dove si sta
          già guardando quanto è pieno. */}
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

      {/* La coda NON si disegna più qui.
          C'era un badge a scomparsa con dentro le stesse righe che il trascritto
          mostra già come bolle «da inviare»: la stessa coda scritta due volte a
          due centimetri di distanza, e le AZIONI (correggi, butta, svuota,
          invia subito) solo in quella nascosta delle due. Adesso vivono sulla
          bolla che riguardano — vedi `QueuedTurns`. */}

      {/* Il composer: LA CARD è solo il campo di testo, e i controlli stanno
          FUORI, sotto. La card portava dentro anche loro, e finiva per
          disegnare un riquadro attorno a due cose diverse — quello che scrivi e
          gli interruttori della sessione — come se fossero la stessa. Il bordo
          adesso recinta soltanto ciò in cui si scrive.
          Il `<form>` resta il contenitore di entrambi (l'invio parte da lui) ma
          non ha più nessun vestito: niente bordo, niente fondo, niente ombra. */}
      <form
        onSubmit={onSubmit}
        // @container: the action-bar row below keys its shrink/scroll
        // behavior off THIS element's width (the pane/tab), not the
        // viewport — panes can be resized far narrower than any viewport
        // breakpoint would ever fire at.
        className={`relative @container ${isMobile ? 'm-2' : 'm-3'} flex-shrink-0 min-w-0 max-w-full`}
        // L'HOME INDICATOR LO SCAVALCA IL COMPOSER, non la pane.
        //
        // «Il bordo dell'input nelle chat tocca i bordi sull'iPhone»: il suo
        // margine sono 8px, e sotto una striscia di sistema da 34 non si vedono.
        // Il primo rimedio metteva la safe-area su `#main-content`, cioè alzava
        // TUTTO il contenuto — «non dovevi alzare tutta l'app ma solo l'input,
        // ora la chat è tagliata nella safe area sotto». Giusto: la
        // conversazione perdeva quei 34px di altezza utile per una striscia
        // sotto cui può benissimo scorrere.
        //
        // L'home indicator è un trattino su fondo TRASPARENTE: il contenuto ci
        // passa sotto senza danno, deve solo non finirci sotto qualcosa da
        // TOCCARE. Quindi la spinta la prende solo chi si tocca. `max(…)` e non
        // una somma: dove la safe-area è più stretta del margine (o è zero, cioè
        // ovunque tranne un iPhone) resta il margine di sempre, e la riga non
        // cambia niente per nessun altro.
        style={{ maxWidth: '100%', marginBottom: 'max(var(--composer-gap), env(safe-area-inset-bottom, 0px))' }}
      >
        {isRecording ? (
          <div className={`${COMPOSER_CARD} flex gap-2 items-center p-3`}>
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
          <div className={COMPOSER_CARD} data-testid="composer-card">
            {/* Row 0: Attachments preview (inside card) */}
            {hasAttachments && (
              <div className="px-3 pt-2.5 flex flex-wrap gap-1.5">
                {pendingImages.map((img, index) => (
                  <div key={`img-${index}`} data-testid="composer-attachment" className="relative inline-block">
                    <ZoomableImage src={img.dataUrl} alt="Pasted image" className="h-[80px] max-w-[160px] object-cover rounded-lg border border-app-border-light" />
                    <button type="button" onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== index))} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600">×</button>
                  </div>
                ))}
                {pendingFiles.map((file, index) => (
                  <div key={`file-${index}`} data-testid="composer-attachment">
                    {isImageFile(file) ? (
                      <ImageThumbnail file={file} onRemove={() => removePendingFile(index)} />
                    ) : (
                      <div className="relative flex items-center gap-1.5 bg-app-hover rounded-lg px-2 py-1 text-[11px]">
                        <Paperclip size={14} className="text-app-text-tertiary" />
                        <span className="max-w-24 truncate text-app-text-secondary">{file.name}</span>
                        <button type="button" onClick={() => removePendingFile(index)} className="ml-0.5 text-red-400 hover:text-red-500 font-bold text-xs">×</button>
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
                <button type="button" onClick={onCancelEdit} className="text-app-text-tertiary hover:text-app-text p-0.5" title="Cancel edit">
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
                <button type="button" aria-label={tr('chat.cancelReply')} onClick={() => setReplyingTo(null)} className="text-app-text-tertiary hover:text-app-text p-0.5">
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

            {/* LA CARD È UNA RIGA: «+», il testo, il microfono, invio. Erano
                due — il testo sopra e i tre gesti sotto — e a riposo la card
                costava il doppio dell'altezza per dire la stessa cosa.
                Qui accanto al testo ci stanno solo tre quadratini da 32px, non
                il gruppo dei controlli di sessione (che è largo ~330px ed è per
                questo che è finito FUORI, sotto la card): il campo si tiene
                tutto il resto della larghezza.
                `items-end`: quando il testo va a capo la colonna cresce verso
                l'alto e i bottoni restano incollati al fondo, allineati alla
                riga che stai scrivendo. */}
            <div className="flex items-end gap-1 px-1.5 py-1.5">
              <AddMenu
                onAttach={() => fileInputRef.current?.click()}
                onExport={onExportConversation}
                isCallActive={isCallActive}
                isListening={isListening}
                isSpeaking={isSpeaking}
                autoTTS={autoTTS}
                voiceCallSupported={voiceCallSupported}
                sttSupported={sttSupported}
                currentStreaming={currentStreaming}
                uploading={uploading}
                dictationBusy={isDictationTranscribing}
                dictationModel={dictationModel}
                toggleCall={toggleCall}
                toggleListening={toggleListening}
                stopSpeaking={stopSpeaking}
                setAutoTTS={setAutoTTS}
                onSlashCommand={(cmd) => {
                  setMessage(cmd + ' ');
                  textareaRef.current?.focus();
                }}
              />

              {/* `min-w-[4rem]` è il pavimento del campo: con `flex-1` la base è
                  0, quindi in una pane strettissima lo schiacciamento cadrebbe
                  tutto qui (campo largo zero) e i tre bottoni resterebbero
                  interi. Con un minimo, la riga sfonda prima di far sparire il
                  posto dove si scrive. */}
              <textarea
                ref={textareaRef}
                data-testid="chat-message-input"
                value={message}
                onChange={handleMessageChange}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                aria-label={`Message input for ${topic.name}`}
                aria-describedby="chat-input-hint"
                placeholder={awaitingAnswer ? tr('chat.answerPlaceholder') : replyingTo ? 'Reply...' : topic.projectPath ? 'Message... (@ to mention files)' : 'Message...'}
                className={`flex-1 min-w-[4rem] px-1.5 py-1.5 leading-5 bg-transparent text-app-text placeholder-app-placeholder resize-none overflow-y-auto focus:outline-none focus-visible:outline-none ${isMobile ? 'text-[16px]' : 'text-[13px]'}`}
                style={{ minHeight: '32px', maxHeight: '140px' }}
                rows={1}
                disabled={uploading}
              />
              <span id="chat-input-hint" className="sr-only">Press Enter to send, Shift+Enter for new line. Type / for commands.</span>

              {/* In coda alla riga: il microfono e l'invio, e nient'altro.
                  `flex-shrink-0`: questi due non si stringono MAI. */}
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {/* Il tasto per DETTARE, l'unico ammesso prima dell'invio: è la
                    seconda strada per riempire questo campo, quindi sta dove
                    finisce di riempirsi. Il resto della voce (dettatura del
                    browser, chiamata, lettura ad alta voce) resta nel «+»,
                    perché sono modalità, non un gesto singolo. */}
                <button
                  type="button"
                  onClick={() => { if (isRecording) stopRecording(); else startRecording(); }}
                  className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg transition-all ${
                    isRecording ? 'bg-red-500 text-white animate-pulse' : 'text-app-text-tertiary hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={`${isRecording ? 'Stop recording' : 'Record voice'} (${shortcut('R', { shift: true })})`}
                  aria-label={isRecording ? 'Stop recording' : 'Record voice'}
                  disabled={currentStreaming || uploading}
                >
                  {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
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
                      title={isAnswer ? tr('chat.answerSend') : isQueue ? 'Queue message (Enter)' : 'Send (Enter)'}
                      aria-label={isAnswer ? tr('chat.answer') : isQueue ? 'Queue message' : 'Send message'}
                    >
                      {uploading ? (
                        /* `current`: il bottone porta già il suo colore
                           (`text-white` sul pieno, il testo tenue quando è
                           spento), e l'anello lo eredita invece di ricopiarsi
                           un bianco che sul bottone spento era invisibile. */
                        <Spinner size="sm" tone="current" />
                      ) : (
                        <Send size={14} />
                      )}
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>

            {/* FUORI DALLA CARD: le condizioni con cui il messaggio parte.
                Non sono il messaggio — chi risponde, quanto può fare da sé,
                quanto ci pensa — quindi non stanno nel recinto di quello che
                scrivi. Dentro la card restano i tre gesti che agiscono su di
                lui: aggiungere, dettare, spedire.
                min-w-0 le lascia stringere sotto la loro larghezza naturale e
                overflow-x-auto le fa SCORRERE invece di tagliarle quando la
                pane non le tiene tutte. Perché scorra davvero, i bottoni
                dentro devono essere `flex-shrink-0`: senza, il default
                `flex-shrink: 1` li SCHIACCIAVA invece di farli traboccare — a
                390px di viewport i quadrati da 32px misuravano 20.9px
                (misurato da `chat-layout-audit`, sotto il minimo WCAG 2.2 di
                24px), con l'icona da 16px in un box storto. */}
            <div className="flex items-center gap-0.5 min-w-0 px-0.5 pt-1.5 overflow-x-auto scrollbar-hide">
              {/* I PERMESSI PER PRIMI: è l'unica leva di questa riga che
                  decide se l'agente può toccare i tuoi file, ed è quindi la
                  cosa da guardare prima di premere invio — non l'ultima
                  pastiglia in fondo alla fila. Le altre tre dicono COME
                  risponde (veloce, quale modello, quanto ci pensa) e stanno
                  dietro, nell'ordine in cui le si cambia. */}
              {onAutonomyChange && (
                <AutonomyPicker value={autonomy ?? null} onChange={onAutonomyChange} />
              )}
              {/* Il «Plan Mode» stava QUI, ed era il secondo modo di fare la
                  stessa cosa: un interruttore in localStorage che iniettava
                  una RICHIESTA nel prompt («sei in plan mode, non toccare
                  niente») e che nessuno faceva rispettare, a quattro bottoni
                  di distanza dal selettore di autonomia — stessa icona, colore
                  diverso — che invece passa `--permission-mode plan` alla CLI
                  e i file non li fa proprio scrivere. Potevano contraddirsi,
                  e non si sincronizzava fra dispositivi.
                  La leva ora è una: «Propone prima» nel selettore qui accanto.
                  Il blocco di prompt non è andato perso — lo inietta la route
                  quando l'autonomia è `ask` (routes/chat.ts), così il piano
                  esce nel formato di sempre. */}
              {onToggleFastMode && fastUi && (
                <button
                  type="button"
                  onClick={onToggleFastMode}
                  className={`w-8 h-8 flex-shrink-0 flex flex-col items-center justify-center gap-px rounded-lg transition-colors ${
                    fastUi.pressed
                      ? 'text-amber-500 bg-amber-500/10'
                      : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={fastUi.title}
                  aria-label="Toggle fast mode"
                  aria-pressed={fastUi.pressed}
                  data-testid="chat-input-fast-mode"
                >
                  {/* IL LAMPO VUOL DIRE VELOCITÀ, E SOLO QUELLA.
                      Ne aveva dieci, di significati: il modello, l'autonomia
                      «Agisce», la corsa di tool, i processi del progetto, un
                      cron armato, un KPI, `/status`, la pane morta. Tre di
                      quelli stavano in QUESTA riga insieme a questo, quindi il
                      lampo non insegnava niente a nessuno. Adesso resta qui e
                      nella sezione «Prestazioni» del changelog — stessa cosa,
                      detta due volte. Prima di metterne un altro: dice
                      «veloce»? Se no, non è questo il glifo.
                      PIENO quando è acceso: in una riga tutta di contorni il
                      solo colore ambra non bastava a dire «attivo». */}
                  <Zap size={fastUi.costMultiplier ? 14 : 16} fill={fastUi.pressed ? 'currentColor' : 'none'} />
                  {/* Quanto costa: 2× lo stesso modello a velocità normale, dal
                      listino che la CLI scrive nei suoi stessi documenti
                      (10$/50$ contro 5$/25$ per 1M). «Più veloce» da solo non
                      è un'informazione finché non dici quanto costa.
                      Non interattivo: un badge che entrasse nel conteggio dei
                      bersagli tattili sarebbe un secondo bottone da 12px dentro
                      il primo. */}
                  {fastUi.costMultiplier && (
                    <span
                      className="pointer-events-none text-[9px] font-medium leading-none tabular-nums"
                      data-testid="fast-mode-cost"
                    >{fastUi.costMultiplier}×</span>
                  )}
                </button>
              )}
              {!isDraftTopic && (
                <button
                  ref={contextBtnRef}
                  type="button"
                  onClick={handleContextRingClick}
                  className={`h-8 flex-shrink-0 flex items-center justify-center gap-1 rounded-lg transition-colors ${
                    // La pastiglia allarga il bottone da quadrato a pillola:
                    // senza padding orizzontale la percentuale toccherebbe i
                    // bordi. Senza avviso resta il quadrato di sempre.
                    contextNotice ? 'w-auto px-1.5' : 'w-8'
                  } ${
                    showContextPopover
                      ? 'bg-primary/10 text-primary'
                      : contextNotice
                        ? contextNotice.severe
                          ? 'text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20'
                          : 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
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
                  {/* L'AVVISO, RIDOTTO A UN NUMERO ACCANTO ALLA SUA MISURA.
                      Il riquadro di prima aveva due bottoni e quattro righe di
                      prosa; qui c'è la sola cosa che cambia una decisione — a
                      che punto è — nel posto in cui la si sta già guardando.
                      Il perché (capienza o costo per chiamata) e il cosa fare
                      stanno nel tooltip e, un click più in là, nell'ispettore
                      col suo bottone per compattare.
                      `pointer-events-none`: il bersaglio da toccare resta uno
                      solo, il bottone che apre l'ispettore. */}
                  {contextNotice && (
                    <span
                      data-testid="context-notice"
                      data-context-level={contextNotice.level}
                      data-context-reason={contextNotice.reason}
                      className="pointer-events-none text-[10px] font-semibold leading-none tabular-nums"
                    >
                      {contextNotice.reason === 'cost'
                        ? formatTokens(contextNotice.used)
                        : `${contextNotice.percent}%`}
                    </span>
                  )}
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
      </form>

      {/* Context Inspector popover — anchored to the ring on desktop, a bottom
          sheet on mobile. Replaces the old docked side panel; both trigger
          points (this ring + the per-pane header button) drive it. */}
      {contextPopoverOpen && createPortal(
        <div
          ref={node => {
            contextPopoverRef.current = node;
            contextPopoverPanelRef.current = node;
          }}
          data-popover="context-inspector"
          className={`fixed ${POPOVER_PANEL} flex flex-col overflow-hidden`}
          // `visibility: hidden` per un solo fotogramma: il pannello è nel DOM
          // (serve, per misurarlo e per il click-outside) ma non lampeggia in
          // alto a sinistra prima che il layout effect lo collochi.
          style={{
            zIndex: Z_POPOVER,
            visibility: 'hidden',
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
            ref={contextScrimRef}
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
            <SheetGrabber />
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

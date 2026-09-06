import { useState, useEffect, useRef, useCallback, useMemo, forwardRef, type ComponentProps } from 'react';
import { Paperclip } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage, CompactionMarker } from '../../types';
import { ScrollToBottom, NewMessageBanner } from '../Shared/ScrollToBottom';
import { CompactionDivider } from './CompactionDivider';
import { LoadOlderDivider } from './LoadOlderDivider';
import { CompactionHoistContext } from './compactionHoist';
import { splitCompactionSummary } from '../../lib/compactionSummary';
import { partitionMarkers } from './partitionMarkers';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '../../lib/settings';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageBubble } from './MessageBubble';
import { clampScrollOffset } from '../../state/pane/adapters';
import {
  SCROLL_TO_MESSAGE_EVENT,
  peekScrollToMessage,
  consumeScrollToMessage,
  markScrollToMessageFired,
} from '../../state/scrollToMessage';
import {
  reduceScroll,
  shouldPin,
  isUserScrollUp,
  initialScrollAuthority,
  AT_BOTTOM_TOLERANCE_PX,
  BOTTOM_RELEASE_PX,
  type ScrollAuthorityState,
  type ScrollEvent,
} from './scrollAuthority';
import { coalesceToolRuns, type CoalescedMessage } from './coalesceToolRun';
import { SkeletonChatMessages } from '../Shared/Skeleton';
import { listPaintedAndWhole } from './listPaintedAndWhole';
import { decideHistoryCompletion } from './historyCompletionDecision';
import { isHistoryIncomplete, requestHistoryCompletion, useHistoryCompleteness } from '../../state/historyCompleteness';
import { usePaneAlive } from '../../state/paneLiveness';
import type { QueuedTurn } from '../../state/chatQueue';
import { QueuedTurns } from './QueuedTurns';

/**
 * La LISTA di Virtuoso, cappata alla misura di lettura.
 *
 * Il tetto va qui — sul contenuto — e non sullo scroller, per due motivi che
 * si vedono subito se si sbaglia: cappando lo scroller la barra di
 * scorrimento finisce in mezzo alla pane invece che sul suo bordo, e ci si
 * scollano i due elementi che sono `absolute inset-0` rispetto a lui
 * (l'overlay del drop dei file, l'ancoraggio del bottone «torna in fondo»).
 * Tutta la geometria dell'autorità di scroll è VERTICALE, quindi un cap
 * orizzontale su un discendente le è invisibile.
 *
 * Definita a livello di modulo: un'identità nuova a ogni render farebbe
 * rimontare l'intero subtree della lista a ogni token di streaming.
 *
 * `{...props}` PRIMA di className, e non è pignoleria: da lì arriva
 * `data-testid="virtuoso-item-list"`, che l'osservatore della crescita
 * (`ro.observe(lista)`, più sotto) usa per trovare questo elemento.
 */
/**
 * Il respiro fra l'ultima risposta e il composer, in pixel.
 *
 * Sta qui e non in una classe perché è ALTEZZA RISERVATA dentro il contenuto
 * scrollato (il Footer di Virtuoso), non un margine: dev'essere un numero che
 * il calcolo della posizione conosce.
 */
const CHAT_BOTTOM_GUTTER_PX = 24;

/**
 * LA FASCIA DIETRO L'INPUT NON È UN POSTO DOVE VA IL TESTO.
 *
 * Il composer galleggia sopra il trascritto (`absolute bottom-0` in ChatPane) e
 * il trascritto ci passa sotto: è il punto dell'overlay. Il difetto era cosa
 * succedeva AL BORDO — la scatola opaca del composer tagliava di netto la riga
 * che gli scorreva dietro, e restava lì una mezza riga illeggibile: né presente
 * né assente.
 *
 * Qui il testo non viene tagliato: si SPEGNE. Una maschera sullo scroller porta
 * l'inchiostro a zero PRIMA del bordo superiore del composer, così la fascia
 * dietro l'input non contiene mai pittura — non è una tinta stesa sopra (che
 * dovrebbe indovinare il colore del vetro che ha dietro, e sbaglierebbe), è
 * l'alfa del contenuto stesso.
 *
 * La rampa vale ESATTAMENTE il varco che il Footer già riserva: da fermo, sotto
 * l'ultima riga, quei 24px sono vuoti per costruzione — quindi da fermo la
 * maschera non sbiadisce nulla, e si vede solo quando scorri. Allungarla
 * significherebbe scolorire l'ultima risposta di una chat ferma.
 */
const INK_FADE_RAMP_PX = CHAT_BOTTOM_GUTTER_PX;

const ChatList = forwardRef<HTMLDivElement, ComponentProps<'div'>>(
  function ChatList({ className, ...props }, ref) {
    return <div {...props} ref={ref} className={`${className ?? ''} chat-measure`} />;
  },
);

/** Identità stabile per la coda assente: un `[]` nuovo a ogni render farebbe
 *  ricostruire la mappa `components` di Virtuoso a ogni token di streaming. */
const NO_QUEUED: QueuedTurn[] = [];
/** The leading compaction dividers of a PARTIAL transcript: none, see `itemContent`. */
const NO_MARKERS: CompactionMarker[] = [];

interface MessageListProps {
  isMobile: boolean;
  topic: Topic;
  currentMessages: ChatMessage[];
  /** Compaction dividers for this session (CHAT-COMPACT-01); folded into the
   *  transcript by afterMessageId. */
  compactionMarkers?: CompactionMarker[];
  currentLoading: boolean;
  currentStreaming: boolean;
  copiedMsgId: string | null;
  fileDragOver: boolean;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onReply: (msg: ChatMessage) => void;
  onCopy: (msg: ChatMessage) => void;
  onTogglePin: (msg: ChatMessage) => void;
  onFileDragOver: (e: React.DragEvent) => void;
  onFileDragLeave: (e: React.DragEvent) => void;
  onFileDrop: (e: React.DragEvent) => void;
  onPlanDecision?: (approved: boolean) => void;
  onRemember?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  onRegenerate?: (msg: ChatMessage) => void;
  onDeleteMessage?: (msg: ChatMessage) => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onRetry?: () => void;
  inputAreaHeight?: number;
  /**
   * Vero quando il composer è al CENTRO della pane (chat vuota / handoff): lì
   * `inputAreaHeight` comprende anche l'invito, non è la fascia in fondo, e
   * spegnere l'inchiostro su quella misura cancellerebbe mezza pane.
   */
  composerCentered?: boolean;
  /**
   * PANE-03 scroll restore (review I1). When set to a finite positive value
   * at mount, the scroller's scrollTop is restored to it (clamped to content
   * height) AFTER Virtuoso's default bottom-anchor. Used by ChatPane's undo
   * path — leave undefined for normal opens.
   */
  initialScrollOffset?: number;
  /**
   * Fired (throttled) when the user scrolls. Lets the parent persist the
   * current position on the pane so a later close+undo can restore it.
   */
  onScrollOffsetChange?: (scrollTop: number) => void;
  /**
   * I messaggi SCRITTI e non ancora partiti (`state/chatQueue.ts`), in coda
   * dietro al turno in corso. Finiscono in fondo al trascritto con la faccia
   * dell'attesa, con tutto quello che ci si può fare: vedi `QueuedTurns`.
   * Sono l'UNICA rappresentazione della coda — il badge del composer che
   * mostrava le stesse righe è stato tolto (vedi il docstring di `QueuedTurns`).
   */
  queuedTurns?: QueuedTurn[];
  /** Correggi una riga in attesa, per ID. */
  onUpdateQueued?: (id: string, content: string) => void;
  onRemoveQueued?: (id: string) => void;
  onClearQueue?: () => void;
  /** Ferma il turno in volo e fa partire la coda adesso. */
  onSendQueueNow?: () => void;
  /** Un turno è in volo: solo allora «invia subito» ha qualcosa da anticipare. */
  queueBusy?: boolean;
}

export function MessageList({
  isMobile,
  topic,
  currentMessages,
  compactionMarkers,
  currentLoading,
  currentStreaming: _currentStreaming,
  copiedMsgId,
  fileDragOver,
  chatContainerRef,
  messagesEndRef,
  onReply,
  onCopy,
  onTogglePin,
  onFileDragOver,
  onFileDragLeave,
  onFileDrop,
  onPlanDecision,
  onRemember,
  onEdit,
  onRegenerate,
  onDeleteMessage,
  onSwitchBranch,
  onMessage,
  onRetry,
  inputAreaHeight = 0,
  composerCentered = false,
  initialScrollOffset,
  onScrollOffsetChange,
  queuedTurns,
  onUpdateQueued,
  onRemoveQueued,
  onClearQueue,
  onSendQueueNow,
  queueBusy,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  /**
   * Lo stesso elemento, ma come STATO — e non è un doppione.
   *
   * Virtuoso consegna lo scroller via `scrollerRef`, cioè scrivendo in un ref:
   * niente render. L'effetto che aggancia `wheel`/`scroll` girava quindi al
   * mount, trovava `null`, usciva subito, e non si rimontava più (le sue
   * dipendenze non cambiano da sole). Risultato: fuori da uno stream i
   * listener spesso non erano attaccati a NIENTE, l'autorità non veniva mai a
   * sapere che l'utente aveva scrollato, e la vista si riagganciava al fondo a
   * caso — «l'aggancio sembra buggato», ed era questo. Con lo stato, l'effetto
   * si rilega nell'istante in cui l'elemento esiste.
   */
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  /**
   * La callback ref per Virtuoso, STABILE, e la stabilità è tutto il punto.
   *
   * Era una freccia scritta inline dentro il JSX. Una freccia inline è una
   * funzione NUOVA a ogni render, e React tratta un cambio di identità della
   * callback ref come uno scollegamento: chiama la vecchia con `null` e la nuova
   * con l'elemento. Ogni render ne faceva quindi partire DUE, con il valore che
   * alternava `null` e lo scroller — per cui la guardia `prev === el` qui sotto
   * non poteva scattare mai, e ognuna delle due chiamate faceva un render.
   *
   * Fuori da una raffica non si vede: i render sono radi e il ciclo si spegne da
   * solo. Dentro una raffica no. MISURATO il 2026-08-16: 120 messaggi da 4 KB
   * versati in una chat a schermo uccidono la pane fra il messaggio 40 e il 70
   * con React #185 «Maximum update depth exceeded», zero messaggi disegnati e la
   * schermata «Questa pane si è rotta». Lo stack nomina `scrollerRef`. Ed è il
   * caso d'uso centrale del prodotto: un agente che scarica output di tool in
   * fretta fa esattamente questo.
   *
   * Con `useCallback` a dipendenze vuote l'identità non cambia più, quindi React
   * la invoca solo quando il NODO cambia davvero. `scrollerElRef` è un oggetto
   * ref e `setScrollerEl` un setter di stato: entrambi stabili per contratto,
   * quindi le dipendenze vuote sono corrette e non catturano niente di stantio.
   */
  const scrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    const el = (ref as HTMLElement | null) ?? null;
    scrollerElRef.current = el;
    // Anche come stato: è l'unica via perché l'effetto dei listener si accorga
    // che lo scroller è arrivato (vedi `scrollerEl` qui sopra).
    setScrollerEl((prev) => (prev === el ? prev : el));
  }, []);
  // UNA sola autorità sull'ancoraggio (1b.3). Prima erano tre ref che si
  // riparavano a vicenda — `isScrolledUpRef`, `userIntentUpRef`,
  // `scrollGuardRef` — e otto punti che pinnavano il fondo, ognuno con un
  // sottoinsieme DIVERSO di quei tre come guardia; ogni bug live è nato da un
  // punto che leggeva il sottoinsieme sbagliato. Ora la decisione sta tutta in
  // `reduceScroll` (puro, testato in scrollAuthority.test.ts) e qui restano
  // solo gli EFFETTI: mandare l'evento e, se la risposta è sì, pinnare.
  const authorityRef = useRef<ScrollAuthorityState>(initialScrollAuthority);
  // Specchio a schermo di `!anchored`: serve solo a bottone "torna in fondo" e
  // banner. Non è una seconda autorità — nessuno lo legge per decidere.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const lastScrollTopRef = useRef(0);
  /** Il punto più alto da cui l'utente sta scendendo DENTRO un gesto: serve a
   *  sommare i cali piccoli di un trackpad o di un dito. Vedi `onScroll`. */
  const scrollUpAnchorRef = useRef(0);
  const prevStreamingRef = useRef(false);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [showNewBanner, setShowNewBanner] = useState(false);
  const prevMsgCountRef = useRef(currentMessages.length);
  const prevTopicIdRef = useRef(topic.id);
  const needsScrollRef = useRef(false);
  const prevLoadingRef = useRef(false);
  // Read settings into state instead of calling loadSettings() in the render
  // body — MessageList re-renders on every streaming token, so the old inline
  // read ran a synchronous localStorage.getItem + JSON.parse per token on the
  // hottest component. Refresh only when settings actually change.
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    const reload = () => setSettings(loadSettings());
    window.addEventListener(SETTINGS_CHANGED_EVENT, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reload);
      window.removeEventListener('storage', reload);
    };
  }, []);
  const isCompact = settings.messageDensity === 'compact';

  /**
   * Lo stile dello SCROLLER, maschera compresa (vedi `INK_FADE_RAMP_PX`).
   *
   * La maschera sta sullo scroller e non sul contenuto perché il suo riquadro
   * di riferimento è la scatola dell'elemento, non il contenuto: resta ferma in
   * fondo alla viewport mentre i messaggi ci scorrono dentro. Sul contenitore
   * esterno non si può: lì dentro vive anche il bottone «torna in fondo», che
   * si spegnerebbe con lui.
   *
   * Niente maschera quando la fascia non esiste (composer al centro, altezza
   * non ancora misurata): un `undefined` lascia lo scroller esattamente com'era.
   */
  const scrollerStyle = useMemo(() => {
    const band = Math.round(inputAreaHeight);
    if (composerCentered || band <= 0) return { height: '100%' };
    const mask = `linear-gradient(to bottom, #000 0, #000 calc(100% - ${band + INK_FADE_RAMP_PX}px), transparent calc(100% - ${band}px))`;
    return { height: '100%', maskImage: mask, WebkitMaskImage: mask };
  }, [inputAreaHeight, composerCentered]);

  // Stable Virtuoso `components` map: a fresh object + Footer fn identity every
  // render defeats Virtuoso's bailout, so the footer churned per streaming
  // token. Il Footer dipende da `inputAreaHeight` e dalla coda, e nessuna delle
  // due cambia per token: la coda arriva da `useChatQueue`, che tiene fermo lo
  // stesso array finché nessuno la tocca.
  const queued = queuedTurns ?? NO_QUEUED;
  const virtuosoComponents = useMemo(() => ({
    // Il Footer riserva l'altezza del composer PIÙ un varco fisso.
    //
    // Misurato prima di metterlo: fra l'ultima riga di risposta e il bordo del
    // composer c'erano SEI pixel — cioè il testo ci stava appiccicato — e
    // bastava che l'area input si RESTRINGESSE (il banner di compattazione che
    // si chiude, le righe del composer che si riassorbono) perché diventassero
    // ZERO, con in più sei pixel di scroll residuo che nessuno chiudeva.
    //
    // Il varco non è decorazione: è il margine che assorbe l'ULTIMO
    // assestamento. Ogni cosa che arriva tardi — un'altezza rimisurata, un
    // font che si assesta, un banner che compare — si mangia lo spazio sotto
    // l'ultima riga, e senza margine se lo mangia dal TESTO. Ventiquattro
    // pixel: poco, dentro la banda in cui stanno le superfici di chat serie, e
    // abbastanza da non far mai toccare le due cose.
    //
    // Qui dentro, SOPRA il varco, stanno anche le bolle di quello che è ancora
    // in coda (`QueuedTurns`). Il posto non è arbitrario: lo scroller di
    // Virtuoso è alto quanto tutta la cella (`height: 100%` in `scrollerStyle`),
    // quindi qualunque cosa appesa DOPO la lista nascerebbe sotto il bordo
    // inferiore, in un secondo scroller che nessuno scorre. Dentro il Footer
    // invece crescono attaccate all'ultima risposta, e la loro crescita passa
    // da `totalListHeightChanged`, cioè dall'aggancio che tiene la vista in
    // fondo.
    Footer: () => (
      <>
        <QueuedTurns
          turns={queued}
          isMobile={isMobile}
          onUpdate={onUpdateQueued}
          onRemove={onRemoveQueued}
          onClear={onClearQueue}
          onSendNow={onSendQueueNow}
          busy={queueBusy}
        />
        <div style={{ height: inputAreaHeight + CHAT_BOTTOM_GUTTER_PX }} />
      </>
    ),
    // IL VARCO IN CIMA È IL GEMELLO DEL FOOTER, e nasce dallo stesso fatto: la
    // conversazione confina con del CHROME, non con il bordo della finestra.
    //
    // Da quando la barra delle tab è un vetro fuori dal flusso
    // (`.pane-chrome-bar`), la cella della chat comincia SOTTO di lei: senza
    // questo varco il primo messaggio nascerebbe già coperto. Con, a riposo non
    // c'è niente di nascosto — e scorrendo i messaggi le passano sotto, che è
    // tutto il punto dell'overlay.
    //
    // Altezza in `var()` e non in pixel, al contrario del Footer, e la
    // differenza è chi conosce il numero. L'altezza del composer la MISURA
    // JavaScript (`inputAreaHeight`), quindi tanto vale sommarla lì; quella
    // della barra è una costante dichiarata dalla card che la possiede
    // (CHROME_BAR_H_VAR), e leggerla in CSS evita di ricopiarla in un terzo
    // posto. Virtuoso misura l'Header col suo ResizeObserver, quindi il numero
    // risolto lo scopre da sé.
    //
    // La variabile è `--chat-gutter` e NON `--chrome-bar-h`, e la differenza è
    // il caso in cui sopra il trascritto c'è un banner: lì il rientro se l'è
    // già preso la cella, e questo varco deve valere zero o i 40px si contano
    // due volte. A deciderlo è UNA regola CSS (`.chat-under-chrome:first-child`,
    // index.css) che accende insieme il margine negativo e il varco: da qui non
    // si vede la condizione, si legge solo il risultato.
    //
    // Il default è 0: una lista montata dove non c'è nessuna barra sopra —
    // oggi nessuna, domani chissà — non si prende un buco per sbaglio.
    Header: () => <div data-testid="chat-top-gutter" style={{ height: 'var(--chat-gutter, 0px)' }} />,
    List: ChatList,
  }), [inputAreaHeight, queued, isMobile, onUpdateQueued, onRemoveQueued, onClearQueue, onSendQueueNow, queueBusy]);

  /**
   * LA CODA VIVA SI SEPARA DAL RESTO — perché è l'unica cosa che cambia.
   *
   * Durante un turno arriva un array nuovo a ogni frame, ma dentro c'è UN solo
   * oggetto diverso: la bolla in streaming, che è l'ultima ed è `partial`. Tutto
   * il resto è identico per riferimento. Passando l'array intero ai tre memo qui
   * sotto, però, ogni frame li invalidava tutti e tre: si rifiltrava il
   * trascritto, si rifondevano tutte le corse di tool (coniando un portante
   * nuovo per ognuna, quindi facendo ridisegnare ogni bolla di tool visibile) e
   * si ri-posizionavano i marker. Sessanta volte al secondo, per un messaggio.
   *
   * Qui il prefisso «assestato» si tiene stabile a mano: stessa lunghezza e
   * stessi oggetti = si restituisce l'array di prima. Il confronto costa dei
   * puntatori; quello che evita costa allocazioni e render.
   */
  const settledRef = useRef<ChatMessage[]>(currentMessages);
  const liveTail = (() => {
    const last = currentMessages[currentMessages.length - 1];
    return last?.role === 'assistant' && last.partial === true ? last : undefined;
  })();
  const settledMessages = (() => {
    const fine = liveTail ? currentMessages.length - 1 : currentMessages.length;
    const prev = settledRef.current;
    if (prev.length === fine) {
      let uguale = true;
      for (let i = 0; i < fine; i++) {
        if (prev[i] !== currentMessages[i]) { uguale = false; break; }
      }
      if (uguale) return prev;
    }
    const next = fine === currentMessages.length ? currentMessages : currentMessages.slice(0, fine);
    settledRef.current = next;
    return next;
  })();

  // Memoize filtered messages
  const visibleMessages = useMemo(() =>
    settledMessages.filter(msg => {
      // Keep partial assistant messages (streaming placeholder)
      if (msg.role === 'assistant' && msg.partial) return true;
      const c = msg.content?.trim();
      if (!c) {
        // An assistant turn can legitimately end with no prose — it only ran
        // tools, or it was interrupted (timeout/stale/abort) before the final
        // text. Keep it when it carries tool work so the timeline renders,
        // instead of the message silently vanishing after it streamed.
        const hasWork = msg.role === 'assistant' && (
          (Array.isArray(msg.blocks) && msg.blocks.length > 0) ||
          (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
        );
        return hasWork;
      }
      if (c === 'NO_REPLY' || c === 'ANNOUNCE_SKIP') return false;
      if (c.startsWith('Agent-to-agent announce step')) return false;
      return true;
    }),
    [settledMessages]
  );

  /**
   * Le corse di tool tornano a essere UN item.
   *
   * Il transcript di Claude Code emette un messaggio assistant per ogni blocco:
   * misurato sul DB, l'85% dei messaggi assistant di una chat è «una sola tool
   * call, testo vuoto». Il raggruppatore lavora dentro un messaggio, quindi
   * riceveva sempre un array di lunghezza uno e non raggruppava mai — e ogni
   * azione si portava dietro il vestito completo di un messaggio (margini,
   * bolla, la riga del timestamp che occupa spazio anche invisibile). Fondendo
   * la corsa qui, il raggruppatore vede finalmente il gruppo e il vestito si
   * paga una volta. Vedi `coalesceToolRun.ts`.
   */
  const { items: settledItems, carrierById } = useMemo(
    () => coalesceToolRuns(visibleMessages),
    [visibleMessages],
  );

  /**
   * La lista da renderizzare: il prefisso fuso più, in fondo, la bolla viva.
   *
   * La coda non passa dal fusore per costruzione — `coalesceToolRuns` non fonde
   * mai un `partial`, perché rimescolare l'item che sta crescendo è proprio ciò
   * che non si deve fare — quindi tenerla fuori non cambia il risultato: cambia
   * solo chi paga. L'unica cosa che si alloca per frame è questo array di
   * puntatori; gli ITEM restano gli stessi oggetti, ed è quello che fa saltare
   * il render a `MessageBubble`, che è `memo`.
   */
  const filteredMessages = useMemo(
    () => (liveTail ? [...settledItems, liveTail as CoalescedMessage] : settledItems),
    [settledItems, liveTail],
  );

  // ── THE REST OF THE HISTORY, out of sight ─────────────────────────────────
  /**
   * The list holds only the TAIL of the thread: a tail-first open painted the
   * last page and the messages before it have not been merged yet
   * (`shared/history-paging.ts`). Three things below read it: a compaction
   * divider whose anchor is not here yet must not be drawn on top as if the
   * chat began here; a palette jump to a message not here yet must ask for the
   * rest instead of giving up; and the first row carries the "load the earlier
   * messages" divider for whoever scrolls up before the rest is in.
   */
  const completeness = useHistoryCompleteness(topic.sessionKey);
  const historyPartial = isHistoryIncomplete(completeness);
  const missingAbove = isHistoryIncomplete(completeness) ? completeness.missing : 0;
  /** The pane has a box in the layout: hidden tabs (keep-alive) are `false`. */
  const paneAlive = usePaneAlive();
  /** Mirrors for the closures that outlive a render (the ResizeObserver, the
   *  completion callback): they read the latest value, not the captured one. */
  const paneAliveRef = useRef(paneAlive);
  paneAliveRef.current = paneAlive;
  const streamingNowRef = useRef(_currentStreaming);
  streamingNowRef.current = _currentStreaming;
  const itemsRef = useRef(filteredMessages);
  itemsRef.current = filteredMessages;
  const carrierRef = useRef(carrierById);
  carrierRef.current = carrierById;
  /** The row at the top of the viewport, by index: what a reader who scrolled
   *  up is looking at, kept for the re-anchor after a merge made while hidden. */
  const topVisibleIndexRef = useRef(0);
  /** How far from the bottom the viewport was at the last scroll: the only
   *  reading available once the pane is hidden and its geometry reads zero. */
  const lastDistanceFromBottomRef = useRef(0);
  /**
   * Where to put the viewport once the rest of the history is in: the row to
   * anchor at the top, by id (its index changes by the number of rows added
   * above it), or `null` when the bottom is where it was resting - the pins
   * of the "pane returns visible" branch already land that.
   */
  const restoreAnchorRef = useRef<{ id: string } | null>(null);
  /** The click on the divider has been made and the rest is on its way. */
  const [olderLoading, setOlderLoading] = useState(false);

  // Position compaction dividers within the visible transcript (CHAT-COMPACT-01).
  // Sui messaggi VISIBILI, non sugli item: un marker ancorato a un messaggio
  // assorbito dev'essere ancora trovabile (altrimenti `partitionMarkers` lo
  // butta in cima, che è la sua rete di sicurezza, non il posto giusto).
  //
  // La coda viva rientra nell'insieme SOLO quando dei marker esistono davvero:
  // senza marker `partitionMarkers` esce prima di guardare i messaggi, quindi
  // aggiungerla costerebbe una concat per frame per un risultato vuoto — e
  // renderebbe instabile un memo che invece deve restare fermo.
  const markerSource = useMemo(
    () => (liveTail && compactionMarkers && compactionMarkers.length > 0
      ? [...visibleMessages, liveTail]
      : visibleMessages),
    [visibleMessages, compactionMarkers, liveTail],
  );
  const markerPartition = useMemo(
    () => partitionMarkers(markerSource, compactionMarkers),
    [markerSource, compactionMarkers],
  );
  /** I marker di un item = i suoi, più quelli dei messaggi che ha assorbito. */
  const markersAfter = useCallback((msg: CoalescedMessage) => {
    const ids = msg.mergedIds ?? (msg.id ? [msg.id] : []);
    const out = ids.flatMap((id) => markerPartition.byAfter.get(id) ?? []);
    return out.length ? out : undefined;
  }, [markerPartition]);

  /**
   * L'indice da cui parte la lista. Si congela alla PRIMA lista non vuota, non
   * al primo render: al primo render i messaggi non ci sono ancora (la storia
   * arriva dopo), e congelare lì avrebbe significato montare Virtuoso sull'item
   * 0 — cioè riaprire la chat IN CIMA a ogni ricarica. Finché non c'è niente si
   * passa il valore vivo, che è quello che il codice faceva da sempre; appena la
   * lista esiste il valore si fissa, così un messaggio nuovo non lo fa
   * RI-applicare (era la lista che si strappava al fondo da sola).
   */
  const initialTopMostIndexRef = useRef<number | null>(null);
  if (initialTopMostIndexRef.current === null && filteredMessages.length > 0) {
    initialTopMostIndexRef.current = filteredMessages.length - 1;
  }
  /**
   * …ma la PRIMA lista non è la storia: e' la CACHE.
   *
   * Al reload la chat nasce dalla copia locale, che e' tagliata a poche decine
   * di messaggi; la storia vera arriva dopo, e su una conversazione lunga puo'
   * essere venti volte piu' grande. L'indice congelato su quella prima ondata
   * punta quindi a un messaggio che nella storia vera sta al tre per cento, e
   * Virtuoso ci monta la vista: e' il «refresho e mi cambia la posizione».
   * Non si vedeva nei test perche' seminano quaranta messaggi, cioe' meno del
   * tetto della cache — la prima ondata E' la storia, e l'indice e' per forza
   * giusto.
   *
   * Si ri-congela UNA volta sola, nell'istante in cui la lista diventa
   * autorevole (fine di `loadHistory`, sotto). Non a ogni messaggio: quello era
   * il difetto opposto, la lista che si strappava al fondo da sola.
   */
  const indexRefrozenRef = useRef(false);
  /**
   * `align: 'end'`, e senza è un bug che si vede solo sulle chat vere.
   *
   * Con il solo indice, Virtuoso allinea l'INIZIO di quell'item in cima alla
   * viewport. Se l'ultimo messaggio è più alto della finestra — una risposta
   * lunga, un turno pieno di blocchi tool: la norma qui — ricaricare ti lascia
   * in cima a quel messaggio, con tutto il resto sotto da riscrollare a mano.
   * È il «aggiorno mentre sono agganciato sotto allo stream e mi porta sopra»:
   * l'aggancio non c'entrava, era il montaggio.
   *
   * Non si vedeva coi messaggi corti (l'item ci sta tutto, quindi il suo inizio
   * in cima È già il fondo), che è esattamente il caso che i test coprivano.
   * Con `align: 'end'` si allinea la FINE dell'ultimo item al fondo della
   * viewport, che è il fondo vero a qualunque altezza.
   */
  const initialIndex = initialTopMostIndexRef.current ?? Math.max(0, filteredMessages.length - 1);
  // Memoizzato per VALORE: la prop è un oggetto, e un'identità nuova a ogni
  // render la farebbe ri-applicare di continuo — è lo stesso difetto che il
  // congelamento dell'indice esiste per chiudere (la lista che si strappava al
  // fondo da sola).
  const initialTopMostItemIndex = initialIndex;


  // ── I due soli verbi dello scroll ─────────────────────────────────────────
  // `pinToBottom` incolla, `dispatchScroll` chiede all'autorità cosa fare. Ogni
  // punto che prima decideva da sé ora usa questi.

  /** Quante volte al massimo si ritenta il pin mentre le altezze si assestano.
   *  Sei frame ≈ 100ms: abbastanza per l'ultimo item e il footer, troppo poco
   *  per combattere con un utente che nel frattempo scrolla (il ri-controllo di
   *  `shouldPin` dentro ogni frame lo lascia comunque vincere). */
  const PIN_SETTLE_FRAMES = 6;
  /** Quanti frame concedere al pin di APERTURA. Più larghi dei sei di regime
   *  perché lì la lista sta misurando tutto per la prima volta: un ultimo
   *  messaggio lungo (120 righe, un turno pieno di blocchi tool) continua a
   *  crescere per parecchi frame, e fermarsi a sei lo lascia a metà. Nessun
   *  rischio di combattere con l'utente: `shouldPin` viene ri-controllato dentro
   *  ogni frame, quindi il primo tocco di rotellina lo ferma. */
  const OPEN_SETTLE_FRAMES = 24;
  /** Per quanto, dopo l'apertura, una rimisura della lista va riportata al
   *  fondo. Virtuoso misura gli item alti a più riprese e, applicando il suo
   *  `initialTopMostItemIndex`, rimette in cima alla viewport l'INIZIO
   *  dell'ultimo messaggio — dopo il nostro pin, quindi vincendo lui. Un
   *  secondo e mezzo copre anche una lista lunga su macchina carica. */
  const OPEN_WINDOW_MS = 1500;
  /** Ogni rimisura dentro la finestra la SPOSTA in avanti di tanto: una lista
   *  lunga misura a più riprese, e una scadenza fissa la lascerebbe a metà
   *  proprio quando l'ultima misura arriva tardi (macchina carica). */
  const OPEN_EXTEND_MS = 400;
  /** …ma non all'infinito: oltre questo, qualunque cosa stia succedendo non è
   *  più «l'apertura». */
  const OPEN_HARD_STOP_MS = 5000;
  /** Quando ricontrollare che l'apertura sia finita DAVVERO in fondo. */
  const OPEN_VERIFY_MS = useMemo(() => [250, 700, 1400], []);
  /** Quando abbiamo pinnato l'ultima volta: serve a distinguere «la vista è in
   *  fondo perché ce l'abbiamo portata noi» da «ci è saltata da sola». */
  const lastPinAtRef = useRef(0);
  /** Finestra entro cui un arrivo al fondo è ancora attribuibile al nostro pin. */
  const PIN_ATTRIBUTION_MS = 500;
  /** Entro tanto da un nostro pin, un calo di `scrollTop` è il riassestamento
   *  della lista, non un gesto — per quanto il dito sia passato di lì. */
  const SELF_PIN_SETTLE_MS = 150;
  /** I tre controlli a scoppio ritardato dell'apertura (`OPEN_VERIFY_MS`), per
   *  poterli spegnere: pinnano con `force`, quindi uno rimasto in volo dopo un
   *  cambio di topic scrive sullo scroller della chat sbagliata. */
  const openVerifyTimersRef = useRef<number[]>([]);

  /** C'è un salto da palette che possiede la viewport per questa topic? */
  const jumpPending = useCallback(() => !!peekScrollToMessage(topic.id), [topic.id]);

  /**
   * Incolla lo scroller al fondo. `frames: 2` per i casi in cui l'altezza
   * dell'item appena aggiunto (o del Footer, che segue il composer via
   * ResizeObserver) viene misurata un frame dopo. `force` salta il veto del
   * salto da palette: lo usa SOLO il bottone "torna in fondo", che è l'utente
   * che chiede esplicitamente il contrario del salto.
   *
   * `viaVirtuoso` non è una SECONDA autorità: è il primo passo di UNA sequenza
   * ordinata. Con una lista virtualizzata l'ultimo item può non essere montato,
   * e scrivere `scrollTop` da soli incolla a un `scrollHeight` che non contiene
   * ancora la coda; `scrollToIndex('LAST')` lo materializza, il rAF successivo
   * incolla sull'altezza vera. Chi decide resta sempre e solo `reduceScroll`.
   */
  const pinToBottom = useCallback((opts?: { viaVirtuoso?: boolean; frames?: 1 | 2; force?: boolean; settleFrames?: number }) => {
    if (!opts?.force && !shouldPin(authorityRef.current, { jumpPending: jumpPending() })) return;
    if (opts?.viaVirtuoso) virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    // Il fondo si raggiunge PER DAVVERO, non "quasi".
    //
    // Un colpo solo di `scrollTop = scrollHeight` incolla all'altezza misurata
    // in QUEL frame: se l'ultimo item, il footer o un'immagine finiscono di
    // misurarsi un frame dopo, resti a qualche decina di pixel dal fondo — e
    // quello che si vede è la freccia «torna in fondo» che ti porta giù e ti
    // lascia con ancora dello scroll sotto. Si riprova per qualche frame finché
    // l'altezza smette di cambiare: appena la distanza è zero si esce.
    let attempts = 0;
    const run = () => {
      const el = scrollerElRef.current;
      // Ri-controllo dentro il frame: uno scroll dell'utente arrivato fra la
      // programmazione e l'esecuzione non va sovrascritto da un pin ormai vecchio.
      if (!el) return;
      if (!opts?.force && !shouldPin(authorityRef.current, { jumpPending: jumpPending() })) return;
      // DOPO le guardie: qui si registrano i pin ESEGUITI, non quelli tentati.
      // Stava in cima, quindi un pin che poi si tirava indietro rinfrescava
      // comunque la finestra di attribuzione — e per 500ms un auto-riancoraggio
      // di Virtuoso non veniva più riconosciuto come `teleported`, cioè
      // `reached-bottom` riancorava chi stava leggendo indietro.
      lastPinAtRef.current = Date.now();
      el.scrollTop = el.scrollHeight;
      const residuo = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (residuo > 1 && attempts < (opts?.settleFrames ?? PIN_SETTLE_FRAMES)) {
        attempts++;
        requestAnimationFrame(run);
      }
    };
    if (opts?.frames === 2) requestAnimationFrame(() => requestAnimationFrame(run));
    else requestAnimationFrame(run);
  }, [jumpPending]);

  /** Manda un evento all'autorità, applica il nuovo stato, e pinna se lo dice lei. */
  const dispatchScroll = useCallback((event: ScrollEvent, pinOpts?: { viaVirtuoso?: boolean; frames?: 1 | 2; settleFrames?: number; force?: boolean }) => {
    const decision = reduceScroll(authorityRef.current, event, Date.now());
    authorityRef.current = decision.state;
    if (decision.pin) pinToBottom(pinOpts);
  }, [pinToBottom]);

  /**
   * LA FRECCIA RISPONDE A UNA DOMANDA GEOMETRICA, e per questo la misura.
   *
   * Prima era `!anchored`, e sbagliava in tutte e due le direzioni. `anchored`
   * non è la geometria: è la POLITICA su chi possiede la viewport, ed è
   * indulgente di proposito. Peggio, era un latch a FRONTE D'ONDA — l'unica
   * cosa che poteva accenderlo era `atBottomStateChange(false)` di Virtuoso,
   * che scatta solo sulla TRANSIZIONE, e quella transizione ha tre porte che
   * la ingoiano senza lasciare traccia (la finestra di guardia, lo stream, il
   * ramo `teleported`). Ingoiata la transizione non ne arriva un'altra finché
   * la vista non torna prima in fondo: la freccia restava sbagliata a tempo
   * indeterminato. È il «fa fatica a capire quando mostrarla».
   *
   * Qui si guarda la sola cosa che la domanda richiede — quanta roba c'è sotto
   * la piega — e la si guarda dove il layout è già letto: `onScroll` e il
   * ResizeObserver. Nessun listener nuovo, nessun poll.
   *
   * ISTERESI, e non è un dettaglio: con una soglia sola la freccia
   * tremolerebbe su ogni rimisura. Si accende oltre `ARROW_SHOW_PX`, si spegne
   * sotto `ARROW_HIDE_PX`, e in mezzo TIENE il valore. La banda morta è due
   * ordini di grandezza sopra l'unica oscillazione nota (il pin che si
   * autoalimenta a ~6px, più sotto), e la soglia di accensione sta SOPRA i 150
   * dell'autorità: l'intento originale — «un colpo di rotellina non deve far
   * comparire il bottone» — non è solo preservato, è più stretto di prima.
   */
  const ARROW_SHOW_PX = 240;
  const ARROW_HIDE_PX = 80;
  const arrowShownRef = useRef(false);
  const syncArrow = useCallback((el: HTMLElement | null) => {
    // Pane nascosta (keep-alive, `display:none`): la viewport è alta 0 e ogni
    // misura direbbe «sei in fondo». Si congela e si ricalcola quando torna
    // visibile — il ramo esiste già nel ResizeObserver.
    if (!el || el.clientHeight === 0) return;
    const d = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = arrowShownRef.current ? d >= ARROW_HIDE_PX : d > ARROW_SHOW_PX;
    if (next === arrowShownRef.current) return;
    arrowShownRef.current = next;
    setIsScrolledUp(next);
  }, []);

  // True once THIS instance has watched a loadHistory cycle complete FOR THE
  // CURRENT TOPIC — the only moment the thread is known authoritative. The
  // palette-jump effect gates its "loaded thread lacks the id → drop the
  // target" branch on it: on a slow machine the pane mounts with a transient
  // non-empty STALE message set and loading=false, and consuming there threw
  // the target away before the real history ever arrived (CI-only CMD-16
  // failure). Reset on topic switch below.
  const sawLoadCompleteRef = useRef(false);

  // Reset scroll state on topic switch
  useEffect(() => {
    if (prevTopicIdRef.current !== topic.id) {
      prevTopicIdRef.current = topic.id;
      needsScrollRef.current = true;
      lastScrollTopRef.current = 0;
      sawLoadCompleteRef.current = false;
      setNewMsgCount(0);
      setShowNewBanner(false);
      // Si semina con la lunghezza CORRENTE, non con zero: azzerando, il primo
      // giro dopo il cambio topic vedeva «da 0 a N messaggi» e contava l'intera
      // storia della chat nuova come «messaggi arrivati mentre eri via».
      prevMsgCountRef.current = filteredMessages.length;
      arrowShownRef.current = false;
      setIsScrolledUp(false);
      // L'indice torna a potersi ri-congelare: la chat nuova avra' la sua
      // prima ondata dalla cache e poi la sua storia.
      indexRefrozenRef.current = false;
      // An anchor remembered for the previous chat's history merge names a row
      // of THAT chat: it must not scroll this one.
      restoreAnchorRef.current = null;
      lastDistanceFromBottomRef.current = 0;
      // NB: `initialTopMostIndexRef` NON si scongela qui, ed è deliberato.
      // Passando da una chat corta a una lunga il ref resta quello di prima e
      // la nuova lista monta all'indice sbagliato — un difetto vero, ma
      // azzerarlo qui ne apre uno peggiore: al cambio di topic `currentMessages`
      // può essere ancora, per un render, la lista STALE della chat precedente
      // (è lo stesso transitorio per cui il salto da palette non consuma il
      // bersaglio finché `sawLoadCompleteRef` non è vero), e il ref si
      // ricongelerebbe su quella — stavolta in modo permanente. Misurato: con
      // l'azzeramento qui, la chat riapriva a metà su una lista lunga.
      // Il rimedio giusto è congelare l'indice sulla lista di QUESTA topic,
      // non azzerarlo alla cieca.
      // I controlli in volo dell'apertura precedente pinnano con `force`: se
      // scattano adesso, lo fanno sullo scroller di questa chat.
      openVerifyTimersRef.current.forEach(window.clearTimeout);
      openVerifyTimersRef.current = [];
      // Riparte ancorata e arma la guardia: la lista si rimonta e si rimisura
      // tutta. Il pin vero lo fa l'effetto che aspetta il caricamento.
      dispatchScroll({ type: 'topic-switch' });
    }
  }, [topic.id, dispatchScroll, filteredMessages.length]);

  /**
   * Il pin di APERTURA: la prima volta che questa chat ha dei messaggi a
   * schermo, si va al fondo vero.
   *
   * `initialTopMostItemIndex` da solo non basta e non può bastare: dice a
   * Virtuoso da quale item partire, e Virtuoso ci allinea l'INIZIO di quell'item
   * in cima alla viewport. Coi messaggi corti l'item ci sta tutto e il risultato
   * È il fondo — motivo per cui la suite era verde — ma se l'ultimo messaggio è
   * più alto della finestra (una risposta lunga, un turno pieno di blocchi tool:
   * la norma) ricaricare ti lascia in cima a QUEL messaggio, col resto da
   * riscrollare a mano. È il «aggiorno mentre sono agganciato sotto allo stream
   * e mi porta sopra»: l'aggancio non c'entrava, era il montaggio.
   *
   * Passare `{index, align:'end'}` sarebbe stata la strada breve e non
   * funziona: Virtuoso calcola quell'allineamento sulle altezze che conosce al
   * montaggio, cioè nessuna, e atterra peggio di prima (provato, due test rossi).
   * Qui invece si pinna a misure fatte, e si ritenta finché il residuo è zero.
   *
   * Gli altri due effetti di sotto non coprono questo caso: uno vuole
   * `needsScrollRef` (lo arma il CAMBIO di topic, non un'apertura a freddo),
   * l'altro una transizione di `currentLoading` da true a false, che a
   * ricaricare con la storia già in cache non avviene.
   */
  const openPinnedForRef = useRef<string | null>(null);
  /** Finestra di APERTURA: fin qui il fondo è ancora lo stato di riposo, e
   *  ogni rimisura della lista va riportata giù. Vedi `totalListHeightChanged`.
   *  Si sposta in avanti a ogni rimisura e si chiude di colpo al primo input
   *  dell'utente. */
  const openingUntilRef = useRef(0);
  /** Oltre questo istante l'apertura è finita comunque, qualunque cosa stia
   *  ancora misurando la lista. */
  const openingHardStopRef = useRef(0);
  /** L'utente ha davvero toccato lo scroll da quando questa chat è aperta?
   *  Lo scrive SOLO il gesto vero (rotellina su, trascinamento), non la
   *  geometria di Virtuoso — che durante l'apertura dice «non sei in fondo»
   *  senza che nessuno abbia mosso niente. */
  const userTouchedRef = useRef(false);
  useEffect(() => {
    if (openPinnedForRef.current === topic.id) return;
    if (!scrollerEl || filteredMessages.length === 0) return;
    // Chi ha una posizione da ripristinare (undo di una pane chiusa) o un salto
    // da palette in canna possiede la viewport: il fondo non è più lo stato di
    // riposo di questa apertura.
    if (initialScrollOffset != null && Number.isFinite(initialScrollOffset)) {
      openPinnedForRef.current = topic.id;
      return;
    }
    if (peekScrollToMessage(topic.id)) return;
    openPinnedForRef.current = topic.id;
    userTouchedRef.current = false;
    openingUntilRef.current = Date.now() + OPEN_WINDOW_MS;
    openingHardStopRef.current = Date.now() + OPEN_HARD_STOP_MS;
    // `scroll-to-bottom` e non un pin nudo, perché qui c'è anche uno STATO da
    // rimettere a posto: montando in cima all'ultimo item la lista non è in
    // fondo, Virtuoso lo annuncia (`left-bottom`) e l'autorità si sgancia da
    // sola — senza che nessuno abbia scrollato. Da lì in poi ogni pin è vietato
    // e compare pure la freccia «torna in fondo» su una chat appena aperta.
    // Questo evento riancora e pinna in un colpo solo.
    // `force`: l'apertura non è una contesa con l'utente, e mentre l'item alto
    // finisce di misurarsi possono arrivare altri `left-bottom` che
    // sgancerebbero di nuovo a metà assestamento.
    dispatchScroll(
      { type: 'scroll-to-bottom' },
      { viaVirtuoso: true, frames: 2, settleFrames: OPEN_SETTLE_FRAMES, force: true },
    );
    // Tre CONTROLLI a scoppio ritardato, e servono perché l'ultimo scarto non
    // lo annuncia nessuno.
    //
    // Dopo l'apertura la lista continua a sistemarsi per un pezzo, e capita che
    // resti qualche pixel sotto: misurato, ferma a 6px dal massimo per oltre un
    // secondo. Quello scarto è invisibile a tutti — sotto la soglia di Virtuoso
    // (150px), sotto quella dello scroll dell'utente (24px), e la contabilità
    // delle altezze non cambia, quindi nessun evento. Restava una chat «quasi»
    // in fondo, con un filo di scroll sotto.
    //
    // Non è un poll: sono tre istanti fissi entro la finestra di apertura, e
    // ognuno si tira indietro se l'utente ha toccato lo scroll o se la vista è
    // ormai lontana dal fondo (allora è una scelta sua, non un residuo).
    // …e si cancellano. Pinnano con `force`, cioè scavalcando `shouldPin`: un
    // timer sopravvissuto a un cambio di topic entro 1,4s leggeva
    // `scrollerElRef.current`, che nel frattempo è lo scroller della chat
    // NUOVA — e gliela portava in fondo. Il topic si ricontrolla anche dentro
    // il timer, perché lo scroller può essere lo stesso elemento riusato.
    // I timer stanno in un ref e NON in una cleanup dell'effetto: questo
    // effetto ri-gira a ogni messaggio nuovo (`filteredMessages.length` è fra
    // le dipendenze) e una cleanup li spegnerebbe al primo messaggio che
    // arriva durante l'apertura — cioè proprio quando servono.
    const apertura = topic.id;
    for (const ritardo of OPEN_VERIFY_MS) {
      openVerifyTimersRef.current.push(window.setTimeout(() => {
        if (userTouchedRef.current) return;
        if (openPinnedForRef.current !== apertura) return;
        const el = scrollerElRef.current;
        if (!el || el.clientHeight === 0) return;
        const residuo = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (residuo <= 1) return;
        // Nessun tetto alla distanza: la guardia che conta è `userTouchedRef`,
        // e l'ha già superata. Il tetto dei 150 stava qui per dire «se sei
        // lontano è una tua scelta» — ma se l'utente non ha toccato niente,
        // essere lontani non è una sua scelta: è un pezzo di lista arrivato
        // tardi, ed è esattamente ciò che questi tre controlli esistono per
        // rimediare. Con il tetto si tiravano indietro proprio nei casi
        // peggiori (misurato: 225px di scarto e nessuno che lo chiudeva).
        pinToBottom({ force: true, settleFrames: OPEN_SETTLE_FRAMES });
      }, ritardo));
    }
  }, [topic.id, scrollerEl, filteredMessages.length, initialScrollOffset, dispatchScroll, pinToBottom, OPEN_SETTLE_FRAMES, OPEN_VERIFY_MS]);

  // Smontando la pane i timer dell'apertura devono morire con lei: pinnano con
  // `force`, e uno rimasto in volo scrive su uno scroller che non è più suo.
  useEffect(() => () => {
    openVerifyTimersRef.current.forEach(window.clearTimeout);
    openVerifyTimersRef.current = [];
  }, []);

  /**
   * Ask for the rest of the thread when NOBODY is looking at this list.
   *
   * The merge re-indexes the rows a virtual list has on screen, so the one
   * moment it can happen unseen is while the pane has no box in the layout
   * (`decideHistoryCompletion` says why "anchored at the bottom" is not
   * enough). The decision also says where to put the viewport when the pane
   * comes back: the bottom, if that is where it was resting, or the row the
   * reader had at the top - remembered here by id, applied in the "pane
   * returns visible" branch of the ResizeObserver below.
   *
   * Runs when the thread becomes partial, when the pane hides, and from the
   * ResizeObserver the frame the viewport goes to zero.
   */
  const completenessRef = useRef(completeness);
  completenessRef.current = completeness;
  const completeOutOfSight = useCallback(() => {
    const known = completenessRef.current;
    if (!isHistoryIncomplete(known)) return;
    const el = scrollerElRef.current;
    const decision = decideHistoryCompletion({
      paneHidden: !paneAliveRef.current || !el || el.clientHeight === 0,
      streaming: streamingNowRef.current,
      userScrolled: userTouchedRef.current,
      anchoredAtBottom: lastDistanceFromBottomRef.current <= AT_BOTTOM_TOLERANCE_PX,
    });
    if (decision.action !== 'complete') return;
    // Two steps, both taken only while hidden: FETCH (the rows are held in
    // `historyCompleteness`, not merged), then MERGE once they are here. The
    // pane may be on screen again by the time the fetch lands; this runs again
    // on that change of state and merges at the next hidden moment.
    if (known.state === 'partial') {
      void requestHistoryCompletion(topic.sessionKey, 'stage');
      return;
    }
    if (decision.restore === 'top-item') {
      const top = itemsRef.current[topVisibleIndexRef.current];
      restoreAnchorRef.current = top?.id ? { id: top.id } : null;
    } else {
      restoreAnchorRef.current = null;
    }
    void requestHistoryCompletion(topic.sessionKey, 'apply');
  }, [topic.sessionKey]);
  const completeOutOfSightRef = useRef(completeOutOfSight);
  completeOutOfSightRef.current = completeOutOfSight;
  useEffect(() => {
    completeOutOfSight();
  }, [completeness, paneAlive, completeOutOfSight]);

  /**
   * The reader asked: the row at the top of the loaded window was clicked.
   * The jump that follows is theirs, so the list re-anchors on the row that
   * was first (the effect below, once the rows above it are in) and they keep
   * reading upwards from where they were.
   */
  const loadOlder = useCallback(() => {
    const first = itemsRef.current[0];
    restoreAnchorRef.current = first?.id ? { id: first.id } : null;
    setOlderLoading(true);
    void requestHistoryCompletion(topic.sessionKey, 'apply').finally(() => setOlderLoading(false));
  }, [topic.sessionKey]);
  useEffect(() => {
    const anchor = restoreAnchorRef.current;
    if (!anchor) return;
    const el = scrollerElRef.current;
    // Hidden: nothing to scroll yet, the "pane returns visible" branch of the
    // ResizeObserver applies the anchor when there is a viewport again.
    if (!el || el.clientHeight === 0) return;
    const target = carrierRef.current.get(anchor.id) ?? anchor.id;
    const index = filteredMessages.findIndex((m) => m.id === target);
    // Still first: the rows above have not landed. Gone: a whole-thread
    // reload replaced the list, and the anchor with it.
    if (index <= 0) {
      if (index < 0) restoreAnchorRef.current = null;
      return;
    }
    restoreAnchorRef.current = null;
    virtuosoRef.current?.scrollToIndex({ index, align: 'start' });
  }, [filteredMessages]);

  // ── IL SIPARIO ────────────────────────────────────────────────────────────
  /**
   * La lista non si guarda mentre si monta.
   *
   * MISURATO al refresh (sonda `tests/e2e/refresh-cls.spec.ts`, 390×844): il
   * blocco dell'ultimo messaggio si sposta TRE volte fra i 138 e i 178ms —
   * y 40 → 264 → 694 → 504 — e da solo vale un CLS di 0,296, cioè il 100% del
   * movimento dell'intera pagina. Non è lentezza né rete: i messaggi sono già in
   * cache locale. È Virtuoso che monta con le altezze ancora da misurare, le
   * misura a più riprese e ri-ancora al fondo; l'assestamento è corretto, ma
   * finora si svolgeva SOTTO GLI OCCHI, ed è esattamente il «cose che caricano
   * dopo, quando in realtà c'erano già prima del refresh».
   *
   * Qui non si accelera l'assestamento — non si può, le altezze vere si sanno
   * solo misurandole — si smette di darlo in scena: la lista resta
   * `visibility: hidden` (che ha layout, quindi Virtuoso misura eccome) finché
   * la geometria non sta ferma, e al suo posto c'è lo scheletro, ancorato in
   * fondo com'è ancorata la chat. Chi guarda vede una superficie ferma che
   * diventa la conversazione, non una conversazione che si assembla.
   *
   * SI CHIUDE SEMPRE, e in fretta: due frame con `scrollHeight` e `scrollTop`
   * identici, oppure il tetto duro qui sotto. Non c'è nessuno stato in cui
   * possa restare aperto — un sipario che non si alza è peggio di uno spinner.
   */
  /** Quanti frame di geometria IMMOBILE bastano a dire «si è posata». Due e non
   *  uno: una singola coincidenza fra due frame capita a metà di un
   *  assestamento, due di fila no. */
  const LIST_REVEAL_STABLE_FRAMES = 2;
  /**
   * Prima di tanto non si alza MAI, anche a geometria ferma.
   *
   * ERA 320, e il perché era questo: il primo dei tre controlli a scoppio
   * ritardato dell'apertura (`OPEN_VERIFY_MS[0]`, 250ms) era l'ultima cosa che
   * poteva ancora spostare la vista, e lo faceva — misurato dopo il sipario a due
   * frame, la lista stava ferma, si scopriva, e a 250ms dal montaggio quel
   * controllo la portava al fondo vero, 190px di salto in scena. Il pavimento
   * stava appena oltre quel controllo così il salto avveniva dietro lo scheletro.
   *
   * QUEL SALTO NON SUCCEDE PIÙ, misurato il 2026-08-15 su un'apertura FREDDA vera
   * (pane non montata prima: la stessa sonda con la pane già in DOM misurava un
   * ritorno e diceva «nessun salto» per il motivo sbagliato). Traccia dello
   * scroller a ogni frame, due scene, e in entrambe lo scroll si posa ESATTAMENTE
   * al fondo — `scrollTop == scrollHeight - viewport` — entro 82-98ms e non si
   * muove più:
   *
   *   scena                         pavimento   sipario a    CLS        salti dopo il reveal
   *   60 messaggi, alcuni alti        320ms      t+329ms     0.00115    0 · 0px
   *   60 messaggi, alcuni alti         80ms      t+125ms     0.00115    0 · 0px
   *   + coda da 120 righe             320ms      t+329ms     0.00115    0 · 0px
   *   + coda da 120 righe              80ms      t+105ms     0.00115    0 · 0px
   *
   * La seconda scena è quella che questa card temeva: la docstring di
   * `OPEN_SETTLE_FRAMES` la nomina, «un ultimo messaggio lungo (120 righe, un
   * turno pieno di blocchi tool) continua a crescere per parecchi frame». Non
   * cambia niente. Il CLS è identico alla quinta cifra, quindi il sipario lungo
   * non stava comprando stabilità: stava solo aspettando.
   *
   * 80 e non 0: il sipario si alza comunque solo a geometria FERMA per due frame
   * (`LIST_REVEAL_STABLE_FRAMES`), e questo pavimento resta per non farlo alzare
   * dentro il primo assestamento su una macchina molto più veloce di questa.
   * Guadagno misurato: ~204-224ms su ogni apertura a freddo, che è il gesto più
   * ripetuto dell'app.
   *
   * Se un giorno il salto torna, torna anche questo numero — ma con la misura
   * accanto, non per prudenza.
   */
  const LIST_REVEAL_FLOOR_MS = 80;
  /** Oltre questo, si alza comunque. Copre il caso in cui la geometria non stia
   *  ferma per un motivo legittimo (uno stream che scrive mentre apri): lì
   *  l'attesa non finirebbe mai, e vedere la lista muoversi è meglio che non
   *  vederla.
   *
   *  1200 and not 600, measured on the reload of a real chat (2026-09-03, the
   *  desktop state replayed in Chromium at 3440x1410): the authoritative
   *  history of an 832 KB conversation lands 330-650 ms after the list mounts,
   *  and the two screenshots in view finish loading ~300 ms after that. With
   *  the cap at 600 the curtain lifted BEFORE both, and what followed was the
   *  list re-anchoring in plain sight (item list 5.8k -> 18.5k px, then the
   *  whole column jumping 640 px when the images got their height): CLS 0.08 to
   *  0.24 on a gesture whose contract is zero. */
  const LIST_REVEAL_HARD_CAP_MS = 1200;
  /** Fin qui dall'apertura, una lista che si popola è ancora «la chat che si
   *  apre». Dopo, è un messaggio che arriva — e un messaggio che arriva non
   *  deve far lampeggiare uno scheletro (era il caso della prima riga scritta
   *  in una chat vuota). */
  const CURTAIN_ARM_WINDOW_MS = 1200;
  const [listSettled, setListSettled] = useState(false);
  /** Quando questa chat si è aperta. Lo scrive l'effetto qui sotto, che gira
   *  al montaggio e a ogni cambio di topic — cioè in tutti e soli i momenti in
   *  cui «apertura» vuol dire qualcosa. */
  const openedAtRef = useRef(performance.now());
  /**
   * True se al momento dell'apertura (cambio topic.id) c'erano gia' messaggi
   * in cache. Con la cache il contenuto e' gia' stabile: non serve aspettare
   * 80ms per evitare il pop, bastano 2 frame stabili (LIST_REVEAL_FLOOR_MS=0).
   * Senza cache (apertura a freddo) il pavimento rimane 80ms per coprire il
   * primo assestamento dopo la fetch del server.
   */
  const hadCacheAtOpenRef = useRef(filteredMessages.length > 0);
  useEffect(() => {
    openedAtRef.current = performance.now();
    // Legge filteredMessages.length PRIMA del render causato dal cambio topic:
    // usa il valore sincronizzato al momento dell'effetto (post-render).
    // Se i messaggi sono gia' presenti, il floor del sipario e' 0.
    hadCacheAtOpenRef.current = filteredMessages.length > 0;
    setListSettled(false);
  }, [topic.id]); // eslint-disable-line react-hooks/exhaustive-deps -- filteredMessages.length letto in modo ref-safe
  /** Mirror of `currentLoading` for the frame loop below: the loop is one
   *  closure per opening, and re-creating it on every loading flip would reset
   *  the frame count it is in the middle of. */
  const currentLoadingRef = useRef(currentLoading);
  useEffect(() => { currentLoadingRef.current = currentLoading; }, [currentLoading]);
  useEffect(() => {
    if (listSettled) return;
    if (!scrollerEl || filteredMessages.length === 0) return;
    // Non è un'apertura: è la chat che stavi già guardando e a cui è arrivato
    // qualcosa. Niente sipario.
    if (performance.now() - openedAtRef.current > CURTAIN_ARM_WINDOW_MS) {
      setListSettled(true);
      return;
    }
    const inizio = performance.now();
    // Con messaggi gia' in cache all'apertura, il contenuto e' stabile fin
    // dal primo render: il floor scenica 0 (bastano 2 frame fermi).
    // Senza cache il floor rimane 80ms per coprire l'assestamento post-fetch.
    const floorMs = hadCacheAtOpenRef.current ? 0 : LIST_REVEAL_FLOOR_MS;
    let raf = 0;
    let ultimaH = -1;
    let ultimoTop = -1;
    let fermi = 0;
    const guarda = () => {
      const el = scrollerElRef.current;
      if (!el) { raf = requestAnimationFrame(guarda); return; }
      // STILL is not SETTLED. Two identical frames also happen on an empty
      // scroller (Virtuoso has not painted an item yet), on the local copy
      // while the server's history is still in flight, and on a bubble whose
      // screenshot has no height yet. Each of those was measured lifting the
      // curtain right before the list moved (see LIST_REVEAL_HARD_CAP_MS), so
      // the frame count only starts once there is something painted, whole,
      // and authoritative to hold still.
      const ready = !currentLoadingRef.current && listPaintedAndWhole(el);
      const h = el.scrollHeight;
      const top = Math.round(el.scrollTop);
      if (ready && h === ultimaH && top === ultimoTop) fermi += 1; else fermi = 0;
      ultimaH = h;
      ultimoTop = top;
      const trascorso = performance.now() - inizio;
      if ((fermi >= LIST_REVEAL_STABLE_FRAMES && trascorso >= floorMs) || trascorso > LIST_REVEAL_HARD_CAP_MS) {
        setListSettled(true);
        return;
      }
      raf = requestAnimationFrame(guarda);
    };
    raf = requestAnimationFrame(guarda);
    return () => cancelAnimationFrame(raf);
  }, [listSettled, scrollerEl, filteredMessages.length, topic.id]);

  // Scroll to bottom after messages load for a new topic.
  // Skipped while a palette jump target is pending (peekScrollToMessage): the
  // jump effect below positions the list instead — this effect's rAF would
  // otherwise run AFTER the jump's scrollToIndex and drag it back to bottom,
  // unmounting the virtualized target row (and its highlight) entirely.
  useEffect(() => {
    if (needsScrollRef.current && filteredMessages.length > 0 && !currentLoading) {
      if (peekScrollToMessage(topic.id)) return;
      needsScrollRef.current = false;
      dispatchScroll({ type: 'scroll-to-bottom' }, { viaVirtuoso: true });
    }
  }, [filteredMessages.length, currentLoading, dispatchScroll, topic.id]);

  // Scroll to bottom after loadHistory completes (loading: true → false).
  // On page refresh or tab switch, Virtuoso mounts at the bottom via
  // initialTopMostItemIndex, but loadHistory then replaces the messages array
  // which can shift the scroll position.
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = currentLoading;
    if (wasLoading && !currentLoading) sawLoadCompleteRef.current = true;
    if (wasLoading && !currentLoading && filteredMessages.length > 0) {
      // Pending palette jump wins over the bottom anchor — see the effect above.
      if (peekScrollToMessage(topic.id)) return;
      // QUESTO e' il momento in cui la lista diventa autorevole, ed e' l'unico
      // in cui vale la pena ri-puntare Virtuoso: l'indice congelato sulla cache
      // ora e' sbagliato di centinaia di item. Una volta sola (il ref lo
      // garantisce), altrimenti si torna alla lista che si strappa da sola.
      if (!indexRefrozenRef.current) {
        indexRefrozenRef.current = true;
        initialTopMostIndexRef.current = filteredMessages.length - 1;
      }
      // E si RIARMA l'apertura, perche' finora e' corsa su un orologio partito
      // dal MOUNT: se la storia atterra dopo un secondo e mezzo, i pin forzati
      // sono gia' scaduti e quello che resta pretende una distanza <=150px su
      // una lista appena cresciuta di centinaia di righe. Nessuno la chiudeva.
      userTouchedRef.current = false;
      openingUntilRef.current = Date.now() + OPEN_WINDOW_MS;
      openingHardStopRef.current = Date.now() + OPEN_HARD_STOP_MS;
      dispatchScroll(
        { type: 'scroll-to-bottom' },
        { viaVirtuoso: true, frames: 2, settleFrames: OPEN_SETTLE_FRAMES, force: true },
      );
    }
  }, [currentLoading, filteredMessages.length, dispatchScroll, topic.id, OPEN_SETTLE_FRAMES]);

  // ── Palette jump: scroll to a searched message ────────────────────────────
  // A ⌘K message hit registers a pending target (scrollToMessage.ts) before
  // opening the topic. Consume it here once the thread actually contains the
  // id: scroll the row to center and flash a highlight. Declared AFTER the
  // bottom-anchor effects above so, in the same commit, this scrollToIndex
  // runs last and wins over the default "open at bottom".
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const jumpHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tryScrollToTarget = useCallback(() => {
    // NEVER jump (or consume) while this pane is hidden: keep-alive keeps
    // background tabs mounted with display:none, where Virtuoso's viewport is
    // 0-high and renders NO rows — a jump there scrolls into the void and the
    // target is lost before the pane ever becomes visible (the palette event
    // fires exactly in that state when the hit's topic isn't the active tab).
    // Il poll qui sotto (armato dall'evento di richiesta) ritenta finché la
    // pane non ha una viewport vera.
    const scroller = scrollerElRef.current;
    if (!scroller || scroller.clientHeight === 0) return;
    const targetId = peekScrollToMessage(topic.id);
    if (!targetId) return;
    // L'id cercato può essere stato ASSORBITO da una corsa di tool: in quel
    // caso la riga esiste ancora, si chiama solo con l'id del portante. Senza
    // questo passaggio il salto da palette su un'azione non trovava niente e
    // scartava il bersaglio come se il messaggio fosse stato cancellato.
    const rowId = carrierById.get(targetId) ?? targetId;
    const index = filteredMessages.findIndex((m) => m.id === rowId);
    if (index < 0) {
      // Drop the target ONLY when an AUTHORITATIVE thread lacks the id
      // (inactive branch, deleted message) — i.e. this instance has watched a
      // loadHistory cycle complete AND the result is non-empty. Both weaker
      // states bit us live: a mounted-but-never-loaded keep-alive pane
      // (0 messages, loading=false — the palette event fires against exactly
      // that), and a slow-machine mount window holding a non-empty STALE set
      // before loadHistory even started (CI-only). The TTL covers leaks.
      if (sawLoadCompleteRef.current && !currentLoading && filteredMessages.length > 0) {
        // ...and only when the thread is WHOLE: after a tail-first open the
        // target may simply be in the part that is not here yet. Ask for it
        // (a jump is the reader's request, so the merge it causes is theirs)
        // and let the effect on `filteredMessages` re-run this once it lands.
        if (historyPartial) {
          void requestHistoryCompletion(topic.sessionKey, 'apply');
          return;
        }
        consumeScrollToMessage(topic.id);
      }
      return;
    }
    // markFired, NOT consume: opening from the palette also fires a message
    // reload whose completion runs the bottom-anchor effects AFTER this jump —
    // with the target consumed their peek-guard is gone and the list snaps
    // back to the bottom (observed: scrollTop 0 → bottom within 100ms). The
    // fired entry keeps those guards active for a short grace and lets the
    // post-reload pass re-run this jump; the store purges it afterwards.
    markScrollToMessageFired(topic.id);
    // Niente guardia da armare: il veto del salto vive in `shouldPin`, in un
    // posto solo, e vale finché la grazia del salto non scade.
    // rAF so we land AFTER any bottom-anchor rAF a prior effect queued in this
    // same frame (belt to the peek-guards' suspenders — event-path timing).
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center' });
    });
    // Si evidenzia la RIGA, quindi l'id del portante: `jumpHighlightId` viene
    // confrontato con `msg.id` dell'item.
    setJumpHighlightId(rowId);
    if (jumpHighlightTimer.current) clearTimeout(jumpHighlightTimer.current);
    jumpHighlightTimer.current = setTimeout(() => setJumpHighlightId(null), 2400);
  }, [topic.id, topic.sessionKey, filteredMessages, currentLoading, historyPartial, carrierById]);
  useEffect(() => {
    if (!currentLoading && filteredMessages.length > 0) tryScrollToTarget();
  }, [currentLoading, filteredMessages.length, tryScrollToTarget]);
  // Topic already open when the palette hit is clicked → no load transition
  // fires, so the request event is the trigger.
  useEffect(() => {
    const onJump = (e: Event) => {
      if ((e as CustomEvent<{ topicId?: string }>).detail?.topicId === topic.id) tryScrollToTarget();
    };
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, onJump);
    return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, onJump);
  }, [topic.id, tryScrollToTarget]);
  useEffect(() => () => {
    if (jumpHighlightTimer.current) clearTimeout(jumpHighlightTimer.current);
  }, []);
  // Safety-net poll. The discrete triggers above (load transition, request
  // event) each have real race windows around a palette-driven open: the
  // event can fire against a hidden/unloaded pane, the load transition can
  // land while the scroller has no layout yet, and slow machines widen every
  // gap (CI-only failures). The poll closes them all: while a target is
  // PENDING for this topic it re-tries every 150ms until the jump fires or
  // the store purges the target (TTL / post-fire grace).
  //
  // ARMED, not always-on. It used to run unconditionally for the lifetime of
  // every mounted MessageList — including the ones frozen behind PaneKeepAlive,
  // which stops re-renders but not effects already mounted. With a dozen chats
  // open that is dozens of timer wake-ups a second whose only job, 99.99% of
  // the time, is one Map lookup that returns null. The cost was never the
  // lookup; it was keeping the renderer's run loop awake.
  //
  // A target can only ever appear through `requestScrollToMessage`, which
  // ALWAYS dispatches SCROLL_TO_MESSAGE_EVENT — so the event is a complete
  // trigger, and the mount-time peek covers the one ordering it can't: a target
  // registered before this list existed (palette opening a closed topic).
  const tryScrollToTargetRef = useRef(tryScrollToTarget);
  tryScrollToTargetRef.current = tryScrollToTarget;
  useEffect(() => {
    let iv: number | undefined;
    const stop = () => {
      if (iv !== undefined) { window.clearInterval(iv); iv = undefined; }
    };
    const arm = () => {
      if (iv !== undefined) return;
      iv = window.setInterval(() => {
        // Self-disarming: the store purges the target on TTL or post-fire
        // grace, so the poll cannot outlive the jump it was armed for.
        if (!peekScrollToMessage(topic.id)) { stop(); return; }
        tryScrollToTargetRef.current();
      }, 150);
    };
    const onRequest = (e: Event) => {
      if ((e as CustomEvent<{ topicId?: string }>).detail?.topicId === topic.id) arm();
    };
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, onRequest);
    // Target registered before this list mounted (palette → closed topic).
    if (peekScrollToMessage(topic.id)) arm();
    return () => {
      window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, onRequest);
      stop();
    };
  }, [topic.id]);

  // Force scroll anchor when streaming starts (user just sent a message).
  // When new items are added (user msg + assistant placeholder), Virtuoso may
  // briefly report atBottom=false before followOutput catches up: senza
  // riancorare qui quel falso negativo bloccherebbe il pin per tutto il turno.
  // This effect is declared BEFORE the streaming scroll effect so React runs
  // it first in the same render cycle.
  /** Lo stesso valore, ma leggibile da un gestore di eventi senza comparire
   *  nelle sue dipendenze: l'effetto dei listener monta anche un
   *  ResizeObserver, e ricrearlo a ogni inizio/fine stream significava
   *  incassare l'osservazione INIZIALE che `observe()` consegna sempre —
   *  dritta nel ramo che ri-pinna al fondo. Cioè: un salto in fondo a ogni
   *  transizione di streaming, anche a chi era risalito a leggere. */
  const streamingRef = useRef(_currentStreaming);
  useEffect(() => {
    streamingRef.current = _currentStreaming;
    if (_currentStreaming && !prevStreamingRef.current) dispatchScroll({ type: 'stream-start' });
    prevStreamingRef.current = _currentStreaming;
  }, [_currentStreaming, dispatchScroll]);

  // Auto-scroll during streaming: the last message content grows in-place
  // (no new items added), so Virtuoso's followOutput doesn't trigger.
  // We set scrollTop = scrollHeight directly on the scroller DOM element,
  // bypassing Virtuoso's item-height measurement which may lag the actual layout.
  // Non decide niente: chiede a `shouldPin` (che include il veto del salto da
  // palette) e incolla. Il ri-controllo dentro il frame è dentro `pinToBottom`.
  useEffect(() => {
    if (_currentStreaming) pinToBottom();
  }, [filteredMessages, _currentStreaming, pinToBottom]);

  // Detect a GENUINE user scroll-up so the streaming bottom-pin can yield to it.
  // A wheel-up is unambiguous; on touch (no wheel) a real DECREASE of scrollTop
  // past a small threshold is the finger dragging content down. The app's own
  // pin only ever raises scrollTop, so a decrease is always the user — this is
  // what separates "the user wants to read history" from "a tool block just grew
  // the content" (which must keep the view stuck). Bound to topic.id so it
  // re-binds when the Virtuoso scroller remounts on a topic swap.
  //
  // Perché non basta aspettare `atBottomStateChange(false)` di Virtuoso: durante
  // lo stream il pin gira a ogni chunk e ributterebbe la vista in fondo PRIMA
  // che quell'evento arrivi — l'utente resterebbe inchiodato al fondo. Lo
  // sgancio deve essere immediato, ed è la transizione `user-scrolled-up` a
  // farlo (fuori dallo stream invece non sgancia: decide la geometria, così un
  // colpo di rotellina da pochi pixel non fa comparire il bottone).
  useEffect(() => {
    const el = scrollerEl;
    if (!el) return;
    lastScrollTopRef.current = el.scrollTop;
    // La distanza dal fondo si misura QUI, dove il DOM ce l'ha sotto mano: fuori
    // dallo stream è quella a decidere lo sgancio, invece di aspettare che
    // Virtuoso superi la sua soglia (nel frattempo la vista si diceva ancorata
    // mentre l'utente stava già leggendo indietro, e il messaggio dopo gliela
    // ributtava in fondo).
    // La SORGENTE viaggia con l'evento: le due qui sotto non hanno la stessa
    // affidabilità. La rotellina è un gesto, e di gesti l'app non ne produce;
    // il calo di `scrollTop` lo produce anche Virtuoso quando rimisura dopo un
    // nostro scroll forzato. Solo la prima ha il diritto di scavalcare la
    // finestra di guardia — vedi `user-scrolled-up` in scrollAuthority.
    // `userTouchedRef` lo alza SOLO un gesto vero.
    //
    // Prima lo alzava qualunque calo di `scrollTop`, sorgente `delta`
    // compresa — cioe' anche il riassestamento del NOSTRO pin. Un solo
    // assestamento spegneva in un colpo il ramo forzato di
    // `totalListHeightChanged`, le tre verifiche dell'apertura e il ramo di
    // apertura del ResizeObserver: tutte le vie di recupero, per un movimento
    // che l'app aveva causato da sola. L'autorita' invece le due sorgenti le
    // distingue gia' da se', quindi l'evento continua a partire per entrambe.
    const releaseToUser = (source: 'gesture' | 'delta') => (
      source === 'gesture' && (userTouchedRef.current = true), dispatchScroll({
      type: 'user-scrolled-up',
      streaming: streamingRef.current,
      source,
      distanceFromBottom: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
    }));

    /**
     * Fin quando uno scroll è ancora attribuibile a un INPUT dell'utente.
     *
     * L'evento `scroll` da solo non dice chi l'ha causato — lo emette anche
     * Virtuoso quando rimisura — e su quella ambiguità è costruita la finestra
     * di guardia. Ma gli input dell'utente sono osservabili: rotellina, dito,
     * tasti, trascinamento della barra. Segnandoli, lo `scroll` che segue smette
     * di essere ambiguo e può scavalcare la guardia.
     *
     * Serve una finestra e non un flag istantaneo perché l'input PRECEDE il
     * movimento: al `keydown` di Home la vista è ancora in fondo, la distanza
     * che conta si misura sullo `scroll` che arriva dopo.
     */
    const GESTURE_WINDOW_MS = 400;
    let gestureUntil = 0;
    const markGesture = () => {
      gestureUntil = Date.now() + GESTURE_WINDOW_MS;
      // Il primo input CHIUDE la finestra di apertura, e non è un dettaglio: il
      // ri-pin di apertura è forzato, quindi finché quella finestra è aperta
      // combatterebbe con chi scrolla. `userTouchedRef` da solo non basta —
      // lo scrive lo `scroll`, che arriva DOPO il tasto o la rotellina, e in
      // mezzo ci sta una rimisura (scorrendo, Virtuoso monta righe nuove e
      // l'altezza totale cambia) che rimetterebbe la vista in fondo.
      openingUntilRef.current = 0;
    };
    // Tasti che muovono la lista. Freccia giù / Fine / PagGiù non servono: qui
    // interessa solo chi va INDIETRO, e chi va in fondo ci pensa `reached-bottom`.
    const SCROLL_KEYS = new Set(['Home', 'PageUp', 'ArrowUp', 'ArrowLeft']);
    // Sul DOCUMENTO, non sullo scroller: quel div non è focalizzabile, quindi il
    // `keydown` non nasce mai lì dentro e un listener sull'elemento non lo
    // vedrebbe mai (gli eventi salgono, non scendono). Con Home o PagSu la
    // lista si muoveva e l'app non se ne accorgeva: restava «ancorata» e il
    // messaggio dopo la ributtava in fondo a chi stava leggendo indietro.
    const onKeyDown = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key)) markGesture(); };
    const onWheel = (e: WheelEvent) => {
      markGesture();
      if (e.deltaY < 0) releaseToUser('gesture');
    };
    const onScroll = () => {
      const st = el.scrollTop;
      const gesto = Date.now() < gestureUntil;
      // I cali si SOMMANO, ma solo mentre l'utente ha le mani sopra.
      //
      // Il confronto fra due `scroll` consecutivi non vede lo scroll lento: un
      // trackpad o un dito producono cali di pochi pixel per evento e non
      // superano mai la soglia, quindi risalendo piano l'app non veniva a
      // sapere che l'utente stava scorrendo. Sommandoli, venti passi da 3px
      // pesano quanto un colpo di rotellina.
      //
      // Fuori da un input, però, sommare è SBAGLIATO, e si vede subito: nella
      // finestra di apertura la lista si assesta abbassando `scrollTop` a
      // piccoli passi, e l'accumulo li leggeva come «ha scrollato lui» —
      // marcando `userTouchedRef` e spegnendo il pin che stava portando la
      // chat in fondo. Cioè: la chat riapriva a metà. Senza gesto si torna al
      // confronto fra eventi consecutivi, che di quell'assestamento non si
      // accorge (ed è giusto così: non è l'utente).
      if (!gesto || st > scrollUpAnchorRef.current) scrollUpAnchorRef.current = st;
      const riferimento = gesto ? scrollUpAnchorRef.current : lastScrollTopRef.current;
      if (isUserScrollUp(riferimento, st)) {
        // Subito dopo un NOSTRO pin, il calo è nostro anche se il dito era
        // appena passato di lì.
        //
        // `scrollToIndex('LAST')` porta la vista in fondo e poi Virtuoso
        // rimisura le altezze: quel riassestamento ABBASSA `scrollTop` di
        // qualche decina di pixel — è la stessa ambiguità per cui esiste la
        // finestra di guardia. Ma la guardia, per un gesto, si scavalca
        // apposta (un gesto l'app non lo produce), e nel varco ci cadeva il
        // riassestamento che segue di un frame l'ultima rotellina: la presa si
        // rialzava da sola un istante dopo che «torna in fondo» l'aveva
        // sciolta, e la chat restava ferma a 12px dal fondo senza che nessun
        // pin potesse più chiuderli. Centocinquanta millisecondi: nulla per una
        // mano, tutto per il nostro assestamento.
        const nostro = Date.now() - lastPinAtRef.current < SELF_PIN_SETTLE_MS;
        // Dentro quella finestra il movimento e' NOSTRO: non si declassa, non
        // si emette affatto. Declassarlo a `delta` sembrava prudente e non lo
        // era: fuori dalla finestra di guardia un `delta` con distanza grande
        // sgancia comunque l'autorita', e da li' ogni pin non forzato e'
        // vietato — cioe' si spegnevano le vie di recupero che restano dopo
        // l'apertura, per un movimento che avevamo causato noi.
        if (nostro) {
          scrollUpAnchorRef.current = st;
        } else {
          releaseToUser(gesto ? 'gesture' : 'delta');
          scrollUpAnchorRef.current = st;
        }
      }
      lastScrollTopRef.current = st;
      // Kept for `completeOutOfSight`: once the pane is hidden its geometry
      // reads zero, and this is the last honest distance from the bottom.
      lastDistanceFromBottomRef.current = Math.max(0, el.scrollHeight - st - el.clientHeight);
      // La freccia si ri-sincronizza QUI, dove la geometria è già sotto mano.
      syncArrow(el);
      // Fondo VERO raggiunto a mano: qui si scioglie la presa, e serve un
      // evento apposta perché Virtuoso non ne manda. La sua soglia è 150px:
      // chi è risalito di 60px non l'ha mai fatta scattare, quindi non c'era
      // nessun `reached-bottom` a chiudere il giro — e la chat sarebbe rimasta
      // senza aggancio per il resto della sessione.
      if (
        authorityRef.current.userHeld &&
        el.scrollHeight - st - el.clientHeight <= BOTTOM_RELEASE_PX
      ) {
        dispatchScroll({ type: 'reached-bottom', distanceFromBottom: 0 });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('touchstart', markGesture, { passive: true });
    el.addEventListener('touchmove', markGesture, { passive: true });
    // Trascinamento della barra di scorrimento: nessun wheel, nessun tasto.
    el.addEventListener('pointerdown', markGesture, { passive: true });

    // La pane torna VISIBILE dopo essere stata nascosta.
    //
    // Le tab non si smontano: la scala keep-alive le lascia montate con
    // `display:none`, e lì la viewport di Virtuoso è alta 0 — non renderizza
    // righe e non misura niente. Quando torni su quella chat la lista si
    // ricostruisce da capo, e dove atterra non lo decide nessuno: se nel
    // frattempo erano arrivati messaggi, ti ritrovi a metà. Il passaggio
    // 0 → altezza vera è il segnale che nessun evento di scroll può dare.
    //
    // Pinna solo se l'autorità dice che eri ancorato: chi aveva lasciato la
    // chat scrollata indietro la ritrova dove l'aveva lasciata.
    let wasHidden = el.clientHeight === 0;
    const ro = new ResizeObserver(() => {
      const hidden = el.clientHeight === 0;
      if (wasHidden && !hidden) {
        wasHidden = hidden;
        // FORZATO se nessuno l'ha toccata, e la differenza si vede solo sulle
        // tab in secondo piano: una pane nascosta ha viewport alta 0, quindi il
        // pin di apertura ci ha scritto sopra a vuoto e si e' consumato. Quando
        // torna visibile l'unico rimedio era un pin NON forzato, che
        // `shouldPin` puo' aver gia' vietato — e la chat restava dove capitava.
        // Una pane nascosta non puo' aver ricevuto gesti: se `userTouchedRef` e'
        // falso, il fondo e' ancora lo stato di riposo.
        //
        // Unless the rest of the history was merged while the pane was hidden
        // and the reader had scrolled up: then the row they were reading has a
        // new index, and the anchor remembered by `completeOutOfSight` puts it
        // back at the top of the viewport instead of the bottom.
        const anchor = restoreAnchorRef.current;
        if (anchor) {
          restoreAnchorRef.current = null;
          const target = carrierRef.current.get(anchor.id) ?? anchor.id;
          const index = itemsRef.current.findIndex((m) => m.id === target);
          if (index >= 0) {
            virtuosoRef.current?.scrollToIndex({ index, align: 'start' });
            syncArrow(el);
            return;
          }
        }
        pinToBottom({ viaVirtuoso: true, frames: 2, settleFrames: OPEN_SETTLE_FRAMES, force: !userTouchedRef.current });
        // Tornata visibile: la misura congelata mentre era nascosta non vale
        // più niente (viewport alta 0), si ricalcola.
        syncArrow(el);
        return;
      }
      wasHidden = hidden;
      if (hidden) {
        // The viewport just went to zero: the one moment the rest of the
        // history can be merged without anybody seeing the rows re-index.
        completeOutOfSightRef.current();
        return;
      }
      syncArrow(el);
      // L'ULTIMA crescita, quella che nessuno annuncia.
      //
      // `totalListHeightChanged` è la contabilità di Virtuoso e copre le righe;
      // qui si guarda il DOM, quindi si vede anche ciò che quella contabilità
      // non conta — il footer che segue l'altezza del composer, un'immagine che
      // finisce di caricare, un font che si assesta. Sono decine di pixel che
      // arrivano dopo che il nostro assestamento è già finito, sotto la soglia
      // di Virtuoso (150px) e quindi senza nessun evento: la chat «arriva in
      // fondo e poi scivola via di poco», che è il difetto che restava.
      //
      // Stessa doppia condizione dell'altra regola: `shouldPin` (dentro
      // `pinToBottom`) più la geometria misurata adesso, così questo pin può
      // solo finire un movimento già quasi compiuto e non trascina mai giù chi
      // sta leggendo indietro.
      const r = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Un pixel di banda morta, non di più: allargarla spegnerebbe
      // l'oscillazione descritta più sotto, ma lascerebbe la chat FERMA a sei
      // pixel dal fondo — e quello si vede. Vedi la nota prima di `pinToBottom`.
      if (r <= 1) return;
      // DENTRO L'APERTURA la distanza non è un argomento.
      //
      // Il resto di questa regola esiste per non strappare la vista a chi sta
      // leggendo, e per quello la tolleranza è giusta: si può solo finire un
      // movimento quasi compiuto. Ma finché la chat si sta APRENDO non c'è
      // nessuno da cui guardarsi — `userTouchedRef` lo dice — e la distanza
      // misura solo quanto è grande l'ULTIMO pezzo di contenuto arrivato.
      // Misurato: su una lista fitta l'ultima crescita è di 225px in un colpo
      // (la lista che monta le righe che le restano PIÙ il footer che prende
      // l'altezza del composer, nello stesso frame), e con la sola soglia dei
      // 150 ogni via di recupero si tirava indietro proprio lì — la chat
      // restava aperta a 225px dal fondo, ferma, senza più nessun evento.
      // Non è un caso di nicchia: più la chat è compatta, più righe entrano in
      // un frame, più grande è quel salto.
      const now = Date.now();
      if (!userTouchedRef.current && now <= openingUntilRef.current && now <= openingHardStopRef.current) {
        pinToBottom({ force: true, settleFrames: OPEN_SETTLE_FRAMES });
        return;
      }
      if (r > AT_BOTTOM_TOLERANCE_PX) return;
      // NOTA sull'anello, per chi passerà di qui a «ottimizzare».
      //
      // A riposo questo pin si autoalimenta: incollare al fondo fa smontare a
      // Virtuoso una riga al bordo, l'altezza cala di ~6px, la riga rientra,
      // l'altezza risale, l'observer riparte. Misurato: `h` che rimbalza fra
      // 1409 e 1415, un pin per giro. È preesistente e costa poco (un rAF e
      // due letture di geometria), ma è visibile in traccia e fa gola.
      //
      // Le due cure ovvie sono state PROVATE e sono peggio del male, perché
      // entrambe lasciano la vista ferma a sei pixel dal fondo:
      //  • allargare la banda morta a 8px;
      //  • contare i colpi e smettere dopo N.
      // Sei pixel di scroll residuo si VEDONO, e sono esattamente il difetto
      // che tre test qui accanto esistono per impedire («il fondo vero, non
      // quasi» — con una tolleranza di 60px quel difetto era arrivato in
      // produzione con la suite verde). Fra un ballo che non si vede e uno
      // scarto fermo che si vede, si sceglie il ballo. Se lo si vuole chiudere
      // davvero, la leva è la bistabilità della lista (`increaseViewportBy`),
      // non la soglia di questa regola.
      pinToBottom();
    });
    ro.observe(el);
    // Anche il CONTENUTO, non solo il contenitore: lo scroller cambia dimensione
    // quando cambia la finestra, il contenuto quando cambia la conversazione.
    //
    // E il contenuto è la LISTA, non il primo figlio: la struttura di Virtuoso è
    // scroller > viewport > lista, e il viewport ha altezza FISSA quanto la
    // finestra (misurato: 760px sempre). Osservare quello voleva dire osservare
    // un elemento che non cambia mai — l'osservatore c'era e non è mai scattato.
    const lista = el.querySelector('[data-testid="virtuoso-item-list"]') ?? el.firstElementChild?.firstElementChild;
    if (lista) ro.observe(lista);

    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      document.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('touchstart', markGesture);
      el.removeEventListener('touchmove', markGesture);
      el.removeEventListener('pointerdown', markGesture);
    };
    // `_currentStreaming` NON sta qui: lo legge `streamingRef`. Vedi il commento
    // sul ref — rimontare i listener a ogni transizione di stream faceva
    // ripartire l'osservazione iniziale del ResizeObserver, e con essa il pin.
    //
    // `syncArrow` invece ci sta, e NON riapre quella porta: è un
    // `useCallback(..., [])` che chiude solo su `arrowShownRef`, su
    // `setIsScrolledUp` e su due `const` primitive — quindi la sua identità è
    // costante per tutta la vita del componente e questa dipendenza non può
    // rieseguire l'effetto nemmeno una volta. Elencarla è l'unico modo per far
    // sì che, se un giorno le si desse una dipendenza vera, il difetto si
    // presenti qui invece di restare una closure stantia che misura la freccia
    // sulla geometria sbagliata. Se quel giorno arriva, la cura è stabilizzarla
    // di nuovo (ref), non toglierla da questa lista.
  }, [scrollerEl, topic.id, dispatchScroll, pinToBottom, OPEN_SETTLE_FRAMES, syncArrow]);

  // Auto-scroll to bottom when a NEW message is APPENDED while streaming is
  // NOT active — an inbound system message, or a peer's message in a shared
  // topic — and the user is parked at the bottom. Virtuoso's followOutput
  // ('smooth') is unreliable for this case: the appended item's height is
  // measured a frame late, so 'smooth' lands short and leaves the view scrolled
  // up with an unread banner (chat-scroll.spec:29). Mirror the streaming effect
  // and pin the scroller DOM element directly once the list has grown.
  const prevAppendLenRef = useRef(filteredMessages.length);
  useEffect(() => {
    const grew = filteredMessages.length > prevAppendLenRef.current;
    prevAppendLenRef.current = filteredMessages.length;
    // Il veto del salto da palette è dentro `pinToBottom` (la sua load
    // sostituisce 0 → N messaggi, che qui conta come "grew" — e questo effetto
    // è dichiarato DOPO quello del salto, quindi il suo rAF girava per ultimo e
    // riportava il salto in fondo: il 4° e ultimo meccanismo della catena).
    // `viaVirtuoso`: la lista è VIRTUALIZZATA, e l'item appena aggiunto può non
    // essere montato. Scrivere `scrollTop = scrollHeight` da soli incolla a
    // un'altezza che non contiene ancora la coda — la vista fa un salto parziale
    // di qualche centinaio di pixel e si ferma a mezz'aria, che è il "si aggancia
    // male" che si vede. `scrollToIndex('LAST')` materializza la coda, poi il rAF
    // incolla sull'altezza vera. Stessa sequenza del bottone «torna in fondo».
    if (grew && !_currentStreaming) pinToBottom({ viaVirtuoso: true, frames: 2 });
  }, [filteredMessages, _currentStreaming, pinToBottom]);

  // A message the USER just sent must ALWAYS snap the view to the bottom —
  // even if they were reading scrolled-up history — because sending is an
  // explicit intent to follow the reply. Unlike the inbound-append effect
  // above (which respects scroll-up for peer/system messages), this fires
  // ONLY when the newly appended last message is the user's own, and va per la
  // transizione `user-sent` — l'unico evento che RIANCORA una vista sganciata.
  // Double-rAF so the freshly measured item height lands before we pin
  // (mirrors the streaming pin). The palette-jump veto still wins.
  const prevSendLenRef = useRef(filteredMessages.length);
  useEffect(() => {
    const grew = filteredMessages.length > prevSendLenRef.current;
    prevSendLenRef.current = filteredMessages.length;
    if (!grew) return;
    const last = filteredMessages[filteredMessages.length - 1];
    if (last?.role !== 'user') return;
    // Inviare È l'intento di seguire la risposta: la transizione `user-sent`
    // riancora anche una vista che l'utente aveva portato indietro a leggere.
    dispatchScroll({ type: 'user-sent' }, { frames: 2 });
  }, [filteredMessages, dispatchScroll]);

  // Re-pin the bottom when the COMPOSER changes height. Its height feeds the
  // Virtuoso Footer — the ONLY bottom spacer — asynchronously via a
  // ResizeObserver, so when the Stop button, TodoStrip or CheckpointTimeline
  // appear/disappear mid-turn the newly reserved space lands a frame AFTER the
  // send/streaming snap already ran. Without this, the freshly reserved gap
  // pushes the live content — and the turn indicator that sits at the very
  // bottom — under the composer ("il loader finisce sotto l'input"). Re-anchor
  // on every height change, unless the user deliberately scrolled up or a
  // palette jump owns the viewport.
  //
  // Due precisazioni, e sono quelle che rendono innocuo il box della CODA.
  // Quel box sta fuori dallo scroller (è nel composer), ma la sua altezza
  // rientra qui dentro: `inputAreaHeight` è il Footer di Virtuoso, cioè
  // contenuto scrollato. Comparire e sparire, a ogni ciclo della coda, sono
  // due cambi d'altezza — e prima ognuno era un pin.
  //  • si pinna solo quando lo spazio CRESCE: è l'unico caso in cui qualcosa
  //    rischia di finire sotto il composer. Uno shrink non nasconde niente;
  //  • si confronta arrotondato, perché `contentRect.height` è un float e il
  //    rumore subpixel bastava a far partire il giro.
  const prevInputAreaHeightRef = useRef(Math.round(inputAreaHeight));
  useEffect(() => {
    const h = Math.round(inputAreaHeight);
    const grew = h > prevInputAreaHeightRef.current;
    prevInputAreaHeightRef.current = h;
    if (!grew) return;
    pinToBottom({ frames: 2 });
  }, [inputAreaHeight, pinToBottom]);

  // Detect new messages while scrolled up
  useEffect(() => {
    // Sui messaggi RESI, non su quelli grezzi: la lista filtra (turni vuoti,
    // marcatori) e fonde le corse di tool in un item solo, quindi contare
    // `currentMessages` prometteva «+3 nuovi» per righe che a schermo non
    // esistono — e cliccando non si trovava niente di nuovo.
    if (filteredMessages.length > prevMsgCountRef.current && isScrolledUp) {
      const newCount = filteredMessages.length - prevMsgCountRef.current;
      setNewMsgCount(prev => prev + newCount);
      setShowNewBanner(true);
    }
    prevMsgCountRef.current = filteredMessages.length;
  }, [filteredMessages.length, isScrolledUp]);

  // PANE-03 scroll-restore (review I1). Apply the undo-captured offset once
  // per topic mount, AFTER Virtuoso's default bottom-anchor settles. We run
  // the effect keyed on topic.id (the Virtuoso remounts via `key={topic.id}`),
  // wait two frames so the initial layout+bottom-scroll lands, then set the
  // scroll position clamped to scrollHeight. If initialScrollOffset is
  // undefined/0/negative we do nothing — normal opens keep their bottom-
  // anchored behavior.
  const restoredForTopicRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredForTopicRef.current === topic.id) return;
    if (typeof initialScrollOffset !== 'number' || initialScrollOffset <= 0) return;
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const el = scrollerElRef.current;
        if (!el) return;
        const target = clampScrollOffset(initialScrollOffset, el.scrollHeight, el.clientHeight);
        // Skip micro-noise — only apply if meaningfully different from the
        // default anchor; also guards against accidentally scrolling away
        // from the bottom if the restored offset rounds to max.
        if (target > 0 && Math.abs(el.scrollTop - target) > 2) {
          el.scrollTop = target;
          // L'autorità deve sapere che NON siamo più in fondo. La banda del
          // ripristino è più stretta di quella live (RESTORE_DETACH_PX): un
          // ripristino deliberato non va arrotondato al fondo.
          dispatchScroll({
            type: 'offset-restored',
            distanceFromBottom: el.scrollHeight - target - el.clientHeight,
          });
        }
        restoredForTopicRef.current = topic.id;
      });
      return () => cancelAnimationFrame(raf2);
    });
    return () => cancelAnimationFrame(raf1);
    // Intentionally not depending on initialScrollOffset — we only want the
    // value as captured at mount (undo time). Subsequent prop churn is ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id]);

  // Throttled scroll tracker — keeps pane.scrollOffset fresh on the store so
  // a future CLOSE_PANE captures the real position (review I1 PANE-03 wiring).
  const trackThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onScrollOffsetChange) return;
    const el = scrollerElRef.current;
    if (!el) return;
    const onScroll = () => {
      if (trackThrottleRef.current) return;
      trackThrottleRef.current = setTimeout(() => {
        trackThrottleRef.current = null;
        const cur = scrollerElRef.current;
        if (cur) onScrollOffsetChange(cur.scrollTop);
      }, 250);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (trackThrottleRef.current) {
        clearTimeout(trackThrottleRef.current);
        trackThrottleRef.current = null;
        // Review #3: flush the pending scroll position on cleanup so a
        // quick scroll-then-close (or topic switch) still captures the
        // final offset — otherwise CLOSE_PANE reads a value up to 250 ms
        // stale. Reading `el.scrollTop` from the closure is safe because
        // the element is still live until React completes the unmount.
        onScrollOffsetChange(el.scrollTop);
      }
    };
    // Re-bind when the scroller element changes (topic swap remounts Virtuoso).
  }, [topic.id, onScrollOffsetChange]);

  const scrollToBottom = useCallback(() => {
    // `force`: è l'utente che chiede il fondo. Un eventuale salto da palette in
    // corso è esattamente ciò a cui sta dicendo di no — non può vetarlo.
    const decision = reduceScroll(authorityRef.current, { type: 'scroll-to-bottom' }, Date.now());
    authorityRef.current = decision.state;
    // La freccia sparisce SUBITO, senza aspettare la misura: il pin è
    // asincrono (rAF) e lasciarla accesa per due frame dopo il click la fa
    // sembrare non premuta. `arrowShownRef` va tenuto allineato, o la prossima
    // misura crederebbe di doverla spegnere e non farebbe niente.
    arrowShownRef.current = false;
    setIsScrolledUp(false);
    pinToBottom({ viaVirtuoso: true, force: true });
    setNewMsgCount(0);
    setShowNewBanner(false);
  }, [pinToBottom]);

  // data-testid on the outer wrapper ensures the selector is always queryable
  // regardless of loading/empty/Virtuoso state (pane-undo.spec.ts relies on
  // [data-testid='chat-scroll-container']). The Virtuoso internal scroller is
  // targeted via scrollerElRef without a separate testid.
  return (
    <div
      data-testid="chat-scroll-container"
      ref={chatContainerRef}
      role="log"
      aria-live="polite"
      aria-label={`Messages for ${topic.name}`}
      className={`chat-under-chrome flex-1 overflow-y-auto relative min-h-0 ${fileDragOver ? 'bg-primary/3' : ''}`}
      onDragOver={onFileDragOver}
      onDragLeave={onFileDragLeave}
      onDrop={onFileDrop}
    >
      {fileDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-lg pointer-events-none">
          <div className="text-center">
            <Paperclip size={20} className="mx-auto mb-1 text-primary/50" />
            <p className="text-primary/70 font-medium text-[12px]">Drop files here</p>
          </div>
        </div>
      )}

      <NewMessageBanner show={showNewBanner} onClick={scrollToBottom} />

      {/* Lo scheletro, UNO SOLO per i due momenti in cui serve: la chat che non
          ha ancora niente da mostrare (primo avvio vero, nessuna cache) e la
          lista che si sta ancora posando (il sipario, sopra). Erano due
          disegni diversi — tre bolle allineate IN CIMA con misure inventate —
          e il passaggio dall'uno all'altra era esso stesso un salto. */}
      {currentLoading && currentMessages.length === 0 ? (
        <SkeletonChatMessages isMobile={isMobile} bottomInset={inputAreaHeight + CHAT_BOTTOM_GUTTER_PX} />
      ) : filteredMessages.length === 0 ? (
        /* Niente. Il vuoto di una chat lo disegna `ChatEmptyState`, dentro il
           blocco del composer: i due si centrano insieme e scivolano insieme in
           fondo al primo messaggio. Stando qui — in cima al contenitore che
           scorre — era lontano mezzo schermo dalla riga di testo di cui parla,
           e non c'era modo di muoverli come una cosa sola. */
        null
      ) : (
        <>
        {!listSettled && <SkeletonChatMessages isMobile={isMobile} bottomInset={inputAreaHeight + CHAT_BOTTOM_GUTTER_PX} />}
        <Virtuoso
          data-testid="chat-message-list"
          // What the list holds of the thread (`historyCompleteness`): the one
          // observable of a merge made while the pane is hidden, where no row
          // is rendered to look at. Read by `chat-tail-first.spec.ts`.
          data-history={completeness.state}
          key={topic.id}
          ref={virtuosoRef}
          scrollerRef={scrollerRef}
          data={filteredMessages}
          // CONGELATO al montaggio, e non è un dettaglio: questa prop dice a
          // Virtuoso da quale item partire, e ricalcolarla a ogni messaggio la
          // fa RI-APPLICARE — la lista strappava la vista dalla cima al fondo da
          // sola, senza che nessuno avesse pinnato (visto in traccia: `top: 0`
          // e un istante dopo `top: 434`, cioè il fondo, seguito da un
          // `reached-bottom` che riancorava). Era il «l'aggancio fa cose sue».
          // La lista si rimonta a ogni cambio di topic (`key={topic.id}`),
          // quindi il valore congelato è sempre quello giusto per la chat che
          // stai guardando.
          initialTopMostItemIndex={initialTopMostItemIndex}
          // Callback form so a pending palette jump can veto the auto-follow:
          // the load that the jump rides in replaces 0 → N messages, and with
          // zero items Virtuoso considers itself trivially "at bottom" — the
          // plain 'smooth' prop then animated to the bottom ~150ms AFTER the
          // jump's scrollToIndex, silently undoing it (the final live bug in
          // the palette-jump chain). Otherwise mirrors the old behavior:
          // follow when at bottom and not streaming.
          followOutput={(isAtBottom: boolean) => {
            if (peekScrollToMessage(topic.id)) return false;
            if (_currentStreaming) return false;
            // Anche questo è un pin, solo che lo esegue Virtuoso e quindi non
            // passa da `shouldPin`. La sua idea di «in fondo» è la stessa
            // fascia dei 150px: senza questa riga, chi era risalito di 149px si
            // vedeva ANIMARE la vista verso il basso a ogni item nuovo — la
            // versione più fastidiosa del difetto, perché dura più frame ed è
            // esattamente il momento in cui uno sta tirando su.
            if (authorityRef.current.userHeld) return false;
            return isAtBottom ? 'smooth' : false;
          }}
          // 150 (not 50) so the redesign's initial bottom-anchor — which
          // settles ~1 short message (≈60–150px) above the true bottom as
          // Virtuoso lazily remeasures item heights — still counts as
          // "at bottom". At 50px that lag latched "scrolled up", which
          // permanently suppressed the append-auto-scroll effect (a new inbound
          // message no longer stuck to the bottom — chat-scroll.spec:29). Stessa
          // costante dell'autorità: AT_BOTTOM_TOLERANCE_PX.
          atBottomThreshold={AT_BOTTOM_TOLERANCE_PX}
          /**
           * L'ultima parola sull'apertura, e serve perché la prima non è nostra.
           *
           * Virtuoso misura gli item a più riprese: il nostro pin di apertura
           * parte a misure ancora provvisorie, e subito dopo Virtuoso applica il
           * suo `initialTopMostItemIndex` sulle altezze vere — rimettendo in
           * cima alla viewport l'INIZIO dell'ultimo messaggio. Con una risposta
           * più alta della finestra il risultato è esattamente il difetto
           * riportato: la chat riapre in cima all'ultimo messaggio e il resto lo
           * riscrolli a mano. Verificato in traccia: pin eseguito, e la vista
           * comunque ferma a `top = 75` (l'altezza del penultimo item).
           *
           * Questa callback arriva a misura FATTA, che è il momento giusto. Vale
           * solo dentro la finestra di apertura e solo se l'utente non ha
           * toccato lo scroll: dopo, la lista è sua.
           */
          totalListHeightChanged={() => {
            const now = Date.now();
            const inApertura =
              !userTouchedRef.current &&
              now <= openingUntilRef.current &&
              now <= openingHardStopRef.current;
            if (inApertura) {
              // Finché la lista continua a misurarsi, l'apertura non è finita:
              // una scadenza fissa la mollava a metà proprio quando l'ultima
              // misura arriva tardi (lista lunga, macchina carica).
              openingUntilRef.current = Math.min(now + OPEN_EXTEND_MS, openingHardStopRef.current);
              pinToBottom({ force: true, settleFrames: OPEN_SETTLE_FRAMES });
              return;
            }
            // FUORI dall'apertura vale la regola generale, ed è la definizione
            // stessa di «ancorato»: se il contenuto cresce mentre sei in fondo,
            // in fondo ci resti. Senza questo restava scoperta l'ultima crescita
            // — quella piccola e tardiva (un'altezza rimisurata, il footer che
            // si assesta): sotto i 150px di soglia Virtuoso non annuncia niente,
            // il nostro assestamento è già finito, e nessuno riporta giù. In
            // traccia si vede benissimo: pin eseguiti, `reached-bottom`, poi più
            // NESSUN evento e la vista comunque a qualche decina di pixel dal
            // fondo. Era il «arriva in fondo e poi scivola via».
            // Doppia condizione, e la seconda è la geometria VERA misurata
            // adesso: `anchored` è una convinzione dell'autorità e può essere in
            // ritardo di un evento, la distanza dal fondo no. Così questo pin
            // può spostare la vista al massimo di una tolleranza — cioè può solo
            // finire un movimento già quasi compiuto — e non può mai trascinare
            // giù chi sta leggendo indietro.
            const el = scrollerElRef.current;
            if (!el) return;
            const distanza = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (distanza > AT_BOTTOM_TOLERANCE_PX) return;
            pinToBottom();
          }}
          atBottomStateChange={(atBottom) => {
            if (atBottom) {
              // Ci siamo arrivati NOI o ci è saltata da sola? Se un attimo fa
              // era lontana dal fondo e nessun pin è passato di qui, è la lista
              // che si è ri-ancorata dopo una rimisura — e quel salto non deve
              // valere come «l'utente è tornato in fondo».
              const el = scrollerElRef.current;
              const distanzaPrima = el ? el.scrollHeight - lastScrollTopRef.current - el.clientHeight : 0;
              const teleported =
                distanzaPrima > AT_BOTTOM_TOLERANCE_PX &&
                Date.now() - lastPinAtRef.current > PIN_ATTRIBUTION_MS;
              // Tornare in fondo perdona tutto: la crescita successiva riaggancia.
              // La distanza VERA viaggia con l'evento: «in fondo» per Virtuoso
              // vuol dire entro 150px, e a 100px dal fondo l'utente sta ancora
              // leggendo — non è il momento di riprendergli lo scroll.
              dispatchScroll({
                type: 'reached-bottom',
                teleported,
                distanceFromBottom: el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0,
              });
              setNewMsgCount(0);
              setShowNewBanner(false);
              return;
            }
            // atBottom === false. Da qui NON si distingue chi l'ha causato: lo
            // decide l'autorità. Durante lo stream questo evento non è mai
            // l'utente (quello passa da `user-scrolled-up` e ha già sganciato):
            // è un tool block che è cresciuto sotto la posizione pinnata, e si
            // resta incollati. Fuori dallo stream conta la geometria, con la
            // guardia contro il rimbalzo dei nostri stessi scroll forzati.
            const el = scrollerElRef.current;
            dispatchScroll({
              type: 'left-bottom',
              streaming: _currentStreaming,
              // Senza scroller non c'è geometria da misurare (Virtuoso ce l'ha
              // sempre quando emette questo evento): 0 = "non so quanto", che
              // dentro la guardia non sgancia e fuori sì, come prima.
              distanceFromBottom: el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0,
            });
          }}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          // The row at the top of the viewport, for the re-anchor after a merge
          // made while the pane was hidden (`completeOutOfSight`). Only while
          // there is a viewport: a hidden pane renders no range worth keeping.
          rangeChanged={(range) => {
            const el = scrollerElRef.current;
            if (el && el.clientHeight > 0) topVisibleIndexRef.current = range.startIndex;
          }}
          itemContent={(idx, msg) => {
            const prev = idx > 0 ? filteredMessages[idx - 1] : undefined;
            // Only show plan approve/reject on the last assistant message
            const isLastAssistant = msg.role === 'assistant' && idx === filteredMessages.length - 1;
            const trailingMarkers = markersAfter(msg);
            // One boundary, one signal: a divider hoists the recap out of the
            // message BELOW it (that's where the CLI writes it) and renders the
            // expander itself, and that message then skips its own fold.
            const next = idx + 1 < filteredMessages.length ? filteredMessages[idx + 1] : undefined;
            const trailingSummary = trailingMarkers?.length
              ? splitCompactionSummary(next?.content ?? '').summary
              : null;
            // A divider whose anchor is not on screen sits on top as a safety
            // net - unless the head of the chat is simply not here yet, in
            // which case the anchor is on its way and the divider waits for it.
            const leading = historyPartial ? NO_MARKERS : markerPartition.leading;
            const leadingSummary = idx === 0 && leading.length
              ? splitCompactionSummary(msg.content ?? '').summary
              : null;
            const hoistOwnSummary = idx === 0
              ? !!leadingSummary
              : !!(prev && markersAfter(prev)?.length);
            return (
              <>
              {idx === 0 && historyPartial && (
                <LoadOlderDivider count={missingAbove} loading={olderLoading} onLoad={loadOlder} />
              )}
              {idx === 0 && leading.map((mk, i) => (
                <CompactionDivider
                  key={mk.id}
                  marker={mk}
                  summary={i === leading.length - 1 ? leadingSummary ?? undefined : undefined}
                />
              ))}
              <CompactionHoistContext.Provider value={hoistOwnSummary}>
              <div
                className={
                  (isMobile ? 'px-2' : 'px-4') +
                  (msg.id === jumpHighlightId ? ' chat-msg-jump-highlight' : '')
                }
                data-jump-highlight={msg.id === jumpHighlightId ? 'true' : undefined}
              >
                <MessageBubble
                  msg={msg}
                  prev={prev}
                  idx={idx}
                  isLast={idx === filteredMessages.length - 1}
                  topic={topic}
                  copiedMsgId={copiedMsgId}
                  isCompact={isCompact}
                  fontSize={settings.fontSize}
                  isMobile={isMobile}
                  onReply={onReply}
                  onCopy={onCopy}
                  onTogglePin={onTogglePin}
                  // La decisione sul piano NON è gatata sull'ultimo messaggio:
                  // il pannello sta sulla riga del tool che ha proposto, che può
                  // essere più su se nel frattempo è arrivato altro.
                  onPlanDecision={onPlanDecision}
                  onRemember={onRemember}
                  onEdit={onEdit}
                  onRegenerate={onRegenerate}
                  onDeleteMessage={onDeleteMessage}
                  onSwitchBranch={onSwitchBranch}
                  onMessage={onMessage}
                  onRetry={isLastAssistant ? onRetry : undefined}
                />
              </div>
              </CompactionHoistContext.Provider>
              {trailingMarkers && trailingMarkers.map((mk) => (
                <CompactionDivider key={mk.id} marker={mk} summary={trailingSummary ?? undefined} />
              ))}
              </>
            );
          }}
          components={virtuosoComponents}
          // `visibility` e non `opacity`: un elemento a opacità zero VIENE
          // DIPINTO (e i suoi spostamenti contano lo stesso nel CLS), uno
          // `hidden` no — ma tiene il layout, quindi Virtuoso continua a
          // misurare le altezze mentre il sipario è chiuso. È l'unica delle due
          // che fa entrambe le cose.
          //
          // Si somma alla maschera del composer (`scrollerStyle`): quella
          // spegne l'inchiostro dietro l'input, questo tiene chiuso il sipario
          // finché la lista non si è assestata. Sono due cose diverse e
          // servono entrambe.
          style={{ ...scrollerStyle, visibility: listSettled ? undefined : 'hidden' }}
        />
        </>
      )}

      <div ref={messagesEndRef} />
      <ScrollToBottom show={isScrolledUp} newCount={newMsgCount} onClick={scrollToBottom} bottomOffset={inputAreaHeight} />
    </div>
  );
}

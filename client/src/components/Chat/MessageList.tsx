import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Paperclip } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage, CompactionMarker } from '../../types';
import { ScrollToBottom, NewMessageBanner } from '../Shared/ScrollToBottom';
import { CompactionDivider } from './CompactionDivider';
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
  type ScrollAuthorityState,
  type ScrollEvent,
} from './scrollAuthority';

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
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onReply: (msg: ChatMessage) => void;
  onCopy: (msg: ChatMessage) => void;
  onTogglePin: (msg: ChatMessage) => void;
  onFileDragOver: (e: React.DragEvent) => void;
  onFileDragLeave: (e: React.DragEvent) => void;
  onFileDrop: (e: React.DragEvent) => void;
  setMessage: (v: string) => void;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  onRemember?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  onRegenerate?: (msg: ChatMessage) => void;
  onDeleteMessage?: (msg: ChatMessage) => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onRetry?: () => void;
  inputAreaHeight?: number;
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
  textareaRef,
  onReply,
  onCopy,
  onTogglePin,
  onFileDragOver,
  onFileDragLeave,
  onFileDrop,
  setMessage,
  onPlanApprove,
  onPlanReject,
  onRemember,
  onEdit,
  onRegenerate,
  onDeleteMessage,
  onSwitchBranch,
  onMessage,
  onRetry,
  inputAreaHeight = 0,
  initialScrollOffset,
  onScrollOffsetChange,
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

  // Stable Virtuoso `components` map: a fresh object + Footer fn identity every
  // render defeats Virtuoso's bailout, so the footer churned per streaming
  // token. The footer only depends on inputAreaHeight.
  const virtuosoComponents = useMemo(() => ({
    Footer: () => inputAreaHeight > 0 ? <div style={{ height: inputAreaHeight }} /> : null,
  }), [inputAreaHeight]);

  // Memoize filtered messages
  const filteredMessages = useMemo(() =>
    currentMessages.filter(msg => {
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
    [currentMessages]
  );

  // Position compaction dividers within the visible transcript (CHAT-COMPACT-01).
  const markerPartition = useMemo(
    () => partitionMarkers(filteredMessages, compactionMarkers),
    [filteredMessages, compactionMarkers],
  );

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
  const initialTopMostItemIndex = initialTopMostIndexRef.current ?? Math.max(0, filteredMessages.length - 1);


  // ── I due soli verbi dello scroll ─────────────────────────────────────────
  // `pinToBottom` incolla, `dispatchScroll` chiede all'autorità cosa fare. Ogni
  // punto che prima decideva da sé ora usa questi.

  /** Quante volte al massimo si ritenta il pin mentre le altezze si assestano.
   *  Sei frame ≈ 100ms: abbastanza per l'ultimo item e il footer, troppo poco
   *  per combattere con un utente che nel frattempo scrolla (il ri-controllo di
   *  `shouldPin` dentro ogni frame lo lascia comunque vincere). */
  const PIN_SETTLE_FRAMES = 6;
  /** Quando abbiamo pinnato l'ultima volta: serve a distinguere «la vista è in
   *  fondo perché ce l'abbiamo portata noi» da «ci è saltata da sola». */
  const lastPinAtRef = useRef(0);
  /** Finestra entro cui un arrivo al fondo è ancora attribuibile al nostro pin. */
  const PIN_ATTRIBUTION_MS = 500;

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
  const pinToBottom = useCallback((opts?: { viaVirtuoso?: boolean; frames?: 1 | 2; force?: boolean }) => {
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
      lastPinAtRef.current = Date.now();
      const el = scrollerElRef.current;
      // Ri-controllo dentro il frame: uno scroll dell'utente arrivato fra la
      // programmazione e l'esecuzione non va sovrascritto da un pin ormai vecchio.
      if (!el) return;
      if (!opts?.force && !shouldPin(authorityRef.current, { jumpPending: jumpPending() })) return;
      el.scrollTop = el.scrollHeight;
      const residuo = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (residuo > 1 && attempts < PIN_SETTLE_FRAMES) {
        attempts++;
        requestAnimationFrame(run);
      }
    };
    if (opts?.frames === 2) requestAnimationFrame(() => requestAnimationFrame(run));
    else requestAnimationFrame(run);
  }, [jumpPending]);

  /** Manda un evento all'autorità, applica il nuovo stato, e pinna se lo dice lei. */
  const dispatchScroll = useCallback((event: ScrollEvent, pinOpts?: { viaVirtuoso?: boolean; frames?: 1 | 2 }) => {
    const decision = reduceScroll(authorityRef.current, event, Date.now());
    authorityRef.current = decision.state;
    setIsScrolledUp(!decision.state.anchored);
    if (decision.pin) pinToBottom(pinOpts);
  }, [pinToBottom]);

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
      prevMsgCountRef.current = 0;
      // Riparte ancorata e arma la guardia: la lista si rimonta e si rimisura
      // tutta. Il pin vero lo fa l'effetto che aspetta il caricamento.
      dispatchScroll({ type: 'topic-switch' });
    }
  }, [topic.id, dispatchScroll]);

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
      dispatchScroll({ type: 'scroll-to-bottom' }, { viaVirtuoso: true });
    }
  }, [currentLoading, filteredMessages.length, dispatchScroll, topic.id]);

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
    // The scroller ResizeObserver below re-fires this when the pane shows.
    const scroller = scrollerElRef.current;
    if (!scroller || scroller.clientHeight === 0) return;
    const targetId = peekScrollToMessage(topic.id);
    if (!targetId) return;
    const index = filteredMessages.findIndex((m) => m.id === targetId);
    if (index < 0) {
      // Drop the target ONLY when an AUTHORITATIVE thread lacks the id
      // (inactive branch, deleted message) — i.e. this instance has watched a
      // loadHistory cycle complete AND the result is non-empty. Both weaker
      // states bit us live: a mounted-but-never-loaded keep-alive pane
      // (0 messages, loading=false — the palette event fires against exactly
      // that), and a slow-machine mount window holding a non-empty STALE set
      // before loadHistory even started (CI-only). The TTL covers leaks.
      if (sawLoadCompleteRef.current && !currentLoading && filteredMessages.length > 0) {
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
    setJumpHighlightId(targetId);
    if (jumpHighlightTimer.current) clearTimeout(jumpHighlightTimer.current);
    jumpHighlightTimer.current = setTimeout(() => setJumpHighlightId(null), 2400);
  }, [topic.id, filteredMessages, currentLoading]);
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
  useEffect(() => {
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
    const releaseToUser = () => dispatchScroll({
      type: 'user-scrolled-up',
      streaming: _currentStreaming,
      distanceFromBottom: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
    });
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseToUser();
    };
    const onScroll = () => {
      const st = el.scrollTop;
      if (isUserScrollUp(lastScrollTopRef.current, st)) releaseToUser();
      lastScrollTopRef.current = st;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollerEl, topic.id, _currentStreaming, dispatchScroll]);

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
  const prevInputAreaHeightRef = useRef(inputAreaHeight);
  useEffect(() => {
    const changed = inputAreaHeight !== prevInputAreaHeightRef.current;
    prevInputAreaHeightRef.current = inputAreaHeight;
    if (!changed) return;
    pinToBottom({ frames: 2 });
  }, [inputAreaHeight, pinToBottom]);

  // Detect new messages while scrolled up
  useEffect(() => {
    if (currentMessages.length > prevMsgCountRef.current && isScrolledUp) {
      const newCount = currentMessages.length - prevMsgCountRef.current;
      setNewMsgCount(prev => prev + newCount);
      setShowNewBanner(true);
    }
    prevMsgCountRef.current = currentMessages.length;
  }, [currentMessages.length, isScrolledUp]);

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
      className={`flex-1 overflow-y-auto relative min-h-0 ${fileDragOver ? 'bg-primary/3' : ''}`}
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

      {currentLoading && currentMessages.length === 0 ? (
        <div className={`${isMobile ? 'px-2' : 'px-4'} ${isCompact ? 'space-y-1' : 'space-y-2'} overflow-hidden`}>
          {[1,2,3].map(i => (
            <div key={i} className={`flex gap-1.5 ${i % 2 === 0 ? 'justify-end' : 'justify-start'} animate-pulse`}>
              <div className={`rounded-lg px-3 py-2 max-w-[85%] ${
                i % 2 === 0 
                  ? 'bg-primary/20' 
                  : 'bg-app-hover'
              }`}>
                <div className="h-3 rounded w-32 mb-1.5 bg-black/10 dark:bg-white/10" />
                <div className="h-3 rounded w-20 bg-black/5 dark:bg-white/5" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredMessages.length === 0 ? (
        <div className={`text-center ${'py-3 px-3 md:py-8 md:px-4'}`}>
          <p className="text-[14px] font-medium text-app-text-secondary">{topic.name}</p>
          {topic.systemPrompt && (
            <p className="text-[11px] text-purple-400 mt-1 flex items-center justify-center gap-1">
              <span>✨</span> Custom system prompt active
            </p>
          )}
          {!topic.projectPath && (
            <p className="text-[12px] text-app-text-muted mt-2 mb-2">Start a conversation</p>
          )}
          <div className="flex flex-wrap gap-2 justify-center mt-4">
            {(topic.projectPath ? [
                { label: '📋 Describe this project', msg: 'Give me a brief overview of this project — what it does, the tech stack, and the main files.' },
                { label: '🔄 Recent changes', msg: 'Show me the recent git changes in this project and summarize what was modified.' },
                { label: '🐛 Find issues', msg: 'Review this project for potential bugs, code smells, or improvements.' },
              ] : [
                { label: '💡 Brainstorm ideas', msg: 'Help me brainstorm some ideas.' },
                { label: '📝 Write something', msg: 'Help me write ' },
                { label: '🔍 Research a topic', msg: 'Research ' },
              ]).map(q => (
                <button
                  key={q.label}
                  onClick={() => { setMessage(q.msg); textareaRef.current?.focus(); }}
                  className="px-3 py-1.5 text-[12px] rounded-full border border-app-border-light text-app-text-secondary hover:bg-app-hover hover:border-primary hover:text-primary transition-all hover-lift"
                >
                  {q.label}
                </button>
              ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 justify-center text-[11px] text-app-text-faint">
            <span className="flex items-center gap-1.5"><kbd className="kbd">⌘K</kbd> commands</span>
            <span className="flex items-center gap-1.5"><kbd className="kbd">/</kbd> slash commands</span>
            {topic.projectPath && <span className="flex items-center gap-1.5"><kbd className="kbd">@</kbd> mention file</span>}
            <span className="flex items-center gap-1.5"><kbd className="kbd">⌘?</kbd> all shortcuts</span>
          </div>
          {inputAreaHeight > 0 && <div style={{ height: inputAreaHeight }} />}
        </div>
      ) : (
        <Virtuoso
          data-testid="chat-message-list"
          key={topic.id}
          ref={virtuosoRef}
          scrollerRef={(ref) => {
            const el = (ref as HTMLElement | null) ?? null;
            scrollerElRef.current = el;
            // Anche come stato: è l'unica via perché l'effetto dei listener si
            // accorga che lo scroller è arrivato (vedi `scrollerEl`).
            setScrollerEl((prev) => (prev === el ? prev : el));
          }}
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
              dispatchScroll({ type: 'reached-bottom', teleported });
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
          itemContent={(idx, msg) => {
            const prev = idx > 0 ? filteredMessages[idx - 1] : undefined;
            // Only show plan approve/reject on the last assistant message
            const isLastAssistant = msg.role === 'assistant' && idx === filteredMessages.length - 1;
            const trailingMarkers = msg.id ? markerPartition.byAfter.get(msg.id) : undefined;
            // One boundary, one signal: a divider hoists the recap out of the
            // message BELOW it (that's where the CLI writes it) and renders the
            // expander itself, and that message then skips its own fold.
            const next = idx + 1 < filteredMessages.length ? filteredMessages[idx + 1] : undefined;
            const trailingSummary = trailingMarkers?.length
              ? splitCompactionSummary(next?.content ?? '').summary
              : null;
            const leadingSummary = idx === 0 && markerPartition.leading.length
              ? splitCompactionSummary(msg.content ?? '').summary
              : null;
            const hoistOwnSummary = idx === 0
              ? !!leadingSummary
              : !!(prev?.id && markerPartition.byAfter.get(prev.id)?.length);
            return (
              <>
              {idx === 0 && markerPartition.leading.map((mk, i) => (
                <CompactionDivider
                  key={mk.id}
                  marker={mk}
                  summary={i === markerPartition.leading.length - 1 ? leadingSummary ?? undefined : undefined}
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
                  onPlanApprove={isLastAssistant ? onPlanApprove : undefined}
                  onPlanReject={isLastAssistant ? onPlanReject : undefined}
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
          style={{ height: '100%' }}
        />
      )}

      <div ref={messagesEndRef} />
      <ScrollToBottom show={isScrolledUp} newCount={newMsgCount} onClick={scrollToBottom} bottomOffset={inputAreaHeight} />
    </div>
  );
}

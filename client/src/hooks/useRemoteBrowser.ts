import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { parseBrowserWsMessage, type BrowserWsMessage } from '../../../shared/browser-ws-messages';
import type { ElementDescription } from '../../../shared/element-describe';
import type { RemoteField } from '../../../shared/browser-keyboard-field';
import { serverWsBase } from '@/lib/shell/net';
import { attachViewerChannel, pushViewerCount } from '../lib/viewerCountBus';
import { mapCoordinates } from './browserCoords';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'fallback-http';

// Phase 30 BROWSER-CHAT-04 — DOM info for the select-element pattern (Cursor Cmd+Shift+E).
// 4.2: non è più un sottoinsieme dichiarato a parte ma LA descrizione condivisa
// (`shared/element-describe`), la stessa che gira nella pane nativa — così il
// pick web e il pick nativo non possono divergere di campo.
export type SelectedElementInfo = ElementDescription;

/** A download the headless page triggered, saved server-side. `href` points at
 *  our own origin (user-clicked link) — the web pane has no native shelf. */
export interface DownloadInfo {
  filename: string;
  href: string;
  size?: number;
  state: 'started' | 'completed' | 'failed';
}

interface RemoteBrowserState {
  url: string;
  title: string;
  loading: boolean;
  connected: boolean;
  screenshotSrc: string | null;
  error: string | null;
  /** URL whose navigation produced `error` — the Retry affordance re-sends it. */
  errorUrl: string | null;
  connectionState: ConnectionState;
  lastClickPos: { x: number; y: number; t: number } | null;
  // Phase 30 BROWSER-CHAT-04 — agent lock + select-element state.
  agentActive: boolean;
  /** Human-readable label of the agent's current action (active=true edge). */
  agentAction: string | null;
  selectMode: boolean;
  selectedElement: SelectedElementInfo | null;
  pageScaleFactor: number;
  /** Downloads the headless page triggered (server-saved, surfaced as links). */
  downloads: DownloadInfo[];
  /** Quanti download sono PARTITI da quando la pane è viva. Solo cresce — anche
   *  quando una voce viene tolta dall'elenco — perché è il segnale con cui il
   *  menu Download della toolbar decide di aprirsi da sé: se contasse le voci
   *  presenti, svuotare l'elenco spegnerebbe l'annuncio del prossimo file. */
  downloadsSeq: number;
  /** T2: whether the CURRENT url allows being framed (probed server-side). The
   *  panel renders a native <iframe> when framable AND no agent is driving. */
  framable: boolean;
  /** Engine switch (task 54601eeb): the engine THIS pane runs on. 'native' = the
   *  headless-Chromium stream; 'chromium' = the user's real Chromium (extensions). */
  engine: 'native' | 'chromium';
  /** Whether the Native↔Chromium toggle should be offered (server capability:
   *  un vero Chromium installato sulla macchina). */
  engineToggleAvailable: boolean;
  /** Extensions loaded in the chromium sidecar profile — the toolbar badge. */
  engineExtensions: number;
  /** WebRTC shared-session transport is live: the pane renders the H.264 <video>
   *  instead of the JPEG <img>. False = JPEG stream (default / fallback). */
  webrtcActive: boolean;
  /** The <video> is mounted (negotiation started) — kept true through negotiation so
   *  ontrack can attach the stream BEFORE ICE connects. Visible only when active. */
  webrtcMounted: boolean;
  /** WebRTC could not be established after all retries (sidecar missing / ICE failed).
   *  The pane surfaces an error + Riprova instead of a JPEG fallback. */
  webrtcError: boolean;
  /** T1 DOM co-browse: how THIS pane renders. 'video' = the pixel stream
   *  (WebRTC/JPEG, default); 'dom' = a native rrweb DOM reconstruction (real
   *  browser, cross-device-sharp) — the server streams DOM events instead of pixels. */
  renderMode: 'video' | 'dom';
}

interface InteractionHandlers {
  onClick: (e: React.MouseEvent<HTMLImageElement | HTMLVideoElement>) => void;
  onWheel: (e: React.WheelEvent<HTMLImageElement | HTMLVideoElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

interface RemoteBrowser extends RemoteBrowserState, InteractionHandlers {
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  goHome: () => void;
  imgRef: React.RefObject<HTMLImageElement | null>;
  /** The <video> element for the WebRTC track — rendered when `webrtcActive`. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Callback ref for the pane content element — wires a debounced ResizeObserver
   *  that streams the pane's real size (+DPR) to the server (kills the letterbox). */
  containerRef: (el: HTMLElement | null) => void;
  // Phase 30 BROWSER-CHAT-04 — take-control + select-element actions.
  takeControl: () => void;
  enterSelectMode: () => void;
  exitSelectMode: () => void;
  setSelectedElement: (el: SelectedElementInfo | null) => void;
  /** Engine switch: request this pane run on the given engine (server-gated). */
  setEngine: (engine: 'native' | 'chromium') => void;
  /** Task 052f53ef: pause/resume the server screencast (iframe-mode ⇒ false). */
  setStreamActive: (active: boolean) => void;
  /** Is this pane ON SCREEN? Separate from setStreamActive on purpose: this is
   *  the ONLY input of the cross-device viewer count, and the screencast pauses
   *  for transport reasons (WebRTC, DOM co-browse) while still watching. */
  setWatching: (active: boolean) => void;
  /** Retry the WebRTC transport after a `webrtcError` (the pane's Riprova button). */
  retryWebrtc: () => void;
  /** T1 DOM co-browse: request 'video' (pixel stream) or 'dom' (native rrweb
   *  reconstruction). The server confirms via `render_mode` (or forces 'video'
   *  when DOM mode is unsupported for the context). */
  setRenderMode: (mode: 'video' | 'dom') => void;
  /** T1 DOM co-browse: register the live rrweb-event sink (the DomCoBrowse view's
   *  Replayer). Returns an unsubscribe. Only one sink at a time. */
  registerDomSink: (cb: (event: unknown) => void) => () => void;
  /** Registra chi riceve il campo a fuoco riportato dal server dopo un click
   *  (null = a fuoco non c'è niente di scrivibile). Uno solo alla volta, come il
   *  sink rrweb; restituisce la disiscrizione. */
  registerFocusSink: (cb: (field: RemoteField | null) => void) => () => void;
  /** Low-level input relay (page-CSS px). The <img>/<video> handlers use it via
   *  their own mapping; the DomCoBrowse view calls it directly with coords it maps
   *  from the reconstructed iframe. */
  sendInput: (
    action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
    payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' },
  ) => void;
  /** Menu Download della toolbar: togli UNA voce (per href) / svuota l'elenco. */
  dismissDownload: (href: string) => void;
  clearDownloads: () => void;
}

const IDLE_INTERVAL = 2000;
const ACTIVE_INTERVAL = 300;
const ACTIVE_DURATION = 3000;
const FALLBACK_DELAY_MS = 2000;
// WS auto-reconnect: exponential backoff capped here. A transient drop now
// restores the full-fidelity stream instead of stranding the pane in HTTP
// polling forever (fallback-http stays as a parallel floor until WS returns).
const MAX_RECONNECT_DELAY_MS = 10000;
// Match the server's bandwidth-safe DPR ceiling (browser-service clampDsf).
const MAX_DSF = 2;
// Watchdog: `loading` is set true on navigate/reload and is normally cleared by
// the server's `nav`/`response` message. If that message is lost (server crash,
// dropped WS frame, a disconnect right after the request), `loading` — and thus
// the pane's busy spinner — would otherwise stick ON forever. This is the upper
// bound after which we force-clear it. Deliberately long: it must be a true
// backstop for a LOST completion signal, not fire during a genuinely slow page
// load (heavy assets / high latency can legitimately take 30s+) — firing early
// would flip the spinner off while the page is still loading, a deceptive
// "done" signal. The happy path clears in well under a second, so this only
// ever fires when something is actually wrong.
const NAV_LOADING_TIMEOUT_MS = 60000;

// Shared-session WebRTC transport — the streaming pane's transport. It negotiates an
// H.264 WebRTC track (served by the Rust webrtc-bridge attached to this pane's CDP
// target) and renders it in a <video>. This is THE transport for non-framable pages
// (framable URLs still use a native <iframe>); there is no JPEG rendering. Default ON;
// opt-OUT escape hatch only: localStorage `topics.browser.webrtc = '0'` or build-time
// VITE_BROWSER_WEBRTC=0 (kill switch for debugging).
const WEBRTC_ENABLED: boolean = (() => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('topics.browser.webrtc') === '0') return false;
  } catch { /* SSR / storage blocked */ }
  return import.meta.env?.VITE_BROWSER_WEBRTC !== '0';
})();
// How many times to renegotiate before surfacing an error+retry (the pane's CDP target
// may not exist yet on the first attempts — the sidecar/context is created lazily).
const WEBRTC_MAX_ATTEMPTS = 4;
const WEBRTC_RETRY_DELAY_MS = 1500;
// Watchdog budgets. The short one covers "no answer at all" (target/sidecar not ready →
// retry fast). Once ICE reaches 'checking' it's re-armed with the longer connect budget:
// a cold LAN path (fresh sidecar spawn + CDP target creation + candidate pairing) can
// take several seconds, and tearing the pc down mid-'checking' causes retry churn.
const WEBRTC_NO_ANSWER_TIMEOUT_MS = 6000;
const WEBRTC_CONNECT_TIMEOUT_MS = 15000;
// Quanto si aspetta la ricevuta di un click sul canale dati prima di chiedere
// lo stesso al server chi ha il fuoco. Largo rispetto al giro vero (un hop
// SCTP sulla stessa PeerConnection dei pixel), stretto rispetto ai 700 ms che
// il server si dà per leggere il campo: chi arriva qui ha già perso la corsa
// con la tastiera, e insistere non la fa salire prima.
const INPUT_ACK_TIMEOUT_MS = 250;

const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/**
 * @param isVisible When false (pane is hidden behind another tab/split), inbound
 *   screencast frames are dropped instead of applied — the last frame is retained
 *   so there's no blank on reveal, but the per-frame base64 decode + `<img>` repaint
 *   is skipped. This keeps the single-WKWebView Tauri renderer's memory/CPU in check
 *   when many browser panes exist but only one is on screen. The WS stays open
 *   (so agent-active / nav state still update); only the costly frame paint pauses.
 */
export function useRemoteBrowser(contextId: string, isVisible = true): RemoteBrowser {
  const encodedId = useMemo(() => encodeURIComponent(contextId), [contextId]);

  // Read inside the long-lived WS `onmessage` closure without re-subscribing the
  // socket on every visibility toggle (re-running the WS effect would close+reopen
  // the connection — churn + lost in-flight state).
  const isVisibleRef = useRef(isVisible);
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  const [state, setState] = useState<RemoteBrowserState>({
    url: '',
    title: '',
    loading: false,
    connected: false,
    screenshotSrc: null,
    error: null,
    errorUrl: null,
    connectionState: 'connecting',
    lastClickPos: null,
    agentActive: false,
    agentAction: null,
    selectMode: false,
    selectedElement: null,
    pageScaleFactor: 1,
    downloads: [],
    downloadsSeq: 0,
    framable: false,
    engine: 'native',
    engineToggleAvailable: false,
    engineExtensions: 0,
    webrtcActive: false,
    webrtcMounted: false,
    webrtcError: false,
    // Option A: DOM is the DEFAULT surface — the real browser rebuilt natively,
    // cross-device-sharp, no video. On connect the pane asks the server for 'dom'
    // (ws.onopen); the server confirms via `render_mode` or forces 'video' back
    // when it can't snapshot the page (canvas/WebGL/injection blocked), and only
    // THEN does the WebRTC pixel transport negotiate.
    renderMode: 'dom',
  });

  const imgRef = useRef<HTMLImageElement | null>(null);
  // WebRTC shared-session transport (opt-in): the <video>, its RTCPeerConnection,
  // a per-connection "tried" guard, the active-mirror for closures, and a watchdog
  // that falls back to JPEG if the PC never connects.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // Il canale su cui viaggia l'input (punto 6). Aperto insieme alla PC, chiuso con
  // lei: finché non è 'open', sendInput usa il WebSocket come ha sempre fatto.
  const inputChannelRef = useRef<RTCDataChannel | null>(null);
  // Numeratore dei messaggi di input a cui vogliamo una ricevuta, e chi aspetta
  // quella ricevuta. Serve a UN caso solo: un click sul canale dati va spinto su
  // CDP PRIMA di chiedere al server chi ha preso il fuoco, o la risposta
  // descrive la pagina di un istante fa. Vedi `sendInput`.
  const inputSeqRef = useRef(0);
  const inputAckWaitersRef = useRef(new Map<number, () => void>());
  const webrtcActiveRef = useRef(false);
  const webrtcWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Renegotiation attempts + retry timer (the CDP target may not exist on the first
  // tries — the sidecar/context is created lazily). Exhausted → webrtcError.
  const webrtcAttemptRef = useRef(0);
  const webrtcRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webrtcStartRef = useRef<() => void>(() => {});
  // Mirror of the effect-local teardownWebrtc so out-of-effect callers (DOM-mode
  // switch) can drop the PC — the server pauses the screencast in DOM mode.
  const webrtcTeardownRef = useRef<() => void>(() => {});
  // Pause the pixel track when the pane leaves the screen (see the isVisible
  // effect below). Distinct from teardownWebrtc: it does NOT re-enable the JPEG
  // bootstrap, so the panel's set_stream(isVisible) gate stays authoritative.
  const webrtcPauseRef = useRef<() => void>(() => {});
  // T1 DOM co-browse: mirror of renderMode for the long-lived onmessage closure,
  // and the live rrweb-event sink (registered by the DomCoBrowse view's Replayer).
  const renderModeRef = useRef<'video' | 'dom'>('dom');
  const domSinkRef = useRef<((event: unknown) => void) | null>(null);
  // Chi ha preso il fuoco nella pagina remota dopo il nostro ultimo click. Lo
  // consuma la superficie visibile (video o mirror) per vestire il campo di
  // cattura della tastiera. Di proposito SENZA buffer, al contrario degli eventi
  // rrweb: un fuoco vecchio applicato tardi è peggio di nessun fuoco.
  const focusSinkRef = useRef<((field: RemoteField | null) => void) | null>(null);
  // Buffer events that arrive before the DomCoBrowse view registers its sink (the
  // bootstrap burst can land in the same tick the pane mounts). Flushed on register.
  const domEventBufferRef = useRef<unknown[]>([]);
  // Newest frame delivered so far. Frames after the first are direct
  // `img.src` writes (no setState), so state.screenshotSrc goes stale by
  // design — this ref lets a remounted <img> re-assert the newest frame
  // instead of showing the stale first one until the page next repaints.
  const lastFrameSrcRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pageScaleFactorRef = useRef<number>(1);
  // Latest CDP frame metadata (CSS-px device dims) for click mapping at HiDPI.
  const frameMetaRef = useRef<{ deviceWidth?: number; deviceHeight?: number }>({});
  // This client's DPR, clamped to the server's bandwidth-safe ceiling (2×).
  const dsfRef = useRef<number>(
    Math.max(1, Math.min(MAX_DSF, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)),
  );
  // Pane content element + its ResizeObserver, and the last size actually sent
  // (dedup guard). See containerRef + sendResize below.
  const containerElRef = useRef<HTMLElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentSizeRef = useRef<{ w: number; h: number; dsf: number }>({ w: 0, h: 0, dsf: 0 });
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeUntilRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const typeBufRef = useRef<string>('');
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Engine switch (task 54601eeb): mirror of state.engine for the ws.onmessage
  // closure (avoids a stale capture), + an epoch that forces a WS remount when
  // the engine changes so the server recreates the context on the new engine.
  const engineRef = useRef<'native' | 'chromium'>('native');
  const [engineEpoch, setEngineEpoch] = useState(0);
  // Task 052f53ef: desired server-stream state. The panel flips it to false while
  // it renders a native <iframe> so the headless Chromium stops rendering; the WS
  // stays open. Re-asserted on every (re)connect (the server defaults to active).
  const streamActiveRef = useRef(true);
  // Is this pane on screen? The ONLY thing the cross-device viewer count reads.
  // Kept apart from streamActiveRef because the screencast pauses for transport
  // reasons (WebRTC took the pixels, DOM co-browse, iframe) while the pane is
  // very much being watched. Re-asserted on every (re)connect (server default:
  // watching).
  const watchingRef = useRef(true);
  // See NAV_LOADING_TIMEOUT_MS — force-clears a stuck `loading` if the nav
  // completion signal never arrives.
  const loadingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLoadingWatchdog = useCallback(() => {
    if (loadingWatchdogRef.current) {
      clearTimeout(loadingWatchdogRef.current);
      loadingWatchdogRef.current = null;
    }
  }, []);

  // Arm the watchdog when a navigation starts. Re-arming cancels the prior
  // timer so only the latest in-flight nav is timed.
  const armLoadingWatchdog = useCallback(() => {
    clearLoadingWatchdog();
    loadingWatchdogRef.current = setTimeout(() => {
      loadingWatchdogRef.current = null;
      if (!mountedRef.current) return;
      // Lost completion signal: say so (BRW-REL-02) — silently flipping the
      // spinner off left the pane looking idle on whatever page it had.
      setState(s => (s.loading
        ? { ...s, loading: false, error: 'Navigation timed out (no response from browser)', errorUrl: s.url || null }
        : s));
    }, NAV_LOADING_TIMEOUT_MS);
  }, [clearLoadingWatchdog]);
  const lastScrollRef = useRef<number>(0);

  const markActive = useCallback(() => {
    activeUntilRef.current = Date.now() + ACTIVE_DURATION;
  }, []);

  const updateConnectionState = useCallback((next: ConnectionState) => {
    connectionStateRef.current = next;
    setState(s => ({
      ...s,
      connectionState: next,
      connected: next === 'connected' || next === 'fallback-http',
    }));
  }, []);

  // Stream the pane's real size (+DPR) to the server so its viewport matches the
  // pane — kills the fixed-1280 letterbox and renders HiDPI-sharp. Deduped (a
  // no-op resize is skipped) and only sent while the WS is live; the value is
  // force-re-sent on every (re)connect (see ws.onopen) so the server viewport
  // is correct even after a context recreate.
  const sendResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    const dsf = dsfRef.current;
    const last = lastSentSizeRef.current;
    if (last.w === width && last.h === height && last.dsf === dsf) return;
    lastSentSizeRef.current = { w: width, h: height, dsf };
    if (connectionStateRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'resize', width, height, deviceScaleFactor: dsf };
        wsRef.current.send(JSON.stringify(msg));
      } catch { /* dropped — re-sent on next reconnect/resize */ }
    }
  }, []);

  // Callback ref for the pane content element: wires a debounced (~150ms)
  // ResizeObserver that reports size changes via sendResize. Re-attaching (or
  // null on unmount) tears down the previous observer + timer.
  const containerRef = useCallback((el: HTMLElement | null) => {
    if (resizeObserverRef.current) { resizeObserverRef.current.disconnect(); resizeObserverRef.current = null; }
    if (resizeDebounceRef.current) { clearTimeout(resizeDebounceRef.current); resizeDebounceRef.current = null; }
    containerElRef.current = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      sendResize(Math.round(r.width), Math.round(r.height));
    };
    const ro = new ResizeObserver(() => {
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(measure, 150);
    });
    ro.observe(el);
    resizeObserverRef.current = ro;
    measure(); // initial size (also force-re-sent on ws.onopen)
  }, [sendResize]);

  // REST fallback — kept for graceful degradation when the WS bridge is down.
  // The interact endpoint does getOrCreate server-side.
  const interact = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/browsers/${encodedId}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok && mountedRef.current) {
        setState(s => ({ ...s, error: `Interact ${res.status}` }));
      }
    } catch {
      // Silently fail — info poll will detect disconnect.
    }
  }, [encodedId]);

  // Fetch screenshot via REST (used only in fallback-http mode).
  const fetchScreenshot = useCallback(() => {
    if (!mountedRef.current) return;
    const preload = new Image();
    preload.onload = () => {
      if (!mountedRef.current) return;
      setState(s => ({ ...s, screenshotSrc: preload.src }));
    };
    preload.onerror = () => {
      // Don't clear existing screenshot on transient errors.
    };
    preload.src = `/api/browsers/${encodedId}/snapshot?t=${Date.now()}`;
  }, [encodedId]);

  // Fetch context info via REST (URL/title check + connection probe).
  const fetchInfo = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/browsers/${encodedId}`);
      if (!mountedRef.current) return false;
      if (res.ok) {
        const data = await res.json();
        setState(s => ({
          ...s,
          url: data.url || s.url,
          title: data.title || s.title,
          loading: false,
        }));
        return true;
      } else if (res.status === 404) {
        return false;
      }
    } catch {
      // Network error — stay in current state; the next poll/WS attempt retries.
    }
    return false;
  }, [encodedId]);

  // sendInput — DataChannel-first, poi WS, poi REST. Tre gradini, e si scende solo
  // se quello sopra non c'è.
  //
  // Il DataChannel è il gradino nuovo (punto 6 del piano WebRTC): viaggia sulla
  // STESSA PeerConnection dei pixel e finisce dritto sulla sessione CDP che il
  // sidecar ha già aperta per lo screencast. Il WS invece passa dal server Bun e da
  // Playwright: due processi in mezzo per muovere un mouse, mentre il video della
  // stessa pane era già in linea diretta.
  //
  // Il messaggio è IDENTICO nei due tubi, di proposito: cambia il trasporto, non il
  // protocollo, così il percorso del WebSocket resta valido e collaudato come rete
  // di sotto — un canale non ancora aperto (o caduto) non fa perdere un click.
  //
  // Un click che scende dal canale dati si porta dietro una coda: `focus_query`.
  // Il ramo del click nel server è anche il posto da cui parte `focus_field`, la
  // risposta che dice al telefono CHE tastiera aprire; scavalcando il server
  // quella risposta non partiva più e sul ramo video tornava su la tastiera
  // generica. La domanda viaggia da sola sul WS, dove il round trip lo pagava
  // già, e il click resta sul canale veloce — che è il punto di tutto questo.
  const askFocusField = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    try {
      const msg: BrowserWsMessage = { type: 'focus_query' };
      wsRef.current.send(JSON.stringify(msg));
    } catch { /* socket caduto — la tastiera resta quella generica */ }
  }, []);

  // Una ricevuta è arrivata (o non arriverà): sveglia chi la aspettava, una volta sola.
  const settleInputAck = useCallback((id: number) => {
    const waiter = inputAckWaitersRef.current.get(id);
    if (!waiter) return;
    inputAckWaitersRef.current.delete(id);
    waiter();
  }, []);

  const sendInput = useCallback((
    action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
    payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' },
  ) => {
    const dc = inputChannelRef.current;
    if (dc?.readyState === 'open') {
      try {
        if (action === 'click') {
          // L'`id` chiede la ricevuta al sidecar: quando torna, i comandi CDP
          // del click sono già sul socket del target. Solo allora ha senso
          // domandare chi ha il fuoco. Se la ricevuta non arriva si chiede lo
          // stesso dopo il timeout: una tastiera forse sbagliata è meglio di
          // nessuna tastiera.
          const id = ++inputSeqRef.current;
          inputAckWaitersRef.current.set(id, askFocusField);
          setTimeout(() => settleInputAck(id), INPUT_ACK_TIMEOUT_MS);
          dc.send(JSON.stringify({ type: 'input', action, payload, id }));
        } else {
          dc.send(JSON.stringify({ type: 'input', action, payload }));
        }
        return;
      } catch {
        // Canale chiuso fra il controllo e l'invio — si scende al WS.
      }
    }
    if (connectionStateRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: BrowserWsMessage = { type: 'input', action, payload };
      try {
        wsRef.current.send(JSON.stringify(msg));
        return;
      } catch {
        // WS send failed mid-flight — fall through to REST.
      }
    }
    // Fallback: REST interact. Map action to the REST shape (the existing
    // /api/browsers/:id/interact endpoint expects { action, ...payload }).
    interact({ action, ...payload });
  }, [interact, askFocusField, settleInputAck]);

  // WebSocket lifecycle with exponential-backoff auto-reconnect. `connect()` is
  // (re)invoked by the mount effect, the backoff timer, and focus/online wake —
  // a transient drop restores the full-fidelity stream instead of stranding the
  // pane in HTTP polling. fallback-http stays as a parallel floor until the WS
  // returns (a successful onopen supersedes it).
  useEffect(() => {
    mountedRef.current = true;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!mountedRef.current) return;
      // Dedup guard: if a socket is already connecting or open, don't spawn a
      // duplicate. The backoff timer, focus/online wake, and React StrictMode's
      // double-mount can all race a second connect(); only (re)connect when the
      // current socket is truly gone (null / CLOSING / CLOSED).
      const cur = wsRef.current;
      if (cur && (cur.readyState === WebSocket.CONNECTING || cur.readyState === WebSocket.OPEN)) return;
      const wsUrl = `${serverWsBase()}/ws/browser/${encodedId}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        // Browser blocked WS — go straight to fallback (no retry loop).
        updateConnectionState('fallback-http');
        return;
      }
      wsRef.current = ws;
      if (connectionStateRef.current !== 'connected') updateConnectionState('connecting');

    // Every handler is inert unless `ws` is STILL the current socket — a
    // superseded socket (StrictMode double-mount, a reconnect that replaced it)
    // must not touch connection state or it would flap the pane to disconnected.
    // This socket carries the pushed viewer count while it is up (see
    // viewerCountBus): announced on open, withdrawn on close, per socket so a
    // superseded one withdraws only itself.
    let detachViewerChannel: (() => void) | null = null;
    ws.onopen = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      updateConnectionState('connected');
      detachViewerChannel = attachViewerChannel(contextId);
      // Fresh connection → reset the WebRTC retry budget + clear any prior error so
      // the transport renegotiates (driven by the first frame proving a live target).
      webrtcAttemptRef.current = 0;
      if (webrtcRetryTimerRef.current) { clearTimeout(webrtcRetryTimerRef.current); webrtcRetryTimerRef.current = null; }
      setState(s => (s.webrtcError ? { ...s, webrtcError: false } : s));
      // NOTE: reconnectAttempt is NOT reset here — only a real FRAME (stable
      // connection) resets the backoff. A flapping server (open→close→open→…
      // with no frame) must let the backoff GROW so its reconnects move away
      // from the fallback timer and polling can engage. See the 'frame' case.
      // Don't clear `error` here: it's a NAVIGATION error now (BRW-REL-02),
      // owned by navigate()/nav-response. Clearing on (re)connect let the WS
      // retry churn wipe the strip milliseconds after a failed nav set it.
      //
      // Do NOT clear the fallback timer here: a FLAPPING server (open→close→
      // open→close before delivering any frame) would otherwise reset it on
      // every brief open and never degrade to polling. The fallback timer is
      // cleared only once a real FRAME proves the stream works (see 'frame').
      // Sync url/title from the server's known context state once on connect.
      // The bridge streams `frame`s but only emits a `nav` message on an
      // actual navigation — a pane that (re)connects to an already-navigated
      // context would otherwise sit at an empty url (screenshot suppressed by
      // the "enter a URL" empty-state gate) until the next navigation. This
      // GET is the server's source of truth; `data.url || s.url` never clobbers
      // a fresher optimistic/nav value.
      fetchInfo();
      // Force-(re)send the pane size so the server viewport matches on (re)connect
      // — after a context recreate the server starts at the default otherwise.
      lastSentSizeRef.current = { w: 0, h: 0, dsf: 0 };
      const el = containerElRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        sendResize(Math.round(r.width), Math.round(r.height));
      }
      // Task 052f53ef: the server defaults a fresh connection to streaming — if
      // the pane is currently in iframe-mode, re-assert the pause so a reconnect
      // (or the initial open) doesn't silently resume the headless render.
      if (!streamActiveRef.current) {
        try { ws.send(JSON.stringify({ type: 'set_stream', active: false } satisfies BrowserWsMessage)); } catch { /* dropped */ }
      }
      // Same for "am I on screen": a fresh socket counts as watching, so a
      // hidden pane that reconnects must say otherwise or it would silently
      // re-enter the viewer count and pin every other device to the shared
      // session.
      if (!watchingRef.current) {
        try { ws.send(JSON.stringify({ type: 'set_watching', active: false } satisfies BrowserWsMessage)); } catch { /* dropped */ }
      }
      // Option A: DOM is the default surface, so RE-ASSERT it on every (re)connect —
      // the server defaults a fresh connection to the pixel stream. This makes the
      // server enable DOM mode, pause this viewer's screencast, and re-send the
      // rrweb bootstrap (a reconnecting DOM viewer needs a fresh FullSnapshot). If
      // the page can't be snapshotted the server replies `render_mode:'video'` and
      // the video effect then negotiates WebRTC — no code path here for that.
      if (renderModeRef.current === 'dom') {
        try { ws.send(JSON.stringify({ type: 'set_render', mode: 'dom' } satisfies BrowserWsMessage)); } catch { /* dropped */ }
      }
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      try {
        const raw = JSON.parse(event.data);
        const result = parseBrowserWsMessage(raw);
        if (!result.ok) {
          // Defense-in-depth: server should already validate emits. Log
          // protocol drift but don't crash the consumer.
          if (import.meta.env.DEV) {
            console.warn(`[browser ${contextId}] Invalid WS message:`, result.error);
          }
          return;
        }
        const msg = result.data;
        switch (msg.type) {
          case 'frame': {
            // A real frame proves the WS stream works: clear any pending
            // fallback-to-polling timer and (re)assert 'connected'. Done BEFORE
            // the isVisible gate so a hidden pane still counts as connected, and
            // this is the ONLY place the fallback timer + reconnect backoff are
            // reset (a flapping server that never delivers a frame must still
            // degrade to polling, with a GROWING backoff).
            reconnectAttempt = 0;
            if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null; }
            if (connectionStateRef.current !== 'connected') updateConnectionState('connected');
            // A frame proves this pane has a live CDP target → negotiate the WebRTC
            // transport (the JPEG frame is an internal bootstrap signal, never rendered;
            // once WebRTC connects we stop the screencast). Guarded internally. Only in
            // 'video' mode: DOM is the default surface (Option A) and needs no pixels.
            if (WEBRTC_ENABLED && renderModeRef.current === 'video' && !pcRef.current && !webrtcActiveRef.current) startWebrtc();
            // Hidden pane: drop the frame (keep the last one painted) to skip the
            // base64 decode + img repaint. See the isVisible param docs above.
            if (!isVisibleRef.current) break;
            const psf = msg.metadata?.pageScaleFactor;
            if (psf) {
              pageScaleFactorRef.current = psf;
            }
            // Stash the device (CSS-px) dims for HiDPI-correct click mapping.
            frameMetaRef.current = {
              deviceWidth: msg.metadata?.deviceWidth,
              deviceHeight: msg.metadata?.deviceHeight,
            };
            const src = `data:image/jpeg;base64,${msg.data}`;
            // Steady-state frames are DIRECT DOM writes (same pattern as the
            // drag paths in SplitTree/useGridResize): at ~15fps a setState
            // here re-rendered the whole 667-line panel — 3 unmemoized
            // toolbars included — per frame. React state only records the
            // transitions that change WHAT renders: the first frame
            // (placeholder → <img>) and a pageScaleFactor change (rare).
            // Re-renders from other state leave the img alone because its
            // src prop (the first-frame value) never changes.
            lastFrameSrcRef.current = src;
            const img = imgRef.current;
            if (img) img.src = src;
            setState(s => {
              const firstFrame = s.screenshotSrc === null;
              const psfChanged = !!psf && psf !== s.pageScaleFactor;
              if (!firstFrame && !psfChanged) return s; // same ref: no render
              return {
                ...s,
                ...(firstFrame ? { screenshotSrc: src } : {}),
                ...(psfChanged ? { pageScaleFactor: psf } : {}),
              };
            });
            break;
          }
          case 'nav':
            if (msg.phase === 'response') {
              clearLoadingWatchdog();
              setState(s => ({ ...s, url: msg.url, loading: false, error: null, errorUrl: null }));
            } else if (msg.phase === 'error') {
              // Failed goto/launch: the page is still on the previous URL —
              // surface the reason instead of silently clearing the spinner
              // (BRW-REL-02). Cleared by the next successful nav/response.
              clearLoadingWatchdog();
              setState(s => ({ ...s, loading: false, error: msg.error || 'Navigation failed', errorUrl: msg.url }));
            }
            break;
          case 'console':
            // Forward to devtools console; full UI surface deferred to plan 30-04.
            console.debug(`[browser ${contextId}] ${msg.level}: ${msg.text}`);
            break;
          case 'agent_active':
            // Phase 30 BROWSER-CHAT-04 — agent lock state surfaced to RemoteBrowserPanel
            // for the "🤖 agent is controlling…" overlay. Retain the action label
            // across the idle linger: overwrite only on the active=true edge.
            setState(s => ({
              ...s,
              agentActive: msg.active,
              agentAction: msg.active && msg.action ? msg.action : s.agentAction,
            }));
            break;
          case 'download':
            // Defense-in-depth: only ever render a link into our own served
            // downloads dir — never a javascript:/data:/external href, even if
            // the message were spoofed. Anything else is dropped.
            if (!msg.href.startsWith('/media/browser/downloads/')) break;
            // Surface the server-saved download as a clickable link (the web
            // pane has no native shelf). Dedup by href: update its state, or
            // append; keep the strip bounded to the most recent few.
            setState(s => {
              const next = s.downloads.slice();
              const i = next.findIndex(d => d.href === msg.href);
              const info: DownloadInfo = { filename: msg.filename, href: msg.href, size: msg.size, state: msg.state };
              if (i >= 0) next[i] = info; else next.push(info);
              return { ...s, downloads: next.slice(-8), downloadsSeq: s.downloadsSeq + (i >= 0 ? 0 : 1) };
            });
            break;
          case 'engine': {
            // Engine switch broadcast (task 54601eeb). Update the badge/engine,
            // and — only when the engine actually CHANGED — bump the epoch to
            // remount the WS: the server already destroyed the context, so the
            // reconnect recreates it (via the engine hint) on the new engine.
            const prevEngine = engineRef.current;
            engineRef.current = msg.engine;
            setState(s => ({ ...s, engine: msg.engine, engineExtensions: msg.extensions ?? s.engineExtensions }));
            if (prevEngine !== msg.engine) setEngineEpoch(e => e + 1);
            break;
          }
          case 'webrtc_answer': {
            const pc = pcRef.current;
            if (pc && pc.signalingState !== 'closed') {
              pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch((err) => {
                if (import.meta.env.DEV) console.warn(`[browser ${contextId}] webrtc answer failed:`, err);
                teardownWebrtc();
              });
            }
            break;
          }
          case 'webrtc_ice': {
            const pc = pcRef.current;
            if (pc && msg.candidate) {
              pc.addIceCandidate({
                candidate: msg.candidate,
                sdpMid: msg.sdpMid ?? undefined,
                sdpMLineIndex: msg.sdpMLineIndex ?? undefined,
              }).catch(() => { /* stray candidate — ignore */ });
            }
            break;
          }
          case 'render_mode': {
            // Server confirmed (or forced) the render mode for this pane. On a
            // forced 'video' (DOM unsupported) this reverts an optimistic toggle.
            renderModeRef.current = msg.mode;
            setState(s => (s.renderMode === msg.mode ? s : { ...s, renderMode: msg.mode }));
            break;
          }
          case 'dom_event':
            // One rrweb event (Meta/FullSnapshot/Incremental) → the DomCoBrowse
            // Replayer. Buffered if the view hasn't registered its sink yet (the
            // bootstrap burst can beat the mount); flushed on registerDomSink.
            if (domSinkRef.current) domSinkRef.current(msg.event);
            else domEventBufferRef.current.push(msg.event);
            break;
          case 'focus_field':
            // Il campo che ha preso il fuoco di là dopo il nostro click (assente
            // = niente di scrivibile). Serve a far uscire la tastiera GIUSTA sul
            // telefono, ed è l'unica risposta possibile sul ramo video, dove non
            // c'è nessun mirror da interrogare.
            focusSinkRef.current?.(msg.field ?? null);
            break;
          case 'viewers':
            // The count moved (or this socket just opened): the auto-share
            // decision hears it from the bus instead of polling for it.
            pushViewerCount(contextId, msg.count);
            break;
          default:
            break;
        }
      } catch (err) {
        console.warn('[useRemoteBrowser] Failed to parse WS message:', err);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      updateConnectionState('disconnected');
    };

    ws.onclose = () => {
      // Before the guard: a superseded socket must still stop claiming that a
      // change would be pushed through it.
      detachViewerChannel?.();
      detachViewerChannel = null;
      if (!mountedRef.current || wsRef.current !== ws) return;
      updateConnectionState('disconnected');
      // The WebRTC signaling rode this WS — drop the PC so a reconnect renegotiates.
      teardownWebrtc();
      // (a) Floor: after a 2s grace, degrade to HTTP polling so the pane stays
      // usable even if the WS can't be restored. Only arm once.
      if (!fallbackTimerRef.current) {
        fallbackTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          if (connectionStateRef.current !== 'connected') {
            updateConnectionState('fallback-http');
          }
        }, FALLBACK_DELAY_MS);
      }
      // (b) But keep trying to restore the full WS stream with exponential
      // backoff — a successful reconnect (onopen) supersedes polling.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
    }; // end connect()

    // --- WebRTC shared-session transport (THE streaming transport) ---
    // Negotiated over THIS WS: the pane offers a recvonly video PC; the server relays
    // to the Rust webrtc-bridge, which attaches to this pane's CDP target (the SAME
    // page mobile+Mac share) and answers with an H.264 track. No JPEG rendering — a
    // non-framable page IS this <video>. On a failed negotiation we retry a few times
    // (the target may not exist yet), then surface an error + Riprova.
    const closePc = () => {
      if (webrtcWatchdogRef.current) { clearTimeout(webrtcWatchdogRef.current); webrtcWatchdogRef.current = null; }
      // Prima il canale: se resta puntato a una PC chiusa, sendInput lo vedrebbe
      // ancora non-null e ci spedirebbe dentro i click invece di scendere sul WS.
      const dc = inputChannelRef.current;
      inputChannelRef.current = null;
      if (dc) { try { dc.close(); } catch { /* già chiuso */ } }
      const pc = pcRef.current;
      pcRef.current = null;
      if (pc) { try { pc.close(); } catch { /* already closed */ } }
      const v = videoRef.current;
      if (v) { try { v.srcObject = null; } catch { /* detached */ } }
      webrtcActiveRef.current = false;
    };

    // Full teardown (unmount / WS close): drop the PC and clear all WebRTC UI state.
    // Re-enable the JPEG bootstrap signal so a reconnect re-drives negotiation off the
    // first frame, and reset the retry budget.
    const teardownWebrtc = () => {
      if (webrtcRetryTimerRef.current) { clearTimeout(webrtcRetryTimerRef.current); webrtcRetryTimerRef.current = null; }
      closePc();
      webrtcAttemptRef.current = 0;
      streamActiveRef.current = true;
      setState(s => (s.webrtcActive || s.webrtcMounted || s.webrtcError
        ? { ...s, webrtcActive: false, webrtcMounted: false, webrtcError: false }
        : s));
    };

    // Arm the negotiation watchdog for `pc`. Fires failWebrtc only if this pc is still
    // the active one and hasn't connected — cancelled/re-armed as ICE progresses.
    const armWebrtcWatchdog = (pc: RTCPeerConnection, ms: number) => {
      if (webrtcWatchdogRef.current) clearTimeout(webrtcWatchdogRef.current);
      webrtcWatchdogRef.current = setTimeout(() => {
        if (pcRef.current === pc && !webrtcActiveRef.current) failWebrtc();
      }, ms);
    };

    // A negotiation attempt failed to connect: retry (target may not exist yet) or,
    // once attempts are exhausted, surface the error+retry (never a JPEG fallback).
    const failWebrtc = () => {
      closePc();
      setState(s => (s.webrtcActive ? { ...s, webrtcActive: false } : s));
      if (webrtcAttemptRef.current < WEBRTC_MAX_ATTEMPTS) {
        if (webrtcRetryTimerRef.current) clearTimeout(webrtcRetryTimerRef.current);
        webrtcRetryTimerRef.current = setTimeout(() => { webrtcRetryTimerRef.current = null; startWebrtc(); }, WEBRTC_RETRY_DELAY_MS);
      } else {
        setState(s => ({ ...s, webrtcMounted: false, webrtcError: true }));
      }
    };

    const startWebrtc = () => {
      if (!WEBRTC_ENABLED || pcRef.current || webrtcActiveRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (typeof RTCPeerConnection === 'undefined') { setState(s => ({ ...s, webrtcError: true })); return; }
      webrtcAttemptRef.current += 1;
      let pc: RTCPeerConnection;
      try { pc = new RTCPeerConnection(); } catch { failWebrtc(); return; }
      pcRef.current = pc;
      // Mount the <video> now so ontrack (fires before ICE connects) can attach the
      // stream; visible only once webrtcActive (spinner shows during negotiation).
      setState(s => (s.webrtcMounted && !s.webrtcError ? s : { ...s, webrtcMounted: true, webrtcError: false }));
      // Il canale di input va creato PRIMA di createOffer, o la sezione dati non
      // entra nell'SDP e il sidecar non ha niente a cui rispondere. Ordinato e
      // affidabile: un click perso è peggio di un click in ritardo, e su una
      // sessione condivisa un evento fuori ordine muoverebbe il mouse a caso.
      try {
        const dc = pc.createDataChannel('input', { ordered: true });
        inputChannelRef.current = dc;
        // L'unica cosa che torna indietro su questo canale: la ricevuta di un
        // input che ne aveva chiesta una. Sblocca la domanda sulla tastiera
        // (vedi `sendInput`); tutto il resto non è roba nostra e si ignora.
        dc.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          try {
            const m = JSON.parse(ev.data) as { t?: unknown; id?: unknown };
            if (m?.t === 'ack' && typeof m.id === 'number') settleInputAck(m.id);
          } catch { /* non è JSON nostro */ }
        };
        dc.onclose = () => { if (inputChannelRef.current === dc) inputChannelRef.current = null; };
      } catch {
        inputChannelRef.current = null; // niente canale → sendInput resta sul WS
      }
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = (ev) => { const v = videoRef.current; if (v && ev.streams[0]) v.srcObject = ev.streams[0]; };
      pc.onicecandidate = (ev) => {
        if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({
              type: 'webrtc_ice', candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex,
            } satisfies BrowserWsMessage));
          } catch { /* dropped — bridge has host candidates from the answer */ }
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const st = pc.iceConnectionState;
        if (st === 'connected' || st === 'completed') {
          if (webrtcWatchdogRef.current) { clearTimeout(webrtcWatchdogRef.current); webrtcWatchdogRef.current = null; }
          webrtcAttemptRef.current = 0; // stable connection — reset the retry budget
          if (!webrtcActiveRef.current) {
            webrtcActiveRef.current = true;
            setState(s => (s.webrtcActive ? s : { ...s, webrtcActive: true, webrtcError: false }));
            // WebRTC carries the video now → stop the (unrendered) JPEG screencast.
            streamActiveRef.current = false;
            try { ws.send(JSON.stringify({ type: 'set_stream', active: false } satisfies BrowserWsMessage)); } catch { /* dropped */ }
          }
        } else if (st === 'checking') {
          // Answer received, ICE is actively pairing candidates. On a cold LAN path
          // (fresh sidecar + target creation + mDNS) this can exceed the short
          // no-answer deadline — re-arm the watchdog with a longer connect budget so
          // we don't tear down a pc that's mid-negotiation and churn forever.
          armWebrtcWatchdog(pc, WEBRTC_CONNECT_TIMEOUT_MS);
        } else if (st === 'failed' || st === 'closed') {
          failWebrtc();
        }
      };
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => {
          if (pcRef.current !== pc || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'webrtc_offer', sdp: offer.sdp || '' } satisfies BrowserWsMessage));
        })
        .catch(() => failWebrtc());
      // No-answer watchdog: if ICE never even reaches 'checking' the target didn't
      // exist yet (or the sidecar was down) → retry fast. Once ICE reaches 'checking'
      // this is re-armed with the longer WEBRTC_CONNECT_TIMEOUT_MS budget.
      armWebrtcWatchdog(pc, WEBRTC_NO_ANSWER_TIMEOUT_MS);
    };
    webrtcStartRef.current = startWebrtc;
    webrtcTeardownRef.current = teardownWebrtc;
    // Hidden-pane pause: drop the peer connection + video surface, but leave the
    // JPEG stream state alone (the panel's set_stream gate owns that). A reveal
    // renegotiates via webrtcStartRef (see the isVisible effect).
    webrtcPauseRef.current = () => {
      closePc();
      setState(s => (s.webrtcActive ? { ...s, webrtcActive: false } : s));
    };

    connect();

    // Reconnect immediately when the tab regains focus or the network returns
    // (e.g. after sleep) instead of waiting out the backoff.
    const onWake = () => {
      if (!mountedRef.current) return;
      // Only kick a reconnect when we're actually down — never interrupt an
      // in-flight connect (connecting) or a healthy socket (connected).
      const st = connectionStateRef.current;
      if (st === 'connected' || st === 'connecting') return;
      reconnectAttempt = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connect();
    };
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { wsRef.current?.close(); } catch { /* already gone */ }
      wsRef.current = null;
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      clearLoadingWatchdog();
      teardownWebrtc();
    };
    // engineEpoch: a change (engine switch) tears down + reopens the WS so the
    // server recreates the context on the newly-selected engine.
  }, [contextId, encodedId, updateConnectionState, clearLoadingWatchdog, fetchInfo, sendResize, engineEpoch, settleInputAck]);

  // P3-3b: a hidden pane must also drop the WebRTC pixel track — set_stream only
  // pauses the JPEG screencast, not the H.264 transport. Pause the peer when the
  // pane leaves the screen; renegotiate on reveal if we're still a video-mode
  // pane (DOM mode has no PC → the pause/start refs are safe no-ops). Reading via
  // refs means no WS re-subscribe on a visibility toggle.
  useEffect(() => {
    if (isVisible) {
      if (renderModeRef.current === 'video') webrtcStartRef.current();
    } else {
      webrtcPauseRef.current();
    }
  }, [isVisible]);

  // HTTP polling effect — runs ONLY when the WS dropped to fallback-http.
  // Mirrors the legacy polling loop but gated on connectionState.
  useEffect(() => {
    if (state.connectionState !== 'fallback-http') {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }
    mountedRef.current = true;
    const poll = async () => {
      if (!mountedRef.current) return;
      const exists = await fetchInfo();
      if (exists) {
        fetchScreenshot();
      }
      const isActive = Date.now() < activeUntilRef.current;
      const interval = isActive ? ACTIVE_INTERVAL : IDLE_INTERVAL;
      pollingRef.current = setTimeout(poll, interval);
    };
    poll();
    return () => {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [state.connectionState, fetchInfo, fetchScreenshot]);

  // T2 — framing probe: whether the CURRENT url can be rendered as a native
  // <iframe>. Reset to false the instant the url changes (so a new page never
  // flashes the previous page's iframe), then probe http(s) URLs server-side.
  // localhost IS probed too: a local dev app can send X-Frame-Options /
  // frame-ancestors (e.g. Quadra on :3100 → SAMEORIGIN) that make the iframe
  // load blank — the old "localhost is always framable" assumption produced a
  // dead white pane. Non-framable → the DOM co-browse surface renders it instead.
  useEffect(() => {
    const url = state.url;
    // Deliberate synchronous reset the instant the url changes: it clears the
    // previous page's `framable` so a new page never flashes the old iframe
    // before the async probe below resolves. Guarded (only when framable is
    // true) so it's at most ONE extra render per navigation — not a loop. The
    // async probe that follows is the effect's real reason to exist.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(s => (s.framable ? { ...s, framable: false } : s));
    if (!url || !/^https?:\/\//i.test(url)) return;
    let cancelled = false;
    fetch(`/api/browsers/framable?url=${encodeURIComponent(url)}`)
      .then(r => (r.ok ? r.json() : { framable: false }))
      .then((d: { framable?: boolean }) => {
        if (!cancelled && mountedRef.current) {
          setState(s => (s.url === url ? { ...s, framable: !!d.framable } : s));
        }
      })
      .catch(() => { /* network error → leave framable=false (stream) */ });
    return () => { cancelled = true; };
  }, [state.url]);

  // Engine capability (task 54601eeb): does the server offer the Native↔Chromium
  // toggle (un vero Chromium installato sulla macchina), and how many
  // extensions would load? Fetched once — the toggle stays hidden unless enabled.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/browsers/engines')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { enabled?: boolean; chromium?: { available?: boolean; extensions?: number } } | null) => {
        if (cancelled) return;
        const available = !!(d?.enabled && d.chromium?.available);
        setState(s => ({ ...s, engineToggleAvailable: available, engineExtensions: d?.chromium?.extensions ?? s.engineExtensions }));
      })
      .catch(() => { /* no capability endpoint → toggle stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  // Drive the WebRTC transport off having a real URL + a live WS — NOT off the first
  // JPEG frame. Frame-triggering was fragile (a pane whose screencast delivered no
  // frame sat forever on "Avvio sessione condivisa…" without ever negotiating). The
  // page having navigated means the pane's CDP target exists → negotiate now. Guarded
  // internally (a live/negotiating PC makes this a no-op), so repeated renders are safe.
  useEffect(() => {
    if (!WEBRTC_ENABLED) return;
    // Option A: only the pixel-stream ('video') surface needs WebRTC. DOM is the
    // default and carries tiny rrweb events, not pixels — negotiating WebRTC there
    // would spin the headless screencast (and the orphan-peer retry noise) for
    // nothing. When the server forces 'video' (DOM unsupported), renderMode flips
    // and this effect re-runs → WebRTC negotiates then.
    if (state.renderMode !== 'video') return;
    if (state.connectionState !== 'connected') return;
    if (!state.url || state.url === 'about:blank') return;
    if (state.webrtcActive || state.webrtcError) return;
    webrtcStartRef.current();
  }, [state.renderMode, state.url, state.connectionState, state.webrtcActive, state.webrtcError]);

  // --- Interaction handlers ---

  const navigate = useCallback((url: string) => {
    setState(s => ({ ...s, loading: true, url, error: null, errorUrl: null }));
    armLoadingWatchdog();
    markActive();
    if (connectionStateRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: BrowserWsMessage = { type: 'nav', url, phase: 'request' };
      try {
        wsRef.current.send(JSON.stringify(msg));
        return;
      } catch {
        // Fall through to REST.
      }
    }
    // REST fallback. interact does getOrCreate — intentional for navigate.
    interact({ action: 'navigate', url }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo, armLoadingWatchdog]);

  const goBack = useCallback(() => {
    if (!connectionStateRef.current || connectionStateRef.current === 'disconnected') return;
    markActive();
    interact({ action: 'back' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goForward = useCallback(() => {
    if (!connectionStateRef.current || connectionStateRef.current === 'disconnected') return;
    markActive();
    interact({ action: 'forward' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const reload = useCallback(() => {
    if (!connectionStateRef.current || connectionStateRef.current === 'disconnected') return;
    setState(s => ({ ...s, loading: true }));
    armLoadingWatchdog();
    markActive();
    interact({ action: 'reload' }).then(() => {
      if (connectionStateRef.current === 'fallback-http') {
        fetchScreenshot();
        fetchInfo();
      }
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo, armLoadingWatchdog]);

  const goHome = useCallback(() => {
    navigate('about:blank');
  }, [navigate]);

  const onClick = useCallback((e: React.MouseEvent<HTMLImageElement | HTMLVideoElement>) => {
    if (connectionStateRef.current === 'disconnected') return;
    const img = e.currentTarget;
    const coords = mapCoordinates(e, img, {
      pageScaleFactor: pageScaleFactorRef.current,
      deviceWidth: frameMetaRef.current.deviceWidth,
      deviceHeight: frameMetaRef.current.deviceHeight,
      deviceScaleFactor: dsfRef.current,
    });
    if (!coords) return;
    markActive();
    setState(s => ({ ...s, lastClickPos: { x: e.clientX, y: e.clientY, t: Date.now() } }));
    sendInput('click', { x: coords.x, y: coords.y });
  }, [markActive, sendInput]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLImageElement | HTMLVideoElement>) => {
    if (connectionStateRef.current === 'disconnected') return;
    const now = Date.now();
    if (now - lastScrollRef.current < 100) return;
    lastScrollRef.current = now;

    const img = e.currentTarget;
    const coords = mapCoordinates(e as unknown as React.MouseEvent<HTMLImageElement | HTMLVideoElement>, img, {
      pageScaleFactor: pageScaleFactorRef.current,
      deviceWidth: frameMetaRef.current.deviceWidth,
      deviceHeight: frameMetaRef.current.deviceHeight,
      deviceScaleFactor: dsfRef.current,
    });
    if (!coords) return;

    markActive();
    sendInput('scroll', {
      x: coords.x,
      y: coords.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [markActive, sendInput]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (connectionStateRef.current === 'disconnected') return;
    if (e.metaKey || e.ctrlKey) return;

    e.preventDefault();
    e.stopPropagation();
    markActive();

    if (SPECIAL_KEYS.has(e.key)) {
      if (typeBufRef.current) {
        sendInput('type', { text: typeBufRef.current });
        typeBufRef.current = '';
        if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      }
      sendInput('keypress', { key: e.key });
    } else if (e.key.length === 1) {
      typeBufRef.current += e.key;
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      typeTimerRef.current = setTimeout(() => {
        if (typeBufRef.current) {
          sendInput('type', { text: typeBufRef.current });
          typeBufRef.current = '';
        }
      }, 50);
    }
  }, [markActive, sendInput]);

  // Phase 30 BROWSER-CHAT-04 — take-control: optimistic UI lock release +
  // notify server. The server's eager broadcast triggers an idempotent
  // agent_active=false (already cleared locally; the duplicate is a no-op).
  const takeControl = useCallback(() => {
    setState(s => ({ ...s, agentActive: false }));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'take_control' };
        wsRef.current.send(JSON.stringify(msg));
      } catch {
        // Ignore — the optimistic UI update already unblocked the user.
      }
    }
  }, []);

  // Phase 30 BROWSER-CHAT-04 — Cmd+Shift+E enters select-element mode (Cursor pattern).
  const enterSelectMode = useCallback(() => {
    setState(s => ({ ...s, selectMode: true }));
  }, []);
  const exitSelectMode = useCallback(() => {
    setState(s => ({ ...s, selectMode: false, selectedElement: null }));
  }, []);
  const setSelectedElement = useCallback((el: SelectedElementInfo | null) => {
    setState(s => ({ ...s, selectedElement: el, selectMode: false }));
  }, []);

  // Task 052f53ef: pause/resume the server-side screencast for this pane. Called
  // by the panel when it switches to/from native iframe-mode. Idempotent; the
  // desired state is stored in a ref so onopen can re-assert it after a reconnect.
  const setStreamActive = useCallback((active: boolean) => {
    if (streamActiveRef.current === active) return;
    streamActiveRef.current = active;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'set_stream', active };
        wsRef.current.send(JSON.stringify(msg));
      } catch { /* socket gone — re-asserted on next onopen */ }
    }
  }, []);

  // "My pane is on screen" — the ONLY input of the cross-device viewer count
  // (GET /api/browsers/:id/viewers → computeAutoShared). Idempotent; the desired
  // state lives in a ref so onopen re-asserts it after a reconnect.
  const setWatching = useCallback((active: boolean) => {
    if (watchingRef.current === active) return;
    watchingRef.current = active;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'set_watching', active };
        wsRef.current.send(JSON.stringify(msg));
      } catch { /* socket gone — re-asserted on next onopen */ }
    }
  }, []);

  // WebRTC error → Riprova: reset the retry budget, clear the error, renegotiate.
  const retryWebrtc = useCallback(() => {
    webrtcAttemptRef.current = 0;
    setState(s => (s.webrtcError ? { ...s, webrtcError: false } : s));
    webrtcStartRef.current();
  }, []);

  // T1 DOM co-browse: request a render mode. Optimistic (snappy toggle); the
  // server's `render_mode` reply confirms or corrects it (forced 'video' when
  // unsupported). Entering DOM mode tears down WebRTC — the server pauses the
  // screencast, so the pixel transport has nothing left to carry.
  const setRenderMode = useCallback((mode: 'video' | 'dom') => {
    if (renderModeRef.current === mode) return;
    renderModeRef.current = mode;
    setState(s => (s.renderMode === mode ? s : { ...s, renderMode: mode }));
    if (mode === 'dom') webrtcTeardownRef.current();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'set_render', mode };
        wsRef.current.send(JSON.stringify(msg));
      } catch { /* socket gone — re-asserted on next onopen */ }
    }
  }, []);

  // T1 DOM co-browse: register the single live rrweb-event sink (DomCoBrowse's
  // Replayer). Returns an unsubscribe that only clears if still the current sink.
  const registerDomSink = useCallback((cb: (event: unknown) => void) => {
    domSinkRef.current = cb;
    // Flush anything buffered before the view mounted (bootstrap burst).
    if (domEventBufferRef.current.length) {
      const queued = domEventBufferRef.current;
      domEventBufferRef.current = [];
      for (const e of queued) cb(e);
    }
    return () => { if (domSinkRef.current === cb) domSinkRef.current = null; };
  }, []);

  // La superficie visibile dichiara qui chi vuole sapere che campo è a fuoco di
  // là. Uno alla volta, come il sink rrweb: la superficie viva è una sola (video
  // o mirror), e due destinatari vorrebbero dire due tastiere.
  const registerFocusSink = useCallback((cb: (field: RemoteField | null) => void) => {
    focusSinkRef.current = cb;
    return () => { if (focusSinkRef.current === cb) focusSinkRef.current = null; };
  }, []);

  // Engine switch (task 54601eeb): ask the server to move this pane to `engine`.
  // Server-orchestrated over the WS — the reply is an `engine` broadcast that
  // flips state + remounts. Streaming-mode only (no WS ⇒ silent no-op).
  const setEngine = useCallback((engine: 'native' | 'chromium') => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const msg: BrowserWsMessage = { type: 'set_engine', engine };
        wsRef.current.send(JSON.stringify(msg));
      } catch { /* socket gone — no-op */ }
    }
  }, []);

  // Download: togli UNA voce / svuota l'elenco. Il menu della toolbar è
  // chiudibile e le sue voci si tolgono a mano — quindi lo stato deve poterle
  // togliere. Prima l'elenco poteva solo crescere (fino al tetto), il che è
  // metà del motivo per cui la vecchia striscia in fondo dava fastidio.
  const dismissDownload = useCallback((href: string) => {
    setState(s => (s.downloads.some(d => d.href === href)
      ? { ...s, downloads: s.downloads.filter(d => d.href !== href) }
      : s));
  }, []);
  const clearDownloads = useCallback(() => {
    setState(s => (s.downloads.length ? { ...s, downloads: [] } : s));
  }, []);

  // After every commit: if the <img> (re)mounted it carries the stale
  // state.screenshotSrc — re-assert the newest direct-written frame. A cheap
  // string compare on the (now rare) panel renders, a write only on remount.
  useEffect(() => {
    const img = imgRef.current;
    const last = lastFrameSrcRef.current;
    if (img && last && img.src !== last) img.src = last;
  });

  return useMemo(() => ({
    ...state,
    navigate,
    goBack,
    goForward,
    reload,
    goHome,
    onClick,
    onWheel,
    onKeyDown,
    imgRef,
    videoRef,
    containerRef,
    takeControl,
    enterSelectMode,
    exitSelectMode,
    setSelectedElement,
    setEngine,
    setStreamActive,
    setWatching,
    retryWebrtc,
    setRenderMode,
    registerDomSink,
    registerFocusSink,
    sendInput,
    dismissDownload,
    clearDownloads,
  }), [state, navigate, goBack, goForward, reload, goHome, onClick, onWheel, onKeyDown, containerRef, takeControl, enterSelectMode, exitSelectMode, setSelectedElement, setEngine, setStreamActive, setWatching, retryWebrtc, setRenderMode, registerDomSink, registerFocusSink, sendInput, dismissDownload, clearDownloads]);
}

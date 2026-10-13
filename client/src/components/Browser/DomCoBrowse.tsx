/**
 * T1 DOM co-browse — the native rrweb reconstruction view (real browser, not a
 * video). The server injects rrweb into the shared headless page and streams DOM
 * events over the pane's WS; this view feeds them to an rrweb Replayer (liveMode),
 * which rebuilds the DOM in a same-origin iframe rendered by THIS device's own
 * engine (WebKit on Tauri, the browser engine on web) — text stays sharp and
 * selectable, ~500x lighter than the JPEG stream, and identical across devices.
 *
 * Loaded lazily (React.lazy) so rrweb + its CSS only land in the bundle when a
 * pane actually switches to DOM mode — the default video path never pays for it.
 *
 * Input — PARENT-FRAME capture overlay (not inside the mirror iframe).
 * ------------------------------------------------------------------------
 * The earlier design made the rrweb iframe itself the input surface
 * (`enableInteract()`) and attached capture-phase listeners INSIDE its
 * `sandbox="allow-same-origin"` contentDocument. That is hostile to WKWebView +
 * the `tauri://localhost` custom scheme: the sandboxed subframe's document is not
 * reliably scriptable when the bridge runs, and WKWebView ignores an in-iframe
 * `preventDefault`, so a link click drives a real subframe navigation that the
 * shell nav-guard then cancels — tearing down the rebuilt DOM. Result: on the Mac
 * app clicks/typing were dead while the web client (Blink) worked.
 *
 * So the mirror iframe is kept strictly as a VISUAL surface (`pointer-events:none`,
 * the Replayer default) and ALL input is captured by a transparent overlay in the
 * MAIN frame — which is fully scriptable with reliable first-responder/focus under
 * WKWebView, and never navigates. Pointer events map to source-page CSS px through
 * the known fit `scale` (the overlay is sized to the scaled mirror and sits
 * exactly on it, so `sourcePx = (localPx - overlayOrigin) / scale`) and relay via `sendInput` (→ CDP).
 * Keyboard is captured by a hidden field (`BrowserKeyboardCapture`): `keydown`
 * covers hardware keys, `beforeinput`/composition cover mobile soft keyboards,
 * paste and IME — so an iPhone PWA follower can type into the shared session too.
 *
 * E la tastiera che iOS apre è quella del CAMPO DI CATTURA, non del campo che hai
 * toccato: finché la cattura è stata una <textarea> nuda, email/numero/password
 * davano tutti la tastiera di testo. Quindi prima del fuoco si guarda chi c'è
 * sotto il dito — nel mirror, con le stesse coordinate che rilanciamo come click
 * — e la cattura si veste come quel campo. Il mirror è il DOM vero della pagina:
 * la risposta è già qui, senza chiedere niente al server.
 *
 * Local selection on demand: holding Option (Alt) flips the mirror iframe back to
 * interactive so the user can natively select + copy text; releasing reverts to
 * the robust relay overlay. While interactive we still cancel link/submit
 * navigations inside the iframe so a stray click can't bust the shell nav-guard.
 *
 * Gated on the agent lock: while an agent drives, a blocking overlay suppresses
 * this viewer's input, mirroring the pixel path's take-control model.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { Loader2 } from 'lucide-react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/rrweb.min.css';
import { BrowserPaneChip } from './BrowserPaneChip';
import BrowserKeyboardCapture, {
  type BrowserKeyboardCaptureHandle,
  type SendInput,
} from './BrowserKeyboardCapture';
import type { RemoteField } from '../../lib/browserKeyboardProfile';
import { fitCentered, viewportFromRrwebEvent } from '../../lib/browserFit';
import { prefixRoutedResources } from '../../lib/domResourceBase';
import { forgetHandedOver, parkClock, stopClock, wakeClock } from '../../lib/mirrorClock';
import { canObserveDocument, createImageDeferral, DEFERRED_IMAGES, revealImage } from '../../lib/mirrorImages';
import { flingVelocity, scrollTargetAt } from '../../lib/mirrorScroll';
import { serverHttpBase } from '../../lib/shell/net';

/** rrweb's IncrementalSnapshot event type, and the source of its scroll events. */
const INCREMENTAL_SNAPSHOT = 3;
const SCROLL_SOURCE = 3;

/** Minimal shape of an rrweb event we rely on (Meta carries the recorded size). */
type RrwebEvent = {
  type: number;
  timestamp: number;
  data?: { width?: number; height?: number; source?: number; id?: number; x?: number; y?: number };
};

/** Senza eventi per questo tempo il timer live si parcheggia: una pagina remota
 *  ferma non deve tenere sveglio il renderer. Abbastanza largo da non tagliare la
 *  coda di applicazione di rrweb (che lavora ~100ms dietro il tempo reale). */
const IDLE_PARK_MS = 400;

/** Coalesce relayed scroll deltas at this cadence (ms) so we don't flood the WS. */
const SCROLL_RELAY_INTERVAL = 60;
/** Below this touch travel a touch is treated as a tap (→ click), not a scroll. */
const TAP_SLOP = 8;
/** How long after a relayed tap a click is that tap's synthesized echo. */
const ECHO_CLICK_WINDOW_MS = 800;
/** How long this device's own scroll wins over the source's echoes of it. */
const LOCAL_SCROLL_HOLD_MS = 600;
/** A fling slows down like one on iOS (UIScrollView's normal rate, per ms)... */
const FLING_DECAY_PER_MS = 0.998;
/** ...and has stopped below this speed, in source px per ms. */
const FLING_STOP_SPEED = 0.02;
/** How far outside the mirror's view a lazy image starts loading, in source px. */
const LAZY_IMAGE_MARGIN = '1000px';

interface Props {
  /** Register the single live rrweb-event sink; returns an unsubscribe. */
  registerDomSink: (cb: (event: unknown) => void) => () => void;
  /** Il campo a fuoco riportato dal server dopo un click. Rete di sicurezza per
   *  quando il mirror non è interrogabile (WKWebView + scheme custom): lì la
   *  tastiera si alza generica e la corregge questa risposta. */
  registerFocusSink: (cb: (field: RemoteField | null) => void) => () => void;
  /** Relay input to the source page (page-CSS px). */
  sendInput: SendInput;
  /** Agent lock — while true, this viewer's input is suppressed (take-control parity). */
  agentActive: boolean;
  /** Hands the pane a reader of the mirror's document: the pane's finder
   *  searches the rebuilt page with it (BROWSER-FIND-04), no server involved. */
  exposeMirrorDocument?: (read: (() => Document | null) | null) => void;
  /** The size this pane last asked the page for: a page laid out at it is shown 1:1 (browserFit). */
  ownSize?: () => { width: number; height: number } | null;
}

export default function DomCoBrowse({ registerDomSink, registerFocusSink, sendInput, agentActive, exposeMirrorDocument, ownSize }: Props) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const kbdRef = useRef<BrowserKeyboardCaptureHandle | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const ownSizeRef = useRef(ownSize);
  useEffect(() => { ownSizeRef.current = ownSize; }, [ownSize]);
  // The mirror's document, for find (BROWSER-FIND-04). A reader and not the
  // document itself: rrweb swaps the iframe's document on a full snapshot.
  useEffect(() => {
    if (!exposeMirrorDocument) return;
    exposeMirrorDocument(() => (replayerRef.current?.iframe as HTMLIFrameElement | undefined)?.contentDocument ?? null);
    return () => exposeMirrorDocument(null);
  }, [exposeMirrorDocument]);
  /** Riallinea il parcheggio del timer live (definita nell'effetto sotto). Sta
   *  in una ref perché `handle` può correre prima che la closure esista. */
  const parkWhenHiddenRef = useRef<(() => void) | null>(null);
  /** Segnala traffico in arrivo al parcheggio del timer live (idem, via ref). */
  const noteActivityRef = useRef<(() => void) | null>(null);
  // Recorded source dimensions (from the Meta event) + the current fit scale.
  const dimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const scaleRef = useRef(1);
  const agentActiveRef = useRef(agentActive);
  useEffect(() => { agentActiveRef.current = agentActive; }, [agentActive]);

  // Il descrittore del campo a fuoco che il server manda dopo ogni click. Qui è
  // una rete, non la via maestra: quando il mirror risponde la tastiera è già
  // giusta prima che il dito si alzi, e `applyRemoteField` se ne accorge e non
  // tocca niente.
  useEffect(() => registerFocusSink((field) => {
    kbdRef.current?.applyRemoteField(field);
  }), [registerFocusSink]);

  // ── Interaction state (refs: the handlers live outside React's render) ───────
  const scrollAccRef = useRef<{ dx: number; dy: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null }>(
    { dx: 0, dy: 0, x: 0, y: 0, timer: null },
  );
  const touchRef = useRef<{ x: number; y: number; travel: number; moves: { t: number; dx: number; dy: number }[] } | null>(null);
  /**
   * This device scrolling the mirror itself (BROWSER-DOM-SCROLL-01): the element
   * it scrolls, until when the source's echoes of that scroll are held back, the
   * latest held echo per node (applied when the hold ends, so a source that
   * ended up elsewhere still wins), and the fling still running.
   */
  const localScrollRef = useRef<{
    target: Element | null;
    until: number;
    held: Map<number, RrwebEvent>;
    release: ReturnType<typeof setTimeout> | null;
    fling: number | null;
  }>({ target: null, until: 0, held: new Map(), release: null, fling: null });
  /** When `onTouchEnd` last relayed a tap, so `onClick` can drop its echo. */
  const lastTapRelayRef = useRef(-Infinity);
  // Option/Alt held → let the user select + copy natively in the mirror iframe.
  const [selecting, setSelecting] = useState(false);
  // Has the replayer painted anything yet? The root is the theme background, so
  // before the first rrweb event this component IS an empty box — indistinguishable
  // from a broken pane when the transport is down (the only other signal is the
  // toolbar's connection chip). Nobody upstream can answer this: the panel only
  // knows the socket state, not whether pixels landed. So we own it here.
  const [painted, setPainted] = useState(false);
  const selectingRef = useRef(false);
  useEffect(() => { selectingRef.current = selecting; }, [selecting]);
  const navGuardAbortRef = useRef<AbortController | null>(null);

  // Fit the reconstructed iframe (recorded WxH) inside the pane and CENTRE it,
  // then put the capture overlay on exactly that scaled rect.
  //
  // It used to be pinned top-left on a white root, which is what a viewer who is
  // not driving the viewport (TOPIC-BROWSER-05) sees most of the time: the page
  // in a corner with a white L around it, looking broken rather than scaled. The
  // leftover space is split in two and the surround is the theme background.
  const applyScale = useCallback(() => {
    const root = rootRef.current;
    const replayer = replayerRef.current;
    const { w, h } = dimsRef.current;
    if (!root || !replayer || !w || !h) return;
    const { scale, left, top } = fitCentered(
      { width: root.clientWidth, height: root.clientHeight },
      { width: w, height: h },
      ownSizeRef.current?.(),
    );
    scaleRef.current = scale;
    const wrapper = replayer.wrapper as HTMLElement | undefined;
    if (wrapper) {
      wrapper.style.transformOrigin = 'top left';
      wrapper.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
    }
    // The overlay moves with the mirror: `toSource` reads its client rect, so
    // the pointer mapping follows the centring without knowing about it.
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.style.left = `${left}px`;
      overlay.style.top = `${top}px`;
      overlay.style.width = `${w * scale}px`;
      overlay.style.height = `${h * scale}px`;
    }
  }, []);

  // Map an overlay-local pointer to source-page CSS px. The overlay is the scaled
  // mirror pinned top-left, so the source coordinate is simply local ÷ scale.
  const toSource = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const overlay = overlayRef.current;
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const x = (clientX - rect.left) / s;
    const y = (clientY - rect.top) / s;
    const { w, h } = dimsRef.current;
    if (x < 0 || y < 0 || (w && x > w) || (h && y > h)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  // Coalesced scroll relay — one `scroll` input per interval, summed deltas.
  const queueScrollRelay = useCallback((dx: number, dy: number, x: number, y: number) => {
    if (agentActiveRef.current) return;
    const acc = scrollAccRef.current;
    acc.dx += dx;
    acc.dy += dy;
    acc.x = x;
    acc.y = y;
    if (acc.timer) return;
    acc.timer = setTimeout(() => {
      acc.timer = null;
      const { dx: fdx, dy: fdy, x: fx, y: fy } = acc;
      acc.dx = 0;
      acc.dy = 0;
      if (fdx || fdy) sendInput('scroll', { x: fx, y: fy, deltaX: fdx, deltaY: fdy });
    }, SCROLL_RELAY_INTERVAL);
  }, [sendInput]);

  /**
   * Scroll the mirror here by (dx, dy) source px at (x, y), ahead of the source
   * (BROWSER-DOM-SCROLL-01). False when nothing moved: a mirror this shell
   * cannot read (WKWebView with a custom scheme), or an element at its edge.
   */
  const scrollMirrorBy = useCallback((dx: number, dy: number, x: number, y: number): boolean => {
    const local = localScrollRef.current;
    let doc: Document | null | undefined;
    try { doc = (replayerRef.current?.iframe as HTMLIFrameElement | undefined)?.contentDocument; } catch { doc = null; }
    if (!doc) return false;
    if (!local.target?.isConnected || local.target.ownerDocument !== doc) {
      local.target = scrollTargetAt(doc, x, y, Math.abs(dx) > Math.abs(dy));
    }
    const target = local.target;
    if (!target) return false;
    const { scrollTop, scrollLeft } = target;
    target.scrollTop = scrollTop + dy;
    target.scrollLeft = scrollLeft + dx;
    const moved = target.scrollTop !== scrollTop || target.scrollLeft !== scrollLeft;
    // Only a scroll that happened here holds the source's back: a page that
    // turns the wheel into something else (a photo's zoom) answers unhindered.
    if (moved) local.until = performance.now() + LOCAL_SCROLL_HOLD_MS;
    return moved;
  }, []);

  const stopFling = useCallback(() => {
    const local = localScrollRef.current;
    if (local.fling !== null) cancelAnimationFrame(local.fling);
    local.fling = null;
  }, []);

  /** A released swipe carries on and slows down, here and at the source alike. */
  const startFling = useCallback((vx0: number, vy0: number, x: number, y: number) => {
    stopFling();
    const local = localScrollRef.current;
    let vx = vx0;
    let vy = vy0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 64);
      last = now;
      const decay = Math.pow(FLING_DECAY_PER_MS, dt);
      vx *= decay;
      vy *= decay;
      const moved = scrollMirrorBy(vx * dt, vy * dt, x, y);
      queueScrollRelay(vx * dt, vy * dt, x, y);
      local.fling = moved && Math.hypot(vx, vy) > FLING_STOP_SPEED ? requestAnimationFrame(step) : null;
    };
    local.fling = requestAnimationFrame(step);
  }, [scrollMirrorBy, queueScrollRelay, stopFling]);

  // Che cosa c'è, nella pagina remota, sotto questo punto.
  //
  // La risposta ce l'abbiamo GIÀ in casa: il mirror rrweb è il DOM vero della
  // pagina, ricostruito qui, e l'interroghiamo con le stesse coordinate che
  // rilanciamo come click — quindi l'elemento che troviamo è lo stesso che
  // riceverà il click di là. Niente andata e ritorno col server: la tastiera
  // deve essere già giusta quando il dito si alza, e un round-trip la
  // farebbe uscire sbagliata e poi correggere sotto gli occhi.
  //
  // Best-effort per costruzione: sotto WKWebView il documento dell'iframe
  // sandboxed non è sempre interrogabile (la stessa ragione per cui l'input non
  // si cattura là dentro). Quando non risponde si ricade sulla tastiera di
  // testo, che è ciò che c'era prima per tutti i campi.
  //
  // `readable` separa le due risposte che prima erano lo stesso `null`: «lì non
  // c'è niente» e «questo documento non me lo fa guardare». La prima chiude la
  // questione (nessuna tastiera), la seconda no: apre quella generica e aspetta
  // il descrittore del campo a fuoco che il server manda dopo il click.
  const mirrorElementAt = useCallback((sx: number, sy: number): { readable: boolean; el: Element | null } => {
    try {
      const doc = (replayerRef.current?.iframe as HTMLIFrameElement | undefined)?.contentDocument;
      if (!doc) return { readable: false, el: null };
      return { readable: true, el: doc.elementFromPoint(sx, sy) };
    } catch {
      return { readable: false, el: null };
    }
  }, []);

  /**
   * Veste la cattura sul campo remoto sotto il punto, poi le dà il fuoco.
   *
   * Quando il mirror non è interrogabile (WKWebView + scheme custom: la stessa
   * ragione per cui l'input non si cattura dentro l'iframe) col dito si alza
   * comunque la tastiera generica. È l'unico momento in cui si può: iOS apre la
   * tastiera solo dentro un gesto, e la risposta del server arriva dopo. Se poi
   * dirà che a fuoco non c'è niente di scrivibile, `applyRemoteField` la fa
   * rientrare.
   */
  const focusKbdAt = useCallback((clientX: number, clientY: number, requireField: boolean) => {
    const c = toSource(clientX, clientY);
    if (!c) { kbdRef.current?.focusForField(null, { requireField }); return; }
    const { readable, el } = mirrorElementAt(c.x, c.y);
    kbdRef.current?.focusForField(el, { requireField: requireField && readable });
  }, [toSource, mirrorElementAt]);

  // ── Pointer / wheel / touch on the overlay ───────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (selectingRef.current) return;
    // Col dito decide onTouchStart: lì sappiamo che è un tocco, e col tocco la
    // tastiera va alzata SOLO su un campo di scrittura. Qui (mouse, penna) la
    // cattura resta sempre viva perché è anche la presa dei tasti hardware.
    if (e.pointerType !== 'touch') focusKbdAt(e.clientX, e.clientY, false);
    // Let the host app see the gesture (pane/tab activation).
    rootRef.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    e.preventDefault();
  }, [focusKbdAt]);

  const onClick = useCallback((e: React.MouseEvent) => {
    if (selectingRef.current || agentActiveRef.current) return;
    // The click the engine synthesizes after a tap that `onTouchEnd` already
    // relayed: the same gesture, so the page must not get it twice
    // (BROWSER-DOM-TAP-01). Only reached when that touchend was not cancelable.
    if (performance.now() - lastTapRelayRef.current < ECHO_CLICK_WINDOW_MS) return;
    const c = toSource(e.clientX, e.clientY);
    if (!c) return;
    sendInput('click', { x: c.x, y: c.y, button: 'left' });
  }, [toSource, sendInput]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (selectingRef.current || agentActiveRef.current) return;
    const c = toSource(e.clientX, e.clientY);
    if (c) sendInput('click', { x: c.x, y: c.y, button: 'right' });
  }, [toSource, sendInput]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (selectingRef.current || agentActiveRef.current) return;
    const c = toSource(e.clientX, e.clientY) || { x: dimsRef.current.w / 2, y: dimsRef.current.h / 2 };
    // Source px: the mirror here and the page there move by the same distance.
    const s = scaleRef.current || 1;
    const dx = e.deltaX / s;
    const dy = e.deltaY / s;
    // A wheel after a pause is a new gesture, and scrolls what is under it now.
    if (performance.now() > localScrollRef.current.until) localScrollRef.current.target = null;
    stopFling();
    scrollMirrorBy(dx, dy, c.x, c.y);
    queueScrollRelay(dx, dy, c.x, c.y);
  }, [toSource, queueScrollRelay, scrollMirrorBy, stopFling]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (selectingRef.current) return;
    const t = e.touches[0];
    // A finger down stops a fling, and its own gesture scrolls what is under it.
    stopFling();
    localScrollRef.current.target = null;
    // Il fuoco va preso DENTRO il gesto, o iOS non apre la tastiera: quindi qui,
    // non al touchend. Ed è vestito sul campo toccato — è tutto il punto.
    if (t) {
      focusKbdAt(t.clientX, t.clientY, true);
      touchRef.current = { x: t.clientX, y: t.clientY, travel: 0, moves: [] };
    }
    rootRef.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }, [focusKbdAt, stopFling]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (selectingRef.current) return;
    const prev = touchRef.current;
    const t = e.touches[0];
    if (!prev || !t) return;
    // Natural scroll: dragging content DOWN scrolls the page UP → invert. In
    // source px, so the content stays under the finger here and there.
    const s = scaleRef.current || 1;
    const dx = (prev.x - t.clientX) / s;
    const dy = (prev.y - t.clientY) / s;
    prev.travel += Math.abs(prev.x - t.clientX) + Math.abs(prev.y - t.clientY);
    prev.x = t.clientX;
    prev.y = t.clientY;
    prev.moves.push({ t: performance.now(), dx, dy });
    if (prev.moves.length > 16) prev.moves.shift();
    const c = toSource(t.clientX, t.clientY) || { x: dimsRef.current.w / 2, y: dimsRef.current.h / 2 };
    if (!agentActiveRef.current) scrollMirrorBy(dx, dy, c.x, c.y);
    queueScrollRelay(dx, dy, c.x, c.y);
  }, [toSource, queueScrollRelay, scrollMirrorBy]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (selectingRef.current || agentActiveRef.current) { touchRef.current = null; return; }
    const prev = touchRef.current;
    touchRef.current = null;
    if (!prev) return;
    if (prev.travel > TAP_SLOP) {
      // A swipe, not a tap: what the finger was doing carries on.
      const { vx, vy } = flingVelocity(prev.moves, performance.now());
      const c = toSource(prev.x, prev.y) || { x: dimsRef.current.w / 2, y: dimsRef.current.h / 2 };
      if (Math.hypot(vx, vy) > FLING_STOP_SPEED) startFling(vx, vy, c.x, c.y);
      return;
    }
    const t = e.changedTouches[0];
    if (!t) return;
    const c = toSource(t.clientX, t.clientY);
    if (!c) return;
    sendInput('click', { x: c.x, y: c.y, button: 'left' });
    lastTapRelayRef.current = performance.now();
    // No synthesized mousedown + click for this tap: the click is relayed, and
    // the mousedown would take the focus from the keyboard capture.
    if (e.cancelable) e.preventDefault();
  }, [toSource, sendInput, startFling]);

  // ── Option/Alt hold → native local selection in the mirror ───────────────────
  // The mirror iframe is made interactive ONCE (enableInteract) but sits UNDER the
  // capture overlay: in normal mode the overlay intercepts every pointer event so
  // the iframe receives nothing and never navigates (WKWebView-safe); holding
  // Option drops the overlay (pointer-events:none, synchronous) so events fall
  // through to the iframe for native selection/copy. Toggling only the overlay
  // avoids the race where the iframe's pointer-events would lag the overlay's.
  //
  // Cancel link/submit navigations inside the iframe regardless — a stray click in
  // selection mode must not drive a real sub-frame navigation (the shell nav-guard
  // would cancel it and could tear down the rebuilt DOM). Best-effort, re-armed on
  // every full-snapshot rebuild (doc.open() drops the listeners); the primary
  // overlay input path never depends on the iframe being scriptable.
  const attachNavGuard = useCallback(() => {
    const doc = (replayerRef.current?.iframe as HTMLIFrameElement | undefined)?.contentDocument;
    navGuardAbortRef.current?.abort();
    if (!doc) return;
    const ac = new AbortController();
    navGuardAbortRef.current = ac;
    const opts = { capture: true, signal: ac.signal } as AddEventListenerOptions;
    doc.addEventListener('click', (e) => e.preventDefault(), opts);
    doc.addEventListener('auxclick', (e) => e.preventDefault(), opts);
    doc.addEventListener('submit', (e) => e.preventDefault(), opts);
  }, []);

  useEffect(() => {
    // Option (Alt) TOGGLES a local text-selection mode; Escape exits it. A toggle
    // (not press-and-hold) is deliberate: holding Option during the select gesture
    // would alter the native selection on macOS. In select mode the overlay yields
    // so the pointer reaches the interactive mirror; a normal press returns to the
    // relay overlay.
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === 'Alt' || e.key === 'Option') setSelecting((s) => !s);
      else if (e.key === 'Escape') setSelecting(false);
    };
    const onBlur = () => setSelecting(false);
    // Capture phase: the focused capture-textarea stopPropagations its keydowns
    // (so they don't double-relay via the panel), which would otherwise hide the
    // Option press from a bubble-phase window listener.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ── rrweb live reconstruction ────────────────────────────────────────────────
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let started = false;
    // Captured for cleanup (stable object; avoids reading a ref at teardown time).
    const acc = scrollAccRef.current;
    const local = localScrollRef.current;

    // Every event is stamped with the moment it reached THIS device
    // (BROWSER-DOM-LIVE-01). rrweb's live replayer applies an event at
    // `start + (its timestamp - baseline)` and fixes the baseline once:
    // `startLive` is ignored once live. With the source's clock, whatever the
    // first event took to arrive (a 1 MB snapshot drained from the Mac, a
    // buffered one minutes old) was added to every event after it, and a tap on
    // the iPad answered seconds late (13/10). Stamped on arrival, an event is
    // applied on the next frame. Never decreasing, so a burst keeps its order.
    let lastStamp = 0;
    const stampArrival = (event: RrwebEvent) => {
      lastStamp = Math.max(Date.now(), lastStamp);
      event.timestamp = lastStamp;
    };

    // While this device scrolls the mirror itself, the source's echo of that
    // scroll would drag it back to where the source was a round trip ago. The
    // echoes wait for the gesture to end, and only the latest per node is
    // applied: where the source really ended up.
    const releaseHeld = () => {
      local.release = null;
      const wait = local.until - performance.now();
      if (wait > 0) { local.release = setTimeout(releaseHeld, wait + 16); return; }
      const held = [...local.held.values()];
      local.held.clear();
      // The clock may have parked while these waited.
      if (held.length) noteActivityRef.current?.();
      for (const event of held) {
        stampArrival(event);
        replayerRef.current?.addEvent(event as never);
      }
    };
    const holdScrollEcho = (event: RrwebEvent): boolean => {
      const id = event.data?.id;
      if (event.type !== INCREMENTAL_SNAPSHOT || event.data?.source !== SCROLL_SOURCE || typeof id !== 'number') return false;
      if (performance.now() >= local.until) return false;
      local.held.set(id, event);
      local.release ??= setTimeout(releaseHeld, local.until - performance.now() + 16);
      return true;
    };

    // Lazy images wait for the mirror's view (BROWSER-DOM-LAZY-01, lib/mirrorImages).
    // The mirror's document runs no scripts, so this one watches it. An engine
    // that cannot observe against a document loads them all, as before.
    const deferral = canObserveDocument() ? createImageDeferral() : null;
    let imageWatch: { io: IntersectionObserver; mo: MutationObserver } | null = null;
    const stopWatchingImages = () => {
      imageWatch?.io.disconnect();
      imageWatch?.mo.disconnect();
      imageWatch = null;
    };
    const watchImages = () => {
      stopWatchingImages();
      const replayer = replayerRef.current;
      const doc = (replayer?.iframe as HTMLIFrameElement | undefined)?.contentDocument;
      if (!deferral || !replayer || !doc) return;
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          revealImage(entry.target);
          deferral.revealed(replayer.getMirror().getId(entry.target));
        }
      }, { root: doc, rootMargin: LAZY_IMAGE_MARGIN });
      const observeWithin = (root: ParentNode) => root.querySelectorAll(DEFERRED_IMAGES).forEach((img) => io.observe(img));
      observeWithin(doc);
      // Images the source adds later arrive by mutation.
      const mo = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            // nodeType, not instanceof: the mirror's nodes belong to the iframe's realm.
            if (node.nodeType !== 1) continue;
            const el = node as Element;
            if (el.matches(DEFERRED_IMAGES)) io.observe(el);
            else observeWithin(el);
          }
        }
      });
      mo.observe(doc, { childList: true, subtree: true });
      imageWatch = { io, mo };
    };

    const handle = (raw: unknown) => {
      const event = raw as RrwebEvent;
      if (!event || typeof event.type !== 'number') return;
      stampArrival(event);
      prefixRoutedResources(event, serverHttpBase());
      deferral?.onEvent(event);
      if (started && holdScrollEcho(event)) return;
      // Traffico: sveglia il timer se era parcheggiato e riarma l'inattività.
      noteActivityRef.current?.();
      // The recorded viewport arrives twice: once in Meta when recording starts,
      // and again as a ViewportResize every time the driver's page changes size.
      const announced = viewportFromRrwebEvent(event);
      if (announced) dimsRef.current = { w: announced.width, h: announced.height };
      if (!started) {
        // First event bootstraps the live replayer; subsequent ones stream in.
        const replayer = new Replayer([event as never], {
          root,
          liveMode: true,
          mouseTail: false,
          showWarning: false,
          showDebug: false,
          // Remote focus must never yank THIS device's focus — the local user
          // drives via the overlay / hidden textarea, not the mirror's elements.
          triggerFocus: false,
        });
        replayer.startLive(event.timestamp);
        replayerRef.current = replayer;
        // Make the iframe interactive once; it stays UNDER the capture overlay, so
        // it only receives events when the user holds Option (the overlay yields).
        replayer.enableInteract();
        replayer.on('fullsnapshot-rebuilded', () => {
          applyScale();
          // doc.open() during rebuild drops in-iframe listeners — re-arm the guard.
          attachNavGuard();
          watchImages();
        });
        started = true;
        setPainted(true);
        applyScale();
        attachNavGuard();
        // Un replayer NATO mentre la pane è nascosta deve parcheggiarsi subito:
        // l'IntersectionObserver ha già deciso, ma non c'era ancora niente da
        // fermare quando l'ha fatto.
        parkWhenHiddenRef.current?.();
        return;
      }
      const current = replayerRef.current;
      if (current) {
        current.addEvent(event as never);
        forgetHandedOver(current);
      }
      if (announced) applyScale(); // refit on the new viewport
    };

    const ro = new ResizeObserver(() => applyScale());
    ro.observe(root);

    // ── Parcheggio del timer live ────────────────────────────────────────────
    // Il Replayer in `liveMode` tiene un loop `requestAnimationFrame` acceso
    // PER SEMPRE, anche a zero eventi: è il modo in cui rrweb pianifica il
    // futuro. Misurato nell'app vera (sonda in lib/devLayoutProbe.ts,
    // 2026-07-28): 915 rAF in 15s, cioè 61/s — il 62% di TUTTI i rAF dell'app,
    // da un mirror che spesso nessuno sta guardando. E un rAF in coda non è
    // gratis: obbliga WebKit a un rendering update completo ogni frame, ed è lì
    // che finiva il layout dell'intero albero delle pane.
    //
    // Quindi il timer vive solo mentre il mirror è VISIBILE. L'IntersectionObserver
    // copre da solo i due casi che contano — tab nascosta (`display:none` ⇒
    // nessun box ⇒ non interseca) e mirror fuori dal viewport — e
    // `visibilitychange` aggiunge la finestra nascosta.
    //
    // rrweb's own `pause()` never stopped a live clock: the mirror drives it
    // (lib/mirrorClock, BROWSER-DOM-IDLE-01). Events keep arriving while it is
    // parked and wait in its queue; waking applies them all on the next frame,
    // so the mirror catches up in one go instead of losing pieces.
    //
    // Non basta però la visibilità: col mirror IN VISTA il timer tornava a
    // pompare a frame pieno (858 rAF in 15s, misurati) anche davanti a una
    // pagina remota completamente FERMA. Quindi il timer segue anche il flusso:
    // dopo `IDLE_PARK_MS` senza eventi si parcheggia, e il prossimo evento lo
    // risveglia. Una pagina che anima davvero (video, spinner) manda eventi di
    // continuo e resta sveglia da sé; una pagina statica costa zero.
    let parked = false;
    let intersecting = true;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const park = () => {
      if (parked || !replayerRef.current) return;
      parked = true;
      try { parkClock(replayerRef.current); } catch { parked = false; }
    };
    const wake = () => {
      if (!parked || !replayerRef.current) return;
      parked = false;
      try { wakeClock(replayerRef.current); } catch { /* the next event tries again */ }
    };
    const sync = () => {
      if (intersecting && !document.hidden) wake();
      else park();
    };
    // Chiamata a ogni evento in arrivo: sveglia e riarma il conto alla rovescia.
    const noteActivity = () => {
      if (idleTimer) clearTimeout(idleTimer);
      sync();
      if (!intersecting || document.hidden) return;
      idleTimer = setTimeout(() => { idleTimer = null; park(); }, IDLE_PARK_MS);
    };
    noteActivityRef.current = noteActivity;
    parkWhenHiddenRef.current = sync;
    const io = new IntersectionObserver((entries) => {
      intersecting = entries.some((e) => e.isIntersecting);
      sync();
    });
    io.observe(root);
    document.addEventListener('visibilitychange', sync);

    // LAST, after the two refs above: `registerDomSink` flushes the buffered
    // bootstrap burst synchronously, inside this call. Registered earlier, the
    // whole initial stream met null refs and never armed the idle park.
    const unsubscribe = registerDomSink(handle);

    return () => {
      unsubscribe();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      if (idleTimer) clearTimeout(idleTimer);
      parkWhenHiddenRef.current = null;
      noteActivityRef.current = null;
      navGuardAbortRef.current?.abort();
      navGuardAbortRef.current = null;
      if (acc.timer) clearTimeout(acc.timer);
      acc.timer = null;
      if (local.release) clearTimeout(local.release);
      local.release = null;
      local.held.clear();
      if (local.fling !== null) cancelAnimationFrame(local.fling);
      local.fling = null;
      stopWatchingImages();
      if (replayerRef.current) stopClock(replayerRef.current);
      try { replayerRef.current?.destroy(); } catch { /* already gone */ }
      replayerRef.current = null;
      // The replayer took the reconstructed DOM with it — we're a blank box again.
      setPainted(false);
    };
  }, [registerDomSink, applyScale, attachNavGuard]);

  return (
    <div ref={rootRef} className="topics-dom-cobrowse relative h-full w-full overflow-hidden bg-app-bg" style={{ isolation: 'isolate' }}>
      {/* Hide rrweb's REPLAYED cursor: liveMode paints a `.replayer-mouse` dot that
          chases the source page's CDP mouse — in co-browse the local user drives
          with their OWN native cursor, so the replayed one is only round-trip lag. */}
      <style>{`.topics-dom-cobrowse .replayer-mouse,.topics-dom-cobrowse .replayer-mouse-tail{display:none!important}`}</style>

      {/* Hidden keyboard capture: focused inside the pointer/touch gesture so
          hardware keys, mobile soft keyboards, paste and IME all reach the source
          page. Si veste sul campo remoto toccato prima di prendere il fuoco — è
          da lì che iOS decide QUALE tastiera aprire. */}
      <BrowserKeyboardCapture ref={kbdRef} sendInput={sendInput} suppressed={agentActive} />

      {/* Parent-frame capture overlay — the robust input surface. Sized to the
          scaled mirror and moved with it by applyScale (centred). Disabled while the user
          holds Option (native selection in the iframe) or an agent drives. */}
      <div
        ref={overlayRef}
        data-testid="browser-dom-input-overlay"
        className="absolute left-0 top-0 z-[2]"
        style={{ pointerEvents: selecting || agentActive ? 'none' : 'auto', cursor: 'default', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      />

      {/* Local text-selection mode indicator (Option toggles it). While active the
          overlay yields to the interactive mirror so text is natively selectable. */}
      {/* Era `bg-black/70 text-white`, l'unico dei quattro chip del pane che non
          seguiva il tema: in chiaro restava una pastiglia nera. */}
      {selecting && !agentActive && (
        <BrowserPaneChip corner="top-center" tone="active" z={3} testId="browser-dom-select-mode">
          {tr('cobrowse.textSelect')}
        </BrowserPaneChip>
      )}

      {/* Nothing reconstructed yet — say so instead of showing a white void. This
          covers both the healthy first moments (snapshot in flight) and the broken
          case (transport down, auto-reconnect backing off): from here the two are
          the same state, "no surface yet", and the toolbar chip is what tells
          connected from disconnected. It never returns once painted: on a later
          drop the last reconstructed DOM stays on screen, which beats covering
          usable content with a spinner. */}
      {!painted && (
        <div
          data-testid="browser-dom-negotiating"
          className="absolute inset-0 z-[4] flex items-center justify-center pointer-events-none select-none"
        >
          <div className="text-center">
            <Loader2 size={28} className="mx-auto mb-2 text-app-spinner animate-spin" />
            <p className="text-compact text-app-text-muted">{tr('browser.shared.starting')}</p>
          </div>
        </div>
      )}

      {/* Agent lock: while an agent drives, a blocking overlay suppresses local
          input (take-control parity). */}
      {agentActive && (
        <div
          role="presentation"
          data-testid="browser-dom-agent-lock"
          className="absolute left-0 top-0 z-[3] w-full h-full"
          style={{ cursor: 'not-allowed' }}
        />
      )}
    </div>
  );
}

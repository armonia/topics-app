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
 * the known fit `scale` (the overlay is sized to the scaled mirror, pinned
 * top-left, so `sourcePx = localPx / scale`) and relay via `sendInput` (→ CDP).
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

/** Minimal shape of an rrweb event we rely on (Meta carries the recorded size). */
type RrwebEvent = {
  type: number;
  timestamp: number;
  data?: { width?: number; height?: number; source?: number; id?: number; x?: number; y?: number };
};

/** rrweb constants we depend on (avoid importing the full enum surface). */
const EVENT_META = 4;

/** Senza eventi per questo tempo il timer live si parcheggia: una pagina remota
 *  ferma non deve tenere sveglio il renderer. Abbastanza largo da non tagliare la
 *  coda di applicazione di rrweb (che lavora ~100ms dietro il tempo reale). */
const IDLE_PARK_MS = 400;

/** Coalesce relayed scroll deltas at this cadence (ms) so we don't flood the WS. */
const SCROLL_RELAY_INTERVAL = 60;
/** Below this touch travel a touch is treated as a tap (→ click), not a scroll. */
const TAP_SLOP = 8;

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
}

export default function DomCoBrowse({ registerDomSink, registerFocusSink, sendInput, agentActive }: Props) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const kbdRef = useRef<BrowserKeyboardCaptureHandle | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
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
  const touchRef = useRef<{ x: number; y: number; travel: number } | null>(null);
  // Option/Alt held → let the user select + copy natively in the mirror iframe.
  const [selecting, setSelecting] = useState(false);
  // Has the replayer painted anything yet? The root is `bg-white`, so before the
  // first rrweb event this component IS a blank white box — indistinguishable
  // from a broken pane when the transport is down (the only other signal is the
  // toolbar's connection chip). Nobody upstream can answer this: the panel only
  // knows the socket state, not whether pixels landed. So we own it here.
  const [painted, setPainted] = useState(false);
  const selectingRef = useRef(false);
  useEffect(() => { selectingRef.current = selecting; }, [selecting]);
  const navGuardAbortRef = useRef<AbortController | null>(null);

  // Fit the reconstructed iframe (recorded WxH) inside the pane, pinned top-left,
  // and size the capture overlay to exactly that scaled rect.
  const applyScale = useCallback(() => {
    const root = rootRef.current;
    const replayer = replayerRef.current;
    const { w, h } = dimsRef.current;
    if (!root || !replayer || !w || !h) return;
    const cw = root.clientWidth;
    const ch = root.clientHeight;
    const scale = Math.min(cw / w, ch / h) || 1;
    scaleRef.current = scale;
    const wrapper = replayer.wrapper as HTMLElement | undefined;
    if (wrapper) {
      wrapper.style.transformOrigin = 'top left';
      wrapper.style.transform = `scale(${scale})`;
    }
    const overlay = overlayRef.current;
    if (overlay) {
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
    if (selectingRef.current) return;
    const c = toSource(e.clientX, e.clientY) || { x: dimsRef.current.w / 2, y: dimsRef.current.h / 2 };
    queueScrollRelay(e.deltaX, e.deltaY, c.x, c.y);
  }, [toSource, queueScrollRelay]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (selectingRef.current) return;
    const t = e.touches[0];
    // Il fuoco va preso DENTRO il gesto, o iOS non apre la tastiera: quindi qui,
    // non al touchend. Ed è vestito sul campo toccato — è tutto il punto.
    if (t) {
      focusKbdAt(t.clientX, t.clientY, true);
      touchRef.current = { x: t.clientX, y: t.clientY, travel: 0 };
    }
    rootRef.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }, [focusKbdAt]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (selectingRef.current) return;
    const prev = touchRef.current;
    const t = e.touches[0];
    if (!prev || !t) return;
    // Natural scroll: dragging content DOWN scrolls the page UP → invert.
    const dx = prev.x - t.clientX;
    const dy = prev.y - t.clientY;
    prev.travel += Math.abs(dx) + Math.abs(dy);
    prev.x = t.clientX;
    prev.y = t.clientY;
    const c = toSource(t.clientX, t.clientY) || { x: dimsRef.current.w / 2, y: dimsRef.current.h / 2 };
    queueScrollRelay(dx, dy, c.x, c.y);
  }, [toSource, queueScrollRelay]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (selectingRef.current || agentActiveRef.current) { touchRef.current = null; return; }
    const prev = touchRef.current;
    touchRef.current = null;
    if (!prev || prev.travel > TAP_SLOP) return; // a scroll, not a tap
    const t = e.changedTouches[0];
    if (!t) return;
    const c = toSource(t.clientX, t.clientY);
    if (c) sendInput('click', { x: c.x, y: c.y, button: 'left' });
  }, [toSource, sendInput]);

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

    const handle = (raw: unknown) => {
      const event = raw as RrwebEvent;
      if (!event || typeof event.type !== 'number') return;
      // Traffico: sveglia il timer se era parcheggiato e riarma l'inattività.
      noteActivityRef.current?.();
      // Meta (type 4) carries the recorded viewport — drive the fit from it.
      if (event.type === EVENT_META && event.data) {
        dimsRef.current = { w: event.data.width || dimsRef.current.w, h: event.data.height || dimsRef.current.h };
      }
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
        replayer.startLive(event.timestamp - 100);
        replayerRef.current = replayer;
        // Make the iframe interactive once; it stays UNDER the capture overlay, so
        // it only receives events when the user holds Option (the overlay yields).
        replayer.enableInteract();
        replayer.on('fullsnapshot-rebuilded', () => {
          applyScale();
          // doc.open() during rebuild drops in-iframe listeners — re-arm the guard.
          attachNavGuard();
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
      replayerRef.current?.addEvent(event as never);
      if (event.type === EVENT_META) applyScale(); // a resize re-emits Meta
    };

    const unsubscribe = registerDomSink(handle);
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
    // Gli eventi continuano ad ARRIVARE mentre è parcheggiato: `addEvent` li
    // accoda, e al risveglio `startLive` con una baseline fresca li scarica
    // tutti insieme. Il mirror si riallinea in un colpo invece di perdere pezzi.
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
      try { replayerRef.current.pause(); } catch { parked = false; }
    };
    const wake = () => {
      if (!parked || !replayerRef.current) return;
      parked = false;
      try { replayerRef.current.startLive(Date.now() - 100); } catch { /* riparte al prossimo evento */ }
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
      try { replayerRef.current?.destroy(); } catch { /* already gone */ }
      replayerRef.current = null;
      // The replayer took the reconstructed DOM with it — we're a blank box again.
      setPainted(false);
    };
  }, [registerDomSink, applyScale, attachNavGuard]);

  return (
    <div ref={rootRef} className="topics-dom-cobrowse relative h-full w-full overflow-hidden bg-white" style={{ isolation: 'isolate' }}>
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
          scaled mirror (applyScale), pinned top-left. Disabled while the user
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
            <p className="text-[12px] text-app-text-muted">{tr('browser.shared.starting')}</p>
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

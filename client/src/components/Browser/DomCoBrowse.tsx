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
 * Input: the mirror itself is the input surface. The replayer iframe is
 * interactive (`enableInteract()`), so selection, hover states, cursor shapes,
 * native scroll (wheel + touch momentum) and the copy context menu all happen
 * locally in this device's engine — no round trip. A capture-phase bridge inside
 * the iframe document relays the SEMANTIC actions to the source page via
 * sendInput (→ CDP): clicks (default-prevented so the mirror never navigates or
 * toggles on its own), keystrokes (beforeinput covers mobile soft keyboards and
 * paste), and coalesced scroll deltas so the source + other viewers follow.
 * Coordinates need no scale math: events captured inside the iframe are already
 * in the iframe's own coordinate space = source-page viewport CSS px (the
 * browser maps the pointer through the wrapper's transform).
 *
 * Scroll echo: while the local user is actively scrolling, incoming rrweb scroll
 * events (the source echoing our own relayed deltas, or another driver) are
 * stashed instead of applied — applying them mid-gesture makes the pane rubber-
 * band, the exact "it's a laggy stream" feel. The latest stashed position is
 * applied when the gesture window expires, so viewers still converge on the
 * source's authoritative position at rest.
 *
 * The rebuild gotcha: rrweb's full-snapshot rebuild goes through doc.open(),
 * which wipes every listener on the iframe document — the bridge re-attaches on
 * each 'fullsnapshot-rebuilded' event (AbortController makes that idempotent).
 *
 * Gated on the agent lock: while an agent drives, a blocking overlay suppresses
 * this viewer's input, mirroring the pixel path's take-control model.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/rrweb.min.css';

/** Minimal shape of an rrweb event we rely on (Meta carries the recorded size). */
type RrwebEvent = {
  type: number;
  timestamp: number;
  data?: { width?: number; height?: number; source?: number; id?: number; x?: number; y?: number };
};

/** rrweb constants we depend on (avoid importing the full enum surface). */
const EVENT_INCREMENTAL = 3;
const EVENT_META = 4;
const INCREMENTAL_SOURCE_SCROLL = 3;

/** Named keys relayed to the source as key presses (the rest stay native). */
const RELAYED_KEYS = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

/** How long after local input we treat scrolling as user-driven (ms). */
const USER_GESTURE_WINDOW = 1200;
/** Touch momentum self-extension: each user-driven scroll keeps the window alive. */
const TOUCH_MOMENTUM_WINDOW = 900;
/** Ignore local scroll events this soon after applying a remote scroll (echo). */
const REMOTE_APPLY_WINDOW = 400;
/** Coalesce relayed scroll deltas at this cadence (ms). */
const SCROLL_RELAY_INTERVAL = 80;

type SendInput = (
  action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
  payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' },
) => void;

interface Props {
  /** Register the single live rrweb-event sink; returns an unsubscribe. */
  registerDomSink: (cb: (event: unknown) => void) => () => void;
  /** Relay input to the source page (page-CSS px). */
  sendInput: SendInput;
  /** Agent lock — while true, this viewer's input is suppressed (take-control parity). */
  agentActive: boolean;
}

export default function DomCoBrowse({ registerDomSink, sendInput, agentActive }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  // Recorded source dimensions (from the Meta event) + the current fit scale.
  const dimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const scaleRef = useRef(1);
  const agentActiveRef = useRef(agentActive);
  agentActiveRef.current = agentActive;

  // ── Interaction state (all refs: the bridge lives outside React's render) ────
  const userActiveUntilRef = useRef(0);
  const touchActiveUntilRef = useRef(0);
  const remoteApplyUntilRef = useRef(0);
  const mouseDownRef = useRef(false);
  const pendingRemoteScrollRef = useRef<RrwebEvent | null>(null);
  const pendingScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDocScrollRef = useRef({ x: 0, y: 0 });
  const scrollAccRef = useRef<{ dx: number; dy: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null }>(
    { dx: 0, dy: 0, x: 0, y: 0, timer: null },
  );
  const bridgeAbortRef = useRef<AbortController | null>(null);

  // Fit the reconstructed iframe (recorded WxH) inside the pane, pinned top-left.
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

  // Apply a (stashed) remote scroll directly via the replayer's mirror — bypasses
  // the live timer so an out-of-window event can't confuse its clock. Absolute
  // positions make this idempotent.
  const applyRemoteScroll = useCallback((event: RrwebEvent) => {
    const replayer = replayerRef.current;
    const data = event.data;
    if (!replayer || !data || data.id == null) return;
    const mirror = replayer.getMirror();
    const node = mirror.getNode(data.id) as Node | null;
    if (!node) return;
    remoteApplyUntilRef.current = Date.now() + REMOTE_APPLY_WINDOW;
    const doc = node.nodeType === Node.DOCUMENT_NODE ? (node as Document) : null;
    const el = doc ? (doc.scrollingElement || doc.documentElement) : (node as Element);
    if (!el || typeof (el as Element).scrollTop !== 'number') return;
    (el as Element).scrollLeft = data.x ?? 0;
    (el as Element).scrollTop = data.y ?? 0;
    if (doc) lastDocScrollRef.current = { x: data.x ?? 0, y: data.y ?? 0 };
  }, []);

  const flushPendingRemoteScroll = useCallback(() => {
    const pending = pendingRemoteScrollRef.current;
    pendingRemoteScrollRef.current = null;
    if (pendingScrollTimerRef.current) {
      clearTimeout(pendingScrollTimerRef.current);
      pendingScrollTimerRef.current = null;
    }
    if (!pending) return;
    const remaining = userActiveUntilRef.current - Date.now();
    if (remaining > 0) {
      // Gesture window got extended (momentum) — re-arm for the new expiry.
      pendingRemoteScrollRef.current = pending;
      pendingScrollTimerRef.current = setTimeout(flushPendingRemoteScroll, remaining + 20);
      return;
    }
    applyRemoteScroll(pending);
  }, [applyRemoteScroll]);

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

  // ── The input bridge: capture-phase listeners inside the replayer iframe ─────
  const attachInputBridge = useCallback(() => {
    const replayer = replayerRef.current;
    const iframe = replayer?.iframe as HTMLIFrameElement | undefined;
    const doc = iframe?.contentDocument;
    if (!replayer || !doc) return;

    // doc.open() (full-snapshot rebuild) wiped any previous listeners; abort the
    // old controller and attach a fresh set — idempotent across rebuilds.
    bridgeAbortRef.current?.abort();
    const ac = new AbortController();
    bridgeAbortRef.current = ac;
    const opts = { capture: true, signal: ac.signal } as AddEventListenerOptions;
    const passive = { capture: true, passive: true, signal: ac.signal } as AddEventListenerOptions;

    const refreshUserWindow = () => { userActiveUntilRef.current = Date.now() + USER_GESTURE_WINDOW; };

    doc.addEventListener('click', (e) => {
      // The mirror must never act on its own: no link navigation, no checkbox
      // toggles, no form submits — the SOURCE performs the action and its DOM
      // echoes back. preventDefault also under the agent lock (view-only).
      e.preventDefault();
      if (agentActiveRef.current) return;
      // A drag-select release also fires click — don't nuke the user's selection
      // intent with a stray relayed click.
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      sendInput('click', { x: e.clientX, y: e.clientY, button: 'left' });
    }, opts);

    doc.addEventListener('auxclick', (e) => { e.preventDefault(); }, opts);
    doc.addEventListener('submit', (e) => { e.preventDefault(); }, opts);
    // Selected text can start a native drag — meaningless in a mirror.
    doc.addEventListener('dragstart', (e) => { e.preventDefault(); }, opts);

    doc.addEventListener('mousedown', (e) => {
      mouseDownRef.current = true;
      refreshUserWindow();
      // Let the host app see the gesture (pane/tab activation) — the iframe
      // swallows it otherwise.
      rootRef.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      // A native <select> popup would fork local state the echo then stomps —
      // relay the click and let the source own the dropdown (arrow keys work).
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'SELECT') {
        e.preventDefault();
        if (!agentActiveRef.current) sendInput('click', { x: e.clientX, y: e.clientY, button: 'left' });
      }
    }, opts);
    doc.addEventListener('mouseup', () => { mouseDownRef.current = false; }, passive);

    doc.addEventListener('keydown', (e) => {
      if (agentActiveRef.current) { e.preventDefault(); return; }
      // Meta/Ctrl combos stay native: ⌘C copies the local selection, ⌘A selects
      // all in the mirror. (⌘V still relays — paste lands in beforeinput below.)
      if (e.metaKey || e.ctrlKey) return;
      if (RELAYED_KEYS.has(e.key)) {
        e.preventDefault();
        sendInput('keypress', { key: e.key });
      } else if (e.key.length === 1) {
        e.preventDefault();
        sendInput('type', { text: e.key });
      }
      // Dead/Process/Unidentified fall through: IME composes locally (not
      // cancelable anyway); mobile soft keyboards land in beforeinput.
    }, opts);

    doc.addEventListener('beforeinput', (e) => {
      const ie = e as InputEvent;
      // insertCompositionText is not cancelable per spec — the echo reconciles.
      if (ie.inputType === 'insertCompositionText') return;
      e.preventDefault();
      if (agentActiveRef.current) return;
      switch (ie.inputType) {
        case 'insertText':
        case 'insertFromPaste':
          if (ie.data) sendInput('type', { text: ie.data });
          break;
        case 'insertParagraph':
        case 'insertLineBreak':
          sendInput('keypress', { key: 'Enter' });
          break;
        case 'deleteContentBackward':
          sendInput('keypress', { key: 'Backspace' });
          break;
        case 'deleteContentForward':
          sendInput('keypress', { key: 'Delete' });
          break;
      }
    }, opts);

    // Wheel: NOT default-prevented — the iframe scrolls natively (instant, with
    // momentum) and the coalesced relay keeps the source + other viewers aligned.
    doc.addEventListener('wheel', (e) => {
      refreshUserWindow();
      queueScrollRelay(e.deltaX, e.deltaY, e.clientX, e.clientY);
    }, passive);

    doc.addEventListener('touchstart', (e) => {
      refreshUserWindow();
      touchActiveUntilRef.current = Date.now() + USER_GESTURE_WINDOW;
      const t = e.touches[0];
      if (t) rootRef.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }, passive);
    doc.addEventListener('touchmove', () => {
      refreshUserWindow();
      touchActiveUntilRef.current = Date.now() + USER_GESTURE_WINDOW;
    }, passive);

    // Document-level scrolls: always track the position; relay the delta only
    // when locally driven — touch pan/momentum (no wheel events on mobile) or a
    // scrollbar drag (mouse held). Wheel-driven doc scrolls already relayed above.
    doc.addEventListener('scroll', (e) => {
      if (e.target !== doc) return; // inner scrollers: wheel relay covers desktop
      const el = doc.scrollingElement || doc.documentElement;
      if (!el) return;
      const now = Date.now();
      const last = lastDocScrollRef.current;
      const dx = el.scrollLeft - last.x;
      const dy = el.scrollTop - last.y;
      lastDocScrollRef.current = { x: el.scrollLeft, y: el.scrollTop };
      if (now < remoteApplyUntilRef.current) return; // echo of a remote apply
      const touchDriven = now < touchActiveUntilRef.current;
      if (!touchDriven && !mouseDownRef.current) return;
      if (touchDriven) {
        // Momentum self-extension: keep treating the glide as user-driven.
        touchActiveUntilRef.current = now + TOUCH_MOMENTUM_WINDOW;
        userActiveUntilRef.current = Math.max(userActiveUntilRef.current, now + TOUCH_MOMENTUM_WINDOW);
      } else {
        userActiveUntilRef.current = now + USER_GESTURE_WINDOW;
      }
      const { w, h } = dimsRef.current;
      queueScrollRelay(dx, dy, w / 2, h / 2);
    }, passive);
  }, [sendInput, queueScrollRelay]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let started = false;

    const handle = (raw: unknown) => {
      const event = raw as RrwebEvent;
      if (!event || typeof event.type !== 'number') return;
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
          // Remote focus must never yank THIS device's focus — local clicks
          // focus mirror elements natively (it's a real DOM).
          triggerFocus: false,
        });
        replayer.startLive(event.timestamp - 100);
        replayerRef.current = replayer;
        // The mirror is the input surface: native selection, hover, scroll.
        replayer.enableInteract();
        // doc.open() during each full-snapshot rebuild wipes the bridge — re-attach.
        replayer.on('fullsnapshot-rebuilded', () => {
          attachInputBridge();
          applyScale();
        });
        started = true;
        applyScale();
        attachInputBridge();
        return;
      }
      // Scroll echo suppression: while the local user is mid-gesture, stash the
      // source's scroll instead of applying it (rubber-banding = "laggy stream"
      // feel). Latest wins; applied when the gesture window expires.
      if (event.type === EVENT_INCREMENTAL && event.data?.source === INCREMENTAL_SOURCE_SCROLL) {
        const now = Date.now();
        if (now < userActiveUntilRef.current) {
          pendingRemoteScrollRef.current = event;
          if (!pendingScrollTimerRef.current) {
            pendingScrollTimerRef.current = setTimeout(
              flushPendingRemoteScroll,
              userActiveUntilRef.current - now + 20,
            );
          }
          return;
        }
        remoteApplyUntilRef.current = now + REMOTE_APPLY_WINDOW;
      }
      replayerRef.current?.addEvent(event as never);
      if (event.type === EVENT_META) applyScale(); // a resize re-emits Meta
    };

    const unsubscribe = registerDomSink(handle);
    const ro = new ResizeObserver(() => applyScale());
    ro.observe(root);

    return () => {
      unsubscribe();
      ro.disconnect();
      bridgeAbortRef.current?.abort();
      bridgeAbortRef.current = null;
      if (pendingScrollTimerRef.current) clearTimeout(pendingScrollTimerRef.current);
      pendingScrollTimerRef.current = null;
      const acc = scrollAccRef.current;
      if (acc.timer) clearTimeout(acc.timer);
      acc.timer = null;
      try { replayerRef.current?.destroy(); } catch { /* already gone */ }
      replayerRef.current = null;
    };
  }, [registerDomSink, applyScale, attachInputBridge, flushPendingRemoteScroll]);

  return (
    <div ref={rootRef} className="topics-dom-cobrowse relative h-full w-full overflow-hidden bg-white" style={{ isolation: 'isolate' }}>
      {/* Hide rrweb's REPLAYED cursor: liveMode paints a `.replayer-mouse` dot that
          chases the source page's CDP mouse, so every relayed click makes a lagging
          dot jump across the pane — the exact "it feels like streaming, the mouse
          moves" artifact. In DOM mode the user drives with their OWN native cursor;
          the replayed one adds nothing but round-trip lag. Scoped to this view. */}
      <style>{`.topics-dom-cobrowse .replayer-mouse,.topics-dom-cobrowse .replayer-mouse-tail{display:none!important}`}</style>
      {/* Agent lock: while an agent drives, a blocking overlay suppresses local
          input (take-control parity). When idle it's not rendered at all — the
          interactive mirror IS the surface. */}
      {agentActive && (
        <div
          ref={overlayRef}
          role="presentation"
          data-testid="browser-dom-agent-lock"
          className="absolute left-0 top-0 z-10"
          style={{ cursor: 'not-allowed' }}
        />
      )}
    </div>
  );
}

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
 * Input: a transparent overlay captures click/wheel/keydown, maps the coords from
 * the scaled iframe back to source-page CSS px, and relays them via sendInput
 * (→ CDP). Gated on the agent lock, mirroring the pixel path's take-control model.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/rrweb.min.css';

/** Minimal shape of an rrweb event we rely on (Meta carries the recorded size). */
type RrwebEvent = {
  type: number;
  timestamp: number;
  data?: { width?: number; height?: number };
};

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

  // Fit the reconstructed iframe (recorded WxH) inside the pane, pinned top-left so
  // the overlay's local coords divide cleanly by the scale back to page px.
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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let started = false;

    const handle = (raw: unknown) => {
      const event = raw as RrwebEvent;
      if (!event || typeof event.type !== 'number') return;
      // Meta (type 4) carries the recorded viewport — drive the fit from it.
      if (event.type === 4 && event.data) {
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
        });
        replayer.startLive(event.timestamp - 100);
        replayerRef.current = replayer;
        started = true;
        applyScale();
      } else {
        replayerRef.current?.addEvent(event as never);
        if (event.type === 4) applyScale(); // a resize re-emits Meta
      }
    };

    const unsubscribe = registerDomSink(handle);
    const ro = new ResizeObserver(() => applyScale());
    ro.observe(root);

    return () => {
      unsubscribe();
      ro.disconnect();
      try { replayerRef.current?.destroy(); } catch { /* already gone */ }
      replayerRef.current = null;
    };
  }, [registerDomSink, applyScale]);

  // ── Input relay (overlay → source-page CSS px), gated on the agent lock ──────
  const toPage = (clientX: number, clientY: number) => {
    const overlay = overlayRef.current;
    if (!overlay) return null;
    const r = overlay.getBoundingClientRect();
    const s = scaleRef.current || 1;
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s };
  };

  const onClick = useCallback((e: React.MouseEvent) => {
    if (agentActiveRef.current) return;
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput('click', { x: p.x, y: p.y, button: 'left' });
  }, [sendInput]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (agentActiveRef.current) return;
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput('scroll', { x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY });
  }, [sendInput]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (agentActiveRef.current) return;
    // Single printable char → type it; named keys (Enter/Backspace/arrows) → press.
    if (e.key.length === 1) sendInput('type', { text: e.key });
    else sendInput('keypress', { key: e.key });
  }, [sendInput]);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-white" style={{ isolation: 'isolate' }}>
      {/* Transparent capture layer over the reconstructed iframe. tabIndex makes it
          keyboard-focusable so keydown relays; agent-lock suppresses relays. */}
      <div
        ref={overlayRef}
        role="presentation"
        tabIndex={0}
        onClick={onClick}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        className="absolute left-0 top-0 z-10 outline-none"
        style={{ cursor: agentActive ? 'not-allowed' : 'default' }}
      />
    </div>
  );
}

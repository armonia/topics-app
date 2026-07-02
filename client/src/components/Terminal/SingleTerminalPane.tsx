import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Copy, Check, RotateCw, Clock } from 'lucide-react';
import { attachTerminalTouchScroll } from './touchScroll';
import { enqueueFit, cancelFit } from '../../lib/staggeredFit';
import { serverWsBase } from '../../lib/shell/net';
import { registerWrappedLinkProvider, openLinkExternally } from './wrappedLinkProvider';
import { signalsActions, useTerminalFinished, useTerminalReloading, useTerminalLoading } from '../../state/signals';
import { useTerminalSessions } from '../../contexts/TopicsContext';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '../../lib/settings';

const TOUCH_KEYS: { label: string; data: string; wide?: boolean }[] = [
  { label: 'Esc',    data: '\x1b' },
  { label: 'Tab',    data: '\t' },
  { label: '↑',      data: '\x1b[A' },
  { label: '↓',      data: '\x1b[B' },
  { label: '←',      data: '\x1b[D' },
  { label: '→',      data: '\x1b[C' },
  { label: 'Ctrl+C', data: '\x03', wide: true },
  { label: 'Ctrl+D', data: '\x04', wide: true },
  { label: 'Ctrl+Z', data: '\x1a', wide: true },
];

const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window && navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|iPod/.test(navigator.userAgent);

const DARK_THEME = {
  // Near-neutral dark gray matched to the project sidebar's dark chrome. The
  // chrome is translucent vibrancy (reads gray, not blue), so an OPAQUE terminal
  // must stay near-neutral — at this low lightness any blue channel is amplified
  // and immediately reads "blue". Keep R/G/B within ~3 (whisper of cool, never
  // warm); darken to match the sidebar, never raise saturation.
  background: '#0d0e10',
  foreground: '#d4d4d8',
  cursor: '#a1a1aa',
  cursorAccent: '#0d0e10',
  selectionBackground: '#3f3f4640',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#0066ff30',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
};

function getTerminalTheme(isDark: boolean) {
  // xterm background is transparent so the container's .chrome-glass (the exact
  // frosted vibrancy of the project sidebar) shows through — identical CSS,
  // identical pixels. The container keeps an opaque fallback bg for non-Electron
  // web, where .chrome-glass is a no-op.
  return { ...(isDark ? DARK_THEME : LIGHT_THEME), background: 'rgba(0,0,0,0)' };
}

interface SingleTerminalPaneProps {
  sessionId: string;
  onStale?: () => void;
  /** True when this pane is the active/visible one. Defaults to true so call
   *  sites that don't pass it keep the old always-visible behavior. */
  isActive?: boolean;
}

export function SingleTerminalPane({ sessionId, onStale, isActive = true }: SingleTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; ws: WebSocket } | null>(null);
  const [stale, setStale] = useState(false);

  // ── Lossless reattach ──────────────────────────────────────────────────
  // The terminal-session list is broadcast by the server and sourced from the
  // PTY bridge, which keeps sessions alive across server reloads/restarts. So
  // the AUTHORITATIVE answer to "is this session still alive?" is "is it in
  // this list?" — NOT the WS close code. We use it to (a) keep reconnecting a
  // pane whose WS dropped during a reload/reconcile instead of dead-ending on
  // "expired", and (b) auto-recover a pane that already went stale the instant
  // its session reappears in the list. Read inside the connection effect via
  // refs so the (sessionId-keyed) xterm mount effect never re-runs on a list
  // change.
  const terminalSessions = useTerminalSessions();
  const sessionListed = useMemo(
    () => terminalSessions.some((s) => s.id === sessionId),
    [terminalSessions, sessionId],
  );
  // Last-known session metadata, captured while the session is still in the
  // authoritative roster. A *stale* session is ABSENT from the roster, so at
  // overlay-time its live entry is already gone — we surface this snapshot
  // instead so the "expired" overlay can still report id / type / cwd / resume.
  const sessionInfo = useMemo(
    () => terminalSessions.find((s) => s.id === sessionId),
    [terminalSessions, sessionId],
  );
  const lastInfoRef = useRef<(typeof terminalSessions)[number] | null>(null);
  useEffect(() => { if (sessionInfo) lastInfoRef.current = sessionInfo; }, [sessionInfo]);
  const sessionListedRef = useRef(sessionListed);
  const staleRef = useRef(stale);
  const reconnectRef = useRef<(() => void) | null>(null);
  useEffect(() => { staleRef.current = stale; }, [stale]);

  // Viewing a claude-code session = its "finished a turn" notification is seen,
  // so clear it. Depending on `finished` (not just isActive) is what makes this
  // false-positive-proof: if the session finishes *while you're already looking
  // at it* (isActive stays true, so an [isActive,sessionId] effect would never
  // re-run), the badge would otherwise pop on a pane you're staring at. This
  // also kills the "I paused mid-typing" false finish — composing in an active
  // pane keeps it cleared.
  const finished = useTerminalFinished(sessionId);
  const reloading = useTerminalReloading(sessionId);
  useEffect(() => {
    if (isActive && finished) signalsActions.clearTerminalFinished(sessionId);
  }, [isActive, finished, sessionId]);

  // "Working" glow — the Apple-Intelligence ring, the terminal twin of the one
  // in ChatPanel. `useTerminalLoading` is the SAME signal the sidebar green
  // terminal row reads (claude phase active, OR pty busy when not resting), so
  // the ring and the sidebar dot can never disagree. Gated behind the same
  // `workingGlow` setting via the same SETTINGS_CHANGED_EVENT pattern, so the
  // one Appearance toggle governs chats and terminals alike. The ring node is
  // rendered ONLY while working (conditional, not display:none) → zero idle cost.
  const isWorking = useTerminalLoading(sessionId);
  const [workingGlowEnabled, setWorkingGlowEnabled] = useState(() => loadSettings().workingGlow);
  useEffect(() => {
    const reload = () => setWorkingGlowEnabled(loadSettings().workingGlow);
    window.addEventListener(SETTINGS_CHANGED_EVENT, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reload);
      window.removeEventListener('storage', reload);
    };
  }, []);
  // Suppress the ring while the "expired"/"reloading" overlays own the pane —
  // those are their own state, and a glow around a dead pane would be noise.
  const showWorkingRing = isWorking && workingGlowEnabled && !stale && !reloading;
  const [copied, setCopied] = useState(false);
  const isDarkRef = useRef(document.documentElement.classList.contains('dark'));

  // Track dark/light theme
  useEffect(() => {
    const check = () => {
      const dark = document.documentElement.classList.contains('dark');
      isDarkRef.current = dark;
      if (termRef.current) {
        termRef.current.term.options.theme = { ...getTerminalTheme(dark) };
      }
    };
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Mount terminal
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Track intentional cleanup to avoid setting stale on unmount
    let intentionalClose = false;

    setStale(false); // Reset stale on (re)mount

    const term = new Terminal({
      theme: getTerminalTheme(isDarkRef.current),
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      allowTransparency: true,
      // @ts-expect-error copyOnSelect exists at runtime but missing from v6 types
      copyOnSelect: true,
      // Renderer: DOM (xterm v6 default) — KEPT ON PURPOSE on every platform, not
      // just a mobile concession. A GPU renderer is disqualified three ways here:
      //  • WebGL breaks our non-negotiable transparency — `allowTransparency:true`
      //    over the native vibrancy triggers the open thin/black-text bug
      //    (xtermjs/xterm.js#4212, unfixed, no workaround).
      //  • Up to ~9 terminals mount at once; one WebGL context each hits Chromium's
      //    ~16-context cap, which silently kills the OLDEST → panes go blank on churn.
      //  • It stacks a second silent blank-screen failure onto a window already
      //    fragile across sleep/wake + display changes (see recomposeWindow).
      // Canvas2D is not an option either: the canvas addon was REMOVED in xterm v6
      // (the pinned @xterm/addon-canvas only loads behind the demo flag below).
      // DOM is the unique renderer that is transparent, context-free, crisp at any
      // DPR, and gives mobile native text selection — and it's every GPU renderer's
      // own fallback anyway. Revisit only if profiling MEASURES DOM dropping frames
      // on the active pane, and then behind a global 1-context WebGL cap.
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Renderer: DOM on EVERY host, including Tauri/WebKit. The Canvas addon
    // (@xterm/addon-canvas) is pinned to xterm core v5 — `peerDependencies:
    // "@xterm/xterm": "^5.0.0"`, still true even of 0.8.0-beta — and CRASHES on
    // our xterm v6 core at RENDER time: `this._linkifier2.onShowLinkUnderline`
    // is undefined because the core's internal link service moved in v6. The
    // try/catch around loadAddon only catches a synchronous LOAD throw, not the
    // later render-time access, so it reported a false "canvasOk" while the
    // terminal blew up on first paint. (Was gated on `isTauri` for an 8-way
    // sidebar-reclaim win — now moot: the sidebar push is a compositor FLIP
    // (useSidebarFlipPush), not a per-frame row relayout, so DOM no longer
    // reflows terminals during the slide.) DOM is transparent (keeps the frosted
    // glass — unlike WebGL bug #4212), crisp at any DPR, and gives native text
    // selection. The demo flag below remains ONLY for the landing page's block-
    // art logo and is itself v6-incompatible — never set it in the app.
    if ((window as unknown as { __TOPICS_DEMO_CANVAS__?: boolean }).__TOPICS_DEMO_CANVAS__) {
      import('@xterm/addon-canvas')
        .then(({ CanvasAddon }) => { try { term.loadAddon(new CanvasAddon()); } catch { /* DOM fallback */ } })
        .catch(() => { /* DOM fallback */ });
    }

    registerWrappedLinkProvider(term, openLinkExternally);

    // Cmd+C (mac) or Ctrl+Shift+C: copy selection without sending SIGINT
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const isCopy = (e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key === 'c' && e.type === 'keydown';
      if (isCopy && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false; // prevent default xterm handling
      }
      return true;
    });

    // Intercept paste events with images — upload to server, copy to system clipboard,
    // then trigger a paste so Claude Code can detect the image via clipboard read
    const handleImagePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      let imageItem: DataTransferItem | null = null;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) return; // no image, let xterm handle text paste normally

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      // Convert to base64 data URL
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        try {
          // Upload to server — saves temp file and copies to macOS clipboard
          await fetch('/api/terminal/paste-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl, sessionId }),
          });

          // Send Ctrl+V (0x16) to the PTY to trigger Claude Code's clipboard read
          const activeWs = termRef.current?.ws;
          if (activeWs && activeWs.readyState === WebSocket.OPEN) {
            activeWs.send('\x16');
          }
        } catch (err) {
          console.error('Image paste failed:', err);
        }
      };
      reader.readAsDataURL(blob);
    };

    el.addEventListener('paste', handleImagePaste as unknown as EventListener, true);

    const detachTouchScroll = attachTerminalTouchScroll(el, term);

    const doFit = () => { try { fitAddon.fit(); } catch {} };
    setTimeout(doFit, 50);
    setTimeout(doFit, 200);
    setTimeout(doFit, 500);
    setTimeout(() => { doFit(); term.focus(); }, 600);

    let retryCount = 0;
    // Grace window for the boot/reconcile race: an attach can fire before the
    // session list has (re)populated. We retry this many times even while the
    // session looks absent, so a live session never false-expires before the
    // authoritative list has had a chance to load. Beyond the grace, the list
    // is the sole arbiter: listed → keep retrying (lossless); absent → expired.
    const RECONCILE_GRACE_RETRIES = 5;
    let retryTimer: ReturnType<typeof setTimeout>;

    // The server sends a `{type:"replay-end"}` text frame after flushing the
    // scrollback backlog (see server/routes/terminal.ts). We gate
    // `terminal:activity` dispatch on that marker so the tab-bar spinner
    // doesn't light up just because the historical buffer is being replayed
    // on (re)mount. State-driven, not time-based: works regardless of how
    // long the backlog takes to arrive or how big it is.
    let replayDone = false;

    /**
     * A frame counts as "real activity" only if, after stripping ANSI escape
     * sequences, it contains visible characters.
     *
     * Claude Code's CLI continuously repaints its status bar (token counter,
     * spinner dots) every ~1.5 s even when fully idle. Those repaints are
     * pure cursor-positioning + SGR sequences (e.g. ESC[H ESC[2C ESC[84B
     * ESC[7m ESC[27m ESC[88;1H) — no printable payload, just chrome. If we
     * treat every frame as activity the tab-bar spinner stays on forever
     * even though nothing is actually happening. Filtering on "visible
     * content present" gives us the right signal without needing the
     * server to know what Claude Code is doing.
     *
     * Sequences stripped:
     *   - CSI / SGR: ESC [ ... <letter>
     *   - OSC: ESC ] ... BEL (or ST)
     *   - Standalone ESC + single-byte introducers
     * Plus the C0 controls that don't carry information (NUL, BEL, BS, …);
     * we keep TAB / LF / CR as those imply real output rhythm.
     */
    function frameHasVisibleContent(s: string): boolean {
      if (!s) return false;
      const stripped = s
        // OSC: ESC ] ... BEL  or  ESC ] ... ESC \
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // CSI / SGR / private modes: ESC [ params? final
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        // 2-byte ESC sequences (e.g. ESC =, ESC >)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')
        // Bare C0 controls that aren't TAB/LF/CR
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      return /\S/.test(stripped);
    }

    function connectWs() {
      const ws = new WebSocket(`${serverWsBase()}/ws/terminal/${sessionId}`);
      ws.binaryType = 'arraybuffer';

      // Update ref so onData/paste always use the current WS
      if (termRef.current) {
        termRef.current.ws = ws;
      }

      ws.onopen = () => {
        retryCount = 0;
        setStale(false);
        // A "Ricarica" reload reconnects here — drop the "Riavvio…" overlay.
        signalsActions.clearTerminalReloading(sessionId);
        // Each new connection re-sends its backlog; reset the gate so a
        // reconnect (network blip, server restart) also suppresses the
        // replay-induced spinner.
        replayDone = false;
        fetch(`/api/terminal/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => {});
      };

      ws.onmessage = (ev) => {
        const data = ev.data;
        let frameAsText: string | null = null;
        if (typeof data === 'string') {
          // Text frames are reserved for control messages from the server.
          // Try to parse; if it's a known control type, consume it without
          // writing to the terminal. If JSON.parse fails or the type is
          // unknown, fall through and treat it as plain output for forward
          // compatibility.
          try {
            const msg = JSON.parse(data);
            if (msg && msg.type === 'replay-end') {
              replayDone = true;
              return;
            }
          } catch { /* not JSON — write as-is */ }
          term.write(data);
          frameAsText = data;
        } else if (data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(data);
          term.write(u8);
          // Decode for the activity heuristic only — xterm already has the
          // bytes; this string isn't kept past the dispatch decision.
          try { frameAsText = new TextDecoder('utf-8', { fatal: false }).decode(u8); } catch { frameAsText = null; }
        }
        // Activity pulse: only when (a) the initial backlog has been
        // fully replayed AND (b) this frame actually carries visible
        // content. Pure-ESC chrome repaints (Claude Code's status bar
        // ticks) are ignored — they would otherwise keep the tab-bar
        // spinner permanently lit on an idle session.
        if (!replayDone) return;
        if (frameAsText !== null && !frameHasVisibleContent(frameAsText)) return;
        try {
          window.dispatchEvent(
            new CustomEvent('terminal:activity', { detail: { sessionId } }),
          );
        } catch {
          /* CustomEvent unsupported — old polyfill path; harmless */
        }
      };

      ws.onclose = (event) => {
        if (intentionalClose) return;
        if (event.code === 1000) {
          // Clean end — the PTY exited (`exit`, process finished). Not a
          // reconnect candidate; the session drops from the list on its own.
          term.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
          return;
        }
        // 1008 ("session not found") or any abnormal close. The PTY bridge
        // keeps sessions alive across server reloads/restarts/reconciles, so
        // this is TRANSIENT as long as the session is still in the
        // authoritative list. Keep reconnecting; declare the pane expired only
        // once the session has actually left the broadcast list. While listed
        // we retry indefinitely (capped backoff) — that's the lossless
        // property: a reload can't strand a terminal whose session is alive.
        retryCount++;
        if (sessionListedRef.current || retryCount <= RECONCILE_GRACE_RETRIES) {
          const delay = Math.min(500 * retryCount, 3000);
          retryTimer = setTimeout(connectWs, delay);
        } else {
          term.write('\r\n\x1b[90m[Session expired]\x1b[0m\r\n');
          setStale(true);
          onStale?.();
        }
      };

      return ws;
    }

    // Exposed so the lossless-recovery effect (below) can force a reconnect
    // when a stale pane's session reappears in the authoritative list. No-op
    // if a connection is already open/opening, so it can't create a duplicate
    // socket racing the live one.
    reconnectRef.current = () => {
      const cur = termRef.current?.ws;
      if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
      clearTimeout(retryTimer);
      retryCount = 0;
      connectWs();
    };

    const initialWs = connectWs();

    term.onData((data) => {
      const ws = termRef.current?.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      // Only an ACTIVE window drives the shared PTY size so background windows
      // (browser vs Electron) don't fight over it. On desktop "active" = focused.
      // BUT on touch devices `document.hasFocus()` is unreliable — iOS PWAs
      // frequently report false even while in the foreground — so the mobile
      // client never resized the shared PTY: it stayed sized for some other
      // (desktop) client and the mobile xterm rendered the TUI with a big band
      // of empty rows below it (the "spazio sotto" on the phone). A VISIBLE
      // touch client therefore counts as active too.
      const active = document.hasFocus() || (isTouchDevice && document.visibilityState === 'visible');
      if (!active) return;
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    });

    termRef.current = { term, fit: fitAddon, ws: initialWs };

    return () => {
      intentionalClose = true;
      clearTimeout(retryTimer);
      reconnectRef.current = null;
      detachTouchScroll();
      el.removeEventListener('paste', handleImagePaste as unknown as EventListener, true);
      termRef.current?.ws.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lossless recovery — see the "Lossless reattach" note up top. Keep the
  // session-presence ref current for the connection effect's close handler,
  // and when a pane that already went stale finds its session back in the
  // authoritative list (reconcile completed, server returned, dormant session
  // revived), clear the overlay and reconnect. Keyed on `sessionListed` only
  // so it never disturbs the xterm mount effect.
  useEffect(() => {
    sessionListedRef.current = sessionListed;
    if (sessionListed && staleRef.current) {
      setStale(false);
      reconnectRef.current?.();
    }
  }, [sessionListed]);

  // Resize observer. A divider drag resizes this pane's container on every
  // animation frame; fitting xterm per frame resizes its canvas layers and
  // repaints the whole grid each time — a continuous flicker for the length of
  // the drag (the demo's "le finestre flashano"). useGridResize brackets a real
  // drag with 'topics:pane-resize-start' / '-end', so coalesce: hold the fits
  // while a drag is live and run exactly one fit when it ends, at the settled
  // geometry. Non-drag size changes (sidebar toggle, window resize) still fit
  // immediately.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // REF-COUNT, not a bare boolean: pane-resize (divider drag) and sidebar-resize
    // (collapse/expand) are INDEPENDENT brackets that can overlap. A bare flag let a
    // sidebar-resize-end clear `resizing` mid divider-drag → per-frame fit thrash for
    // the rest of the drag. Count concurrent brackets; only resume fits at depth 0.
    // Mirrors NativeBrowserPlaceholder's drag ref-count.
    let resizeDepth = 0;
    let missed = false;
    const fit = () => { if (termRef.current) { try { termRef.current.fit.fit(); } catch {} } };
    // Stagger fits ONE PER FRAME (staggeredFit): N terminals fitting in one tick thrash
    // layout (each fit reads layout after the previous wrote → full reflow per fit →
    // ~570ms for 8 on a sidebar reclaim). Spreading lets layout settle between fits so
    // each is cheap, and the app stays interactive. Dedupes per terminal.
    const handleResize = () => { if (resizeDepth > 0) { missed = true; return; } enqueueFit(fit); };
    const onResizeStart = () => { resizeDepth += 1; };
    const onResizeEnd = () => {
      resizeDepth = Math.max(0, resizeDepth - 1);
      if (resizeDepth === 0 && missed) { missed = false; enqueueFit(fit); }
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(el);
    // Coalesce fits during BOTH a divider drag (pane-resize-*) and a sidebar
    // collapse/expand (sidebar-resize-*): per-frame fit() over a 200ms slide forces a
    // layout + row-DOM rebuild each frame (~190-300ms jank for ~6 terminals → measured).
    // Holding the fits and running one at the settled size drops that to a single ~84ms
    // re-fit. See useSidebarFitCoalesce for the sidebar dispatcher.
    window.addEventListener('topics:pane-resize-start', onResizeStart);
    window.addEventListener('topics:pane-resize-end', onResizeEnd);
    window.addEventListener('topics:sidebar-resize-start', onResizeStart);
    window.addEventListener('topics:sidebar-resize-end', onResizeEnd);
    return () => {
      observer.disconnect();
      cancelFit(fit); // drop any queued fit so we never call into a disposed terminal
      window.removeEventListener('topics:pane-resize-start', onResizeStart);
      window.removeEventListener('topics:pane-resize-end', onResizeEnd);
      window.removeEventListener('topics:sidebar-resize-start', onResizeStart);
      window.removeEventListener('topics:sidebar-resize-end', onResizeEnd);
    };
  }, []);

  // When window gains focus, re-fit and force-send dimensions to server.
  // Another window may have resized the shared PTY while this one was in background.
  // fit() alone won't help if this window's size hasn't changed (xterm skips onResize
  // when cols/rows are unchanged), so we force-send the current size.
  useEffect(() => {
    const handleFocus = () => {
      const ref = termRef.current;
      if (!ref) return;
      try { ref.fit.fit(); } catch {}
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: ref.term.cols, rows: ref.term.rows }),
      }).catch(() => {});
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [sessionId]);

  // When this pane becomes the ACTIVE/visible tab, re-fit and force-send the
  // current size to the shared PTY. Switching tabs inside an already-focused
  // window fires NEITHER `window.focus` (the window never lost focus) NOR
  // `document.visibilitychange` (the document stayed visible), and the
  // ResizeObserver is a no-op when the container size didn't change — so if the
  // shared PTY was resized by another tab/window/client while this tab was
  // `display:none`, a full-screen TUI like Claude Code stays drawn at that stale
  // geometry (clipped / overflowing) until you manually resize the window. This
  // is the "ogni tanto si perde la finestra e devo resizarla" bug. Force-sending
  // the size triggers a SIGWINCH → the TUI repaints at the right size, and
  // `refresh()` repaints xterm's own viewport immediately. The rAF lets the
  // just-shown element settle its layout before `fit()` measures it.
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      const ref = termRef.current;
      if (!ref) return;
      try { ref.fit.fit(); } catch {}
      try { ref.term.refresh(0, ref.term.rows - 1); } catch {}
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: ref.term.cols, rows: ref.term.rows }),
      }).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, sessionId]);

  // Touch devices: when the PWA returns to the foreground, re-fit and force-send
  // dimensions. `document.hasFocus()` can't be relied on here (see onResize), so
  // visibility is the trigger that the user is actually looking at this terminal.
  useEffect(() => {
    if (!isTouchDevice) return;
    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ref = termRef.current;
      if (!ref) return;
      try { ref.fit.fit(); } catch {}
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: ref.term.cols, rows: ref.term.rows }),
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', handleVisible);
    return () => document.removeEventListener('visibilitychange', handleVisible);
  }, [sessionId]);

  const handleCopyOutput = () => {
    const term = termRef.current?.term;
    if (!term) return;
    // Copy selection if any, otherwise copy last 200 lines of scrollback
    const text = term.hasSelection()
      ? term.getSelection()
      : (() => {
          const buf = term.buffer.active;
          const lines: string[] = [];
          const start = Math.max(0, buf.length - 200);
          for (let i = start; i < buf.length; i++) {
            lines.push(buf.getLine(i)?.translateToString(true) ?? '');
          }
          return lines.join('\n').trimEnd();
        })();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const sendToTerminal = (data: string) => {
    const ws = termRef.current?.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  return (
    <div data-testid="single-terminal-pane" className="flex-1 min-h-0 flex flex-col">
      {/* Virtual key toolbar — touch devices only */}
      {isTouchDevice && !stale && (
        <div className="flex-shrink-0 flex items-center gap-1 px-2 py-[5px] bg-[#111] border-b border-white/10 overflow-x-auto select-none">
          {TOUCH_KEYS.map(({ label, data, wide }) => (
            <button
              key={label}
              onPointerDown={(e) => { e.preventDefault(); sendToTerminal(data); }}
              className={`flex-shrink-0 px-2 py-[3px] rounded bg-white/10 text-white text-[11px] font-mono active:bg-white/30 transition-colors ${wide ? 'px-3' : ''}`}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={handleCopyOutput}
            className="flex-shrink-0 flex items-center gap-1 px-2 py-[3px] rounded bg-white/10 text-white text-[11px] active:bg-white/30 transition-colors"
            title="Copy output"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      )}

      {/* Terminal area — chrome-glass matches the project sidebar's frosted
          vibrancy under Electron (xterm bg is transparent so it shows through);
          inline bg is the opaque web fallback + covers any sub-cell edge gap. */}
      <div
        className="flex-1 min-h-0 relative overflow-hidden chrome-glass"
        style={{ backgroundColor: isDarkRef.current ? DARK_THEME.background : LIGHT_THEME.background }}
      >
        <div
          ref={containerRef}
          className="absolute inset-0"
          onClick={() => termRef.current?.term.focus()}
        />
        {/* Apple-Intelligence "working" glow — a thin rotating ring hugging this
            pane's edge while the Claude Code session works. Same CSS + perf
            model as ChatPanel (transform-only, masked to a ~1.5px ring,
            pointer-events:none, z-30, border-radius inherit). Absolutely
            positioned over the xterm container, so it never touches xterm's
            layout or fit. Rendered only when working → zero idle cost. */}
        {showWorkingRing && <>
          <div className="chat-working-halo" aria-hidden="true" />
          <div className="chat-working-ring" aria-hidden="true" />
        </>}
        {/* Copy button for non-touch */}
        {!isTouchDevice && !stale && (
          <button
            onClick={handleCopyOutput}
            // backdrop-blur ONLY on hover: the button is opacity-0 at rest, but a
            // base `backdrop-blur` would still create a persistent blur(8px)
            // compositor layer that the GPU re-samples every frame — and these
            // tile across every visible terminal (9 invisible blurs = a big chunk
            // of GPU compositing, measured via CDP trace). Gating it to hover keeps
            // the exact glass look when shown and drops the idle GPU cost to zero.
            className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-md bg-black/40 text-white text-[11px] opacity-0 hover:opacity-100 hover:backdrop-blur-sm transition-opacity"
            title="Copy output"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        )}
        {stale && (
          <div data-testid="terminal-stale-overlay" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/80 z-10 px-4">
            <div className="flex items-center gap-1.5 text-app-text-muted text-[12px]">
              <Clock size={13} />
              <span>Sessione scaduta</span>
            </div>
            {(() => {
              const info = lastInfoRef.current;
              return (
                <div
                  data-testid="terminal-stale-info"
                  className="flex max-w-full flex-col items-center gap-0.5 break-all text-center font-mono text-[10px] leading-relaxed text-app-text-muted/70"
                >
                  {info?.type && (
                    <span>{info.type}{info.cwd ? ` · ${info.cwd}` : ''}</span>
                  )}
                  <span>id {sessionId.slice(0, 8)}{info?.claudeSessionId ? ` · resume ${info.claudeSessionId.slice(0, 8)}` : ''}</span>
                </div>
              );
            })()}
            {/* Self-service recovery: the same in-place reload as the tab's
                "Ricarica" menu item — for claude/codex this resumes the
                conversation (--resume), so the session isn't a dead-end. */}
            <button
              type="button"
              disabled={reloading}
              onClick={() => {
                signalsActions.markTerminalReloading(sessionId);
                window.setTimeout(() => signalsActions.clearTerminalReloading(sessionId), 15000);
                void fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/reload`, { method: 'POST' }).catch(() => {});
              }}
              title="Riavvia la sessione in-place (riprende la conversazione per claude/codex)"
              className="flex items-center gap-1.5 rounded-md bg-black/40 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-black/55 disabled:opacity-50"
            >
              <RotateCw size={13} className={reloading ? 'animate-spin' : ''} />
              <span>{reloading ? 'Riavvio…' : 'Ricarica'}</span>
            </button>
          </div>
        )}
        {/* "Ricarica" restart in progress — a clear overlay instead of the bare
            grey gap while the PTY is killed and re-spawned (claude/codex --resume
            boot). Cleared on WS reconnect (ws.onopen) or a safety timeout. */}
        {reloading && !stale && (
          <div data-testid="terminal-reloading-overlay" className="absolute inset-0 flex items-center justify-center bg-surface/80 z-20">
            <div className="flex items-center gap-2 text-app-text-muted text-[12px]">
              <RotateCw size={14} className="animate-spin" />
              <span>Riavvio sessione…</span>
            </div>
          </div>
        )}
        {/* "Ricarica" restart in progress — a clear overlay instead of the bare
            grey gap while the PTY is killed and re-spawned (claude/codex --resume
            boot). Cleared on WS reconnect (ws.onopen) or a safety timeout. */}
        {reloading && !stale && (
          <div data-testid="terminal-reloading-overlay" className="absolute inset-0 flex items-center justify-center bg-surface/80 z-20">
            <div className="flex items-center gap-2 text-app-text-muted text-[12px]">
              <RotateCw size={14} className="animate-spin" />
              <span>Riavvio sessione…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

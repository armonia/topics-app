import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Copy, Check } from 'lucide-react';
import { attachTerminalTouchScroll } from './touchScroll';
import { registerWrappedLinkProvider, openLinkExternally } from './wrappedLinkProvider';
import { signalsActions, useTerminalFinished } from '../../state/signals';

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

  // Viewing a claude-code session = its "finished a turn" notification is seen,
  // so clear it. Depending on `finished` (not just isActive) is what makes this
  // false-positive-proof: if the session finishes *while you're already looking
  // at it* (isActive stays true, so an [isActive,sessionId] effect would never
  // re-run), the badge would otherwise pop on a pane you're staring at. This
  // also kills the "I paused mid-typing" false finish — composing in an active
  // pane keeps it cleared.
  const finished = useTerminalFinished(sessionId);
  useEffect(() => {
    if (isActive && finished) signalsActions.clearTerminalFinished(sessionId);
  }, [isActive, finished, sessionId]);
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
      // xterm.js v6: default renderer is DOM (real DOM nodes → native iOS text selection)
      // Canvas/WebGL renderer would be loaded via addon — we intentionally don't load it
      // so mobile gets native selectable text out of the box.
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
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
    const MAX_RETRIES = 15;
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
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);
      ws.binaryType = 'arraybuffer';

      // Update ref so onData/paste always use the current WS
      if (termRef.current) {
        termRef.current.ws = ws;
      }

      ws.onopen = () => {
        retryCount = 0;
        setStale(false);
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
        if (event.code === 1008) {
          term.write('\r\n\x1b[90m[Session expired - close and reopen terminal]\x1b[0m\r\n');
          setStale(true);
          onStale?.();
        } else if (event.code === 1000) {
          term.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
        } else {
          // Unexpected disconnect — auto-reconnect
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = Math.min(500 * retryCount, 3000);
            retryTimer = setTimeout(connectWs, delay);
          } else {
            term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
            setStale(true);
            onStale?.();
          }
        }
      };

      return ws;
    }

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
      detachTouchScroll();
      el.removeEventListener('paste', handleImagePaste as unknown as EventListener, true);
      termRef.current?.ws.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleResize = () => {
      if (termRef.current) {
        try { termRef.current.fit.fit(); } catch {}
      }
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(el);
    return () => observer.disconnect();
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
        {/* Copy button for non-touch */}
        {!isTouchDevice && !stale && (
          <button
            onClick={handleCopyOutput}
            className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-md bg-black/40 text-white text-[11px] backdrop-blur-sm opacity-0 hover:opacity-100 transition-opacity"
            title="Copy output"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        )}
        {stale && (
          <div data-testid="terminal-stale-overlay" className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
            <div className="text-center">
              <p className="text-app-text-muted text-[12px] mb-3">This terminal session has expired</p>
              <p className="text-app-text-muted text-[11px]">Close this tab and open a new terminal</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Copy, Check } from 'lucide-react';

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

const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

const DARK_THEME = {
  background: '#1a1a1a',
  foreground: '#d4d4d8',
  cursor: '#a1a1aa',
  cursorAccent: '#1a1a1a',
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
  return isDark ? DARK_THEME : LIGHT_THEME;
}

interface SingleTerminalPaneProps {
  sessionId: string;
  onStale?: () => void;
}

export function SingleTerminalPane({ sessionId, onStale }: SingleTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; ws: WebSocket } | null>(null);
  const [stale, setStale] = useState(false);
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
      // @ts-expect-error copyOnSelect exists at runtime but missing from v6 types
      copyOnSelect: true,
      // xterm.js v6: default renderer is DOM (real DOM nodes → native iOS text selection)
      // Canvas/WebGL renderer would be loaded via addon — we intentionally don't load it
      // so mobile gets native selectable text out of the box.
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

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

    const doFit = () => { try { fitAddon.fit(); } catch {} };
    setTimeout(doFit, 50);
    setTimeout(doFit, 200);
    setTimeout(doFit, 500);
    setTimeout(() => { doFit(); term.focus(); }, 600);

    let retryCount = 0;
    const MAX_RETRIES = 15;
    let retryTimer: ReturnType<typeof setTimeout>;

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
        fetch(`/api/terminal/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => {});
      };

      ws.onmessage = (ev) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          term.write(new Uint8Array(data));
        } else {
          term.write(data);
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

      {/* Terminal area */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div
          ref={containerRef}
          className="absolute inset-0 p-1"
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

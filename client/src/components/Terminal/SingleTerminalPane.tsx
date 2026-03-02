import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

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
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    const doFit = () => { try { fitAddon.fit(); } catch {} };
    setTimeout(doFit, 50);
    setTimeout(doFit, 200);
    setTimeout(doFit, 500);
    setTimeout(() => { doFit(); term.focus(); }, 600);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
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
      if (intentionalClose) return; // Cleanup-triggered close, ignore
      if (event.code === 1008) {
        term.write('\r\n\x1b[90m[Session expired - close and reopen terminal]\x1b[0m\r\n');
        setStale(true);
        onStale?.();
      } else if (event.code === 1000) {
        term.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
      } else {
        term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
        setStale(true);
        onStale?.();
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
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

    termRef.current = { term, fit: fitAddon, ws };

    return () => {
      intentionalClose = true;
      ws.close();
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

  return (
    <div className="flex-1 min-h-0 relative">
      <div
        ref={containerRef}
        className="absolute inset-0 p-1"
        onClick={() => termRef.current?.term.focus()}
      />
      {stale && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
          <div className="text-center">
            <p className="text-app-text-muted text-[12px] mb-3">This terminal session has expired</p>
            <p className="text-app-text-muted text-[11px]">Close this tab and open a new terminal</p>
          </div>
        </div>
      )}
    </div>
  );
}

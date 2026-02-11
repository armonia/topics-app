import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, TerminalSquare, RefreshCw } from 'lucide-react';

interface TerminalTab {
  id: string;
  label: string;
  stale?: boolean; // Session no longer exists on server
}

interface TerminalPanelProps {
  projectPath?: string;
}

const THEME = {
  background: '#0c0c12',
  foreground: '#d4d4d8',
  cursor: '#a1a1aa',
  cursorAccent: '#0c0c12',
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

export function TerminalPanel({ projectPath }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const terminalsRef = useRef<Map<string, { term: Terminal; fit: FitAddon; ws: WebSocket }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const createTerminal = useCallback(async () => {
    try {
      const res = await fetch('/api/terminal/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath || undefined }),
      });
      const data = await res.json();
      const id = data.id;

      const tab: TerminalTab = { id, label: `Terminal ${tabs.length + 1}` };
      setTabs(prev => [...prev, tab]);
      setActiveTabId(id);

      // Defer terminal creation to next tick so the container is visible
      setTimeout(() => mountTerminal(id), 0);
    } catch (err) {
      console.error('Failed to create terminal:', err);
    }
  }, [projectPath, tabs.length]);

  const mountTerminal = useCallback((id: string) => {
    if (terminalsRef.current.has(id)) return;
    const el = document.getElementById(`terminal-${id}`);
    if (!el) return;

    const term = new Terminal({
      theme: THEME,
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

    // Small delay to let the DOM settle before fitting
    setTimeout(() => {
      try { fitAddon.fit(); } catch {}
    }, 50);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${id}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Send initial size
      fetch(`/api/terminal/${id}/resize`, {
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
      // Code 1008 = Policy Violation (session not found on server)
      if (event.code === 1008) {
        term.write('\r\n\x1b[90m[Session expired - click refresh to start a new terminal]\x1b[0m\r\n');
        // Mark tab as stale
        setTabs(prev => prev.map(t => t.id === id ? { ...t, stale: true } : t));
      } else {
        term.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      fetch(`/api/terminal/${id}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    });

    terminalsRef.current.set(id, { term, fit: fitAddon, ws });
  }, []);

  const closeTerminal = useCallback(async (id: string) => {
    const entry = terminalsRef.current.get(id);
    if (entry) {
      entry.ws.close();
      entry.term.dispose();
      terminalsRef.current.delete(id);
    }
    fetch(`/api/terminal/${id}`, { method: 'DELETE' }).catch(() => {});
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeTabId]);

  // Replace a stale terminal with a new one
  const replaceStaleTerminal = useCallback(async (oldId: string) => {
    // Close the old terminal
    const entry = terminalsRef.current.get(oldId);
    if (entry) {
      entry.ws.close();
      entry.term.dispose();
      terminalsRef.current.delete(oldId);
    }

    // Create a new session
    try {
      const res = await fetch('/api/terminal/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath || undefined }),
      });
      const data = await res.json();
      const newId = data.id;

      // Replace the tab in-place to preserve position
      setTabs(prev => prev.map(t => t.id === oldId
        ? { id: newId, label: t.label, stale: false }
        : t
      ));
      setActiveTabId(newId);

      // Mount the new terminal
      setTimeout(() => mountTerminal(newId), 0);
    } catch (err) {
      console.error('Failed to replace terminal:', err);
    }
  }, [projectPath, mountTerminal]);

  // Auto-create first terminal
  useEffect(() => {
    if (tabs.length === 0) createTerminal();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fit on resize
  useEffect(() => {
    const handleResize = () => {
      if (activeTabId) {
        const entry = terminalsRef.current.get(activeTabId);
        if (entry) {
          try { entry.fit.fit(); } catch {}
        }
      }
    };
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [activeTabId]);

  // Fit when switching tabs
  useEffect(() => {
    if (activeTabId) {
      const entry = terminalsRef.current.get(activeTabId);
      if (entry) {
        setTimeout(() => {
          try { entry.fit.fit(); entry.term.focus(); } catch {}
        }, 50);
      }
    }
  }, [activeTabId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const [id, entry] of terminalsRef.current) {
        entry.ws.close();
        entry.term.dispose();
        fetch(`/api/terminal/${id}`, { method: 'DELETE' }).catch(() => {});
      }
      terminalsRef.current.clear();
    };
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="flex flex-col h-full bg-[#0c0c12]" ref={containerRef}>
      {/* Tab bar */}
      <div className="flex items-center bg-[#111118] border-b border-[#1e1e2e] flex-shrink-0 min-h-[32px]">
        <div className="flex items-center flex-1 overflow-x-auto scrollbar-none">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] cursor-pointer select-none border-r border-[#1e1e2e] transition-colors ${
                activeTabId === tab.id
                  ? 'bg-[#0c0c12] text-[#d4d4d8]'
                  : 'text-[#71717a] hover:text-[#a1a1aa] hover:bg-[#16161e]'
              } ${tab.stale ? 'opacity-60' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <TerminalSquare size={11} className={tab.stale ? 'text-yellow-500' : ''} />
              <span>{tab.label}</span>
              {tab.stale && (
                <button
                  onClick={(e) => { e.stopPropagation(); replaceStaleTerminal(tab.id); }}
                  className="ml-0.5 w-4 h-4 flex items-center justify-center rounded hover:bg-white/10 text-yellow-500 hover:text-yellow-400"
                  title="Session expired - click to restart"
                >
                  <RefreshCw size={9} />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-white/10 text-[#71717a] hover:text-[#d4d4d8]"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={createTerminal}
          className="w-7 h-7 flex items-center justify-center text-[#71717a] hover:text-[#d4d4d8] hover:bg-white/5 transition-colors flex-shrink-0"
          title="New terminal"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal containers */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map(tab => (
          <div
            key={tab.id}
            id={`terminal-${tab.id}`}
            className="absolute inset-0 p-1"
            style={{ display: activeTabId === tab.id ? 'block' : 'none' }}
          />
        ))}
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-[#52525b] text-[12px]">
            No terminals open
          </div>
        )}
        {/* Show refresh prompt for stale active tab */}
        {activeTab?.stale && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0c0c12]/80 z-10">
            <div className="text-center">
              <p className="text-[#71717a] text-[12px] mb-3">This terminal session has expired</p>
              <button
                onClick={() => replaceStaleTerminal(activeTab.id)}
                className="px-4 py-2 bg-[#3f3f46] hover:bg-[#52525b] text-[#d4d4d8] text-[12px] rounded-md flex items-center gap-2 mx-auto transition-colors"
              >
                <RefreshCw size={12} />
                Start New Session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

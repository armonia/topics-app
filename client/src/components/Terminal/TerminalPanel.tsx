import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, TerminalSquare, RefreshCw, Link, Loader2 } from 'lucide-react';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { DropdownPortal } from '../Shared/DropdownPortal';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';

interface TerminalTab {
  id: string;
  label: string;
  stale?: boolean;
  type: 'shell' | 'claude-code';
}

interface RemoteSession {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  clients: number;
  topicId?: string;
  type: 'shell' | 'claude-code';
}

interface TerminalPanelProps {
  projectPath?: string;
  topicId?: string;
  initialType?: 'shell' | 'claude-code';
}

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

export function TerminalPanel({ projectPath, topicId, initialType }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [remoteSessions, setRemoteSessions] = useState<RemoteSession[]>([]);
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const [isCreating, setIsCreating] = useState(false);
  const isDarkRef = useRef(isDark);
  const terminalsRef = useRef<Map<string, { term: Terminal; fit: FitAddon; ws: WebSocket }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const newMenuBtnRef = useRef<HTMLButtonElement>(null);
  const sessionPickerRef = useRef<HTMLDivElement>(null);
  const initialLoadDone = useRef(false);
  const shellCounterRef = useRef(0);
  const connectedIdsRef = useRef(new Set<string>());
  const closingIdsRef = useRef(new Set<string>());
  const fitTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => { isDarkRef.current = isDark; }, [isDark]);

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const theme = getTerminalTheme(isDark);
    for (const [, entry] of terminalsRef.current) {
      entry.term.options.theme = { ...theme };
    }
  }, [isDark]);

  // Close session picker on outside click
  useEffect(() => {
    if (!showSessionPicker) return;
    const h = (e: MouseEvent) => {
      if (sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) setShowSessionPicker(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showSessionPicker]);

  const mountTerminal = useCallback((id: string): boolean => {
    if (terminalsRef.current.has(id)) return true;
    const el = document.getElementById(`terminal-${id}`);
    if (!el) return false;

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
    const t1 = setTimeout(doFit, 50);
    const t2 = setTimeout(doFit, 200);
    const t3 = setTimeout(doFit, 500);
    const t4 = setTimeout(() => { doFit(); term.focus(); }, 600);
    fitTimersRef.current.push(t1, t2, t3, t4);

    let retryCount = 0;
    const MAX_RETRIES = 15;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connectWs() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${id}`);
      ws.binaryType = 'arraybuffer';

      // Update ref so onData always uses the current WS
      const entry = terminalsRef.current.get(id);
      if (entry) entry.ws = ws;

      ws.onopen = () => {
        retryCount = 0;
        setTabs(prev => prev.map(t => t.id === id ? { ...t, stale: false } : t));
        fetch(`/api/terminal/sessions/${id}/resize`, {
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
        if (closingIdsRef.current.has(id)) return;
        if (event.code === 1008) {
          term.write('\r\n\x1b[90m[Session expired - click refresh to start a new terminal]\x1b[0m\r\n');
          setTabs(prev => prev.map(t => t.id === id ? { ...t, stale: true } : t));
        } else if (event.code === 1000) {
          term.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n');
        } else {
          // Unexpected disconnect — auto-reconnect
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = Math.min(500 * retryCount, 3000);
            retryTimer = setTimeout(connectWs, delay);
          } else {
            term.write('\r\n\x1b[90m[Disconnected - click refresh to reconnect]\x1b[0m\r\n');
            setTabs(prev => prev.map(t => t.id === id ? { ...t, stale: true } : t));
          }
        }
      };

      return ws;
    }

    const ws = connectWs();

    term.onData((data) => {
      const entry = terminalsRef.current.get(id);
      if (entry && entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      fetch(`/api/terminal/sessions/${id}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    });

    terminalsRef.current.set(id, { term, fit: fitAddon, ws });
    return true;
  }, []);

  const connectToSession = useCallback((id: string, label: string, type: 'shell' | 'claude-code' = 'shell') => {
    if (connectedIdsRef.current.has(id)) {
      setActiveTabId(id);
      return;
    }

    connectedIdsRef.current.add(id);
    const tab: TerminalTab = { id, label, type };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(id);

    setTimeout(() => {
      if (!mountTerminal(id)) {
        setTimeout(() => {
          if (!mountTerminal(id)) {
            setTimeout(() => mountTerminal(id), 200);
          }
        }, 100);
      }
    }, 0);
  }, [mountTerminal]);

  const getTerminalDimensions = useCallback(() => {
    const container = containerRef.current;
    const cols = container ? Math.floor((container.clientWidth - 10) / 7.8) : 120;
    const rows = container ? Math.floor((container.clientHeight - 40) / 17) : 30;
    return { cols, rows };
  }, []);

  const createTerminal = useCallback(async (type: 'shell' | 'claude-code' = 'shell') => {
    setError(null);
    setShowNewMenu(false);
    setIsCreating(true);
    try {
      const { cols, rows } = getTerminalDimensions();
      const name = type === 'claude-code' ? 'Claude Code' : `Shell ${(shellCounterRef.current += 1)}`;
      const body: Record<string, unknown> = { cwd: projectPath || undefined, cols, rows, topicId, type, name };
      if (type === 'claude-code') body.skipPermissions = claudeSkipPermissions;
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.statusText}`);
      const data = await res.json();
      connectToSession(data.id, data.name || name, type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Failed to create terminal:', err);
      setError(`Failed to create terminal: ${msg}`);
    } finally {
      setIsCreating(false);
    }
  }, [projectPath, topicId, connectToSession, getTerminalDimensions, claudeSkipPermissions]);

  const closeTerminal = useCallback(async (id: string) => {
    closingIdsRef.current.add(id);
    const entry = terminalsRef.current.get(id);
    if (entry) {
      entry.ws.close();
      entry.term.dispose();
      terminalsRef.current.delete(id);
    }
    connectedIdsRef.current.delete(id);
    fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeTabId]);

  const replaceStaleTerminal = useCallback(async (oldId: string) => {
    closingIdsRef.current.add(oldId);
    const oldTab = tabs.find(t => t.id === oldId);
    const type = oldTab?.type || 'shell';
    const entry = terminalsRef.current.get(oldId);
    if (entry) {
      entry.ws.close();
      entry.term.dispose();
      terminalsRef.current.delete(oldId);
    }

    try {
      const { cols, rows } = getTerminalDimensions();
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath || undefined, topicId, type, cols, rows }),
      });
      const data = await res.json();
      const newId = data.id;

      setTabs(prev => prev.map(t => t.id === oldId
        ? { id: newId, label: data.name || t.label, stale: false, type }
        : t
      ));
      setActiveTabId(newId);
      setTimeout(() => mountTerminal(newId), 0);
    } catch (err) {
      console.error('Failed to replace terminal:', err);
    }
  }, [projectPath, topicId, tabs, mountTerminal, getTerminalDimensions]);

  const fetchRemoteSessions = useCallback(async () => {
    try {
      const params = topicId ? `?topicId=${topicId}` : '';
      const res = await fetch(`/api/terminal/sessions${params}`);
      const data = await res.json();
      setRemoteSessions(data);
    } catch {}
  }, [topicId]);

  const handleShowSessionPicker = useCallback(() => {
    fetchRemoteSessions();
    setShowSessionPicker(true);
  }, [fetchRemoteSessions]);

  // On mount: reconnect to existing sessions, auto-create if initialType set, or show choice screen
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const params = topicId ? `?topicId=${topicId}` : '';
    fetch(`/api/terminal/sessions${params}`)
      .then(r => r.json())
      .then((sessions: RemoteSession[]) => {
        if (sessions.length > 0) {
          // Seed shell counter from existing sessions to avoid duplicate names
          for (const s of sessions) {
            if (s.type === 'shell' || !s.type) {
              const match = s.name.match(/^Shell (\d+)$/);
              if (match) {
                shellCounterRef.current = Math.max(shellCounterRef.current, parseInt(match[1], 10));
              }
            }
          }
          // Reconnect to all existing sessions
          for (const s of sessions) {
            connectToSession(s.id, s.name, s.type || 'shell');
          }
        } else if (initialType) {
          // Auto-create terminal of the requested type — skip the choice screen
          createTerminal(initialType);
        }
        // If no sessions and no initialType, show empty state (user picks Shell or Claude Code)
      })
      .catch(() => {});
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
        const doFit = () => { try { entry.fit.fit(); } catch {} };
        const t1 = setTimeout(() => { doFit(); entry.term.focus(); }, 50);
        const t2 = setTimeout(doFit, 200);
        const t3 = setTimeout(doFit, 500);
        return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
      }
    }
  }, [activeTabId]);

  // Cleanup on unmount — only close WS, don't kill sessions
  useEffect(() => {
    return () => {
      for (const t of fitTimersRef.current) clearTimeout(t);
      fitTimersRef.current = [];
      for (const [id, entry] of terminalsRef.current) {
        closingIdsRef.current.add(id);
        entry.ws.close();
        entry.term.dispose();
      }
      terminalsRef.current.clear();
    };
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Empty state — no terminals yet, show choice screen
  if (tabs.length === 0 && !error) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-surface overflow-hidden gap-4" ref={containerRef}>
        <div className="text-app-text-muted text-[13px] mb-2">Open a terminal</div>
        <div className="flex gap-3">
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => createTerminal('claude-code')}
              disabled={isCreating}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#D97757] hover:bg-[#C4684A] disabled:opacity-50 disabled:cursor-not-allowed text-white text-[13px] font-medium rounded-lg transition-colors shadow-sm"
            >
              {isCreating ? <Loader2 size={16} className="animate-spin" /> : <ClaudeIcon size={16} />}
              Claude Code
            </button>
            <label className="flex items-center gap-1.5 text-[11px] text-app-text-muted cursor-pointer select-none">
              <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
              <span>yolo mode</span>
            </label>
          </div>
          <button
            onClick={() => createTerminal('shell')}
            disabled={isCreating}
            className="flex items-center gap-2 px-4 py-2.5 bg-app-hover hover:bg-app-hover/80 disabled:opacity-50 disabled:cursor-not-allowed text-app-text text-[13px] font-medium rounded-lg transition-colors border border-app-border"
          >
            {isCreating ? <Loader2 size={16} className="animate-spin" /> : <TerminalSquare size={16} />}
            Shell
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden" ref={containerRef}>
      {/* Tab bar */}
      {tabs.length >= 1 && (
        <div className="flex items-center bg-app-hover dark:bg-app-panel border-b border-app-border flex-shrink-0 min-h-[32px]">
          <div className="flex items-center flex-1 overflow-x-auto scrollbar-none">
            {tabs.map(tab => (
              <div
                key={tab.id}
                className={`flex items-center gap-1 px-2.5 py-1 text-[11px] cursor-pointer select-none border-r border-app-border transition-colors ${
                  activeTabId === tab.id
                    ? 'bg-surface text-app-text'
                    : 'text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover'
                } ${tab.stale ? 'opacity-60' : ''}`}
                onClick={() => setActiveTabId(tab.id)}
              >
                {tab.type === 'claude-code' ? (
                  <ClaudeIcon size={12} className={`${tab.stale ? 'text-yellow-500' : 'text-[#D97757]'}`} />
                ) : (
                  <TerminalSquare size={12} className={tab.stale ? 'text-yellow-500' : ''} />
                )}
                <span>{tab.label}</span>
                {tab.stale && (
                  <button
                    onClick={(e) => { e.stopPropagation(); replaceStaleTerminal(tab.id); }}
                    className="ml-0.5 w-4 h-4 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-yellow-500 hover:text-yellow-400"
                    title="Session expired - click to restart"
                  >
                    <RefreshCw size={10} />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }}
                  className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-muted hover:text-app-text"
                  title="Kill session"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
          <div className="relative" ref={sessionPickerRef}>
            <button
              onClick={handleShowSessionPicker}
              className="w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
              title="Connect to existing session"
            >
              <Link size={14} />
            </button>
            {showSessionPicker && (
              <div className="absolute top-full right-0 mt-1 z-50 bg-surface border border-app-border rounded-lg shadow-lg min-w-[280px] max-h-[300px] overflow-y-auto">
                <div className="p-2 border-b border-app-border flex items-center justify-between">
                  <span className="text-[11px] font-medium text-app-text-muted">Active Sessions</span>
                  <button onClick={() => setShowSessionPicker(false)} className="text-app-text-muted hover:text-app-text">
                    <X size={12} />
                  </button>
                </div>
                {remoteSessions.length === 0 ? (
                  <div className="p-3 text-[11px] text-app-text-muted text-center">No active sessions</div>
                ) : (
                  remoteSessions.map(s => (
                    <div
                      key={s.id}
                      className={`px-3 py-2 text-[11px] border-b border-app-border last:border-0 ${
                        connectedIdsRef.current.has(s.id) ? 'opacity-50' : 'hover:bg-app-hover cursor-pointer'
                      }`}
                      onClick={() => {
                        if (!connectedIdsRef.current.has(s.id)) {
                          connectToSession(s.id, s.name, s.type || 'shell');
                          setShowSessionPicker(false);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-app-text font-medium">
                          {s.type === 'claude-code' ? <ClaudeIcon size={12} className="text-[#D97757]" /> : <TerminalSquare size={12} />}
                          {s.name}
                        </span>
                        <span className="text-app-text-muted">{s.clients} client{s.clients !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="text-app-text-muted truncate mt-0.5">{s.cwd}</div>
                      {connectedIdsRef.current.has(s.id) && <div className="text-green-500 mt-0.5">Connected</div>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="relative">
            <button
              ref={newMenuBtnRef}
              onClick={() => setShowNewMenu(!showNewMenu)}
              className="w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
              title="New terminal"
            >
              <Plus size={14} />
            </button>
            <DropdownPortal open={showNewMenu} anchorRef={newMenuBtnRef} onClose={() => setShowNewMenu(false)}>
              <button
                onClick={() => createTerminal('claude-code')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
              >
                <ClaudeIcon size={14} className="text-[#D97757]" />
                <span className="flex-1 text-left">Claude Code</span>
                <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
                  <span>yolo</span>
                </label>
              </button>
              <button
                onClick={() => createTerminal('shell')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
              >
                <TerminalSquare size={14} />
                <span>Shell</span>
              </button>
            </DropdownPortal>
          </div>
        </div>
      )}

      {/* Terminal containers */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map(tab => (
          <div
            key={tab.id}
            id={`terminal-${tab.id}`}
            className="absolute inset-0 p-1"
            style={{ display: activeTabId === tab.id ? 'block' : 'none' }}
            onClick={() => {
              const entry = terminalsRef.current.get(tab.id);
              if (entry) entry.term.focus();
            }}
          />
        ))}
        {tabs.length === 0 && !error && (
          <div className="flex items-center justify-center h-full text-app-text-muted text-[12px]">
            No terminals open
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-red-400 text-[12px] mb-3">{error}</p>
              <button
                onClick={() => { setError(null); createTerminal(); }}
                className="px-4 py-2 bg-app-hover text-app-text text-[12px] rounded-md flex items-center gap-2 mx-auto transition-colors"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          </div>
        )}
        {activeTab?.stale && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
            <div className="text-center">
              <p className="text-app-text-muted text-[12px] mb-3">This terminal session has expired</p>
              <button
                onClick={() => replaceStaleTerminal(activeTab.id)}
                className="px-4 py-2 bg-app-hover text-app-text text-[12px] rounded-md flex items-center gap-2 mx-auto transition-colors"
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

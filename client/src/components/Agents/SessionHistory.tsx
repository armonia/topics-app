import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, ChevronLeft, ChevronRight, ArrowLeft, AlertCircle, Filter, MessageSquare, User, Bot, ExternalLink } from 'lucide-react';
import { agentProfilesApi, chatApi, type SessionHistoryItem, type AgentProfile } from '../../lib/api';
import type { HistoryMessage } from '../../types';
import type { AgentSession as LiveSession } from '../../hooks/useAgents';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'error', label: 'Error' },
  { value: 'stale', label: 'Stale' },
] as const;

const PAGE_SIZE = 30;

function statusDot(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-500 animate-pulse';
    case 'idle': return 'bg-yellow-500';
    case 'paused': return 'bg-yellow-500';
    case 'completed': return 'bg-blue-500';
    case 'error': return 'bg-red-500';
    case 'stale': return 'bg-gray-400';
    default: return 'bg-gray-400';
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-500/10 text-green-500';
    case 'idle': return 'bg-yellow-500/10 text-yellow-500';
    case 'paused': return 'bg-yellow-500/10 text-yellow-500';
    case 'completed': return 'bg-blue-500/10 text-blue-500';
    case 'error': return 'bg-red-500/10 text-red-500';
    default: return 'bg-app-hover text-app-text-muted';
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDuration(startedAt: string | number, completedAt: string | null): string {
  const start = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m`;
  return `${(diffMs / 3_600_000).toFixed(1)}h`;
}

function formatDate(ts: string | number): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

// Unified session type (works for both live and DB sessions)
export interface UnifiedSession {
  id: string;
  sessionKey: string;
  topicId: string | null;
  topicName: string | null;
  agentName: string | null;
  agentAvatar: string | null;
  agentRole: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  totalTokens: number;
  errorMessage: string | null;
  taskId: string | null;
  lastHeartbeat: string | null;
  isLive?: boolean;
}

function liveToUnified(s: LiveSession): UnifiedSession {
  return {
    id: s.key,
    sessionKey: s.key,
    topicId: s.topicId || null,
    topicName: s.topicName || null,
    agentName: s.displayName,
    agentAvatar: null,
    agentRole: null,
    status: s.status,
    startedAt: new Date(s.updatedAt).toISOString(),
    completedAt: null,
    totalTokens: s.totalTokens || 0,
    errorMessage: null,
    taskId: null,
    lastHeartbeat: null,
    isLive: true,
  };
}

function historyToUnified(s: SessionHistoryItem): UnifiedSession {
  return {
    id: s.id,
    sessionKey: s.sessionKey,
    topicId: s.topicId,
    topicName: s.topicName,
    agentName: s.agentName,
    agentAvatar: s.agentAvatar,
    agentRole: s.agentRole,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    totalTokens: s.totalTokens,
    errorMessage: s.errorMessage,
    taskId: s.taskId,
    lastHeartbeat: s.lastHeartbeat,
    isLive: false,
  };
}

// ─── Main Component ───────────────────────────────────────────

interface SessionHistoryProps {
  liveSessions?: LiveSession[];
  onNavigateToTopic?: (topicId: string) => void;
  onOpenSessionViewer?: (sessionKey: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export function SessionHistory({ liveSessions = [], onNavigateToTopic, onOpenSessionViewer, onMessage }: SessionHistoryProps) {
  const [selectedSession, setSelectedSession] = useState<UnifiedSession | null>(null);

  if (selectedSession) {
    return (
      <SessionDetail
        session={selectedSession}
        onBack={() => setSelectedSession(null)}
        onNavigateToTopic={onNavigateToTopic}
        onOpenInPane={onOpenSessionViewer}
        onMessage={onMessage}
      />
    );
  }

  return (
    <SessionList
      liveSessions={liveSessions}
      onSelect={setSelectedSession}
    />
  );
}

// ─── Session List ─────────────────────────────────────────────

function SessionList({ liveSessions, onSelect }: {
  liveSessions: LiveSession[];
  onSelect: (s: UnifiedSession) => void;
}) {
  const [historySessions, setHistorySessions] = useState<SessionHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [showFilters, setShowFilters] = useState(false);

  const [agents, setAgents] = useState<AgentProfile[]>([]);
  useEffect(() => {
    agentProfilesApi.list().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(0); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await agentProfilesApi.history({
        status: statusFilter || undefined,
        agentId: agentFilter || undefined,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setHistorySessions(data.sessions);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, agentFilter, search, page]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);
  useEffect(() => { setPage(0); }, [statusFilter, agentFilter]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasActiveFilters = !!(statusFilter || agentFilter || search);

  // Filter live sessions by search/status if filters are active
  const filteredLive = liveSessions.filter(s => {
    if (statusFilter && s.status !== statusFilter) return false;
    // Exclude if NEITHER displayName nor key matches search (correct: && means both must fail to exclude)
    if (search && !s.displayName.toLowerCase().includes(search.toLowerCase()) && !s.key.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-app-border/40 flex-shrink-0">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-app-text-muted" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search sessions..."
            className="w-full pl-6 pr-6 py-1 text-[11px] bg-transparent border border-app-border rounded focus:outline-none focus:border-primary text-app-text"
          />
          {searchInput && (
            <button onClick={() => setSearchInput('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-app-text-muted hover:text-app-text-secondary">
              <X size={10} />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`p-1 rounded transition-colors ${showFilters || hasActiveFilters ? 'text-primary bg-primary/10' : 'text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover'}`}
          title="Filters"
        >
          <Filter size={12} />
        </button>
        <span className="text-[10px] text-app-text-muted tabular-nums flex-shrink-0">
          {filteredLive.length > 0 ? `${filteredLive.length} live · ` : ''}{total}
        </span>
      </div>

      {showFilters && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-app-border/40 flex-shrink-0">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-[11px] bg-transparent border border-app-border rounded px-1.5 py-0.5 text-app-text focus:outline-none focus:border-primary">
            {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="text-[11px] bg-transparent border border-app-border rounded px-1.5 py-0.5 text-app-text focus:outline-none focus:border-primary min-w-0 max-w-[140px]">
            <option value="">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.avatarEmoji} {a.name}</option>)}
          </select>
          {hasActiveFilters && (
            <button onClick={() => { setStatusFilter(''); setAgentFilter(''); setSearchInput(''); }} className="text-[10px] text-app-text-muted hover:text-primary transition-colors">Clear</button>
          )}
        </div>
      )}

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-500 flex items-center gap-1.5 flex-shrink-0">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Live sessions */}
        {filteredLive.length > 0 && (
          <>
            <div className="px-2.5 pt-2 pb-1">
              <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">Live</span>
            </div>
            {filteredLive.map(s => (
              <SessionRow key={`live-${s.key}`} session={liveToUnified(s)} onSelect={onSelect} />
            ))}
          </>
        )}

        {/* History sessions */}
        {(historySessions.length > 0 || loading) && (
          <div className="px-2.5 pt-2 pb-1">
            <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">History</span>
          </div>
        )}
        {loading && historySessions.length === 0 ? (
          <div className="flex items-center justify-center py-6">
            <div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" />
          </div>
        ) : historySessions.length === 0 && filteredLive.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-app-text-muted">
            {hasActiveFilters ? 'No sessions match filters' : 'No sessions yet'}
          </div>
        ) : (
          historySessions.map(s => (
            <SessionRow key={`hist-${s.id}`} session={historyToUnified(s)} onSelect={onSelect} />
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-app-border/40 flex-shrink-0">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="p-1 rounded text-app-text-muted hover:text-app-text hover:bg-app-hover disabled:opacity-30 transition-colors">
            <ChevronLeft size={12} />
          </button>
          <span className="text-[10px] text-app-text-muted tabular-nums">{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="p-1 rounded text-app-text-muted hover:text-app-text hover:bg-app-hover disabled:opacity-30 transition-colors">
            <ChevronRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Session Row ──────────────────────────────────────────────

function SessionRow({ session, onSelect }: { session: UnifiedSession; onSelect: (s: UnifiedSession) => void }) {
  return (
    <button
      className="w-full flex items-start gap-2 px-2.5 py-2 hover:bg-app-hover/50 transition-colors text-left"
      onClick={() => onSelect(session)}
    >
      <div className="flex-shrink-0 pt-1">
        <div className={`w-2 h-2 rounded-full ${statusDot(session.status)}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {session.agentAvatar && <span className="text-[11px]">{session.agentAvatar}</span>}
          <span className="text-[11px] font-medium text-app-text truncate">
            {session.agentName || session.sessionKey}
          </span>
          <span className={`text-[9px] px-1 py-px rounded font-medium flex-shrink-0 ${statusBadge(session.status)}`}>
            {statusLabel(session.status)}
          </span>
          {session.isLive && (
            <span className="text-[9px] px-1 py-px rounded bg-green-500/10 text-green-500 font-medium flex-shrink-0">LIVE</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {session.topicName && (
            <span className="text-[10px] text-app-text-secondary truncate max-w-[140px]" title={session.topicName}>
              {session.topicName}
            </span>
          )}
          <span className="text-[10px] text-app-text-muted">{formatDate(session.startedAt)}</span>
          <span className="text-[10px] text-app-text-muted">{formatDuration(session.startedAt, session.completedAt)}</span>
          {session.totalTokens > 0 && (
            <span className="text-[10px] text-app-text-muted">{formatTokens(session.totalTokens)} tok</span>
          )}
        </div>
      </div>
      <ChevronRight size={12} className="text-app-text-muted flex-shrink-0 mt-1" />
    </button>
  );
}

// ─── Unified Timeline Entry ───────────────────────────────────

interface TimelineEntry {
  type: 'message' | 'session_start' | 'session_end' | 'heartbeat' | 'action';
  timestamp: string;
  data: any;
}

function actionLabel(actionType: string): string {
  switch (actionType) {
    case 'task.created': return 'Task created';
    case 'task.claimed': return 'Task claimed';
    case 'task.completed': return 'Task completed';
    case 'task.deleted': return 'Task deleted';
    case 'approval.requested': return 'Approval requested';
    case 'agent.nudge': return 'Agent nudged';
    case 'escalation.sent': return 'Escalation';
    default: return actionType;
  }
}

// ─── Session Detail (unified timeline) ────────────────────────

export function SessionDetail({ session, onBack, onNavigateToTopic, onOpenInPane, onMessage }: {
  session: UnifiedSession;
  onBack?: () => void;
  onNavigateToTopic?: (topicId: string) => void;
  onOpenInPane?: (sessionKey: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastUpdateRef = useRef<number>(0);

  // Shared fetch logic: tries local history first, falls back to gateway for sub-agent sessions
  const fetchTimeline = useCallback(async (): Promise<TimelineEntry[]> => {
    const entries: TimelineEntry[] = [];

    // 1. Try local history (works for web/WhatsApp/Discord/etc.)
    let localMsgCount = 0;
    try {
      const histData = await chatApi.getHistory(session.sessionKey);
      for (const msg of histData.messages) {
        if (msg.timestamp) {
          entries.push({ type: 'message', timestamp: msg.timestamp, data: msg });
          localMsgCount++;
        }
      }
    } catch {
      // Messages may not be available locally — non-blocking
    }

    // 2. If no local messages, try gateway (sub-agent / Claude Code sessions)
    if (localMsgCount === 0) {
      try {
        const gwData = await agentProfilesApi.sessionHistory(session.sessionKey);
        for (const msg of gwData.messages) {
          if (msg.timestamp) {
            entries.push({ type: 'message', timestamp: msg.timestamp, data: msg });
          }
        }
      } catch {
        // Gateway history may not be available — non-blocking
      }
    }

    // 3. Fetch session timeline (heartbeats + actions)
    try {
      const tlData = await agentProfilesApi.timeline(session.sessionKey);
      for (const evt of tlData.events) {
        entries.push({ type: evt.type as TimelineEntry['type'], timestamp: evt.timestamp, data: evt.data });
      }
    } catch {
      // Timeline may not exist for ephemeral sessions — non-blocking
    }

    // Sort chronologically
    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Deduplicate consecutive heartbeats with same status (keep ones with token deltas)
    const deduped: TimelineEntry[] = [];
    for (const e of entries) {
      if (e.type === 'heartbeat') {
        const prev = deduped[deduped.length - 1];
        if (prev?.type === 'heartbeat' && prev.data.status === e.data.status && !e.data.tokensUsed) continue;
      }
      deduped.push(e);
    }
    return deduped;
  }, [session.sessionKey]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTimeline().then(deduped => {
      if (cancelled) return;
      setTimeline(deduped);
      setLoading(false);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }).catch(err => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Failed to load');
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [session.topicId, session.sessionKey, fetchTimeline]);

  // WS-driven refresh: re-fetch on stream:end or agents:stopped for this session
  useEffect(() => {
    if (!session.isLive || session.status !== 'active' || !onMessage) return;
    const unsub = onMessage((msg: any) => {
      try {
        const isRelevant =
          (msg.type === 'stream:end' && msg.sessionKey === session.sessionKey) ||
          (msg.type === 'agents:stopped' && msg.sessionKey === session.sessionKey);
        if (!isRelevant) return;
        const now = Date.now();
        lastUpdateRef.current = now;
        fetchTimeline().then(deduped => {
          setTimeline(prev => {
            if (deduped.length <= prev.length) return prev;
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight, behavior: 'smooth' });
            });
            return deduped;
          });
        }).catch(() => {});
      } catch { /* ignore */ }
    });
    return unsub;
  }, [session.isLive, session.status, session.sessionKey, onMessage, fetchTimeline]);

  // Fallback polling: 30s when session is live and active (consistency check / no-WS fallback)
  useEffect(() => {
    if (!session.isLive || session.status !== 'active') return;
    const interval = setInterval(async () => {
      try {
        const fetchTime = Date.now();
        const deduped = await fetchTimeline();
        // Skip if WS provided fresher data
        if (lastUpdateRef.current > fetchTime) return;
        setTimeline(prev => {
          if (deduped.length <= prev.length) return prev;
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight, behavior: 'smooth' });
          });
          return deduped;
        });
      } catch {}
    }, onMessage ? 30_000 : 30_000);
    return () => clearInterval(interval);
  }, [session.isLive, session.status, session.sessionKey, fetchTimeline, onMessage]);

  // Count by type for summary
  const msgCount = timeline.filter(e => e.type === 'message').length;
  const hbCount = timeline.filter(e => e.type === 'heartbeat').length;
  const actCount = timeline.filter(e => e.type === 'action').length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-app-border/40 flex-shrink-0">
        {onBack && (
          <button onClick={onBack} className="p-1 rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors">
            <ArrowLeft size={14} />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {session.agentAvatar && <span className="text-[12px]">{session.agentAvatar}</span>}
            <span className="text-[12px] font-medium text-app-text truncate">
              {session.agentName || session.sessionKey}
            </span>
            <span className={`text-[9px] px-1 py-px rounded font-medium ${statusBadge(session.status)}`}>
              {statusLabel(session.status)}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[10px] text-app-text-muted">{formatDate(session.startedAt)}</span>
            <span className="text-[10px] text-app-text-muted">{formatDuration(session.startedAt, session.completedAt)}</span>
            {session.totalTokens > 0 && (
              <span className="text-[10px] text-app-text-muted">{formatTokens(session.totalTokens)} tok</span>
            )}
            {!loading && (
              <span className="text-[9px] text-app-text-muted">
                {[
                  msgCount > 0 && `${msgCount} msg`,
                  hbCount > 0 && `${hbCount} hb`,
                  actCount > 0 && `${actCount} act`,
                ].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        </div>
        {onOpenInPane && (
          <button
            onClick={() => onOpenInPane(session.sessionKey)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-purple-500 hover:bg-purple-500/10 transition-colors flex-shrink-0"
            title="Open in pane"
          >
            <ExternalLink size={10} />
            Pane
          </button>
        )}
        {session.topicId && onNavigateToTopic && (
          <button
            onClick={() => onNavigateToTopic(session.topicId!)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
            title="Open in main panel"
          >
            <MessageSquare size={10} />
            Open
          </button>
        )}
      </div>

      {/* Error bar */}
      {session.errorMessage && (
        <div className="mx-2.5 mt-2 px-2 py-1.5 rounded bg-red-500/10 text-[10px] text-red-400 flex-shrink-0">
          {session.errorMessage}
        </div>
      )}

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-center text-[11px] text-red-500">{error}</div>
        ) : timeline.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-app-text-muted">
            No data for this session
          </div>
        ) : (
          <div className="px-2 py-2 space-y-0.5">
            {timeline.map((entry, i) => (
              <TimelineEntryView key={`${entry.type}-${i}`} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Timeline Entry Renderer ──────────────────────────────────

export function TimelineEntryView({ entry }: { entry: TimelineEntry }) {
  switch (entry.type) {
    case 'message':
      return <MessageBubble message={entry.data} />;
    case 'session_start':
      return (
        <div className="flex items-center gap-2 py-1.5 px-1">
          <div className="flex-1 h-px bg-app-border/50" />
          <span className="text-[9px] text-green-500 font-medium flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Session started
          </span>
          <span className="text-[9px] text-app-text-muted">{formatDate(entry.timestamp)}</span>
          <div className="flex-1 h-px bg-app-border/50" />
        </div>
      );
    case 'session_end':
      return (
        <div className="flex items-center gap-2 py-1.5 px-1">
          <div className="flex-1 h-px bg-app-border/50" />
          <span className={`text-[9px] font-medium flex items-center gap-1 ${
            entry.data.status === 'error' ? 'text-red-500' : 'text-blue-500'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${entry.data.status === 'error' ? 'bg-red-500' : 'bg-blue-500'}`} />
            {entry.data.status === 'error' ? 'Error' : 'Completed'}
          </span>
          <span className="text-[9px] text-app-text-muted">{formatDate(entry.timestamp)}</span>
          <div className="flex-1 h-px bg-app-border/50" />
          {entry.data.errorMessage && (
            <span className="text-[9px] text-red-400 truncate max-w-[200px]">{entry.data.errorMessage}</span>
          )}
        </div>
      );
    case 'heartbeat':
      return (
        <div className="flex items-center gap-2 py-0.5 px-3">
          <div className={`w-1 h-1 rounded-full flex-shrink-0 ${statusDot(entry.data.status)}`} />
          <span className="text-[9px] text-app-text-muted">{formatDate(entry.timestamp)}</span>
          {entry.data.tokensUsed > 0 && (
            <span className="text-[9px] text-app-text-muted">+{formatTokens(entry.data.tokensUsed)} tok</span>
          )}
          {entry.data.currentTask && (
            <span className="text-[9px] text-app-text-muted truncate" title={entry.data.currentTask}>
              {entry.data.currentTask}
            </span>
          )}
        </div>
      );
    case 'action':
      return (
        <div className="flex items-center gap-2 py-1 px-2 mx-1 rounded bg-amber-500/5 border border-amber-500/10">
          <span className="text-[10px]">⚡</span>
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {actionLabel(entry.data.actionType)}
          </span>
          {entry.data.detail?.text && (
            <span className="text-[9px] text-app-text-muted truncate flex-1" title={entry.data.detail.text}>
              {entry.data.detail.text}
            </span>
          )}
          {entry.data.detail?.message && (
            <span className="text-[9px] text-app-text-muted truncate flex-1" title={entry.data.detail.message}>
              {entry.data.detail.message}
            </span>
          )}
          <span className="text-[9px] text-app-text-muted flex-shrink-0">{formatDate(entry.timestamp)}</span>
        </div>
      );
    default:
      return null;
  }
}

// ─── Message Bubble ───────────────────────────────────────────

export function MessageBubble({ message }: { message: HistoryMessage }) {
  const isUser = message.role === 'user';
  const [showFull, setShowFull] = useState(false);

  const MAX_PREVIEW = 600;
  const content = message.content || '';
  const isTruncated = content.length > MAX_PREVIEW && !showFull;
  const displayContent = isTruncated ? content.slice(0, MAX_PREVIEW) + '...' : content;

  return (
    <div className={`flex gap-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
          <Bot size={10} className="text-primary" />
        </div>
      )}
      <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${
        isUser ? 'bg-primary/10 text-app-text' : 'bg-elevated text-app-text'
      }`}>
        <p className="text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {displayContent}
        </p>
        {isTruncated && (
          <button onClick={() => setShowFull(true)} className="text-[10px] text-primary hover:underline mt-0.5">
            Show more
          </button>
        )}
        {message.thinking && (
          <details className="mt-1">
            <summary className="text-[9px] text-app-text-muted cursor-pointer hover:text-app-text-secondary">Thinking</summary>
            <p className="text-[10px] text-app-text-muted mt-0.5 whitespace-pre-wrap">
              {message.thinking.slice(0, 500)}{message.thinking.length > 500 ? '...' : ''}
            </p>
          </details>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-1 text-[9px] text-app-text-muted">
            {message.toolCalls.length} tool call{message.toolCalls.length > 1 ? 's' : ''}
          </div>
        )}
        {message.timestamp && (
          <div className="text-[9px] text-app-text-muted mt-0.5 text-right">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
      {isUser && (
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-app-hover flex items-center justify-center mt-0.5">
          <User size={10} className="text-app-text-muted" />
        </div>
      )}
    </div>
  );
}

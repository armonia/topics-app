import { useState, useEffect } from 'react';
import { Activity } from 'lucide-react';
import { agentProfilesApi, type AgentSession } from '../../lib/api';

interface HeartbeatTimelineProps {
  agentId: string;
  agentName: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-500';
    case 'paused': return 'bg-yellow-500';
    case 'completed': return 'bg-blue-500';
    case 'error': return 'bg-red-500';
    case 'stale': return 'bg-gray-400';
    default: return 'bg-gray-400';
  }
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;

  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m`;
  return `${(diffMs / 3_600_000).toFixed(1)}h`;
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function HeartbeatTimeline({ agentId, agentName }: HeartbeatTimelineProps) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    agentProfilesApi.sessions(agentId)
      .then(setSessions)
      .catch(err => console.error('Failed to load sessions:', err))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return (
      <div className="text-[11px] text-app-text-muted py-4 text-center">Loading sessions...</div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-app-text-muted">
        <Activity size={20} className="mb-2 opacity-40" />
        <span className="text-[11px]">No sessions recorded for {agentName}</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <Activity size={12} className="text-app-text-muted" />
        <span className="text-[11px] font-medium text-app-text">Session History</span>
        <span className="text-[11px] text-app-text-muted ml-auto">{sessions.length} sessions</span>
      </div>

      <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
        {sessions.map(session => (
          <div
            key={session.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            {/* Status dot */}
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor(session.status)}`} />

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-app-text font-medium">{session.status}</span>
                {session.taskId && (
                  <span className="text-[11px] px-1 py-px rounded bg-primary/10 text-primary truncate max-w-[120px]">
                    {session.taskId.slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-app-text-muted">
                {formatTime(session.startedAt)}
                {session.completedAt && ` — ${formatTime(session.completedAt)}`}
              </div>
            </div>

            {/* Duration */}
            <span className="text-[11px] text-app-text-muted flex-shrink-0">
              {formatDuration(session.startedAt, session.completedAt)}
            </span>

            {/* Tokens */}
            {session.totalTokens > 0 && (
              <span className="text-[11px] text-app-text-muted flex-shrink-0">
                {session.totalTokens.toLocaleString()}t
              </span>
            )}

            {/* Error */}
            {session.errorMessage && (
              <span className="text-[11px] text-red-400 truncate max-w-[100px]" title={session.errorMessage}>
                {session.errorMessage}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

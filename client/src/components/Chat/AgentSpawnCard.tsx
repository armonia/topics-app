import { useState, useEffect, useRef, memo } from 'react';
import { Loader2, Check, X, ExternalLink } from 'lucide-react';

interface AgentSpawnCardProps {
  sessionKey: string;
  label: string;
  onOpenInPane?: (sessionKey: string) => void;
}

interface SessionInfo {
  status: 'active' | 'idle' | 'completed' | 'error';
  totalTokens: number;
  startedAt: string | null;
}

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const AgentSpawnCard = memo(function AgentSpawnCard({ sessionKey, label, onOpenInPane }: AgentSpawnCardProps) {
  const [info, setInfo] = useState<SessionInfo>({ status: 'active', totalTokens: 0, startedAt: null });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/agents/sessions?activeMinutes=1440`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const sessions: Array<{ key: string; status: string; totalTokens?: number; updatedAt?: number }> = data.sessions || [];
        const match = sessions.find((s: any) => s.key === sessionKey);
        if (match && !cancelled) {
          setInfo(prev => ({
            status: (match.status as SessionInfo['status']) || 'active',
            totalTokens: match.totalTokens || 0,
            startedAt: prev.startedAt || new Date().toISOString(),
          }));
        }
      } catch { /* ignore */ }
    };

    // Initial fetch
    setInfo(prev => ({ ...prev, startedAt: prev.startedAt || new Date().toISOString() }));
    poll();

    intervalRef.current = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Stop polling when terminal
  useEffect(() => {
    if ((info.status === 'completed' || info.status === 'error') && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [info.status]);

  // Re-render every 5s to update duration while active
  const [, setTick] = useState(0);
  useEffect(() => {
    if (info.status === 'completed' || info.status === 'error') return;
    const t = setInterval(() => setTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, [info.status]);

  const isTerminal = info.status === 'completed' || info.status === 'error';
  const isActive = info.status === 'active' || info.status === 'idle';

  const statusIcon = isActive
    ? <Loader2 size={14} className="animate-spin text-blue-500" />
    : info.status === 'completed'
      ? <Check size={14} className="text-green-500" />
      : <X size={14} className="text-red-500" />;

  const borderColor = isActive
    ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20'
    : info.status === 'completed'
      ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20'
      : 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20';

  return (
    <div className={`my-1 flex items-center gap-2.5 px-3 py-2 rounded-lg border ${borderColor} text-[12px]`}>
      {statusIcon}
      <span className="font-medium truncate flex-1 min-w-0">{label}</span>
      {info.totalTokens > 0 && (
        <span className="text-app-text-muted tabular-nums flex-shrink-0">{formatTokens(info.totalTokens)} tok</span>
      )}
      {info.startedAt && (
        <span className="text-app-text-muted tabular-nums flex-shrink-0">{formatDuration(info.startedAt)}</span>
      )}
      {onOpenInPane && (
        <button
          onClick={() => onOpenInPane(sessionKey)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
          title="Open session viewer"
        >
          <ExternalLink size={12} />
          {isTerminal ? 'View' : 'Open'}
        </button>
      )}
    </div>
  );
});

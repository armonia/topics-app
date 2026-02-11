import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProcessInfo } from '../../types';
import { processesApi } from '../../lib/api';

interface ProcessListProps {
  topicId: string;
  compact?: boolean;
}

function statusIcon(status: ProcessInfo['status']): string {
  switch (status) {
    case 'running': return '🔄';
    case 'done': return '✅';
    case 'error': return '❌';
    default: return '❓';
  }
}

function formatDuration(start: string, end?: string): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const diff = Math.floor((e - s) / 1000);
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const sec = diff % 60;
  return `${m}m${sec}s`;
}

export function ProcessList({ topicId }: ProcessListProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProcess, setExpandedProcess] = useState<string | null>(null);

  const loadProcesses = useCallback(async () => {
    try {
      setError(null);
      const result = await processesApi.list(topicId);
      setProcesses(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load processes');
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    loadProcesses();
    const timer = setInterval(loadProcesses, 10000);
    return () => clearInterval(timer);
  }, [loadProcesses]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 min-h-0">
        <div className="flex items-center gap-2 text-[#8b8b8b] text-[13px]">
          <div className="w-4 h-4 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" />
          Loading processes...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 gap-2">
        <p className="text-red-500 text-[13px]">{error}</p>
        <button onClick={loadProcesses} className="text-[12px] text-[var(--primary)] hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#e8e8e8] dark:border-[#2a2a2a] bg-[#fafafa] dark:bg-[#1e1e1e] flex-shrink-0">
        <span className="text-[11px] font-medium text-[#8b8b8b] uppercase tracking-wider">
          Processes ({processes.length})
        </span>
        <button
          onClick={loadProcesses}
          className="p-1 rounded hover:bg-[#eee] dark:hover:bg-[#333] text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Process list */}
      <div className="flex-1 overflow-y-auto">
        {processes.length === 0 ? (
          <div className="flex items-center justify-center flex-1 min-h-0 text-[#8b8b8b] text-[13px]">
            <div className="text-center">
              <p className="text-[24px] mb-2 opacity-40">⚡</p>
              <p>No sub-processes</p>
              <p className="text-[11px] mt-1 opacity-60">Sub-agents spawned from this topic will appear here</p>
            </div>
          </div>
        ) : (
          <div className="py-1">
            {processes.map((proc) => (
              <div key={proc.sessionKey}>
                <div
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                    expandedProcess === proc.sessionKey
                      ? 'bg-[#f5f5f5] dark:bg-[#222]'
                      : 'hover:bg-[#f8f8f8] dark:hover:bg-[#1e1e1e]'
                  }`}
                  onClick={() => setExpandedProcess(
                    expandedProcess === proc.sessionKey ? null : proc.sessionKey
                  )}
                >
                  <span className="text-[14px]">{statusIcon(proc.status)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-[#333] dark:text-[#ddd] truncate">
                      {proc.label}
                    </div>
                    <div className="text-[10px] text-[#888] dark:text-[#777]">
                      {formatDuration(proc.startedAt, proc.completedAt)}
                      {proc.status === 'running' && ' (running)'}
                    </div>
                  </div>
                </div>
                {expandedProcess === proc.sessionKey && (
                  <div className="px-3 py-2 bg-[#fafafa] dark:bg-[#1a1a1a] border-t border-[#eee] dark:border-[#2a2a2a] text-[11px] text-[#666] dark:text-[#999]">
                    <p>Session: <code className="text-[10px] bg-[#f0f0f0] dark:bg-[#333] px-1 py-0.5 rounded">{proc.sessionKey}</code></p>
                    <p>Started: {new Date(proc.startedAt).toLocaleString()}</p>
                    {proc.completedAt && <p>Completed: {new Date(proc.completedAt).toLocaleString()}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

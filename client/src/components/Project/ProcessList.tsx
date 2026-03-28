import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, Square, X } from 'lucide-react';
import type { ProcessInfo } from '../../types';
import { processesApi } from '../../lib/api';

interface ProcessListProps {
  topicId: string;
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

interface SpawnDialogProps {
  topicId: string;
  onClose: () => void;
  onSpawned: () => void;
}

function SpawnDialog({ topicId, onClose, onSpawned }: SpawnDialogProps) {
  const [task, setTask] = useState('');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!task.trim()) return;
    setSpawning(true);
    setError(null);
    try {
      const resp = await fetch(`/api/agents/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicId,
          task: task.trim(),
          label: label.trim() || undefined,
          model: model || undefined,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: 'Spawn failed' }));
        throw new Error(data.error || 'Spawn failed');
      }
      onSpawned();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to spawn agent');
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 bg-surface flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border flex-shrink-0">
        <span className="text-[12px] font-medium text-app-text">New Agent</span>
        <button onClick={onClose} className="p-1 rounded hover:bg-app-hover text-app-text-tertiary">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div>
          <label className="block text-[11px] font-medium text-app-text-secondary mb-1">Task *</label>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe what this agent should do..."
            className="w-full px-2 py-1.5 text-[12px] bg-app-bg border border-app-border rounded-md focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder resize-none"
            rows={3}
            autoFocus
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-app-text-secondary mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional display name"
            className="w-full px-2 py-1.5 text-[12px] bg-app-bg border border-app-border rounded-md focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-app-text-secondary mb-1">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-2 py-1.5 text-[12px] bg-app-bg border border-app-border rounded-md focus:outline-none focus:border-primary text-app-text"
          >
            <option value="">Default</option>
            <option value="claude-opus-4-6">Opus</option>
            <option value="claude-sonnet-4-5-20250929">Sonnet</option>
            <option value="claude-haiku-4-5-20251001">Haiku</option>
          </select>
        </div>
        {error && <p className="text-red-500 text-[11px]">{error}</p>}
      </div>
      <div className="px-3 py-2 border-t border-app-border flex-shrink-0">
        <button
          onClick={handleSubmit}
          disabled={!task.trim() || spawning}
          className="w-full px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {spawning ? 'Launching...' : 'Launch'}
        </button>
      </div>
    </div>
  );
}

async function stopAgent(sessionKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/agents/sessions/${encodeURIComponent(sessionKey)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export function ProcessList({ topicId }: ProcessListProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProcess, setExpandedProcess] = useState<string | null>(null);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [stoppingKeys, setStoppingKeys] = useState<Set<string>>(new Set());

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

  const handleStop = useCallback(async (sessionKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setStoppingKeys(prev => new Set([...prev, sessionKey]));
    const ok = await stopAgent(sessionKey);
    if (ok) {
      // Refresh list after a brief delay to let it settle
      setTimeout(loadProcesses, 1000);
    }
    setStoppingKeys(prev => {
      const next = new Set(prev);
      next.delete(sessionKey);
      return next;
    });
  }, [loadProcesses]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 min-h-0">
        <div className="flex items-center gap-2 text-app-text-tertiary text-[13px]">
          <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
          Loading processes...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 gap-2">
        <p className="text-red-500 text-[13px]">{error}</p>
        <button onClick={loadProcesses} className="text-[12px] text-primary hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div data-testid="process-list" className="flex-1 min-h-0 flex flex-col relative">
      {/* Spawn dialog overlay */}
      {showSpawnDialog && (
        <SpawnDialog
          topicId={topicId}
          onClose={() => setShowSpawnDialog(false)}
          onSpawned={() => setTimeout(loadProcesses, 1000)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border bg-elevated flex-shrink-0">
        <span className="text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
          Processes ({processes.length})
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSpawnDialog(true)}
            className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors"
            title="New Agent"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={loadProcesses}
            className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-secondary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Process list */}
      <div className="flex-1 overflow-y-auto">
        {processes.length === 0 ? (
          <div className="flex items-center justify-center flex-1 min-h-0 text-app-text-tertiary text-[13px]">
            <div className="text-center py-8">
              <p className="text-[24px] mb-2 opacity-40">⚡</p>
              <p>No sub-processes</p>
              <p className="text-[11px] mt-1 opacity-60">Sub-agents spawned from this topic will appear here</p>
              <button
                onClick={() => setShowSpawnDialog(true)}
                className="mt-3 px-3 py-1 text-[11px] text-primary border border-primary rounded-md hover:bg-primary/10 transition-colors"
              >
                Launch Agent
              </button>
            </div>
          </div>
        ) : (
          <div className="py-1">
            {processes.map((proc) => (
              <div key={proc.sessionKey}>
                <div
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                    expandedProcess === proc.sessionKey
                      ? 'bg-app-hover'
                      : 'hover:bg-app-hover'
                  }`}
                  onClick={() => setExpandedProcess(
                    expandedProcess === proc.sessionKey ? null : proc.sessionKey
                  )}
                >
                  <span className="text-[14px]">{statusIcon(proc.status)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-app-text truncate">
                      {proc.label}
                    </div>
                    <div className="text-[10px] text-app-text-muted">
                      {formatDuration(proc.startedAt, proc.completedAt)}
                      {proc.status === 'running' && ' (running)'}
                    </div>
                  </div>
                  {proc.status === 'running' && (
                    <button
                      onClick={(e) => handleStop(proc.sessionKey, e)}
                      disabled={stoppingKeys.has(proc.sessionKey)}
                      className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-app-text-tertiary hover:text-red-500 transition-colors disabled:opacity-40"
                      title="Stop agent"
                    >
                      <Square size={12} />
                    </button>
                  )}
                </div>
                {expandedProcess === proc.sessionKey && (
                  <div className="px-3 py-2 bg-elevated border-t border-app-border text-[11px] text-app-text-secondary">
                    <p>Session: <code className="text-[10px] bg-app-hover px-1 py-0.5 rounded">{proc.sessionKey}</code></p>
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

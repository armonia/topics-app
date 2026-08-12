import { useState, useEffect, useCallback } from 'react';
import { Clock, ChevronRight, Play, Trash2, RefreshCw, Calendar, Power, PowerOff } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';

interface CronJob {
  id: string;
  name?: string;
  enabled: boolean;
  schedule: {
    kind: 'at' | 'every' | 'cron';
    atMs?: number;
    everyMs?: number;
    expr?: string;
    tz?: string;
    anchorMs?: number;
  };
  payload: {
    kind: 'systemEvent' | 'agentTurn';
    text?: string;
    message?: string;
  };
  sessionTarget: 'main' | 'isolated';
  nextRunAt?: string;
  lastRunAt?: string;
}

interface CronJobsPanelProps {
  enabled?: boolean;
}

function formatSchedule(schedule: CronJob['schedule']): string {
  if (schedule.kind === 'at' && schedule.atMs) {
    const date = new Date(schedule.atMs);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  if (schedule.kind === 'every' && schedule.everyMs) {
    const mins = Math.round(schedule.everyMs / 60000);
    if (mins < 60) return `every ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `every ${hours}h`;
    return `every ${Math.round(hours / 24)}d`;
  }
  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.expr;
  }
  return '-';
}

function formatNextRun(nextRunAt?: string): string {
  if (!nextRunAt) return '-';
  const date = new Date(nextRunAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs < 0) return 'now';
  if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m`;
  if (diffMs < 86400000) return `${Math.round(diffMs / 3600000)}h`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function CronJobsPanel({ enabled = true }: CronJobsPanelProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/cron/jobs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (err) {
      console.error('[CronJobs] Failed to load:', err);
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    loadJobs();
    const interval = setInterval(loadJobs, 30000);
    return () => clearInterval(interval);
  }, [enabled, loadJobs]);

  const toggleJob = useCallback(async (jobId: string, jobEnabled: boolean) => {
    try {
      const res = await fetch('/api/cron/jobs/' + jobId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: jobEnabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, enabled: jobEnabled } : j));
    } catch (err) {
      console.error('[CronJobs] Toggle failed:', err);
    }
  }, []);

  const runJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch('/api/cron/jobs/' + jobId + '/run', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTimeout(loadJobs, 1000);
    } catch (err) {
      console.error('[CronJobs] Run failed:', err);
    }
  }, [loadJobs]);

  const deleteJob = useCallback(async (jobId: string) => {
    if (!await confirm({ title: 'Delete this job?', confirmLabel: 'Delete' })) return;
    try {
      const res = await fetch('/api/cron/jobs/' + jobId, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJobs(prev => prev.filter(j => j.id !== jobId));
    } catch (err) {
      console.error('[CronJobs] Delete failed:', err);
    }
  }, [confirm]);

  const enabledJobs = jobs.filter(j => j.enabled);
  const disabledJobs = jobs.filter(j => !j.enabled);

  return (
    <div className="pb-2 px-2">
      {error && (
        <div className="px-2 py-1 text-[11px] text-red-500">{error}</div>
      )}

      {/* Enabled jobs */}
      {enabledJobs.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {enabledJobs.map(job => (
            <JobRow
              key={job.id}
              job={job}
              onToggle={toggleJob}
              onRun={runJob}
              onDelete={deleteJob}
            />
          ))}
        </div>
      )}

      {/* Disabled jobs (collapsed) */}
      {disabledJobs.length > 0 && (
        <details className="group">
          <summary className="px-2 py-1 text-[11px] text-app-text-muted cursor-pointer hover:text-app-text-secondary list-none flex items-center gap-1">
            <ChevronRight size={10} className="group-open:rotate-90 transition-transform text-app-text-muted" />
            {disabledJobs.length} disabled
          </summary>
          <div className="space-y-0.5 mt-1 opacity-60">
            {disabledJobs.map(job => (
              <JobRow
                key={job.id}
                job={job}
                onToggle={toggleJob}
                onRun={runJob}
                onDelete={deleteJob}
              />
            ))}
          </div>
        </details>
      )}

      {jobs.length === 0 && !loading && (
        <div className="px-2 py-3 text-center text-[11px] text-app-text-muted">
          No cron jobs
        </div>
      )}

      <button
        onClick={loadJobs}
        disabled={loading}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 mt-1 text-[11px] text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        Refresh
      </button>
    </div>
  );
}

interface JobRowProps {
  job: CronJob;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
}

function JobRow({ job, onToggle, onRun, onDelete }: JobRowProps) {
  const [showActions, setShowActions] = useState(false);

  const name = job.name || job.payload.text?.slice(0, 30) || job.payload.message?.slice(0, 30) || 'Job';
  const scheduleIcon = job.schedule.kind === 'at' ? Calendar : job.schedule.kind === 'every' ? RefreshCw : Clock;
  const ScheduleIcon = scheduleIcon;

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded group cursor-pointer ${
        job.enabled
          ? 'bg-primary/5 hover:bg-primary/10'
          : 'hover:bg-app-hover'
      }`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Toggle */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(job.id, !job.enabled); }}
        className={`w-4 h-4 flex items-center justify-center rounded transition-colors ${
          job.enabled ? 'text-primary' : 'text-app-text-muted'
        }`}
        title={job.enabled ? 'Disable' : 'Enable'}
      >
        {/* Acceso/spento, non lampo/pausa. Questo bottone ARMA il job; a
            quaranta pixel c'è già un `Play` che vuol dire «esegui adesso», e
            fra un lampo e una pausa non si capiva quale dei due fosse lo stato
            e quale il comando. */}
        {job.enabled ? <Power size={12} /> : <PowerOff size={12} />}
      </button>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-app-text truncate">
          {name}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-app-text-muted">
          <span className="flex items-center gap-0.5">
            <ScheduleIcon size={10} />
            {formatSchedule(job.schedule)}
          </span>
          {job.nextRunAt && job.enabled && (
            <span className="text-primary">
              → {formatNextRun(job.nextRunAt)}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      {showActions && (
        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onRun(job.id); }}
            className="p-1 text-app-text-muted hover:text-primary transition-colors"
            title="Run now"
          >
            <Play size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(job.id); }}
            className="p-1 text-app-text-muted hover:text-red-500 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

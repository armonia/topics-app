import { useState, useEffect, useCallback } from 'react';
import { Clock, ChevronDown, ChevronRight, Play, Pause, Trash2, RefreshCw, Calendar, Zap } from 'lucide-react';

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
  expanded?: boolean;
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
  return '—';
}

function formatNextRun(nextRunAt?: string): string {
  if (!nextRunAt) return '—';
  const date = new Date(nextRunAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  
  if (diffMs < 0) return 'now';
  if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m`;
  if (diffMs < 86400000) return `${Math.round(diffMs / 3600000)}h`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function CronJobsPanel({ expanded = false }: CronJobsPanelProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [isExpanded, setIsExpanded] = useState(expanded);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Load on mount and when expanded
  useEffect(() => {
    if (isExpanded) {
      loadJobs();
      // Refresh every 30s when expanded
      const interval = setInterval(loadJobs, 30000);
      return () => clearInterval(interval);
    }
  }, [isExpanded, loadJobs]);

  const toggleJob = useCallback(async (jobId: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/cron/jobs/' + jobId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, enabled } : j));
    } catch (err) {
      console.error('[CronJobs] Toggle failed:', err);
    }
  }, []);

  const runJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch('/api/cron/jobs/' + jobId + '/run', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh after run
      setTimeout(loadJobs, 1000);
    } catch (err) {
      console.error('[CronJobs] Run failed:', err);
    }
  }, [loadJobs]);

  const deleteJob = useCallback(async (jobId: string) => {
    if (!confirm('Delete this job?')) return;
    try {
      const res = await fetch('/api/cron/jobs/' + jobId, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJobs(prev => prev.filter(j => j.id !== jobId));
    } catch (err) {
      console.error('[CronJobs] Delete failed:', err);
    }
  }, []);

  const enabledJobs = jobs.filter(j => j.enabled);
  const disabledJobs = jobs.filter(j => !j.enabled);

  return (
    <div className="border-t border-[#e8e8e8] dark:border-[#2a2a2a]">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors"
      >
        {isExpanded ? <ChevronDown size={14} className="text-[#666] dark:text-[#999]" /> : <ChevronRight size={14} className="text-[#666] dark:text-[#999]" />}
        <Clock size={14} className={enabledJobs.length > 0 ? 'text-[var(--primary)]' : 'text-[#888]'} />
        <span className="text-[13px] text-[#1a1a1a] dark:text-[#e5e5e5] flex-1">Cron Jobs</span>
        {jobs.length > 0 && (
          <span className="text-[11px] text-[#888] bg-[#eee] dark:bg-[#333] px-1.5 rounded">
            {enabledJobs.length}/{jobs.length}
          </span>
        )}
        {loading && (
          <RefreshCw size={12} className="animate-spin text-[#888]" />
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
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
              <summary className="px-2 py-1 text-[10px] text-[#888] cursor-pointer hover:text-[#666] dark:hover:text-[#aaa] list-none flex items-center gap-1">
                <ChevronRight size={10} className="group-open:rotate-90 transition-transform text-[#888] dark:text-[#666]" />
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
            <div className="px-2 py-3 text-center text-[11px] text-[#888]">
              No cron jobs
            </div>
          )}

          {/* Refresh button */}
          <button
            onClick={loadJobs}
            disabled={loading}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 mt-1 text-[11px] text-[#888] hover:text-[#666] dark:hover:text-[#aaa] hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a] rounded transition-colors"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      )}
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
          ? 'bg-[var(--primary)]/5 hover:bg-[var(--primary)]/10'
          : 'hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a]'
      }`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Toggle */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(job.id, !job.enabled); }}
        className={`w-4 h-4 flex items-center justify-center rounded transition-colors ${
          job.enabled ? 'text-[var(--primary)]' : 'text-[#999] dark:text-[#555]'
        }`}
        title={job.enabled ? 'Disable' : 'Enable'}
      >
        {job.enabled ? <Zap size={12} /> : <Pause size={12} />}
      </button>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-[#1a1a1a] dark:text-[#e5e5e5] truncate">
          {name}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#888]">
          <span className="flex items-center gap-0.5">
            <ScheduleIcon size={9} />
            {formatSchedule(job.schedule)}
          </span>
          {job.nextRunAt && job.enabled && (
            <span className="text-[var(--primary)]">
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
            className="p-1 text-[#888] hover:text-[var(--primary)] transition-colors"
            title="Run now"
          >
            <Play size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(job.id); }}
            className="p-1 text-[#888] hover:text-red-500 transition-colors"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

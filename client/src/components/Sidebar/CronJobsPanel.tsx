import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Check, Clock, ChevronRight, Play, Trash2, RefreshCw, Calendar, Power, PowerOff } from 'lucide-react';
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

/**
 * The refusal, in the words the server used.
 *
 * `/api/cron/*` answers a rejection with `{ error }` (see `server/routes/cron.ts`),
 * so there is a sentence to show and the panel does not have to invent one. The
 * status code is the fallback for a body that is not JSON: a number is thin,
 * but it still tells a person the click was refused rather than ignored.
 */
async function refusal(res: Response, what: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  const detail = typeof body?.error === 'string' ? body.error.trim() : '';
  return detail ? `${what}: ${detail}` : `${what}: HTTP ${res.status}`;
}

/** How long ago a run happened, in the same shorthand as the next run. */
function formatRan(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  /** When a job was last run FROM HERE. The server's `lastRunAt` says the same
   *  thing but arrives with the next refresh, and the receipt for a click has
   *  to be there while the person is still looking at the row. */
  const [ranAt, setRanAt] = useState<Record<string, number>>({});
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

  // THE THREE COMMANDS ANSWER, and they answer on the screen. Each of them used
  // to end in a `console.error`: on a refusal the icon stayed where it was, the
  // row did not move, and the only trace was in a console nobody has open. The
  // cure is the one `SystemStatusPanel` already applies to the gateway restart:
  // read the outcome, and put the server's own sentence next to the button that
  // produced it.
  const toggleJob = useCallback(async (jobId: string, jobEnabled: boolean) => {
    setError(null);
    try {
      const res = await fetch('/api/cron/jobs/' + jobId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: jobEnabled }),
      });
      if (!res.ok) { setError(await refusal(res, jobEnabled ? 'Enable failed' : 'Disable failed')); return; }
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, enabled: jobEnabled } : j));
    } catch {
      setError(jobEnabled ? 'Enable failed: no answer from the server' : 'Disable failed: no answer from the server');
    }
  }, []);

  const runJob = useCallback(async (jobId: string) => {
    setError(null);
    try {
      const res = await fetch('/api/cron/jobs/' + jobId + '/run', { method: 'POST' });
      if (!res.ok) { setError(await refusal(res, 'Run failed')); return; }
      // A run that WORKS also has to leave a mark. Until now «Play» had no sign
      // either way, so a working run and a refused one looked identical. The
      // stamp is written here rather than waited for from the refresh: the list
      // comes back a second later, and a receipt that arrives late is read as
      // «nothing happened».
      setRanAt(prev => ({ ...prev, [jobId]: Date.now() }));
      setTimeout(loadJobs, 1000);
    } catch {
      setError('Run failed: no answer from the server');
    }
  }, [loadJobs]);

  const deleteJob = useCallback(async (jobId: string) => {
    if (!await confirm({ title: 'Delete this job?', confirmLabel: 'Delete' })) return;
    setError(null);
    try {
      const res = await fetch('/api/cron/jobs/' + jobId, { method: 'DELETE' });
      if (!res.ok) { setError(await refusal(res, 'Delete failed')); return; }
      setJobs(prev => prev.filter(j => j.id !== jobId));
    } catch {
      setError('Delete failed: no answer from the server');
    }
  }, [confirm]);

  const enabledJobs = jobs.filter(j => j.enabled);
  const disabledJobs = jobs.filter(j => !j.enabled);

  return (
    <div className="pb-2 px-2">
      {/* ONE band for every refusal, load and commands alike: it is read next to
          the rows that did not move, which is where whoever pressed is looking.
          Same shape as `system-restart-error` in the panel next door. */}
      {error && (
        <div
          data-testid="cron-error"
          className="flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-400"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {/* Enabled jobs */}
      {enabledJobs.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {enabledJobs.map(job => (
            <JobRow
              key={job.id}
              job={job}
              ranAt={ranAt[job.id]}
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
                ranAt={ranAt[job.id]}
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
  /** The receipt for a run started from this panel, if there was one. */
  ranAt?: number;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
}

function JobRow({ job, ranAt, onToggle, onRun, onDelete }: JobRowProps) {
  const [showActions, setShowActions] = useState(false);
  // The click of a moment ago wins over the server's timestamp: they say the
  // same thing, and the list is refreshed a second later.
  const lastRun = ranAt ?? (job.lastRunAt ? Date.parse(job.lastRunAt) : NaN);

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
          {/* «It ran» was the state this row never had: `lastRunAt` arrived from
              the server and was thrown away, so a Play that worked and one that
              was refused left the very same row behind. */}
          {Number.isFinite(lastRun) && (
            <span data-testid="cron-job-ran" className="flex items-center gap-0.5 text-emerald-400">
              <Check size={10} />
              ran {formatRan(lastRun)}
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

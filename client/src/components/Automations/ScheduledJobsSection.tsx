/**
 * «Lavori di Topics»: the jobs this installation runs on a schedule, made and
 * followed from the Automations view. A person writes when (with the next three
 * occurrences under the field), what (a command or a board card), where the
 * outcome goes and in which project; then sees each job's rounds: when they
 * started, how they ended, what they printed, and why a round was skipped or
 * lost. «Run now», pause and delete sit on the row.
 *
 * It reads `/api/scheduled-jobs` only, so it is whole on an installation with
 * no hub and no jarvis-channels.
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, Pause, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { boardApi, type BoardProjectRef } from '../../lib/board';
import { previewOccurrences, type JobRun, type ScheduledJob } from '../../lib/scheduledJobs';
import { Segmented } from '../Shared/Segmented';
import { Select } from '../Shared/Select';
import { BOX, BUTTON, BUTTON_PRIMARY, ICON_BUTTON, SECTION, SECTION_COUNT, SECTION_REST } from './automationsUi';
import { draftOf, emptyDraft, inputOf, scheduleOf, type JobDraft, type WhenKind } from './scheduledJobForm';
import { useScheduledJobs, type ScheduledJobsData } from './useScheduledJobs';

const INPUT = 'h-8 w-full rounded-sm border border-app-border-input bg-app-input px-2 text-compact text-app-text outline-none placeholder:text-app-text-muted focus-visible:border-primary';
const WHEN_KINDS: WhenKind[] = ['daily', 'weekly', 'hourly', 'every', 'once', 'custom'];
const KNOWN_CAUSES = new Set(['overlap', 'down']);
const DELIVERY_STATES = new Set(['delivered', 'delivering', 'delivery_failed', 'empty', 'not_delivered']);
const BAD_STATUS = new Set(['error', 'timeout', 'failed_to_start', 'interrupted', 'missed']);

export function ScheduledJobsSection() {
  const tr = useT();
  const confirm = useConfirm();
  const data = useScheduledJobs();
  const [editing, setEditing] = useState<{ id: string | null; draft: JobDraft } | null>(null);
  const jobs = data.jobs ?? [];

  const remove = async (job: ScheduledJob) => {
    const ok = await confirm({ title: tr('sj.confirm.title', { name: job.name }), body: tr('sj.confirm.body'), confirmLabel: tr('sj.delete') });
    if (ok) await data.remove(job.id);
  };

  return (
    <section data-testid="scheduled-jobs" aria-label={tr('sj.title')}>
      <h2 className={SECTION}>
        <CalendarClock size={13} aria-hidden="true" />{tr('sj.title')}
        <span className={SECTION_COUNT}>{jobs.length}</span>
        <span className={SECTION_REST}>{tr('sj.note')}</span>
        {!editing && (
          <button type="button" className={`${BUTTON} ml-auto normal-case tracking-normal`} data-testid="sj-new" onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
            <Plus size={13} aria-hidden="true" />{tr('sj.new')}
          </button>
        )}
      </h2>
      {data.failing && <p role="alert" className="m-0 mb-1.5 text-mini text-app-text-secondary" data-testid="sj-failing">{tr('sj.failing')}</p>}
      {data.error && !editing && <p role="alert" className="m-0 mb-1.5 text-mini text-red-600 dark:text-red-400" data-testid="sj-error">{data.error}</p>}
      {editing && (
        <JobForm
          key={editing.id ?? 'new'}
          initial={editing.draft}
          id={editing.id}
          data={data}
          onDone={() => setEditing(null)}
        />
      )}
      {data.jobs !== null && jobs.length === 0 && !editing && <p className="m-0 text-compact text-app-text-secondary" data-testid="sj-empty">{tr('sj.empty')}</p>}
      {jobs.length > 0 && (
        <ul className={`m-0 list-none p-0 ${BOX}`} data-testid="sj-list">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} data={data} onEdit={() => setEditing({ id: job.id, draft: draftOf(job) })} onRemove={() => { void remove(job); }} />
          ))}
        </ul>
      )}
    </section>
  );
}

function useDateWords() {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return (value: string | Date | null) => (value ? format.format(new Date(value)) : '');
  }, [locale]);
}

function JobRow({ job, data, onEdit, onRemove }: { job: ScheduledJob; data: ScheduledJobsData; onEdit(): void; onRemove(): void }) {
  const tr = useT();
  const when = useDateWords();
  const [open, setOpen] = useState(false);
  const last = job.lastRun;
  const editable = job.action.kind === 'command' || job.action.kind === 'card';
  const schedule = job.schedule;
  const rule = schedule.kind === 'cron' ? `${schedule.expr} · ${schedule.tz}` : schedule.kind === 'every' ? tr('sj.everyN', { n: schedule.minutes }) : when(schedule.at);
  return (
    <li data-testid="sj-row" data-job-id={job.id} data-enabled={job.enabled} className="border-b border-app-border-subtle last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={tr('sj.history', { name: job.name })}
          data-testid="sj-toggle"
          onClick={() => setOpen((v) => !v)}
          className={ICON_BUTTON}
        >{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>
        <div className="min-w-0 flex-1 basis-48">
          <div className="truncate text-compact font-medium text-app-text" data-testid="sj-name">{job.name}</div>
          <div className="truncate text-mini text-app-text-muted">
            {tr(`sj.action.${job.action.kind}`)} · {rule}
            {' · '}{job.enabled ? (job.nextRunAt ? tr('sj.next', { when: when(job.nextRunAt) }) : tr('sj.noNext')) : tr('sj.paused')}
          </div>
        </div>
        <span className="text-mini text-app-text-secondary" data-testid="sj-last" data-status={last?.status ?? 'none'}>
          {last ? <RunStatus run={last} /> : tr('sj.neverRan')}
        </span>
        <span className="ml-auto flex flex-none items-center gap-1">
          <button type="button" className={BUTTON} data-testid="sj-run" onClick={() => { void data.runNow(job.id).then(() => setOpen(true)); }}>
            <Zap size={13} aria-hidden="true" />{tr('sj.runNow')}
          </button>
          <button type="button" className={ICON_BUTTON} data-testid="sj-pause" aria-label={tr(job.enabled ? 'sj.pause' : 'sj.resume', { name: job.name })} onClick={() => { void data.update(job.id, { enabled: !job.enabled }); }}>
            {job.enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </button>
          {editable && (
            <button type="button" className={ICON_BUTTON} data-testid="sj-edit" aria-label={tr('sj.edit', { name: job.name })} onClick={onEdit}><Pencil size={14} aria-hidden="true" /></button>
          )}
          <button type="button" className={ICON_BUTTON} data-testid="sj-delete" aria-label={tr('sj.deleteNamed', { name: job.name })} onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></button>
        </span>
      </div>
      {open && <RunHistory job={job} data={data} />}
    </li>
  );
}

function RunStatus({ run }: { run: JobRun }) {
  const tr = useT();
  const bad = BAD_STATUS.has(run.status);
  return <span className={bad ? 'text-red-600 dark:text-red-400' : undefined}>{tr(`sj.status.${run.status}`)}</span>;
}

function durationOf(run: JobRun, tr: ReturnType<typeof useT>): string {
  if (!run.startedAt || !run.finishedAt) return '';
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? tr('sj.sec', { n: seconds }) : tr('sj.minSec', { m: Math.floor(seconds / 60), s: seconds % 60 });
}

function RunHistory({ job, data }: { job: ScheduledJob; data: ScheduledJobsData }) {
  const tr = useT();
  const when = useDateWords();
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const lastId = job.lastRun?.id ?? null;
  const lastStatus = job.lastRun?.status ?? null;
  const { runs: readRuns } = data;
  // Read again whenever the newest round appears or changes state.
  useEffect(() => {
    let alive = true;
    void readRuns(job.id).then((list) => { if (alive) setRuns(list); });
    return () => { alive = false; };
  }, [readRuns, job.id, lastId, lastStatus]);
  if (runs === null) return <p className="m-0 px-3 pb-2 text-mini text-app-text-muted">{tr('auto.reading')}</p>;
  if (runs.length === 0) return <p className="m-0 px-3 pb-2 text-mini text-app-text-muted" data-testid="sj-no-runs">{tr('sj.noRuns')}</p>;
  return (
    <ol className="m-0 list-none px-3 pb-2" data-testid="sj-runs">
      {runs.map((run) => {
        const why = [run.cause ? (KNOWN_CAUSES.has(run.cause) ? tr(`sj.cause.${run.cause}`) : run.cause) : null, run.reason, run.missedCount > 1 ? tr('sj.missed', { n: run.missedCount }) : null].filter(Boolean).join(' · ');
        const output = [run.stdout, run.stderr].filter((part): part is string => !!part && part.trim() !== '').join('\n');
        return (
          <li key={run.id} data-testid="sj-run-row" data-status={run.status} className="border-t border-app-border-subtle py-1.5 text-mini">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-app-text-secondary">
              <span className="font-medium"><RunStatus run={run} /></span>
              <span>{when(run.startedAt ?? run.scheduledFor)}</span>
              {durationOf(run, tr) && <span data-testid="sj-run-duration">{durationOf(run, tr)}</span>}
              {run.exitCode !== null && <span>{tr('sj.exit', { code: run.exitCode })}</span>}
              {run.delivery && <span>{tr(DELIVERY_STATES.has(run.delivery.state) ? `sj.delivery.${run.delivery.state}` : 'sj.delivery.unknown')}</span>}
            </div>
            {why && <div className="text-app-text-muted" data-testid="sj-run-why">{why}</div>}
            {output && <pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-app-inset p-2 font-mono text-mini text-app-text" data-testid="sj-run-output" tabIndex={0} aria-label={tr('sj.output')}>{output}</pre>}
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-mini text-app-text-secondary">
      <span>{label}</span>
      {children}
    </label>
  );
}

function JobForm({ initial, id, data, onDone }: { initial: JobDraft; id: string | null; data: ScheduledJobsData; onDone(): void }) {
  const tr = useT();
  const when = useDateWords();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<BoardProjectRef[]>([]);
  useEffect(() => {
    let alive = true;
    void boardApi.projects().then((r) => { if (alive) setProjects(r.projects); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const set = <K extends keyof JobDraft>(key: K, value: JobDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // The preview is read from the shared schedule module on every keystroke: it is the same arithmetic the server does.
  const preview = useMemo(() => previewOccurrences(scheduleOf(draft), new Date(), id === null), [draft, id]);
  const needsZone = draft.whenKind === 'daily' || draft.whenKind === 'weekly' || draft.whenKind === 'hourly' || draft.whenKind === 'custom';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const input = inputOf(draft);
    const ok = id ? await data.update(id, input) : await data.create(input);
    setBusy(false);
    if (ok) onDone();
  };
  const projectOptions = [{ value: '', label: tr('sj.noProject') }, ...projects.map((p) => ({ value: p.projectId, label: p.name }))];

  return (
    <form onSubmit={(e) => { void submit(e); }} data-testid="sj-form" aria-label={tr(id ? 'sj.editTitle' : 'sj.newTitle')} className={`mb-3 grid gap-3 p-3 ${BOX}`}>
      <h3 className="m-0 text-compact font-medium text-app-text">{tr(id ? 'sj.editTitle' : 'sj.newTitle')}</h3>
      <Field label={tr('sj.name')}>
        <input required maxLength={120} className={INPUT} data-testid="sj-name-input" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder={tr('sj.namePlaceholder')} />
      </Field>
      <Field label={tr('sj.command')}>
        <input required className={`${INPUT} font-mono`} data-testid="sj-command" value={draft.commandLine} onChange={(e) => set('commandLine', e.target.value)} placeholder={tr('sj.commandPlaceholder')} />
      </Field>
      <Field label={tr('sj.cwd')}>
        <input required={!draft.projectId} className={`${INPUT} font-mono`} data-testid="sj-cwd" value={draft.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder={tr('sj.cwdPlaceholder')} />
      </Field>
      <div className="grid gap-1.5">
        <span className="text-mini text-app-text-secondary">{tr('sj.when')}</span>
        <Segmented<WhenKind> value={draft.whenKind} ariaLabel={tr('sj.when')} testId="sj-when" onChange={(v) => set('whenKind', v)} options={WHEN_KINDS.filter((value) => id === null || (value === 'once') === (initial.whenKind === 'once')).map((value) => ({ value, label: tr(`sj.when.${value}`) }))} />
        <div className="grid grid-cols-2 gap-2 @max-2xl:grid-cols-1">
          {(draft.whenKind === 'daily' || draft.whenKind === 'weekly') && (
            <Field label={tr('sj.time')}><input type="time" required className={INPUT} data-testid="sj-time" value={draft.time} onChange={(e) => set('time', e.target.value)} /></Field>
          )}
          {draft.whenKind === 'every' && (
            <Field label={tr('sj.everyLabel')}><input type="number" min={1} required className={INPUT} data-testid="sj-every" value={draft.everyMinutes} onChange={(e) => set('everyMinutes', e.target.value)} /></Field>
          )}
          {draft.whenKind === 'once' && (
            <Field label={tr('sj.onceLabel')}><input type="datetime-local" required className={INPUT} data-testid="sj-once" value={draft.onceAt} onChange={(e) => set('onceAt', e.target.value)} /></Field>
          )}
          {draft.whenKind === 'custom' && (
            <Field label={tr('sj.cron')}><input required className={`${INPUT} font-mono`} data-testid="sj-cron" value={draft.cron} onChange={(e) => set('cron', e.target.value)} placeholder="0 9 * * 1" /></Field>
          )}
          {needsZone && (
            <Field label={tr('sj.zone')}><input required className={INPUT} data-testid="sj-zone" value={draft.timeZone} onChange={(e) => set('timeZone', e.target.value)} /></Field>
          )}
        </div>
        <div className="text-mini" data-testid="sj-preview" aria-live="polite">
          {preview.ok ? (
            preview.at.length === 0 ? <span className="text-app-text-muted">{tr('sj.previewNone')}</span> : (
              <>
                <span className="text-app-text-secondary">{tr('sj.previewTitle')}</span>
                <ol className="m-0 mt-0.5 list-none p-0 text-app-text">
                  {preview.at.map((at) => <li key={at.toISOString()} data-testid="sj-preview-item" data-at={at.toISOString()}>{when(at)}</li>)}
                </ol>
              </>
            )
          ) : <span className="text-red-600 dark:text-red-400" data-testid="sj-preview-error">{preview.error}</span>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 @max-2xl:grid-cols-1">
        <div className="grid gap-1.5">
          <span className="text-mini text-app-text-secondary">{tr('sj.deliver')}</span>
          <Segmented value={draft.deliver} ariaLabel={tr('sj.deliver')} testId="sj-deliver" onChange={(v) => set('deliver', v)} options={[{ value: 'app', label: tr('sj.deliver.app') }, { value: 'owner', label: tr('sj.deliver.owner') }]} />
        </div>
        <div className="grid gap-1.5">
          <span className="text-mini text-app-text-secondary">{tr('sj.project')}</span>
          <Select value={draft.projectId} options={projectOptions} ariaLabel={tr('sj.project')} testId="sj-project" onChange={(v) => set('projectId', v)} />
        </div>
      </div>
      {data.error && <p role="alert" className="m-0 text-mini text-red-600 dark:text-red-400" data-testid="sj-form-error">{data.error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={() => { data.clearError(); onDone(); }}>{tr('sj.cancel')}</button>
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !preview.ok} data-testid="sj-save">{tr(id ? 'sj.save' : 'sj.create')}</button>
      </div>
    </form>
  );
}

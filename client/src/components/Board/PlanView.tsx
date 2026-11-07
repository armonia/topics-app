/**
 * Plan view: Project -> Area -> Milestone -> Card -> Sources, over the board.
 * It shows and acts; it recomputes nothing: counts, progress and signals come
 * from the server (`/api/plan`). No card is copied.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { Select } from '../Shared/Select';
import {
  createArea, createMilestone, fetchPlan, linkCard, mergeDuplicate, updateMilestone,
  type PlanArea, type PlanCard, type PlanMilestone, type PlanProject, type PlanProgress, type PlanSignal, type PlanTree,
} from './planApi';
import { SIGNAL_KEY, milestoneChoices, nodeKey, progressLabel, progressPct } from './planTree';

interface Props {
  onOpenTask: (id: string) => void;
  onOpenTopic?: (topicId: string) => void;
}

const INPUT = 'rounded-md border border-app-border bg-surface px-2 py-1 text-compact text-app-text outline-none focus-visible:border-primary';
const BTN = 'rounded px-2 py-1 text-compact text-app-text-secondary hover:bg-white/10';

function ProgressBar({ p }: { p: PlanProgress }) {
  return (
    <span className="flex shrink-0 items-center gap-2" data-testid="plan-progress">
      <span className="h-1.5 w-20 overflow-hidden rounded bg-black/10 dark:bg-white/10">
        <span className="block h-full bg-primary" style={{ width: `${progressPct(p)}%` }} />
      </span>
      <span className="w-10 text-mini text-app-text-muted">{progressLabel(p)}</span>
    </span>
  );
}

function SignalBadges({ signals }: { signals: readonly PlanSignal[] }) {
  const tr = useT();
  return <>{signals.map((s) => (
    <span key={s} data-testid={`plan-signal-${s}`} className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-mini text-amber-500">{tr(SIGNAL_KEY[s])}</span>
  ))}</>;
}

export function PlanView({ onOpenTask, onOpenTopic }: Props) {
  const tr = useT();
  const [tree, setTree] = useState<PlanTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeDone, setIncludeDone] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [form, setForm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTree(await fetchPlan(includeDone)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [includeDone]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (k: string) => setOpen((old) => { const n = new Set(old); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setForm(null); await load(); } catch (e) { setError((e as Error).message); }
  };

  const Row = ({ k, depth, title, p, signals, extra }: { k: string; depth: number; title: string; p: PlanProgress; signals?: readonly PlanSignal[]; extra?: React.ReactNode }) => (
    <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: depth * 16 }}>
      <button type="button" aria-expanded={open.has(k)} onClick={() => toggle(k)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {open.has(k) ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate text-compact font-medium">{title}</span>
      </button>
      {signals && <SignalBadges signals={signals} />}
      {extra}
      <ProgressBar p={p} />
    </div>
  );

  const renderCard = (c: PlanCard, project: PlanProject, depth: number) => (
    <div key={c.id} data-testid="plan-card" className="py-1" style={{ paddingLeft: depth * 16 }}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onOpenTask(c.id)} className="min-w-0 flex-1 truncate text-left text-compact hover:underline">{c.text}</button>
        <span className="shrink-0 text-mini text-app-text-muted">{c.status}</span>
        <SignalBadges signals={c.signals} />
        {c.duplicateOf && (
          <button type="button" className={BTN} onClick={() => void act(() => mergeDuplicate(c.projectId, c.id, c.duplicateOf!))}>{tr('plan.mergeInto')}</button>
        )}
        <Select<string>
          ariaLabel={tr('plan.moveTo')} placeholder={tr('plan.moveTo')} value=""
          options={milestoneChoices(project).map((m) => ({ value: m.id, label: m.label }))}
          onChange={(mid) => void act(() => linkCard(c.id, mid))}
        />
      </div>
      <div className="flex flex-wrap gap-x-3 pl-1 text-mini text-app-text-muted">
        {c.sources.map((s, i) => s.kind === 'session' && s.topicId && onOpenTopic ? (
          <button key={i} type="button" className="flex items-center gap-1 hover:underline" onClick={() => onOpenTopic(s.topicId!)}>
            <ExternalLink className="h-3 w-3" />{tr('plan.openSession')} ({s.label})
          </button>
        ) : s.url ? (
          <a key={i} href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.kind}: {s.label}</a>
        ) : <span key={i}>{s.kind}: {s.label}</span>)}
      </div>
    </div>
  );

  const renderMilestone = (m: PlanMilestone, project: PlanProject) => {
    const k = nodeKey('milestone', m.id);
    return (
      <div key={m.id} data-testid="plan-milestone">
        <Row k={k} depth={2} title={m.title} p={m.progress} signals={m.signals}
          extra={m.dueDate ? <span className="shrink-0 text-mini text-app-text-muted">{m.dueDate}</span> : undefined} />
        {open.has(k) && (
          <div className="pb-1">
            <div className="flex flex-wrap items-center gap-2 text-mini text-app-text-muted" style={{ paddingLeft: 3 * 16 }}>
              {m.expectedResult && <span>{m.expectedResult}</span>}
              {m.completionCriteria && <span>· {m.completionCriteria}</span>}
              <label className="flex items-center gap-1">{tr('plan.owner')}
                <input className={INPUT} defaultValue={m.owner ?? ''} onBlur={(e) => { if (e.target.value !== (m.owner ?? '')) void act(() => updateMilestone(m.id, { owner: e.target.value })); }} />
              </label>
              <label className="flex items-center gap-1">{tr('plan.due')}
                <input type="date" className={INPUT} defaultValue={m.dueDate ?? ''} onBlur={(e) => { if (e.target.value !== (m.dueDate ?? '')) void act(() => updateMilestone(m.id, { dueDate: e.target.value })); }} />
              </label>
            </div>
            {m.tasks.map((c) => renderCard(c, project, 3))}
          </div>
        )}
      </div>
    );
  };

  const MilestoneForm = ({ area }: { area: PlanArea }) => {
    const [v, setV] = useState({ title: '', expectedResult: '', completionCriteria: '', owner: '', dueDate: '' });
    const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
    return (
      <form className="flex flex-wrap items-end gap-2 py-1" style={{ paddingLeft: 2 * 16 }}
        onSubmit={(e) => { e.preventDefault(); if (v.title.trim()) void act(() => createMilestone({ areaId: area.id, ...v })); }}>
        <input className={INPUT} placeholder={tr('plan.milestoneTitle')} value={v.title} onChange={set('title')} autoFocus />
        <input className={INPUT} placeholder={tr('plan.expectedResult')} value={v.expectedResult} onChange={set('expectedResult')} />
        <input className={INPUT} placeholder={tr('plan.criteria')} value={v.completionCriteria} onChange={set('completionCriteria')} />
        <input className={INPUT} placeholder={tr('plan.owner')} value={v.owner} onChange={set('owner')} />
        <input type="date" className={INPUT} aria-label={tr('plan.due')} value={v.dueDate} onChange={set('dueDate')} />
        <button type="submit" className={BTN}>{tr('plan.create')}</button>
        <button type="button" className={BTN} onClick={() => setForm(null)}>{tr('plan.cancel')}</button>
      </form>
    );
  };

  const AreaForm = ({ project }: { project: PlanProject }) => {
    const [name, setName] = useState('');
    return (
      <form className="flex items-center gap-2 py-1" style={{ paddingLeft: 16 }}
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(() => createArea(project.projectId, name)); }}>
        <input className={INPUT} placeholder={tr('plan.areaName')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <button type="submit" className={BTN}>{tr('plan.create')}</button>
        <button type="button" className={BTN} onClick={() => setForm(null)}>{tr('plan.cancel')}</button>
      </form>
    );
  };

  return (
    <div data-testid="plan-view" className="min-h-0 flex-1 overflow-auto px-3 py-3 text-app-text sm:px-5">
      <div className="mx-auto max-w-5xl">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{tr('plan.title')}</h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-compact text-app-text-secondary">
              <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />{tr('plan.showDone')}
            </label>
            <button type="button" className={`${BTN} flex items-center gap-1`} onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />{tr('plan.refresh')}
            </button>
          </div>
        </div>
        {error && <p role="alert" className="mb-2 text-compact text-red-500">{tr('plan.error', { message: error })}</p>}
        {!tree && !error && <div className="flex items-center gap-2 py-6 text-compact text-app-text-secondary"><SparkLoader />{tr('plan.loading')}</div>}
        {tree && tree.projects.length === 0 && <p className="py-6 text-compact text-app-text-secondary">{tr('plan.empty')}</p>}
        {tree?.projects.map((project) => {
          const pk = nodeKey('project', project.projectId);
          const uk = nodeKey('unplaced', project.projectId);
          return (
            <section key={project.projectId} data-testid="plan-project" className="border-b border-app-border/50 py-1">
              <Row k={pk} depth={0} title={project.name} p={project.progress}
                extra={<button type="button" className={BTN} onClick={() => setForm(`area:${project.projectId}`)}>{tr('plan.newArea')}</button>} />
              {open.has(pk) && <>
                {form === `area:${project.projectId}` && <AreaForm project={project} />}
                {project.areas.map((a) => {
                  const ak = nodeKey('area', a.id);
                  return (
                    <div key={a.id} data-testid="plan-area">
                      <Row k={ak} depth={1} title={a.name} p={a.progress}
                        extra={<button type="button" className={BTN} onClick={() => setForm(`ms:${a.id}`)}>{tr('plan.newMilestone')}</button>} />
                      {open.has(ak) && <>
                        {form === `ms:${a.id}` && <MilestoneForm area={a} />}
                        {a.milestones.length === 0 && <p className="text-mini text-app-text-muted" style={{ paddingLeft: 2 * 16 }}>{tr('plan.noMilestones')}</p>}
                        {a.milestones.map((m) => renderMilestone(m, project))}
                      </>}
                    </div>
                  );
                })}
                {(project.unplaced.tasks.length > 0 || project.unplaced.progress.total > 0) && (
                  <div data-testid="plan-unplaced">
                    <Row k={uk} depth={1} title={tr('plan.unplaced')} p={project.unplaced.progress} />
                    {open.has(uk) && project.unplaced.tasks.map((c) => renderCard(c, project, 2))}
                  </div>
                )}
              </>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

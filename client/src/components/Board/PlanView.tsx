/**
 * Plan view: Project -> Area -> Milestone -> Card -> Sources, over the board.
 * It shows and acts; it recomputes nothing: counts, progress and signals come
 * from the server (`/api/plan`). No card is copied.
 *
 * The numbers are OPEN work: a board with 900 closed cards is not «935/991
 * done», it is «56 open». Done cards only count inside a milestone, where
 * they are the progress of a result.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { Select } from '../Shared/Select';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { StatusIcon } from './atoms';
import {
  createArea, createMilestone, fetchPlan, linkCard, mergeDuplicate, updateMilestone,
  type PlanArea, type PlanCard, type PlanMilestone, type PlanProject, type PlanProgress, type PlanSignal, type PlanTree,
} from './planApi';
import { SIGNAL_KEY, milestoneChoices, nodeKey, openOf, progressLabel, progressPct } from './planTree';

interface Props {
  onOpenTask: (id: string) => void;
  onOpenTopic?: (topicId: string) => void;
}

const INPUT = 'rounded-md border border-app-border bg-surface px-2 py-1 text-compact text-app-text outline-none focus-visible:border-primary';
const BTN = 'rounded px-2 py-1 text-compact text-app-text-secondary hover:bg-app-hover';
/** Row actions appear on hover or focus, so the tree reads as a list and not as a toolbar. */
const HOVER_ACTION = `${BTN} flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100`;
const INDENT = 18;

function ProgressBar({ p }: { p: PlanProgress }) {
  return (
    <span className="flex shrink-0 items-center gap-2" data-testid="plan-progress">
      <span className="h-1 w-16 overflow-hidden rounded-full bg-app-border">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${progressPct(p)}%` }} />
      </span>
      <span className="w-9 text-right text-mini tabular-nums text-app-text-muted">{progressLabel(p)}</span>
    </span>
  );
}

function OpenCount({ n }: { n: number }) {
  const tr = useT();
  return <span className="shrink-0 text-mini tabular-nums text-app-text-muted" data-testid="plan-open">{tr('plan.openCount', { n })}</span>;
}

function SignalBadges({ signals }: { signals: readonly PlanSignal[] }) {
  const tr = useT();
  return <>{signals.map((s) => (
    <span key={s} data-testid={`plan-signal-${s}`} className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-mini text-amber-600 dark:text-amber-400">{tr(SIGNAL_KEY[s])}</span>
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

  const Row = ({ k, depth, lead, title, meta, actions, strong }: {
    k: string; depth: number; lead?: ReactNode; title: string; meta?: ReactNode; actions?: ReactNode; strong?: boolean;
  }) => (
    <div className="group flex min-h-8 items-center gap-2 rounded-md pr-2 hover:bg-app-hover/60" style={{ paddingLeft: depth * INDENT }}>
      <button type="button" aria-expanded={open.has(k)} onClick={() => toggle(k)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
        {open.has(k) ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-app-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />}
        {lead}
        <span className={`truncate text-compact ${strong ? 'font-semibold text-app-text-heading' : 'font-medium'}`}>{title}</span>
      </button>
      {actions}
      {meta}
    </div>
  );

  const renderCard = (c: PlanCard, project: PlanProject, depth: number) => {
    const choices = milestoneChoices(project);
    return (
      <div key={c.id} data-testid="plan-card" className="group rounded-md py-1 pr-2 hover:bg-app-hover/60" style={{ paddingLeft: depth * INDENT + 4 }}>
        <div className="flex items-center gap-2">
          <StatusIcon status={c.status as Parameters<typeof StatusIcon>[0]['status']} />
          <button type="button" onClick={() => onOpenTask(c.id)} className="min-w-0 flex-1 truncate text-left text-compact text-app-text hover:underline">{c.text}</button>
          <SignalBadges signals={c.signals} />
          {c.duplicateOf && (
            <button type="button" className={BTN} onClick={() => void act(() => mergeDuplicate(c.projectId, c.id, c.duplicateOf!))}>{tr('plan.mergeInto')}</button>
          )}
          {choices.length > 0 && (
            <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
              <Select<string>
                ariaLabel={tr('plan.moveTo')} placeholder={tr('plan.moveTo')} value=""
                options={choices.map((m) => ({ value: m.id, label: m.label }))}
                onChange={(mid) => void act(() => linkCard(c.id, mid))}
              />
            </span>
          )}
        </div>
        {c.sources.some((s) => !s.implicit || s.kind === 'topic' || s.url) && (
          <div className="flex flex-wrap gap-x-3 pl-6 text-mini text-app-text-muted">
            {c.sources.map((s, i) => s.kind === 'topic' && s.topicId && onOpenTopic ? (
              <button key={i} type="button" className="flex items-center gap-1 hover:underline" onClick={() => onOpenTopic(s.topicId!)}>
                <ExternalLink className="h-3 w-3" />{tr('plan.openSession')}
              </button>
            ) : s.url ? (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline"><ExternalLink className="h-3 w-3" />{s.label}</a>
            ) : !s.implicit ? <span key={i}>{s.label}</span> : null)}
          </div>
        )}
      </div>
    );
  };

  const renderMilestone = (m: PlanMilestone, project: PlanProject) => {
    const k = nodeKey('milestone', m.id);
    return (
      <div key={m.id} data-testid="plan-milestone">
        <Row k={k} depth={2} title={m.title}
          meta={<>
            <SignalBadges signals={m.signals} />
            {m.targetDate && <span className="shrink-0 text-mini tabular-nums text-app-text-muted">{new Date(`${m.targetDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
            <ProgressBar p={m.progress} />
          </>} />
        {open.has(k) && (
          <div className="pb-1">
            {(m.expectedResult || m.completionCriteria) && (
              <p className="py-0.5 text-mini text-app-text-secondary" style={{ paddingLeft: 3 * INDENT + 4 }}>
                {m.expectedResult}{m.expectedResult && m.completionCriteria ? ' · ' : ''}{m.completionCriteria}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 py-0.5 text-mini text-app-text-muted" style={{ paddingLeft: 3 * INDENT + 4 }}>
              <label className="flex items-center gap-1">{tr('plan.owner')}
                <input className={INPUT} defaultValue={m.owner ?? ''} onBlur={(e) => { if (e.target.value !== (m.owner ?? '')) void act(() => updateMilestone(m.id, { owner: e.target.value })); }} />
              </label>
              <label className="flex items-center gap-1">{tr('plan.due')}
                <input type="date" className={INPUT} defaultValue={m.targetDate ?? ''} onBlur={(e) => { if (e.target.value !== (m.targetDate ?? '')) void act(() => updateMilestone(m.id, { targetDate: e.target.value })); }} />
              </label>
            </div>
            {m.tasks.length === 0
              ? <p className="py-1 text-mini text-app-text-muted" style={{ paddingLeft: 3 * INDENT + 4 }}>{tr('plan.milestoneEmpty')}</p>
              : m.tasks.map((c) => renderCard(c, project, 3))}
          </div>
        )}
      </div>
    );
  };

  const MilestoneForm = ({ area }: { area: PlanArea }) => {
    const [v, setV] = useState({ title: '', expectedResult: '', completionCriteria: '', owner: '', targetDate: '' });
    const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
    return (
      <form className="flex flex-wrap items-end gap-2 py-1" style={{ paddingLeft: 2 * INDENT }}
        onSubmit={(e) => { e.preventDefault(); if (v.title.trim()) void act(() => createMilestone({ areaId: area.id, ...v })); }}>
        <input className={INPUT} placeholder={tr('plan.milestoneTitle')} value={v.title} onChange={set('title')} autoFocus />
        <input className={INPUT} placeholder={tr('plan.expectedResult')} value={v.expectedResult} onChange={set('expectedResult')} />
        <input className={INPUT} placeholder={tr('plan.criteria')} value={v.completionCriteria} onChange={set('completionCriteria')} />
        <input className={INPUT} placeholder={tr('plan.owner')} value={v.owner} onChange={set('owner')} />
        <input type="date" className={INPUT} aria-label={tr('plan.due')} value={v.targetDate} onChange={set('targetDate')} />
        <button type="submit" className={BTN}>{tr('plan.create')}</button>
        <button type="button" className={BTN} onClick={() => setForm(null)}>{tr('plan.cancel')}</button>
      </form>
    );
  };

  const AreaForm = ({ project }: { project: PlanProject }) => {
    const [name, setName] = useState('');
    return (
      <form className="flex items-center gap-2 py-1" style={{ paddingLeft: INDENT }}
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(() => createArea(project.projectId, name)); }}>
        <input className={INPUT} placeholder={tr('plan.areaName')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <button type="submit" className={BTN}>{tr('plan.create')}</button>
        <button type="button" className={BTN} onClick={() => setForm(null)}>{tr('plan.cancel')}</button>
      </form>
    );
  };

  return (
    <div data-testid="plan-view" className="min-h-0 flex-1 overflow-auto px-3 py-3 text-app-text sm:px-5">
      <div className="mx-auto max-w-4xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-title font-semibold">{tr('plan.title')}</h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-compact text-app-text-secondary">
              <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />{tr('plan.showDone')}
            </label>
            <button type="button" className={`${BTN} flex items-center gap-1`} onClick={() => void load()} aria-label={tr('plan.refresh')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {error && <p role="alert" className="mb-2 text-compact text-red-500">{tr('plan.error', { message: error })}</p>}
        {!tree && !error && <div className="flex items-center gap-2 py-6 text-compact text-app-text-secondary"><SparkLoader />{tr('plan.loading')}</div>}
        {tree && tree.projects.length === 0 && <p className="py-6 text-compact text-app-text-secondary">{tr('plan.empty')}</p>}
        {tree?.projects.map((project) => {
          const pk = nodeKey('project', project.projectId);
          const uk = nodeKey('unplaced', project.projectId);
          const unplacedOpen = openOf(project.unplaced.progress);
          return (
            <section key={project.projectId} data-testid="plan-project" className="border-b border-app-border/60 py-0.5 last:border-b-0">
              <Row k={pk} depth={0} strong title={project.name}
                lead={project.path ? <ProjectFavicon path={project.path} size={14} className="shrink-0" /> : undefined}
                actions={<button type="button" className={HOVER_ACTION} onClick={() => { setForm(`area:${project.projectId}`); setOpen((o) => new Set(o).add(pk)); }}><Plus className="h-3 w-3" />{tr('plan.newArea')}</button>}
                meta={<OpenCount n={project.openCount} />} />
              {open.has(pk) && <div className="pb-1">
                {form === `area:${project.projectId}` && <AreaForm project={project} />}
                {project.areas.map((a) => {
                  const ak = nodeKey('area', a.id);
                  return (
                    <div key={a.id} data-testid="plan-area">
                      <Row k={ak} depth={1} title={a.name}
                        actions={<button type="button" className={HOVER_ACTION} onClick={() => { setForm(`ms:${a.id}`); setOpen((o) => new Set(o).add(ak)); }}><Plus className="h-3 w-3" />{tr('plan.newMilestone')}</button>}
                        meta={<OpenCount n={openOf(a.progress)} />} />
                      {open.has(ak) && <>
                        {form === `ms:${a.id}` && <MilestoneForm area={a} />}
                        {a.milestones.length === 0 && form !== `ms:${a.id}` && <p className="py-1 text-mini text-app-text-muted" style={{ paddingLeft: 2 * INDENT + 4 }}>{tr('plan.noMilestones')}</p>}
                        {a.milestones.map((m) => renderMilestone(m, project))}
                      </>}
                    </div>
                  );
                })}
                {project.unplaced.tasks.length > 0 && (
                  <div data-testid="plan-unplaced">
                    <Row k={uk} depth={1} title={tr('plan.unplaced')} meta={<OpenCount n={unplacedOpen} />} />
                    {open.has(uk) && project.unplaced.tasks.map((c) => renderCard(c, project, 2))}
                  </div>
                )}
              </div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

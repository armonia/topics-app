/**
 * Plan view: one bento tile per project, laid out in as many columns as the
 * pane allows. Milestones and their cards show at once, without levels to
 * open: the reader sees the plan, not a tree to explore. Areas are a small
 * caption inside the tile. It shows and acts; it recomputes nothing: counts,
 * progress and signals come from the server (`/api/plan`).
 *
 * The numbers are OPEN work: a board with 900 closed cards is not «935/991
 * done», it is «56 open». Done cards only count inside a milestone, where
 * they are the progress of a result.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, Inbox, Plus, RefreshCw, SquareKanban } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { Select } from '../Shared/Select';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import { StatusIcon } from './atoms';
import { ActivityBadge, NeedsYouBox } from './PlanTileParts';
import {
  createArea, createMilestone, fetchPlan, linkCard, mergeDuplicate, updateMilestone,
  type PlanArea, type PlanCard, type PlanMilestone, type PlanProject, type PlanProgress, type PlanSignal, type PlanTree,
} from './planApi';
import { SIGNAL_KEY, milestoneChoices, openOf, progressLabel, progressPct, sortForPlan } from './planTree';

interface Props {
  onOpenTask: (id: string) => void;
  onOpenTopic?: (topicId: string) => void;
  /**
   * The board's own compact card for a task the board has loaded, so a card
   * looks the same in the Plan and on the board; null for one it has not
   * (a done card, a card of a board not in the feed), drawn as the Plan's row.
   */
  boardCard?: (taskId: string) => ReactNode | null;
}

const INPUT = 'rounded-md border border-app-border bg-surface px-2 py-1 text-compact text-app-text outline-none focus-visible:border-primary';
const BTN = 'rounded px-2 py-1 text-compact text-app-text-secondary hover:bg-app-hover';
/** Tile actions appear on hover or focus, so the tile reads as content and not as a toolbar. */
const HOVER_ACTION = 'flex items-center gap-1 rounded px-1.5 py-0.5 text-mini text-app-text-muted hover:bg-app-hover hover:text-app-text opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 coarse:opacity-100';
/** Cards shown per milestone before «+N»: a tile stays a glance, the rest is one click away. */
const CARDS_SHOWN = 6;

function ProgressBar({ p }: { p: PlanProgress }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" data-testid="plan-progress">
      <span className="h-1 w-12 overflow-hidden rounded-full bg-app-border">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${progressPct(p)}%` }} />
      </span>
      <span className="text-mini tabular-nums text-app-text-muted">{progressLabel(p)}</span>
    </span>
  );
}

function OpenCount({ n }: { n: number }) {
  const tr = useT();
  return <span className="shrink-0 text-mini tabular-nums text-app-text-muted" data-testid="plan-open">{tr('plan.openCount', { n })}</span>;
}

/**
 * The project's open work, roots and sub-cards apart: the Kanban shows only
 * the roots, so one summed number read as «cards on the board» and was not.
 */
function ProjectOpenCount({ roots, subs }: { roots: number; subs: number }) {
  const tr = useT();
  const rootsLabel = tr(roots === 1 ? 'plan.openRoots.one' : 'plan.openRoots.many', { n: roots });
  const subsLabel = subs > 0 ? tr(subs === 1 ? 'plan.openSubs.one' : 'plan.openSubs.many', { n: subs }) : null;
  return (
    <span className="shrink-0 text-mini tabular-nums text-app-text-muted" data-testid="plan-open" title={tr('plan.openTotal.hint', { roots, subs })}>
      {subsLabel ? `${rootsLabel} · ${subsLabel}` : rootsLabel}
    </span>
  );
}

/** A board with no folder (a virtual board, or cards with no project) gets a neutral glyph, so headers stay aligned. */
function ProjectGlyph({ project }: { project: PlanProject }) {
  if (project.path) return <ProjectFavicon path={project.path} size={16} className="shrink-0" />;
  const Glyph = project.projectId === '_none' ? Inbox : SquareKanban;
  return <Glyph className="h-4 w-4 shrink-0 text-app-text-muted" aria-hidden />;
}

function SignalBadges({ signals }: { signals: readonly PlanSignal[] }) {
  const tr = useT();
  return <>{signals.map((s) => (
    <span key={s} data-testid={`plan-signal-${s}`} className={`shrink-0 whitespace-nowrap rounded bg-amber-500/15 px-1 py-px text-mini leading-tight ${SEGNALE_ATTESA}`}>{tr(SIGNAL_KEY[s])}</span>
  ))}</>;
}

const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function PlanView({ onOpenTask, onOpenTopic, boardCard }: Props) {
  const tr = useT();
  const [tree, setTree] = useState<PlanTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeDone, setIncludeDone] = useState(false);
  /** Milestones whose details (result, owner, date) are open, and lists shown in full. */
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

  const renderCard = (c: PlanCard, project: PlanProject, nested = false): ReactNode => {
    const choices = milestoneChoices(project);
    const links = c.sources.filter((s) => (s.kind === 'topic' && s.topicId && onOpenTopic) || s.url);
    // What only the Plan does with a card: its signals, the merge of a duplicate, its sources, the move to a milestone.
    const actions = (
      <>
        <SignalBadges signals={c.signals} />
        {c.duplicateOf && (
          <button type="button" className="shrink-0 rounded px-1 text-mini text-app-text-secondary hover:bg-app-hover" onClick={() => void act(() => mergeDuplicate(c.projectId, c.id, c.duplicateOf!))}>{tr('plan.mergeInto')}</button>
        )}
        {links.map((s, i) => s.kind === 'topic' ? (
          <button key={i} type="button" aria-label={tr('plan.openSession')} title={tr('plan.openSession')} className="shrink-0 text-app-text-muted opacity-0 hover:text-app-text group-hover/card:opacity-100 focus-visible:opacity-100 coarse:opacity-100" onClick={() => onOpenTopic!(s.topicId!)}>
            <ExternalLink className="h-3 w-3" />
          </button>
        ) : (
          <a key={i} href={s.url!} target="_blank" rel="noreferrer" title={s.label} className="shrink-0 truncate text-mini text-app-text-muted hover:underline max-w-[7rem]">{s.label}</a>
        ))}
        {/* Over the row, not beside it: hidden, it would still eat the title's width. */}
        {choices.length > 0 && (
          <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
            <Select<string>
              className="bg-surface shadow-sm"
              ariaLabel={tr('plan.moveTo')} placeholder={tr('plan.moveTo')} value=""
              options={choices.map((m) => ({ value: m.id, label: m.label }))}
              onChange={(mid) => void act(() => linkCard(c.id, mid))}
            />
          </span>
        )}
      </>
    );
    const face = boardCard?.(c.id) ?? null;
    return (
      <div key={c.id}>
        {face ? (
          // THE BOARD'S CARD, compact: one face for a card wherever it is drawn. The Plan's own gestures ride under it.
          <div data-testid="plan-card" data-face="board" className={`group/card ${nested ? 'pl-5' : ''}`}>
            {face}
            {(c.signals.length > 0 || c.duplicateOf || links.length > 0 || choices.length > 0) && (
              <div role="group" className="relative flex min-h-[22px] items-center gap-1.5 px-1 pt-0.5" aria-label={tr('plan.card.actions')}>{actions}</div>
            )}
          </div>
        ) : (
          <div data-testid="plan-card" className={`group/card relative flex items-center gap-1.5 rounded-md py-0.5 pr-1 hover:bg-app-hover/60 ${nested ? 'pl-5' : 'pl-1'}`}>
            <StatusIcon status={c.status} className="h-3 w-3" />
            <button type="button" onClick={() => onOpenTask(c.id)} title={c.text} className="min-w-0 flex-1 truncate text-left text-compact text-app-text hover:underline">{c.text}</button>
            {actions}
          </div>
        )}
        {c.children?.map((child) => renderCard(child, project, true))}
      </div>
    );
  };

  /** A list of cards that stays short: the busiest first, the rest behind «+N». */
  const CardList = ({ id, cards, project }: { id: string; cards: PlanCard[]; project: PlanProject }) => {
    const all = open.has(`all:${id}`);
    const sorted = sortForPlan(cards);
    const shown = all ? sorted : sorted.slice(0, CARDS_SHOWN);
    return (
      <div className={`flex flex-col ${boardCard ? 'gap-1.5' : ''}`}>
        {shown.map((c) => renderCard(c, project))}
        {sorted.length > CARDS_SHOWN && (
          <button type="button" className="self-start rounded px-1 py-0.5 text-mini text-app-text-muted hover:bg-app-hover hover:text-app-text" onClick={() => toggle(`all:${id}`)}>
            {all ? tr('plan.showFewer') : tr('plan.showMore', { n: sorted.length - CARDS_SHOWN })}
          </button>
        )}
      </div>
    );
  };

  const renderMilestone = (m: PlanMilestone, project: PlanProject) => {
    const k = `ms:${m.id}`;
    return (
      <div key={m.id} data-testid="plan-milestone" className="rounded-lg bg-app-hover/40 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <button type="button" aria-expanded={open.has(k)} onClick={() => toggle(k)} className="min-w-0 flex-1 truncate text-left text-compact font-medium text-app-text-heading hover:underline">{m.title}</button>
          <ActivityBadge activity={m.activity} />
          {m.targetDate && <span className="shrink-0 text-mini tabular-nums text-app-text-muted">{shortDate(m.targetDate)}</span>}
          <ProgressBar p={m.progress} />
        </div>
        {open.has(k) && (
          <div className="mt-1 flex flex-col gap-1 text-mini text-app-text-secondary">
            {(m.expectedResult || m.completionCriteria) && (
              <p>{m.expectedResult}{m.expectedResult && m.completionCriteria ? ' · ' : ''}{m.completionCriteria}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-app-text-muted">
              <label className="flex items-center gap-1">{tr('plan.owner')}
                <input className={INPUT} defaultValue={m.owner ?? ''} onBlur={(e) => { if (e.target.value !== (m.owner ?? '')) void act(() => updateMilestone(m.id, { owner: e.target.value })); }} />
              </label>
              <label className="flex items-center gap-1">{tr('plan.due')}
                <input type="date" className={INPUT} defaultValue={m.targetDate ?? ''} onBlur={(e) => { if (e.target.value !== (m.targetDate ?? '')) void act(() => updateMilestone(m.id, { targetDate: e.target.value })); }} />
              </label>
            </div>
          </div>
        )}
        <div className="mt-1">
          {m.tasks.length === 0
            ? <p className="px-1 text-mini text-app-text-muted">{tr('plan.milestoneEmpty')}</p>
            : <CardList id={m.id} cards={m.tasks} project={project} />}
        </div>
      </div>
    );
  };

  const MilestoneForm = ({ area }: { area: PlanArea }) => {
    const [v, setV] = useState({ title: '', expectedResult: '', completionCriteria: '', owner: '', targetDate: '' });
    const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
    return (
      <form className="flex flex-col gap-1.5 rounded-lg border border-app-border p-2"
        onSubmit={(e) => { e.preventDefault(); if (v.title.trim()) void act(() => createMilestone({ areaId: area.id, ...v })); }}>
        <input className={INPUT} placeholder={tr('plan.milestoneTitle')} value={v.title} onChange={set('title')} autoFocus />
        <input className={INPUT} placeholder={tr('plan.expectedResult')} value={v.expectedResult} onChange={set('expectedResult')} />
        <input className={INPUT} placeholder={tr('plan.criteria')} value={v.completionCriteria} onChange={set('completionCriteria')} />
        <div className="flex gap-1.5">
          <input className={`${INPUT} min-w-0 flex-1`} placeholder={tr('plan.owner')} value={v.owner} onChange={set('owner')} />
          <input type="date" className={INPUT} aria-label={tr('plan.due')} value={v.targetDate} onChange={set('targetDate')} />
        </div>
        <div className="flex justify-end gap-1">
          <button type="button" className={BTN} onClick={() => setForm(null)}>{tr('plan.cancel')}</button>
          <button type="submit" className={BTN}>{tr('plan.create')}</button>
        </div>
      </form>
    );
  };

  const AreaForm = ({ project }: { project: PlanProject }) => {
    const [name, setName] = useState('');
    return (
      <form className="flex items-center gap-1.5"
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(() => createArea(project.projectId, name)); }}>
        <input className={`${INPUT} min-w-0 flex-1`} placeholder={tr('plan.areaName')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <button type="submit" className={BTN}>{tr('plan.create')}</button>
        <button type="button" className={BTN} onClick={() => setForm(null)}>{tr('plan.cancel')}</button>
      </form>
    );
  };

  const renderProject = (project: PlanProject) => {
    const unplacedOpen = openOf(project.unplaced.progress);
    // Areas with nothing in them still show (they are the plan being built);
    // the caption is the only level left between the project and its milestones.
    return (
      <section key={project.projectId} data-testid="plan-project"
        className="group/tile mb-3 flex break-inside-avoid flex-col gap-2 rounded-xl border border-app-border bg-surface p-3">
        <header className="flex items-center gap-2">
          <ProjectGlyph project={project} />
          <h3 className="min-w-0 flex-1 truncate text-compact font-semibold text-app-text-heading">{project.name}</h3>
          <button type="button" className={HOVER_ACTION} onClick={() => setForm(`area:${project.projectId}`)}><Plus className="h-3 w-3" />{tr('plan.newArea')}</button>
          <ActivityBadge activity={project.activity} />
          <ProjectOpenCount roots={project.openCount} subs={project.openSubCount} />
        </header>
        <NeedsYouBox needs={project.needsYou} onOpenTask={onOpenTask} />
        {form === `area:${project.projectId}` && <AreaForm project={project} />}
        {project.areas.map((a) => (
          <div key={a.id} data-testid="plan-area" className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-mini font-medium uppercase tracking-wide text-app-text-muted">{a.name}</span>
              <button type="button" className={HOVER_ACTION} onClick={() => setForm(`ms:${a.id}`)}><Plus className="h-3 w-3" />{tr('plan.newMilestone')}</button>
            </div>
            {form === `ms:${a.id}` && <MilestoneForm area={a} />}
            {a.milestones.length === 0 && form !== `ms:${a.id}` && <p className="text-mini text-app-text-muted">{tr('plan.noMilestones')}</p>}
            {a.milestones.map((m) => renderMilestone(m, project))}
          </div>
        ))}
        {project.unplaced.tasks.length > 0 && (
          <div data-testid="plan-unplaced" className="flex flex-col gap-1">
            {project.areas.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-mini font-medium uppercase tracking-wide text-app-text-muted">{tr('plan.unplaced')}</span>
                <OpenCount n={unplacedOpen} />
              </div>
            )}
            <CardList id={`unplaced:${project.projectId}`} cards={project.unplaced.tasks} project={project} />
          </div>
        )}
      </section>
    );
  };

  const waiting = tree?.projects.reduce((n, p) => n + p.needsYou.length, 0) ?? 0;
  return (
    <div data-testid="plan-view" className="min-h-0 flex-1 overflow-auto px-3 py-3 text-app-text sm:px-5">
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <h2 className="text-title font-semibold">{tr('plan.title')}</h2>
            {waiting > 0 && <span data-testid="plan-needs-total" className={`truncate text-compact font-medium ${SEGNALE_ATTESA}`}>{tr('plan.needsYou.total', { n: waiting })}</span>}
          </div>
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
        {/* Columns by width, not by breakpoint: the pane is narrower than the window whenever a chat sits beside it. */}
        {tree && tree.projects.length > 0 && (
          <div data-testid="plan-grid" style={{ columnWidth: 340, columnGap: 12 }}>
            {tree.projects.map(renderProject)}
          </div>
        )}
      </div>
    </div>
  );
}

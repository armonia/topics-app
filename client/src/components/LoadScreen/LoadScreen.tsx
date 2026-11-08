/**
 * THE LOAD SCREEN: what a machine that takes the load (today the Windows PC)
 * shows on its own monitor, at `/schermo/<machine id>` (`/schermo` for this
 * machine). It replaces the PowerShell window of the PC's screen script.
 *
 * The app's own pieces, not a page with styles of its own: the gauges and the
 * process rows of the machine's Processes view (`Gauge`, `ProcessRowView`), the
 * pace dial of the accounts view (`PaceDial`), the board's status glyph and
 * project favicon. The page is laid out at `LAYOUT_WIDTH` and enlarged with
 * CSS zoom to the screen, so the same components read from across a room.
 *
 * Cheap by construction, because the PC must not count it as work: no
 * animation, no transition, no socket. Four reads every POLL_MS while the
 * page is visible (the pace every PACE_POLL_MS), a clock that moves once a
 * minute's fraction. Read-only: nothing on it starts, stops or changes.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, CheckCircle2, CircleAlert, CircleDashed, CloudOff, Cpu, Gauge as GaugeIcon, Moon, Monitor, Server, Zap, type LucideIcon } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import LOAD_SCREEN_IT from '../../lib/i18n-loadscreen-it';
import LOAD_SCREEN_EN from '../../lib/i18n-loadscreen-en';
import { apiFetch } from '../../lib/shell/net';
import { startVisibleInterval } from '../../state/documentVisibility';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { formatMem, formatPct, macGauges, pcView } from '../../lib/machineProcesses';
import { readBoardAccounts, type BoardAccount } from '../../lib/accountInsights';
import { hubProse } from '../../lib/accountQuotas';
import { projectIdForPath } from '../../../../shared/board';
import {
  cardsOn, elapsedParts, projectLabel, readReadout, readoutRows, screenZoom, sleepView,
  type Readout, type ScreenCard, type ScreenJob, type ScreenOutcome, type SleepView,
} from '../../lib/loadScreen';
import { Gauge, ProcessRowView } from '../Processes/MachineProcessesPane';
import { PaceDial } from '../Accounts/AccountInsights';
import { StatusIcon } from '../Board/atoms';
import { ProjectFavicon } from '../Shared/ProjectFavicon';

addCatalogue('it', LOAD_SCREEN_IT);
addCatalogue('en', LOAD_SCREEN_EN);

type Tr = ReturnType<typeof useT>;

/** The PC's readout is cached 20 s server side and the hub's census 30 s: reading faster buys nothing. */
const POLL_MS = 20_000;
const PACE_POLL_MS = 60_000;
const TOP_ROWS = 8;
/** The right column's lists, capped so it never clips a row in half at 1080 px. */
const RUNNING_ROWS = 3;
const PACE_ROWS = 3;
const OUTCOME_ROWS = 3;
const NOOP = () => {};

const SECTION = 'min-w-0 overflow-hidden rounded border border-app-border bg-surface';
const SECTION_HEAD = 'flex h-[38px] items-center gap-2 border-b border-app-border-subtle px-2.5';
const FAINT = 'text-app-text-faint';
const CHIP = 'flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-black/[0.05] px-1.5 py-0.5 text-mini leading-4 text-app-text-secondary dark:bg-white/10';
const TONE = { ok: 'text-app-text-secondary', warn: WARNING_TEXT, bad: DANGER_TEXT, mut: 'text-app-text-secondary' } as const;

interface Reads {
  readout: Readout | null;
  machines: unknown;
  tasks: unknown;
  projects: Map<string, { name: string; path: string }>;
  at: number | null;
  hubFailing: boolean;
}

async function readJson(path: string): Promise<unknown> {
  try {
    const r = await apiFetch(path);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function projectsOf(raw: unknown): Map<string, { name: string; path: string }> {
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { projects?: unknown }).projects) ? (raw as { projects: unknown[] }).projects : [];
  const out = new Map<string, { name: string; path: string }>();
  for (const p of rows) {
    if (!p || typeof p !== 'object') continue;
    const { id, name, path } = p as { id?: unknown; name?: unknown; path?: unknown };
    // Keyed by BOARD id: a card names its board, a hash of the folder, not the project row's id.
    if (typeof id === 'string' && typeof path === 'string' && path) out.set(projectIdForPath(path), { name: typeof name === 'string' ? name : id, path });
  }
  return out;
}

function useScreenReads(machine: string | null): Reads {
  const [reads, setReads] = useState<Reads>({ readout: null, machines: null, tasks: null, projects: new Map(), at: null, hubFailing: false });
  useEffect(() => {
    let alive = true;
    const q = machine ? `?machine=${encodeURIComponent(machine)}` : '';
    const read = async () => {
      const [readout, machines, tasks, projects] = await Promise.all([
        readJson(`/api/system/machine-readout${q}`), readJson('/api/hub/machines'),
        readJson('/api/all-boards/tasks?status=in_progress'), readJson('/api/projects'),
      ]);
      if (!alive) return;
      // A failed read keeps the last good one; the band says the hub is gone.
      setReads((prev) => ({
        readout: readout ? readReadout(readout) : prev.readout,
        machines: machines ?? prev.machines,
        tasks: tasks ?? prev.tasks,
        projects: projects ? projectsOf(projects) : prev.projects,
        at: Date.now(),
        hubFailing: machines === null,
      }));
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, [machine]);
  return reads;
}

function usePace(): BoardAccount[] | null {
  const [board, setBoard] = useState<BoardAccount[] | null>(null);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const raw = await readJson('/api/hub/board');
      if (alive && raw) setBoard(readBoardAccounts(raw));
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, PACE_POLL_MS);
    return () => { alive = false; stop(); };
  }, []);
  return board;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), ms), [ms]);
  return now;
}

/** The zoom that fits the layout to the window, recomputed only when the window changes size. */
function useZoom(): { zoom: number; width: number; height: number } {
  const measure = () => {
    const zoom = screenZoom(window.innerWidth);
    return { zoom, width: window.innerWidth / zoom, height: window.innerHeight / zoom };
  };
  const [z, setZ] = useState(measure);
  useEffect(() => {
    const on = () => setZ(measure());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return z;
}

function clock(ms: number, locale: string): string {
  return new Date(ms).toLocaleTimeString(locale === 'en' ? 'en-GB' : 'it-IT', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function elapsed(ms: number, tr: Tr): string {
  if (ms < 60_000) return tr('loadScreen.running.lessThanMinute');
  const { h, m } = elapsedParts(ms);
  return tr('loadScreen.running.since', { time: h > 0 ? tr('loadScreen.running.hours', { h, m: String(m).padStart(2, '0') }) : tr('loadScreen.running.minutes', { m }) });
}

export function LoadScreen({ machine }: { machine: string | null }) {
  const tr = useT();
  const locale = useLocale();
  const { zoom, width, height } = useZoom();
  const reads = useScreenReads(machine);
  const pace = usePace();
  const now = useNow(POLL_MS);
  const r = reads.readout;
  const local = r?.machine.local ?? machine === null;
  const cards = useMemo(() => cardsOn(reads.tasks, r?.machine.id ?? machine, local), [reads.tasks, r, machine, local]);
  const jobs = r?.screen?.jobs ?? [];
  const view = r ? sleepView(r, cards.length, now) : null;
  const pc = useMemo(() => (local ? null : pcView(reads.machines)), [reads.machines, local]);
  const mac = useMemo(() => (local ? macGauges(null, reads.machines, null) : null), [reads.machines, local]);
  const name = r?.machine.name || (local ? tr('processes.mac') : tr('processes.pc'));

  useEffect(() => { document.title = `${name} · ${tr('loadScreen.title')}`; }, [name, tr]);

  return (
    <div className="h-full overflow-hidden bg-app-bg text-app-text" data-testid="load-screen" data-state={view?.kind ?? 'reading'}>
      <div className="@container flex flex-col gap-3 overflow-hidden px-6 pb-5 pt-4" style={{ zoom, width, height }}>
        <header className="flex flex-none items-center gap-3">
          {local ? <Monitor size={22} className="flex-none text-app-text-secondary" aria-hidden="true" /> : <Cpu size={22} className="flex-none text-app-text-secondary" aria-hidden="true" />}
          <h1 className="m-0 text-headline font-bold text-app-text-heading" data-testid="load-screen-name">{name}</h1>
          {pc && <PcStatePill state={pc.state} />}
          <span className="flex-1" />
          <span className={`text-compact tabular-nums ${FAINT}`} data-testid="load-screen-updated">
            {reads.at === null ? tr('loadScreen.reading') : tr('loadScreen.updated', { time: clock(reads.at, locale) })}
          </span>
          <span className="text-display font-bold tabular-nums text-app-text-heading" data-testid="load-screen-clock">{clock(now, locale)}</span>
        </header>

        {reads.hubFailing && reads.at !== null && (
          <div role="status" className={`flex flex-none items-center gap-2 rounded border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-compact ${WARNING_TEXT}`} data-testid="load-screen-hub-down">
            <CloudOff size={14} className="flex-none" aria-hidden="true" />{tr('loadScreen.hubDown')}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] gap-3">
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <section className={SECTION} data-testid="load-screen-hero">
              <Hero view={view} cards={cards.length} jobs={jobs.length} threshold={r?.screen?.thresholdMin ?? null} locale={locale} />
              {pc && pc.metrics.length > 0 && (
                <div className="grid grid-cols-4 border-t border-app-border-subtle tabular-nums">
                  {pc.metrics.slice(0, 4).map((m) => <Gauge key={m.key} label={m.name} value={formatPct(m.pct)} share={m.pct === null ? null : m.pct / 100} warn={m.pct !== null && m.pct >= 85} history={m.history} note={m.note} />)}
                </div>
              )}
              {mac && (
                <div className="grid grid-cols-4 border-t border-app-border-subtle tabular-nums">
                  <Gauge label={tr('processes.cpu')} value={formatPct(mac.cpuPct)} share={mac.cpuPct === null ? null : mac.cpuPct / 100} history={mac.history.cpu} note={mac.notes.cpu} />
                  <Gauge label={tr('processes.memory')} value={formatPct(mac.memPressurePct)} share={mac.memPressurePct === null ? null : mac.memPressurePct / 100} note={mac.notes.mem} />
                  <Gauge label={tr('processes.gpu')} value={formatPct(mac.gpuPct)} share={mac.gpuPct === null ? null : mac.gpuPct / 100} history={mac.history.gpu} />
                  <Gauge label={tr('processes.disk')} value={formatPct(mac.disk?.pct ?? null)} share={mac.disk?.pct == null ? null : mac.disk.pct / 100} note={mac.disk?.note ?? null} />
                </div>
              )}
            </section>
            <WeightSection readout={r} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <RunningSection cards={cards} jobs={jobs} projects={reads.projects} now={now} reasons={r?.screen?.reasons ?? pc?.lines ?? []} working={view?.kind === 'working'} />
            <PaceSection board={pace} />
            {(r?.screen?.outcomes.length ?? 0) > 0 && <OutcomesSection outcomes={r!.screen!.outcomes} locale={locale} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function PcStatePill({ state }: { state: string }) {
  const tr = useT();
  const on = state === 'lavora' || state === 'acceso'; // allow-italian: the hub's wire values
  const dot = on ? 'bg-emerald-500 dark:bg-emerald-400' : state === 'dorme' ? 'bg-app-text-faint opacity-50' : 'bg-amber-500'; // allow-italian: the hub's wire value
  return (
    <span className={`inline-flex items-center gap-1.5 text-body-lg font-semibold ${on ? SUCCESS_TEXT : state === 'dorme' ? FAINT : WARNING_TEXT}`} data-testid="load-screen-pc-state" data-state={state}>{/* allow-italian: the hub's wire value */}
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />{tr(`processes.pc.${state}`)}
    </span>
  );
}

function Hero({ view, cards, jobs, threshold, locale }: { view: SleepView | null; cards: number; jobs: number; threshold: number | null; locale: string }) {
  const tr = useT();
  let icon: LucideIcon = CircleDashed;
  let title = tr('loadScreen.reading');
  let sub: string | null = null;
  let tone = 'text-app-text-heading';
  if (view?.kind === 'working') {
    icon = Zap;
    title = tr('loadScreen.state.working');
    tone = SUCCESS_TEXT;
    const c = cards === 1 ? tr('loadScreen.state.card') : tr('loadScreen.state.cards', { n: cards });
    const j = jobs === 0 ? tr('loadScreen.state.noJobs') : jobs === 1 ? tr('loadScreen.state.job') : tr('loadScreen.state.jobs', { n: jobs });
    sub = tr('loadScreen.state.workingSub', { cards: c, jobs: j });
  } else if (view?.kind === 'countdown') {
    icon = Moon;
    title = tr('loadScreen.state.countdown', { n: view.minutes });
    sub = threshold !== null
      ? tr('loadScreen.state.countdownSub', { time: clock(view.at, locale), threshold })
      : tr('loadScreen.state.countdownSubBare', { time: clock(view.at, locale) });
  } else if (view?.kind === 'sleeping') {
    icon = Moon;
    title = tr('loadScreen.state.sleeping');
  } else if (view?.kind === 'idle') {
    icon = Moon;
    title = tr('loadScreen.state.idle');
    sub = view.thresholdMin !== null ? tr('loadScreen.state.idleSub', { threshold: view.thresholdMin }) : tr('loadScreen.state.idleSubBare');
  }
  const Icon = icon;
  return (
    <div className="flex items-center gap-4 px-4 py-3" data-testid="load-screen-state" data-kind={view?.kind ?? 'reading'}>
      <Icon size={44} strokeWidth={2.25} className={`flex-none ${tone}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className={`text-display-xl font-bold leading-none tracking-tight ${tone}`} data-testid="load-screen-headline">{title}</div>
        {sub && <div className="mt-1.5 text-title font-semibold text-app-text-secondary" data-testid="load-screen-subline">{sub}</div>}
      </div>
    </div>
  );
}

function SectionHead({ icon: Icon, title, aside }: { icon: LucideIcon; title: string; aside?: ReactNode }) {
  return (
    <div className={SECTION_HEAD}>
      <Icon size={15} className="flex-none text-app-text-secondary" aria-hidden="true" />
      <span className="text-body-lg font-bold text-app-text-heading">{title}</span>
      {aside && <span className={`min-w-0 flex-1 truncate text-mini tabular-nums ${FAINT}`}>{aside}</span>}
    </div>
  );
}

function WeightSection({ readout: r }: { readout: Readout | null }) {
  const tr = useT();
  const rows = useMemo(() => (r ? readoutRows(r, (n) => tr('loadScreen.weight.processes', { n })) : []), [r, tr]);
  const shown = rows.slice(0, TOP_ROWS);
  const hidden = r ? r.procs.slice(TOP_ROWS) : [];
  const restCount = (r?.rest.count ?? 0) + hidden.reduce((s, p) => s + p.count, 0);
  const restMem = (r?.rest.memMB ?? 0) + hidden.reduce((s, p) => s + p.memMB, 0);
  const sub = r && r.total > 0
    ? [tr('loadScreen.weight.sub', { n: r.total, cores: r.cores ?? '-', mem: r.memTotalMB === null ? '-' : formatMem(r.memTotalMB) }), r.memMetric ? tr(`loadScreen.weight.metric.${r.memMetric}`) : null].filter(Boolean).join(' · ')
    : undefined;
  const unread = !r || r.procs.length === 0;
  return (
    <section className={`${SECTION} @container flex min-h-0 flex-1 flex-col`} data-testid="load-screen-weight">
      <SectionHead icon={Activity} title={tr('loadScreen.weight')} aside={sub} />
      {unread ? (
        <div className={`flex items-center gap-2 px-3 py-3 text-body-lg ${WARNING_TEXT}`} data-testid="load-screen-weight-unread">
          <CloudOff size={16} className="flex-none" aria-hidden="true" />
          {tr(r?.error === 'not_paired' ? 'loadScreen.weight.notPaired' : 'loadScreen.weight.unread')}
        </div>
      ) : (
        <>
          <div className={`grid h-7 grid-cols-[minmax(0,1fr)_46px_118px_42px_108px_64px] items-center gap-x-2.5 border-b border-app-border-subtle px-2.5 text-mini uppercase tracking-[0.04em] ${FAINT}`}>
            <span>{tr('processes.process')}</span>
            <span className="text-right">{tr('processes.cpu')}</span>
            <span className="text-right text-app-text-secondary">{tr('processes.memory')}</span>
            <span className="text-right">{tr('processes.gpu')}</span>
            <span className="text-right">{tr('processes.net')}</span>
            <span />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden" data-testid="load-screen-procs">
            {shown.map((row) => <ProcessRowView key={row.id} row={row} onStopped={NOOP} />)}
          </div>
          {restCount > 0 && (
            <div className={`border-t border-app-border-subtle px-2.5 py-1.5 text-compact tabular-nums ${FAINT}`} data-testid="load-screen-procs-rest">
              {tr('loadScreen.weight.rest', { n: restCount, mem: formatMem(restMem) })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RunningSection({ cards, jobs, projects, now, reasons, working }: {
  cards: ScreenCard[]; jobs: ScreenJob[]; projects: Reads['projects']; now: number; reasons: string[]; working: boolean;
}) {
  const tr = useT();
  const empty = cards.length === 0 && jobs.length === 0;
  return (
    <section className={SECTION} data-testid="load-screen-running">
      <SectionHead icon={Zap} title={tr('loadScreen.running')} aside={empty ? undefined : String(cards.length + jobs.length)} />
      {empty && <div className={`px-3 py-3 text-body-lg ${FAINT}`} data-testid="load-screen-running-none">{tr('loadScreen.running.none')}</div>}
      {cards.slice(0, RUNNING_ROWS).map((c) => {
        const p = projectLabel(c.projectId, projects);
        return (
          <div key={c.id} className="border-b border-app-border-subtle px-3 py-2 last:border-b-0" data-testid="load-screen-card">
            <div className="flex min-w-0 items-center gap-1.5 text-compact text-app-text-secondary">
              {p.path ? <ProjectFavicon path={p.path} size={14} /> : null}
              <span className="truncate font-semibold">{p.name}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <StatusIcon status="in_progress" className="h-4 w-4" />
              <span className="min-w-0 truncate text-title font-bold text-app-text" title={c.title}>{c.title}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {c.since !== null && <span className={CHIP} data-testid="load-screen-card-since">{elapsed(now - c.since, tr)}</span>}
              {c.model && <span className={CHIP}>{c.model}</span>}
              {c.from && <span className={CHIP}><Server className="h-3 w-3 shrink-0 text-app-text-muted" aria-hidden="true" />{tr('loadScreen.running.from', { who: c.from })}</span>}
            </div>
          </div>
        );
      })}
      {jobs.slice(0, Math.max(0, RUNNING_ROWS - cards.length)).map((j, i) => (
        <div key={`job-${i}`} className="border-b border-app-border-subtle px-3 py-2 last:border-b-0" data-testid="load-screen-job">
          <div className="flex min-w-0 items-center gap-1.5 text-compact text-app-text-secondary">
            <span className="truncate font-semibold">{j.project ?? tr('loadScreen.running.job')}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <Zap size={16} className={`flex-none ${SUCCESS_TEXT}`} aria-hidden="true" />
            <span className="min-w-0 truncate text-title font-bold text-app-text">{j.what}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {j.since !== null && <span className={CHIP}>{elapsed(now - j.since, tr)}</span>}
            {j.who && <span className={CHIP}><Server className="h-3 w-3 shrink-0 text-app-text-muted" aria-hidden="true" />{tr('loadScreen.running.from', { who: j.who })}</span>}
          </div>
        </div>
      ))}
      {cards.length + jobs.length > RUNNING_ROWS && (
        <div className={`px-3 py-1.5 text-compact ${FAINT}`} data-testid="load-screen-running-more">{tr('loadScreen.running.more', { n: cards.length + jobs.length - RUNNING_ROWS })}</div>
      )}
      {/* What keeps it awake when nothing listed above does: running work is its own reason. */}
      {working && empty && reasons.length > 0 && (
        <div className="border-t border-app-border-subtle px-3 py-2" data-testid="load-screen-why">
          <div className={`mb-1 text-mini uppercase tracking-[0.04em] ${FAINT}`}>{tr('loadScreen.why')}</div>
          {reasons.slice(0, 4).map((line, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-compact text-app-text">
              <Activity size={13} className={`flex-none ${FAINT}`} aria-hidden="true" />
              <span className="min-w-0 truncate">{line}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PaceSection({ board }: { board: BoardAccount[] | null }) {
  const tr = useT();
  const locale = useLocale();
  // Accounts with a pace dial first.
  const rows = (board ?? []).filter((b) => b.dial || b.state.text).sort((a, b) => Number(!!b.dial) - Number(!!a.dial)).slice(0, PACE_ROWS);
  return (
    <section className={SECTION} data-testid="load-screen-pace">
      <SectionHead icon={GaugeIcon} title={tr('loadScreen.pace')} />
      {rows.length === 0 && <div className={`px-3 py-3 text-body-lg ${FAINT}`}>{tr('loadScreen.pace.none')}</div>}
      {rows.map((b) => {
        const state = hubProse(b.state.text, locale);
        const end = b.end ? hubProse(b.end.text, locale) : null;
        return (
          <div key={`${b.provider}:${b.account}`} className="flex items-center gap-3 border-b border-app-border-subtle px-3 py-2 last:border-b-0" data-testid="load-screen-pace-row">
            {b.dial ? <PaceDial needle={b.dial.needle} zone={b.dial.zone} label={tr('loadScreen.pace.dial', { state: state ?? '' })} scale={2} /> : <span className="h-9 w-[60px] flex-none" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-lg font-bold capitalize text-app-text">{b.provider}</div>
              <div className="truncate text-mini text-app-text-secondary">{b.account}</div>
            </div>
            <div className="min-w-0 text-right">
              {state && <div className={`truncate text-body-lg font-bold ${TONE[b.state.tone]}`} data-testid="load-screen-pace-state">{state}</div>}
              {end && <div className="truncate text-compact text-app-text-secondary">{tr('loadScreen.pace.end')} <b className={b.end!.tone === 'ok' ? 'text-app-text' : TONE[b.end!.tone]}>{end}</b></div>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function OutcomesSection({ outcomes, locale }: { outcomes: ScreenOutcome[]; locale: string }) {
  const tr = useT();
  return (
    <section className={`${SECTION} min-h-0`} data-testid="load-screen-outcomes">
      <SectionHead icon={CheckCircle2} title={tr('loadScreen.outcomes')} />
      {outcomes.slice(0, OUTCOME_ROWS).map((o, i) => {
        const Icon = o.ok === false ? CircleAlert : CheckCircle2;
        const tone = o.ok === false ? DANGER_TEXT : o.ok ? SUCCESS_TEXT : FAINT;
        const secs = o.seconds === null ? null : o.seconds < 60 ? tr('loadScreen.outcome.seconds', { n: Math.round(o.seconds) }) : tr('loadScreen.outcome.minutes', { m: Math.floor(o.seconds / 60), s: Math.round(o.seconds % 60) });
        return (
          <div key={i} className="flex items-center gap-2 border-b border-app-border-subtle px-3 py-1.5 last:border-b-0" data-testid="load-screen-outcome" data-ok={String(o.ok)}>
            <Icon size={16} className={`flex-none ${tone}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-compact text-app-text"><b className="font-semibold">{o.project ?? ''}</b>{o.project ? ' · ' : ''}{o.what}</span>
            <span className={`text-compact font-semibold ${tone}`}>{tr(o.ok === false ? 'loadScreen.outcome.failed' : o.ok ? 'loadScreen.outcome.ok' : 'loadScreen.outcome.unknown')}</span>
            {secs && <span className={`text-mini tabular-nums ${FAINT}`}>{secs}</span>}
            {o.endedAt !== null && <span className={`text-mini tabular-nums ${FAINT}`}>{clock(o.endedAt, locale)}</span>}
          </div>
        );
      })}
    </section>
  );
}


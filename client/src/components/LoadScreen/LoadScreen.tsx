/**
 * THE LOAD SCREEN: what a machine that takes the load (today the Windows PC)
 * shows on its own monitor, at `/schermo/<machine id>` (`/schermo` for this
 * machine). It replaces the PowerShell window of the PC's screen script.
 *
 * The app's own pieces, not a page with styles of its own: the sections, the
 * gauges, the process rows and the PC's state badge of the machine's
 * Processes view (`SECTION`, `Gauge`, `ProcessRowView`, `PcStateBadge`), the
 * outlook row of «Account e quote» (`AccountOutlook`: dial, state, end), the board's
 * own compact card (`Card` with `density="compact"`). The page is laid out at
 * `LAYOUT_WIDTH` x `LAYOUT_HEIGHT` and enlarged with CSS zoom to the screen,
 * so the same components read from across a room; every list shows the rows
 * that fit WHOLE and counts the rest, never a row cut in half.
 *
 * Cheap by construction, because the PC must not count it as work: no
 * animation, no transition, no socket. Four reads every POLL_MS while the
 * page is visible (the pace every PACE_POLL_MS), a clock that moves once a
 * minute's fraction. Read-only: nothing on it starts, stops or changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Activity, CheckCircle2, CircleAlert, CircleDashed, CircleSlash, CloudOff, Cpu, Gauge as GaugeIcon, Moon, Monitor, Server, Zap, type LucideIcon } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import LOAD_SCREEN_IT from '../../lib/i18n-loadscreen-it';
import LOAD_SCREEN_EN from '../../lib/i18n-loadscreen-en';
import { apiFetch } from '../../lib/shell/net';
import { startVisibleInterval } from '../../state/documentVisibility';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { formatMem, formatPct, macGauges, pcView } from '../../lib/machineProcesses';
import { readBoardAccounts, type BoardAccount } from '../../lib/accountInsights';
import { projectIdForPath } from '../../../../shared/board';
import type { BoardTask } from '../../lib/board';
import {
  cardsOn, elapsedParts, projectLabel, readReadout, readoutRows, screenZoom, sleepView,
  type Readout, type ScreenCard, type ScreenJob, type ScreenOutcome, type SleepView,
} from '../../lib/loadScreen';
import { FAINT, Gauge, PcStateBadge, ProcessRowView, SECTION, SECTION_HEAD } from '../Processes/MachineProcessesPane';
import { AccountOutlook } from '../Accounts/AccountInsights';
import ACCOUNTS_IT from '../../lib/i18n-accounts-it';
import ACCOUNTS_EN from '../../lib/i18n-accounts-en';
import { Card } from '../Board/Card';

addCatalogue('it', LOAD_SCREEN_IT);
addCatalogue('en', LOAD_SCREEN_EN);
// The outlook row's words belong to «Account e quote», whose pane is not loaded here.
addCatalogue('it', ACCOUNTS_IT);
addCatalogue('en', ACCOUNTS_EN);

type Tr = ReturnType<typeof useT>;

/** The PC's readout is cached 20 s server side and the hub's census 30 s: reading faster buys nothing. */
const POLL_MS = 20_000;
const PACE_POLL_MS = 60_000;
/** The most rows a list asks for; how many it SHOWS is what fits whole (`useFitCount`). */
const TOP_ROWS = 14;
const RUNNING_ROWS = 6;
const PACE_ROWS = 3;
const OUTCOME_ROWS = 3;
const NOOP = () => {};

const CHIP = 'flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-black/[0.05] px-1.5 py-0.5 text-mini leading-4 text-app-text-secondary dark:bg-white/10';

interface Reads {
  readout: Readout | null;
  machines: unknown;
  tasks: unknown;
  projects: Map<string, { name: string; path: string }>;
  at: number | null;
  hubFailing: boolean;
  /** A read came back and the machine gave no readout: only then the screen says it does not answer. */
  readoutFailed: boolean;
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
  const [reads, setReads] = useState<Reads>({ readout: null, machines: null, tasks: null, projects: new Map(), at: null, hubFailing: false, readoutFailed: false });
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
        readoutFailed: readout === null && prev.readout === null,
      }));
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, [machine]);
  return reads;
}

/** The pace of each account; `undefined` until the first answer, null when the hub gave none. */
function usePace(): BoardAccount[] | null | undefined {
  const [board, setBoard] = useState<BoardAccount[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const raw = await readJson('/api/hub/board');
      if (!alive) return;
      // A failed read keeps the last good pace.
      setBoard((prev) => (raw ? readBoardAccounts(raw) : prev ?? null));
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
    const zoom = screenZoom(window.innerWidth, window.innerHeight);
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

/**
 * How many of a list's children fit WHOLE in its box: the list renders up to
 * `max`, this measures after layout and shrinks to the rows whose bottom is
 * inside, before the frame is painted. It starts again from `max` when the
 * rows (`key`) or the window change, never on a timer.
 */
function useFitCount(max: number, key: string): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);
  // The fit belongs to the rows and the window it was measured on: a new signature starts again from `max`.
  const sig = `${max}|${size}|${key}`;
  const [fit, setFit] = useState<{ sig: string; n: number }>({ sig, n: max });
  const n = fit.sig === sig ? fit.n : max;
  useEffect(() => {
    const on = () => setSize((v) => v + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.getBoundingClientRect().bottom + 0.5;
    const first = Array.from(el.children).findIndex((k) => k.getBoundingClientRect().bottom > bottom);
    if (first >= 0 && first < n) setFit({ sig, n: first });
  }, [sig, n]);
  return [ref, n];
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
          {pc && <PcStateBadge state={pc.state} className="gap-1.5 text-body-lg font-semibold" dotClassName="h-2.5 w-2.5" testId="load-screen-pc-state" />}
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
            <WeightSection readout={r} failed={reads.readoutFailed} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <RunningSection cards={cards} jobs={jobs} projects={reads.projects} now={now} reasons={r?.screen?.reasons ?? pc?.lines ?? []} working={view?.kind === 'working'} read={reads.at !== null} />
            <PaceSection board={pace} />
            {(r?.screen?.outcomes.length ?? 0) > 0 && <OutcomesSection outcomes={r!.screen!.outcomes} locale={locale} />}
          </div>
        </div>
      </div>
    </div>
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

function WeightSection({ readout: r, failed }: { readout: Readout | null; failed: boolean }) {
  const tr = useT();
  const rows = useMemo(() => (r ? readoutRows(r, (n) => tr('loadScreen.weight.processes', { n })) : []), [r, tr]);
  const [fitRef, fit] = useFitCount(TOP_ROWS, rows.map((row) => row.id).join('|'));
  const shown = rows.slice(0, Math.min(TOP_ROWS, fit));
  const hidden = r ? r.procs.slice(shown.length) : [];
  const restCount = (r?.rest.count ?? 0) + hidden.reduce((s, p) => s + p.count, 0);
  const restMem = (r?.rest.memMB ?? 0) + hidden.reduce((s, p) => s + p.memMB, 0);
  const sub = r && r.total > 0
    ? [tr('loadScreen.weight.sub', { n: r.total, cores: r.cores ?? '-', mem: r.memTotalMB === null ? '-' : formatMem(r.memTotalMB) }), r.memMetric ? tr(`loadScreen.weight.metric.${r.memMetric}`) : null].filter(Boolean).join(' · ')
    : undefined;
  // Before the first answer the screen is reading, not failing.
  const reading = !r && !failed;
  const unread = !reading && (!r || r.procs.length === 0);
  return (
    <section className={`${SECTION} @container flex min-h-0 flex-1 flex-col`} data-testid="load-screen-weight">
      <SectionHead icon={Activity} title={tr('loadScreen.weight')} aside={sub} />
      {reading ? (
        <div className={`flex items-center gap-2 px-3 py-3 text-body-lg ${FAINT}`} data-testid="load-screen-weight-reading">
          <CircleDashed size={16} className="flex-none" aria-hidden="true" />{tr('loadScreen.reading')}
        </div>
      ) : unread ? (
        <div className={`flex items-center gap-2 px-3 py-3 text-body-lg ${WARNING_TEXT}`} data-testid="load-screen-weight-unread">
          <CloudOff size={16} className="flex-none" aria-hidden="true" />
          {tr(r?.error === 'not_paired' ? 'loadScreen.weight.notPaired' : 'loadScreen.weight.unread')}
        </div>
      ) : (
        <>
          <div className={`grid h-7 flex-none grid-cols-[minmax(0,1fr)_46px_118px_42px_108px_64px] items-center gap-x-2.5 border-b border-app-border-subtle px-2.5 text-mini uppercase tracking-[0.04em] ${FAINT}`}>
            <span>{tr('processes.process')}</span>
            <span className="text-right">{tr('processes.cpu')}</span>
            <span className="text-right text-app-text-secondary">{tr('processes.memory')}</span>
            <span className="text-right">{tr('processes.gpu')}</span>
            <span className="text-right">{tr('processes.net')}</span>
            <span />
          </div>
          <div ref={fitRef} className="min-h-0 flex-1 overflow-hidden" data-testid="load-screen-procs">
            {shown.map((row) => <ProcessRowView key={row.id} row={row} onStopped={NOOP} />)}
          </div>
          {restCount > 0 && (
            <div className={`flex-none border-t border-app-border-subtle px-2.5 py-1.5 text-compact tabular-nums ${FAINT}`} data-testid="load-screen-procs-rest">
              {tr('loadScreen.weight.rest', { n: restCount, mem: formatMem(restMem) })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RunningSection({ cards, jobs, projects, now, reasons, working, read }: {
  cards: ScreenCard[]; jobs: ScreenJob[]; projects: Reads['projects']; now: number; reasons: string[]; working: boolean; read: boolean;
}) {
  const tr = useT();
  const empty = cards.length === 0 && jobs.length === 0;
  const total = cards.length + jobs.length;
  const [fitRef, fit] = useFitCount(RUNNING_ROWS, [...cards.map((c) => c.id), ...jobs.map((j) => j.what)].join('|'));
  const room = Math.min(RUNNING_ROWS, fit);
  const shownCards = cards.slice(0, room);
  const shownJobs = jobs.slice(0, Math.max(0, room - shownCards.length));
  return (
    <section className={`${SECTION} flex min-h-0 flex-1 flex-col`} data-testid="load-screen-running">
      <SectionHead icon={Zap} title={tr('loadScreen.running')} aside={empty ? undefined : String(total)} />
      {empty && <div className={`px-3 py-3 text-body-lg ${FAINT}`} data-testid={read ? 'load-screen-running-none' : 'load-screen-running-reading'}>{tr(read ? 'loadScreen.running.none' : 'loadScreen.reading')}</div>}
      <div ref={fitRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 py-2" data-testid="load-screen-running-list">
        {shownCards.map((c) => {
          const p = projectLabel(c.projectId, projects);
          return (
            // THE BOARD'S OWN CARD, compact, and inert: the screen is read from across a room, nothing on it is pressed.
            <div key={c.id} className="flex-none" data-testid="load-screen-card" inert>
              <Card
                task={c.raw as unknown as BoardTask} onOpen={NOOP} showProject onError={NOOP} onRefetch={NOOP}
                paneBoardId="" paneSettings={null} projectPath={p.path ?? undefined} density="compact"
              />
              <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1">
                {c.since !== null && <span className={CHIP} data-testid="load-screen-card-since">{elapsed(now - c.since, tr)}</span>}
                {c.from && <span className={CHIP}><Server className="h-3 w-3 shrink-0 text-app-text-muted" aria-hidden="true" />{tr('loadScreen.running.from', { who: c.from })}</span>}
              </div>
            </div>
          );
        })}
        {shownJobs.map((j, i) => (
          <div key={`job-${i}`} className="flex-none rounded-md border border-app-border bg-surface px-2.5 py-1.5" data-testid="load-screen-job">
            <div className="flex min-w-0 items-center gap-1.5 text-compact text-app-text-secondary">
              <span className="truncate font-semibold">{j.project ?? tr('loadScreen.running.job')}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <Zap size={16} className={`flex-none ${SUCCESS_TEXT}`} aria-hidden="true" />
              <span className="min-w-0 truncate text-body-lg font-semibold text-app-text">{j.what}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {j.since !== null && <span className={CHIP}>{elapsed(now - j.since, tr)}</span>}
              {j.who && <span className={CHIP}><Server className="h-3 w-3 shrink-0 text-app-text-muted" aria-hidden="true" />{tr('loadScreen.running.from', { who: j.who })}</span>}
            </div>
          </div>
        ))}
      </div>
      {total > shownCards.length + shownJobs.length && (
        <div className={`flex-none border-t border-app-border-subtle px-3 py-1.5 text-compact ${FAINT}`} data-testid="load-screen-running-more">{tr('loadScreen.running.more', { n: total - shownCards.length - shownJobs.length })}</div>
      )}
      {/* What keeps it awake when nothing listed above does: running work is its own reason. */}
      {working && empty && reasons.length > 0 && (
        <div className="flex-none border-t border-app-border-subtle px-3 py-2" data-testid="load-screen-why">
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

function PaceSection({ board }: { board: BoardAccount[] | null | undefined }) {
  const tr = useT();
  // Accounts with a pace dial first.
  const rows = (board ?? []).filter((b) => b.dial || b.state.text).sort((a, b) => Number(!!b.dial) - Number(!!a.dial)).slice(0, PACE_ROWS);
  return (
    <section className={`${SECTION} flex-none`} data-testid="load-screen-pace">
      <SectionHead icon={GaugeIcon} title={tr('loadScreen.pace')} />
      {rows.length === 0 && (
        <div className={`px-3 py-3 text-body-lg ${FAINT}`} data-testid={board === undefined ? 'load-screen-pace-reading' : 'load-screen-pace-none'}>
          {tr(board === undefined ? 'loadScreen.reading' : 'loadScreen.pace.none')}
        </div>
      )}
      {rows.map((b) => (
        // The account's outlook row of «Account e quote»: its dial, state and end, the same component.
        <div key={`${b.provider}:${b.account}`} className="flex min-w-0 items-center gap-3 border-b border-app-border-subtle px-3 py-1.5 last:border-b-0" data-testid="load-screen-pace-row">
          <span className="w-[92px] flex-none truncate text-body-lg font-bold capitalize text-app-text" title={b.account}>{b.provider}</span>
          <AccountOutlook board={b} className="min-w-0 flex-1" />
        </div>
      ))}
    </section>
  );
}

function OutcomesSection({ outcomes, locale }: { outcomes: ScreenOutcome[]; locale: string }) {
  const tr = useT();
  return (
    <section className={`${SECTION} flex-none`} data-testid="load-screen-outcomes">
      <SectionHead icon={CheckCircle2} title={tr('loadScreen.outcomes')} />
      {outcomes.slice(0, OUTCOME_ROWS).map((o, i) => {
        const Icon = o.ok === false ? CircleAlert : o.interrupted ? CircleSlash : CheckCircle2;
        const tone = o.ok === false ? DANGER_TEXT : o.ok ? SUCCESS_TEXT : o.interrupted ? WARNING_TEXT : FAINT;
        const secs = o.seconds === null ? null : o.seconds < 60 ? tr('loadScreen.outcome.seconds', { n: Math.round(o.seconds) }) : tr('loadScreen.outcome.minutes', { m: Math.floor(o.seconds / 60), s: Math.round(o.seconds % 60) });
        return (
          <div key={i} className="flex items-center gap-2 border-b border-app-border-subtle px-3 py-1.5 last:border-b-0" data-testid="load-screen-outcome" data-ok={String(o.ok)}>
            <Icon size={16} className={`flex-none ${tone}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-compact text-app-text"><b className="font-semibold">{o.project ?? ''}</b>{o.project ? ' · ' : ''}{o.what}</span>
            <span className={`text-compact font-semibold ${tone}`}>{tr(o.ok === false ? 'loadScreen.outcome.failed' : o.ok ? 'loadScreen.outcome.ok' : o.interrupted ? 'loadScreen.outcome.interrupted' : 'loadScreen.outcome.unknown')}</span>
            {secs && <span className={`text-mini tabular-nums ${FAINT}`}>{secs}</span>}
            {o.endedAt !== null && <span className={`text-mini tabular-nums ${FAINT}`}>{clock(o.endedAt, locale)}</span>}
          </div>
        );
      })}
    </section>
  );
}


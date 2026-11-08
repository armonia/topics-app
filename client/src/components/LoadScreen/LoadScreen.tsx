/**
 * THE LOAD SCREEN: what a machine that takes the load (today the Windows PC)
 * shows on its own monitor, at `/schermo/<machine id>` (`/schermo` for this
 * machine). It replaces the PowerShell window of the PC's screen script.
 *
 * It is Topics, and says so: the app's mark and name in the header, the app's
 * own pieces below it (`SECTION`, `Gauge`, `ProcessRowView`, `PcStateBadge`, the
 * board's state icon). The CENTRE is the SESSIONS: every card, chat or terminal
 * at work, with its model, tokens, tokens per second, a clock that runs, and the
 * CPU and memory of everything Topics launched for it (`SessionRowView`, the
 * same row the Processes view and the card drawer draw, from the same answer).
 * The machine's own processes are a smaller section on the side: what weighs on
 * the PC, as a detail, not the subject.
 *
 * The page is laid out at `LAYOUT_WIDTH` x `LAYOUT_HEIGHT` and enlarged with CSS
 * zoom to the screen, so the same components read from across a room; the list
 * shows the rows that fit WHOLE and counts the rest, never a row cut in half.
 *
 * Cheap by construction, because the PC must not count it as work: no
 * animation, no transition, no socket. The sessions are read every
 * SESSIONS_POLL_MS and the slow data every POLL_MS, while the page is visible;
 * the only thing that moves between reads is the clocks, once a second.
 * Read-only: nothing on it starts, stops or changes, and the device that shows
 * it may read the two routes of the page and nothing else of Topics
 * (`server/lib/screen-scope.ts`).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Activity, CheckCircle2, CircleAlert, CircleDashed, CircleSlash, CloudOff, Cpu, Moon, Monitor, Zap, type LucideIcon } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import LOAD_SCREEN_IT from '../../lib/i18n-loadscreen-it';
import LOAD_SCREEN_EN from '../../lib/i18n-loadscreen-en';
import { apiFetch } from '../../lib/shell/net';
import { startVisibleInterval } from '../../state/documentVisibility';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { formatMem, formatPct, macGauges, pcView } from '../../lib/machineProcesses';
import { readScreenData, readoutRows, screenZoom, sleepView, type Readout, type ScreenJob, type ScreenOutcome, type SleepView } from '../../lib/loadScreen';
import { FAINT, SECTION, SECTION_HEAD } from '../Processes/processesStyles';
import { Gauge, PcStateBadge, ProcessRowView } from '../Processes/MachineProcessesPane';
import { ConsumptionNotes, SessionRowView, useSecondTick, useSessionConsumption } from '../Processes/SessionConsumption';
import type { SessionConsumption } from '../../../../shared/session-consumption';

addCatalogue('it', LOAD_SCREEN_IT);
addCatalogue('en', LOAD_SCREEN_EN);

/** The machine's slow data is cached 20 s server side and the hub's census 30 s: reading faster buys nothing. */
const POLL_MS = 20_000;
/** The sessions move with every model round: the tokens per second are only as fresh as this. */
const SESSIONS_POLL_MS = 4_000;
/** The most rows a list asks for; how many it SHOWS is what fits whole (`useFitCount`). */
const TOP_ROWS = 10;
const SESSION_ROWS = 12;
const OUTCOME_ROWS = 3;
const NOOP = () => {};

interface Reads {
  readout: Readout | null;
  machines: unknown;
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

function useScreenReads(machine: string | null): Reads {
  const [reads, setReads] = useState<Reads>({ readout: null, machines: null, at: null, hubFailing: false, readoutFailed: false });
  useEffect(() => {
    let alive = true;
    const q = machine ? `?machine=${encodeURIComponent(machine)}` : '';
    const read = async () => {
      const raw = await readJson(`/api/system/screen-data${q}`);
      if (!alive) return;
      const data = raw === null ? null : readScreenData(raw);
      // A failed read keeps the last good one; the band says the hub is gone.
      setReads((prev) => ({
        readout: data ? data.readout : prev.readout,
        machines: data ? data.machines : prev.machines,
        at: Date.now(),
        hubFailing: data === null || data.machines === null,
        readoutFailed: data === null && prev.readout === null,
      }));
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, [machine]);
  return reads;
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

export function LoadScreen({ machine }: { machine: string | null }) {
  const tr = useT();
  const locale = useLocale();
  const { zoom, width, height } = useZoom();
  const reads = useScreenReads(machine);
  const sessionsPath = `/api/system/screen-sessions${machine ? `?machine=${encodeURIComponent(machine)}` : ''}`;
  const sessionReads = useSecondTickedSessions(sessionsPath);
  const now = sessionReads.now;
  const r = reads.readout;
  const local = r?.machine.local ?? machine === null;
  const sessions = sessionReads.answer?.sessions ?? [];
  const jobs = r?.screen?.jobs ?? [];
  const view = r ? sleepView(r, sessions.length, now) : null;
  const pc = useMemo(() => (local ? null : pcView(reads.machines)), [reads.machines, local]);
  const mac = useMemo(() => (local ? macGauges(null, reads.machines, null) : null), [reads.machines, local]);
  const name = r?.machine.name || (local ? tr('processes.mac') : tr('processes.pc'));

  useEffect(() => { document.title = `${name} · Topics`; }, [name]);

  return (
    <div className="h-full overflow-hidden bg-app-bg text-app-text" data-testid="load-screen" data-state={view?.kind ?? 'reading'}>
      <div className="@container flex flex-col gap-3 overflow-hidden px-6 pb-5 pt-4" style={{ zoom, width, height }}>
        <header className="flex flex-none items-center gap-3" data-testid="load-screen-header">
          {/* The app's own mark and name, as the pairing screen draws them: this is Topics. */}
          <img src="/icons/icon-192.png" alt="" width={34} height={34} className="flex-none rounded-[8px] border border-app-border" data-testid="load-screen-logo" />
          <span className="text-headline font-bold tracking-tight text-app-text-heading" data-testid="load-screen-brand">Topics</span>
          <span className="h-6 w-px flex-none bg-app-border" aria-hidden="true" />
          {local ? <Monitor size={20} className="flex-none text-app-text-secondary" aria-hidden="true" /> : <Cpu size={20} className="flex-none text-app-text-secondary" aria-hidden="true" />}
          <h1 className="m-0 text-title font-semibold text-app-text-secondary" data-testid="load-screen-name">{name}</h1>
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

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3">
          <SessionsSection sessions={sessions} answer={sessionReads.answer} now={now} read={sessionReads.at !== null} failing={sessionReads.failing} />
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <section className={SECTION} data-testid="load-screen-hero">
              <Hero view={view} sessions={sessions.length} jobs={jobs.length} threshold={r?.screen?.thresholdMin ?? null} locale={locale} />
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
            <SentWorkSection jobs={unplacedJobs(jobs, sessions)} />
            <WeightSection readout={r} failed={reads.readoutFailed} />
            {(r?.screen?.outcomes.length ?? 0) > 0 && <OutcomesSection outcomes={r!.screen!.outcomes} locale={locale} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The sessions read every few seconds and the second-by-second clock they run on. */
function useSecondTickedSessions(path: string) {
  const reads = useSessionConsumption(path, SESSIONS_POLL_MS);
  const now = useSecondTick();
  return { ...reads, now };
}

/** The jobs sent from the Mac that no session carries: they stay visible as work, apart. */
function unplacedJobs(jobs: ScreenJob[], sessions: SessionConsumption[]): ScreenJob[] {
  const placed = new Set(sessions.flatMap((s) => s.remote.map((x) => `${x.what}|${x.since ?? ''}`)));
  return jobs.filter((j) => !placed.has(`${j.what}|${j.since ?? ''}`));
}

function Hero({ view, sessions, jobs, threshold, locale }: { view: SleepView | null; sessions: number; jobs: number; threshold: number | null; locale: string }) {
  const tr = useT();
  let icon: LucideIcon = CircleDashed;
  let title = tr('loadScreen.reading');
  let sub: string | null = null;
  let tone = 'text-app-text-heading';
  if (view?.kind === 'working') {
    icon = Zap;
    title = tr('loadScreen.state.working');
    tone = SUCCESS_TEXT;
    const c = sessions === 0 ? tr('loadScreen.state.noSessions') : sessions === 1 ? tr('loadScreen.state.session') : tr('loadScreen.state.sessions', { n: sessions });
    const j = jobs === 0 ? tr('loadScreen.state.noJobs') : jobs === 1 ? tr('loadScreen.state.job') : tr('loadScreen.state.jobs', { n: jobs });
    sub = tr('loadScreen.state.workingSub', { sessions: c, jobs: j });
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
    <div className="flex items-center gap-3 px-3 py-2.5" data-testid="load-screen-state" data-kind={view?.kind ?? 'reading'}>
      <Icon size={34} strokeWidth={2.25} className={`flex-none ${tone}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className={`text-display-md font-bold leading-none tracking-tight ${tone}`} data-testid="load-screen-headline">{title}</div>
        {sub && <div className="mt-1 truncate text-body-lg font-semibold text-app-text-secondary" data-testid="load-screen-subline">{sub}</div>}
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

/** THE CENTRE: every session at work, with what it costs. */
function SessionsSection({ sessions, answer, now, read, failing }: {
  sessions: SessionConsumption[]; answer: ReturnType<typeof useSessionConsumption>['answer']; now: number; read: boolean; failing: boolean;
}) {
  const tr = useT();
  const [fitRef, fit] = useFitCount(SESSION_ROWS, sessions.map((s) => s.key).join('|'));
  const shown = sessions.slice(0, Math.min(SESSION_ROWS, fit));
  return (
    <section className={`${SECTION} flex min-h-0 flex-col`} data-testid="load-screen-sessions">
      <SectionHead icon={Zap} title={tr('consumption.title')} aside={sessions.length === 0 ? undefined : tr('consumption.live', { n: sessions.length })} />
      {sessions.length === 0 && (
        <div className={`flex items-center gap-2 px-3 py-3 text-body-lg ${FAINT}`} data-testid={failing ? 'load-screen-sessions-unread' : read ? 'load-screen-sessions-none' : 'load-screen-sessions-reading'}>
          {failing && <CloudOff size={16} className={`flex-none ${WARNING_TEXT}`} aria-hidden="true" />}
          {failing ? tr('consumption.unread') : read ? tr('consumption.none') : tr('consumption.reading')}
        </div>
      )}
      <div ref={fitRef} className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="load-screen-sessions-list">
        {shown.map((s) => <SessionRowView key={s.key} session={s} now={now} variant="screen" windowS={answer?.windowS ?? 30} />)}
      </div>
      {sessions.length > shown.length && (
        <div className={`flex-none border-t border-app-border-subtle px-3 py-1.5 text-compact ${FAINT}`} data-testid="load-screen-sessions-more">{tr('consumption.more', { n: sessions.length - shown.length })}</div>
      )}
      {answer && <ConsumptionNotes answer={{ ...answer, sessions: shown }} />}
    </section>
  );
}

/** Work the Mac sent that no session of the list carries (a job of a project with nothing running). */
function SentWorkSection({ jobs }: { jobs: ScreenJob[] }) {
  const tr = useT();
  if (jobs.length === 0) return null;
  return (
    <section className={`${SECTION} flex-none`} data-testid="load-screen-sent">
      <SectionHead icon={Zap} title={tr('loadScreen.sent')} aside={String(jobs.length)} />
      {jobs.slice(0, 3).map((j, i) => (
        <div key={i} className="flex min-w-0 items-center gap-2 border-b border-app-border-subtle px-3 py-1.5 text-compact last:border-b-0" data-testid="load-screen-job">
          <span className="min-w-0 flex-1 truncate text-app-text">{[j.project, j.what || tr('loadScreen.sent.job')].filter(Boolean).join(' · ')}</span>
          {j.who && <span className={`flex-none ${FAINT}`}>{tr('loadScreen.sent.from', { who: j.who })}</span>}
        </div>
      ))}
    </section>
  );
}

/** What weighs on the machine, program by program: the context of the sessions, smaller than they are. */
function WeightSection({ readout: r, failed }: { readout: Readout | null; failed: boolean }) {
  const tr = useT();
  const rows = useMemo(() => (r ? readoutRows(r, (n) => tr('loadScreen.weight.processes', { n }), tr('loadScreen.weight.fromMac')) : []), [r, tr]);
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

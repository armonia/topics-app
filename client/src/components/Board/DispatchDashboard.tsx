/**
 * THE CONSUMPTION DASHBOARD at the top of the board settings panel.
 *
 * Design chosen by Attilio (the "how cards start" mock, panel c): before
 * turning the knobs you read what is happening — how many cards work, how many
 * wait and in what order, how much memory the Mac has and who holds it.
 *
 * On 28/10 Attilio kept the first version of the panel and wanted on top of it
 * three improvements from the design: the memory chart for the last hour, the
 * status row "no card is stopped by a fault" with the live dot, and the
 * numbered queue with project, age and Start anyway on the first card.
 *
 * Every number comes from the same sources the dispatcher uses to decide
 * (`/system/dispatch-capacity` in the cap store, and
 * `/dispatch/memory-queue`, which also carries the free-memory series):
 * the panel recomputes nothing. The waiting texts are the server's neutral
 * ones (`queueReason`), not a phrase of ours.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Hourglass, Play } from 'lucide-react';
import { useActiveLocale, useT } from '../../hooks/useT';
import { boardApi, isProjectlessId, req } from '../../lib/board';
import { projectNameFromId } from '../../lib/boardProjectsStore';
import type { BoardTask, DispatchCapacity } from '../../lib/board';
import type { DispatchMemoryQueueSnapshot } from '../../../../shared/board';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { chartMax, queuedCards, waitingLabel, type QueuedCard } from './dispatchDashboardModel';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { admissionVerdictText, verdictSentence } from './dispatchLoad';

const LOCALE = 'it-IT';
const gb = (n: number) => `${n.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} GB`;

// ── the memory-queue snapshot: ONE read every 15 s for every surface ──
let snap: DispatchMemoryQueueSnapshot | null = null;
/** When the last good read arrived: without it, the live dot would be a promise. */
let snapAt = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function loadSnapshot() {
  req<DispatchMemoryQueueSnapshot>('/dispatch/memory-queue').then(
    (s) => { snap = s; snapAt = Date.now(); listeners.forEach((l) => l()); },
    () => { /* without a dispatcher the dashboard shows capacity only */ },
  );
}
function subscribeSnapshot(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) { loadSnapshot(); timer = setInterval(loadSnapshot, 15_000); }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}
/** The read is live if it arrived within the last two rounds (15 s each) plus margin. */
const snapshotIsLive = (now: number) => snap !== null && now - snapAt < 45_000;
function useMemoryQueueSnapshot(): DispatchMemoryQueueSnapshot | null {
  return useSyncExternalStore(subscribeSnapshot, () => snap, () => null);
}

/** Section title, the same small caps as the panel's other sections. */
function SectionLabel({ children, right }: { children: React.ReactNode; right?: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2 text-mini font-medium uppercase tracking-wide text-app-text-secondary">
      <span>{children}</span>
      {right && <span className="normal-case tracking-normal font-normal text-app-text-secondary">{right}</span>}
    </div>
  );
}

// ── the chart: free memory, last hour, with the threshold and the working cards ──
// The drawing space is as wide as the chart on screen: the labels stay
// at a true 10 px in the narrow panel (400) and in the phone sheet too.
const PL = 30, PR = 8, PT = 8, CH = 84, SY = 98, SH = 16, VH_CARDS = 136, VH_PLAIN = 112;

export function MemoryChart({ history, startGB, now, width: initialWidth = 372, cpuHolds = false }: {
  history: DispatchMemoryQueueSnapshot['history'];
  startGB: number | null;
  now: number;
  /** The CPU is the brake, not memory: the threshold is still drawn but does not promise that another one starts. */
  cpuHolds?: boolean;
  /** Width before the measurement (and in the tests' static render). */
  width?: number;
}) {
  const tr = useT();
  const [hover, setHover] = useState<number | null>(null);
  const [W, setW] = useState(initialWidth);
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e!.contentRect.width); if (w > 0) setW(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const points = history
    .map((p) => ({ t: Date.parse(p.at), v: p.freeGB, r: p.running }))
    .filter((p) => p.t >= now - 3_660_000); // a full hour, plus the edge minute
  // The measured container is ALWAYS this div: if it were the empty-state <p>, when
  // the series arrived the observer would stay attached to a node that is gone.
  if (points.length < 2) {
    return <div ref={wrap}><p className="text-mini text-app-text-secondary" data-testid="dispatch-chart-empty">{tr('board.dash.chartEmpty')}</p></div>;
  }
  // The axis runs to NOW, not to the last sample: if the sampler stops
  // the line ends before "now", instead of passing old data off as current.
  const t0 = points[0]!.t, tEnd = Math.max(now, points[points.length - 1]!.t), span = Math.max(60_000, tEnd - t0);
  const AXIS_TOP = chartMax(points.map((p) => p.v), startGB);
  const ticks = [0, 1, 2, 3].map((k) => (AXIS_TOP / 3) * k);
  const x = (t: number) => PL + ((t - t0) / span) * (W - PL - PR);
  const y = (v: number) => PT + CH - (Math.min(v, AXIS_TOP) / AXIS_TOP) * CH;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(points[points.length - 1]!.t)} ${y(0)}L${x(t0)} ${y(0)}Z`;
  const last = points[points.length - 1]!;
  const hasRunning = points.some((p) => p.r !== undefined);
  // one rect per run with the same card count: one rect per minute
  // leaves light seams between one minute and the next
  const bars: Array<{ x: number; w: number; c: number }> = [];
  if (hasRunning) {
    for (let i = 0; i < points.length - 1;) {
      const c = points[i]!.r ?? 0;
      let j = i;
      while (j < points.length - 1 && (points[j + 1]!.r ?? 0) === c) j++;
      const end = Math.min(j + 1, points.length - 1);
      if (c) bars.push({ x: x(points[i]!.t), w: x(points[end]!.t) - x(points[i]!.t), c });
      i = j + 1;
    }
  }
  const VH = hasRunning ? VH_CARDS : VH_PLAIN;
  const axisY = VH - 3;
  const mins = Math.round(span / 60_000);
  const h = hover === null ? null : points[hover]!;
  // The current value under the point, or above it when it would fall in the card strip.
  const lastLabelY = y(last.v) + 16 > PT + CH - 2 ? y(last.v) - 8 : y(last.v) + 16;
  // An "N cards" label only where there is room, and never over the previous one.
  let labelEnd = -Infinity;
  const showLabel = bars.map((b) => { const ok = b.x >= labelEnd && b.w >= 30; if (ok) labelEnd = b.x + 36; return ok; });
  return (
    <div ref={wrap} className="relative" data-testid="dispatch-chart">
      <svg viewBox={`0 0 ${W} ${VH}`} width="100%" height={VH} className="block" role="img" aria-label={tr('board.dash.chartTitle')}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          // The nearest point in TIME: samples are not evenly spaced.
          const t = t0 + ((px - PL) / (W - PL - PR)) * span;
          let best = 0;
          for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
          setHover(best);
        }}>
        <g className="text-app-text-secondary" fontSize="10" fill="currentColor">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--border)" />
              <text x={PL - 5} y={y(v) + 3.5} textAnchor="end">{v} GB</text>
            </g>
          ))}
        </g>
        <path d={area} fill="var(--primary)" fillOpacity=".10" />
        {startGB !== null && (
          <g className="text-app-text-secondary">
            <line x1={PL} x2={W - PR} y1={y(startGB)} y2={y(startGB)} stroke="currentColor" strokeWidth="1.25" strokeDasharray="4 3" />
            <text x={PL + 6} y={y(startGB) + 13} fontSize="10" fontWeight="600" fill="currentColor">{tr(cpuHolds ? 'board.dash.chartThresholdCpu' : 'board.dash.chartThreshold', { start: gb(startGB) })}</text>
          </g>
        )}
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
        <circle cx={x(last.t)} cy={y(last.v)} r="4" fill="var(--primary)" stroke="var(--popover-bg, var(--bg-surface))" strokeWidth="2" />
        <text x={x(last.t)} y={lastLabelY} textAnchor="end" fontSize="10.5" fontWeight="600" fill="currentColor" className="text-app-text">{gb(last.v)}</text>
        {hasRunning && (
          <g className="text-app-text-secondary" fontSize="10" fill="currentColor">
            {/* the height stops at 2 cards, the written number is the real one */}
            {bars.map((b, i) => <rect key={i} x={b.x} y={SY + SH - (Math.min(b.c, 2) / 2) * SH} width={b.w} height={(Math.min(b.c, 2) / 2) * SH} fill="var(--primary)" fillOpacity=".28" />)}
            <line x1={PL} x2={W - PR} y1={SY + SH} y2={SY + SH} stroke="var(--border)" />
            {/* a tick where the number of working cards changes, with the number */}
            {bars.map((b, i) => <line key={`s${i}`} x1={b.x} x2={b.x} y1={SY - 3} y2={SY + SH} stroke="currentColor" />)}
            {bars.map((b, i) => showLabel[i] && <text key={`l${i}`} x={b.x + 3} y={SY + 6 + (b.c > 1 ? 4 : 0)} fontSize="9.5" fill="currentColor" className="text-app-text-body">{tr('board.dash.chartN', { n: b.c })}</text>)}
            <text x={PL - 5} y={SY + SH - 2} textAnchor="end">{tr('board.dash.chartCards')}</text>
          </g>
        )}
        <g className="text-app-text-secondary" fontSize="10" fill="currentColor">
          <text x={x(t0)} y={axisY}>{tr('board.dash.chartAgo', { min: mins })}</text>
          {mins >= 20 && <text x={(x(t0) + x(tEnd)) / 2} y={axisY} textAnchor="middle">{tr('board.dash.chartAgo', { min: Math.round(mins / 2) })}</text>}
          <text x={x(tEnd)} y={axisY} textAnchor="end">{tr('board.dash.chartNow')}</text>
        </g>
        {h && <line x1={x(h.t)} x2={x(h.t)} y1={PT} y2={SY + SH} stroke="currentColor" className="text-app-text-muted" />}
      </svg>
      {h && (
        <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-app-border-light bg-surface px-2 py-1 text-mini shadow">
          {tr('board.dash.chartTip', { ago: Math.max(0, Math.round((tEnd - h.t) / 60_000)), free: gb(h.v) })}
        </div>
      )}
    </div>
  );
}

/** Why Start anyway did not start, from the server's `code`. */
export type StartFailure = { id: string; code: string | null };
const START_ERR: Record<string, string> = {
  memory_slot_busy: 'board.dash.startErr.busy',
  start_rejected: 'board.dash.startErr.rejected',
  not_memory_queued: 'board.dash.startErr.moved',
  dispatcher_unavailable: 'board.dash.startErr.noDispatcher',
};

type Tone = 'ok' | 'warn' | 'bad';

/** Wait colours: the same amber the cards use for a waiting state. */
const WARN_BOX = 'bg-amber-500/15 text-amber-800 dark:text-amber-300';
const TONE_BOX: Record<Tone, string> = {
  ok: 'bg-white/5 text-app-text',
  warn: WARN_BOX,
  bad: `bg-red-500/10 ${DANGER_TEXT}`,
};
const TONE_DOT: Record<Tone, string> = { ok: 'bg-emerald-600', warn: 'bg-amber-500', bad: 'bg-red-500' };

interface DashboardInput {
  capacity: DispatchCapacity | null;
  snapshot: DispatchMemoryQueueSnapshot | null;
  queue: QueuedCard[];
  /** Cards stopped by a real fault (not by a wait). */
  broken?: number;
  /** The global switch: off, the queue does NOT start by itself, and the status row says so. */
  dispatchOn?: boolean | null;
}

/**
 * THE ONE ANSWER: a single sentence for the whole panel. A fault wins over a
 * wait, a wait over "all well"; red is for faults only, amber for waits.
 */
function useAnswer({ capacity, snapshot, queue, broken = 0, dispatchOn }: DashboardInput): { tone: Tone; text: string; off: boolean } {
  const tr = useT();
  const locale = useActiveLocale();
  const free = capacity?.availableMemGB ?? snapshot?.reading.freeGB ?? null;
  const startGB = snapshot?.threshold.startGB ?? null;
  const stalled = queue.filter((q) => q.stalled).length;
  const admission = capacity?.admission ?? null;
  const base = { off: false };
  if (broken) return { ...base, tone: 'bad', text: tr(broken === 1 ? 'board.dash.broken1' : 'board.dash.broken', { n: broken }) };
  // Off wins even with an empty queue: the switch is the thing to turn back on.
  if (dispatchOn === false) return { off: true, tone: 'warn', text: queue.length ? tr('board.dash.dispatchOff', { queued: queue.length }) : tr('board.dash.dispatchOffEmpty') };
  if (!queue.length) return { ...base, tone: 'ok', text: tr('board.dash.noBrokenEmpty') };
  if (stalled) return { ...base, tone: 'warn', text: tr(stalled === 1 ? 'board.dash.stalled1' : 'board.dash.stalled', { n: stalled }) };
  if (admission && !admission.admit) {
    return { ...base, tone: 'warn', text: verdictSentence(admissionVerdictText(admission, capacity), tr, locale) };
  }
  if (startGB !== null && free !== null && free < startGB) {
    return { ...base, tone: 'warn', text: tr('board.dash.memoryWait', { free: gb(free), start: gb(startGB) }) };
  }
  if (dispatchOn == null) return { ...base, tone: 'ok', text: tr('board.dash.noBrokenEmpty') };
  return { ...base, tone: 'ok', text: tr('board.dash.noBroken', { queued: queue.length }) };
}

/**
 * ON TOP of the panel: "N working · M queued" and the one answer in a box.
 * The controls come right after it; the detail (chart, queue, who holds the
 * memory) is `DispatchDetailsView`, below the controls.
 */
export function DispatchSummaryView({ capacity, snapshot, queue, broken = 0, dispatchOn, live, onTurnOn }: DashboardInput & {
  /** The server's read is fresh; absent = there is a snapshot. */
  live?: boolean;
  /** Turns auto-dispatch on: the button sits in the warning box while it is off. */
  onTurnOn?: () => void;
}) {
  const tr = useT();
  const running = capacity?.running ?? 0;
  const isLive = live ?? snapshot !== null;
  const answer = useAnswer({ capacity, snapshot, queue, broken, dispatchOn });
  return (
    <section data-testid="dispatch-dashboard" className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-semibold text-app-text" data-testid="dispatch-dashboard-hero">
          {tr('board.dash.hero', { running, queued: queue.length })}
        </div>
        {isLive && (
          <span data-testid="dispatch-dashboard-live" className="inline-flex shrink-0 items-center gap-1 text-mini text-app-text-secondary">
            <i className="h-1.5 w-1.5 rounded-full bg-emerald-600" />{tr('board.dash.live')}
          </span>
        )}
      </div>
      <div
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2.5 py-2 font-medium ${TONE_BOX[answer.tone]}`}
        data-testid="dispatch-dashboard-ok" data-tone={answer.tone}
      >
        <i className={`h-[7px] w-[7px] shrink-0 rounded-full ${TONE_DOT[answer.tone]}`} />
        <p className="min-w-0 flex-1 break-words" data-testid="dispatch-dashboard-answer">{answer.text}</p>
        {answer.off && onTurnOn && (
          <button
            type="button"
            data-testid="dispatch-dashboard-turn-on"
            onClick={onTurnOn}
            className="inline-flex min-h-6 shrink-0 items-center rounded-md bg-amber-500/25 px-2 py-0.5 text-mini font-semibold hover:bg-amber-500/40 coarse:min-h-11"
          >{tr('board.dash.turnOn')}</button>
        )}
      </div>
    </section>
  );
}

/** BELOW the controls: the memory chart, the numbered queue, and who holds the memory (closed). */
export function DispatchDetailsView({ capacity, snapshot, queue, now, onStartNow, starting, startFailure }: Omit<DashboardInput, 'broken' | 'dispatchOn'> & {
  /** The last rejected Start anyway; shown only while that card is still queued. */
  startFailure?: StartFailure | null;
  now: number;
  /** Start anyway on the first queued card; absent = no button. */
  onStartNow?: (card: QueuedCard) => void;
  /** The card that is starting through Start anyway. */
  starting?: string | null;
}) {
  const tr = useT();
  const running = capacity?.running ?? 0;
  const total = capacity?.totalMemGB ?? null;
  const startGB = snapshot?.threshold.startGB ?? null;
  const consumers = snapshot?.consumers ?? [];
  const biggest = Math.max(1, ...consumers.map((c) => c.gb));
  const cpuHolds = capacity?.admission?.blockedBy === 'cpu';
  // The server keeps one single manual seat and refuses it while a local turn is in flight
  // (dispatch-memory-start: `localMemorySeatTaken`): with cards at work the button cannot
  // succeed, and it says so instead of answering with an error.
  const seatBusy = running > 0;
  const failure = startFailure && queue.some((q) => q.id === startFailure.id) ? startFailure : null;
  return (
    <section data-testid="dispatch-dashboard-details" className="space-y-2 rounded-md bg-white/5 p-2.5">
      <div data-testid="dispatch-chart-block">
        <SectionLabel right={tr('board.dash.chartSub')}>{tr('board.dash.chartTitle')}</SectionLabel>
        <MemoryChart history={snapshot?.history ?? []} startGB={startGB} now={now} cpuHolds={cpuHolds} />
      </div>
      <div>
        <SectionLabel>{tr('board.dash.queue', { n: queue.length })}</SectionLabel>
        {queue.length === 0 ? (
          <p className="text-mini text-app-text-secondary" data-testid="dispatch-dashboard-queue-empty">{tr('board.dash.queueEmpty')}</p>
        ) : (
          <ol className="space-y-1.5" data-testid="dispatch-dashboard-queue">
            {queue.map((q, i) => (
              <li key={q.id} className="flex flex-wrap items-start gap-x-1.5 gap-y-1" data-testid="dispatch-dashboard-queue-row">
                <span className="w-5 shrink-0 text-mini text-app-text-secondary">{i + 1}ª</span>
                <span className="min-w-0 flex-1 basis-40">
                  {/* At 400 px (and on the phone) nothing is cut: title and reason wrap. */}
                  <span className="block break-words" title={q.title}>{q.title}</span>
                  <span className="flex flex-wrap items-center gap-x-1 text-mini text-app-text-secondary">
                    <Hourglass className="h-3 w-3 shrink-0" />
                    {q.project && <span className="rounded bg-white/5 px-1" data-testid="dispatch-dashboard-queue-project">{q.project}</span>}
                    {/* ONE reason per card; the detail is the tooltip. */}
                    <span className="break-words" data-testid="dispatch-dashboard-queue-reason" title={q.detail ?? undefined}>{q.reason ?? tr('board.dash.waiting')}</span>
                    <span>· {tr('board.dash.since', { time: waitingLabel(q.waitingMs) })}</span>
                  </span>
                </span>
                {i === 0 && onStartNow && q.memoryWaiter && (
                  <button
                    type="button"
                    data-testid="dispatch-dashboard-start-now"
                    title={tr(seatBusy ? 'board.dash.startNowBusy' : 'board.dash.startNowTitle')}
                    disabled={starting === q.id || seatBusy}
                    onClick={() => onStartNow(q)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-app-border-light bg-surface px-2 py-0.5 text-mini font-medium text-app-text-secondary enabled:hover:bg-app-hover disabled:opacity-50 coarse:min-h-11"
                  ><Play className="h-3 w-3" aria-hidden />{tr('board.dash.startNow')}</button>
                )}
                {failure?.id === q.id && (
                  <p className={`basis-full text-mini ${DANGER_TEXT}`} role="alert" data-testid="dispatch-dashboard-start-error">
                    {tr('board.dash.startNowFailed', { error: tr(START_ERR[failure.code ?? ''] ?? 'board.dash.startErr.generic') })}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {consumers.length > 0 && (
        // Closed by default: it opens on request.
        <details className="group" data-testid="dispatch-dashboard-holders-fold">
          <summary className="mb-1 flex min-h-6 cursor-pointer list-none items-center gap-1 text-mini font-medium uppercase tracking-wide text-app-text-secondary coarse:min-h-11">
            <ChevronRight size={10} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
            {tr('board.dash.holders', { total: total !== null ? gb(total) : '' })}
          </summary>
          <ul className="space-y-0.5" data-testid="dispatch-dashboard-holders">
            {consumers.map((c) => (
              <li key={c.label} className="flex items-center gap-2 text-mini">
                <span className="min-w-0 flex-1 break-words">{c.label}</span>
                <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded bg-white/10">
                  <i className="block h-full bg-sky-500/80" style={{ width: `${Math.round((c.gb / biggest) * 100)}%` }} />
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums">{gb(c.gb)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Summary and detail in one piece (tests and surfaces that do not split them). */
export function DispatchDashboardView({ live, onTurnOn, ...rest }: Parameters<typeof DispatchDetailsView>[0] & DashboardInput & {
  live?: boolean;
  onTurnOn?: () => void;
}) {
  return (
    <div className="space-y-2">
      <DispatchSummaryView capacity={rest.capacity} snapshot={rest.snapshot} queue={rest.queue} broken={rest.broken} dispatchOn={rest.dispatchOn} live={live} onTurnOn={onTurnOn} />
      <DispatchDetailsView {...rest} />
    </div>
  );
}

/** Capacity from the store, queue and series from the server every 15 s. */
function useDashboardData(tasks: readonly BoardTask[]) {
  const tr = useT();
  const { capacity } = useGlobalDispatchCap();
  const snapshot = useMemoryQueueSnapshot();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  // A real fault: the dispatcher parks the card with `failed` (the agent did not
  // deliver) or `blocked` (configuration to fix). A wait is not one.
  const broken = tasks.filter((t) => !t.parentTaskId && t.status !== 'done' && (t.dispatchState === 'failed' || t.dispatchState === 'blocked')).length;
  // The project name from the id (`<folder>-<hash>`); cards without a project show none.
  const projectName = (t: BoardTask) => (isProjectlessId(t.projectId) ? null : projectNameFromId(t.projectId));
  return { capacity, snapshot, now, broken, queue: queuedCards(tasks, tr, now, projectName) };
}

/** The live summary, for the top of the panel. */
export function DispatchSummary({ tasks, dispatchOn, onTurnOn }: { tasks: readonly BoardTask[]; dispatchOn?: boolean | null; onTurnOn?: () => void }) {
  const d = useDashboardData(tasks);
  return <DispatchSummaryView capacity={d.capacity} snapshot={d.snapshot} queue={d.queue} broken={d.broken} dispatchOn={dispatchOn} live={snapshotIsLive(d.now)} onTurnOn={onTurnOn} />;
}

/** The live detail (chart, queue, holders), for below the controls. */
export function DispatchDetails({ tasks }: { tasks: readonly BoardTask[] }) {
  const d = useDashboardData(tasks);
  const [starting, setStarting] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null);
  const start = (card: QueuedCard) => {
    if (starting) return;
    setStarting(card.id);
    setStartFailure(null);
    // The card changes state by itself: the server broadcasts it (`task:updated`) and the queue rereads.
    boardApi.startAnyway(card.projectId, card.id)
      .then(() => loadSnapshot(), (e: unknown) => setStartFailure({ id: card.id, code: (e as { code?: string } | null)?.code ?? null }))
      .finally(() => setStarting(null));
  };
  return <DispatchDetailsView capacity={d.capacity} snapshot={d.snapshot} queue={d.queue} now={d.now} onStartNow={start} starting={starting} startFailure={startFailure} />;
}

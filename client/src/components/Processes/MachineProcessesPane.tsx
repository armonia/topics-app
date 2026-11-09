/**
 * THE MACHINE'S PROCESSES (hub-smistamento, HUBBR-08 and HUBBR-09).
 *
 * One view for the whole machine, read from the usage hub through the Topics
 * proxy: the Mac (gauges, then who weighs, with memory, GPU and network per
 * process and the CPU where the hub measures it), the PC, the hub's services
 * and the Claude proxy's log, live. It replaces «This computer» of the Topics
 * menu: the server and the gateway are services here.
 *
 * Read-only by design. The one command is the Stop button on a project script Topics
 * started (the same stop as the project's own Processes section); the hub
 * restarts nothing from here. A number the hub did not measure is a dash.
 *
 * The log is an EventSource on the proxy's stream, open only while the view is
 * mounted and the log is open: closing either closes the stream, so nothing
 * keeps reading the proxy for a view nobody has in front.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, AppWindow, ArrowUpRight, Asterisk, Box, ChevronDown, ChevronRight, CloudOff, Cpu, Folder,
  Monitor, Moon, Pause, Play, Plug, ScrollText, Server, Square, Zap, type LucideIcon,
} from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useScripts } from '../../hooks/useScripts';
import { useHubEverRead, useHubLive, refreshHubLive } from '../../state/hubLive';
import { startVisibleInterval } from '../../state/documentVisibility';
import { serverHttpBase } from '../../lib/shell/net';
import { scriptsApi } from '../../lib/api';
import { PROCESSES_LOG_EVENT, takeProcessesLogRequest } from '../../state/processesLog';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { readJson } from '../../lib/readJson';
import {
  NOT_MEASURED, PROXY_SERVICE_ID, censusAt, formatMem, formatPct, formatRate, macGauges, parseLogEvent, pcView,
  processRows, pushLogLine, serviceGroups, serviceRows, servicesReadAt, servicesToWatch, type HistoryPoint, type LogLine, type MacGauges, type PcView, type ProcessRow, type ServiceRow, type UnitKind,
} from '../../lib/machineProcesses';

type Tr = ReturnType<typeof useT>;

/** The census is recomputed at most every 30 s by the hub: reading faster buys nothing. */
const POLL_MS = 15_000;
/** Rows drawn before the "N more processes" line. */
const TOP_ROWS = 8;

const KIND_ICON: Record<UnitKind, LucideIcon> = {
  app: AppWindow, servizio: Server, sessione: Asterisk, lavoro: Zap, devserver: Zap, mcp: Plug, macos: Monitor, altro: Cpu, resto: Box, // allow-italian: the census's wire values
};

const SECTION = 'min-w-0 overflow-hidden rounded border border-app-border bg-surface';
const SECTION_HEAD = 'flex h-[38px] items-center gap-2 border-b border-app-border-subtle px-2.5';
const FAINT = 'text-app-text-faint';
const STOP_BUTTON = 'inline-flex h-6 items-center gap-1 justify-self-end rounded-sm bg-black/[0.035] px-[7px] text-mini text-app-text-secondary hover:bg-black/[0.06] hover:text-app-text dark:bg-white/[0.05] dark:hover:bg-white/[0.14] @max-3xl:h-9 @max-3xl:px-2.5 @max-3xl:text-compact disabled:opacity-60';
const TRACK = 'bg-black/[0.07] dark:bg-white/[0.08]';
const ROW_GRID = '@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_46px_118px_42px_108px_64px] @3xl:items-center @3xl:gap-x-2.5';

interface HubReads {
  census: unknown;
  mac: unknown;
  machines: unknown;
}

/**
 * The three reads of the hub, again every POLL_MS while the page is visible.
 * `failing` is true when the last round got nothing at all: the view's own
 * proof that the hub is gone, which does not wait on the socket (a window whose
 * socket is reconnecting never gets the hub-down frame).
 */
function useHubReads(enabled: boolean): { reads: HubReads | null; failing: boolean; reread: () => Promise<void> } {
  const [reads, setReads] = useState<HubReads | null>(null);
  const [failing, setFailing] = useState(false);
  const round = useRef<() => Promise<void>>(async () => {});
  const reread = useCallback(() => round.current(), []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = async () => {
      const [census, mac, machines] = await Promise.all([readJson('/api/hub/mac/procs'), readJson('/api/hub/mac'), readJson('/api/hub/machines')]);
      if (!alive) return;
      const any = Boolean(census || mac || machines);
      setFailing(!any);
      // A failed read keeps the last good one: the hub-down band says how old it is.
      if (any) setReads((prev) => ({ census: census ?? prev?.census, mac: mac ?? prev?.mac, machines: machines ?? prev?.machines }));
    };
    round.current = read;
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, [enabled]);
  return { reads, failing, reread };
}

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), ms), [ms]);
  return now;
}

export function MachineProcessesPane() {
  const tr = useT();
  const present = useHubEverRead();
  const live = useHubLive();
  const answering = Object.values(live).some((e) => e?.data !== undefined);
  const { reads, failing, reread } = useHubReads(present);
  const { allScripts, refresh } = useScripts({ ports: true });
  const now = useTick(5_000);

  const rows = useMemo(() => processRows(reads?.census, reads?.mac, allScripts), [reads, allScripts]);
  const gauges = useMemo(() => macGauges(reads?.mac, reads?.machines, reads?.census), [reads]);
  const pc = useMemo(() => pcView(reads?.machines), [reads]);
  // The socket can miss the hub-down frame while it reconnects: with the view's own
  // reads failing, the last list it pushed is not shown as current.
  const services = useMemo(() => (failing ? [] : serviceRows(live.services?.data)), [live.services, failing]);
  const at = censusAt(reads?.census);
  // One answer for every section: with the hub gone, nothing reads as current.
  const stale = !answering || failing;

  return (
    <div className="@container h-full overflow-auto bg-app-bg" data-testid="machine-processes">
      <div className="mx-auto max-w-[1180px] px-[18px] pb-[22px] pt-3.5 @max-3xl:px-2.5 @max-3xl:pb-7">
        <header className="mb-3 flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-title font-semibold text-app-text-heading @max-3xl:hidden">{tr('processes.title')}</h1>
          <span className="flex-1 @max-3xl:hidden" />
          <span className={`flex items-center gap-1.5 text-mini tabular-nums ${FAINT} @max-3xl:text-compact`} data-testid="machine-processes-updated">
            <span className={`h-[7px] w-[7px] flex-none rounded-full ${!stale ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-amber-500'}`} />
            {at === null ? tr('processes.reading') : `${tr(stale ? 'processes.lastRead' : 'processes.now')} · ${updatedLabel(now - at, tr)}`}
          </span>
        </header>

        {present && stale && <HubDownBand onRetry={reread} />}

        {present && (
        <div className="grid items-start gap-3.5 @5xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <MacSection gauges={gauges} rows={rows} onStopped={refresh} />
          <div className="flex min-w-0 flex-col gap-3.5">
            {pc && <PcSection pc={pc} stale={stale} />}
            <ServicesAndLog services={services} readAt={failing ? null : servicesReadAt(live.services?.data)} />
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

function updatedLabel(ageMs: number, tr: Tr): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  return s < 60 ? tr('processes.updatedS', { n: s }) : tr('processes.updatedMin', { n: Math.floor(s / 60) });
}

function HubDownBand({ onRetry }: { onRetry: () => Promise<void> }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" data-testid="machine-processes-hub-down" className={`mb-3.5 flex items-center gap-2 rounded border border-amber-500/35 bg-amber-500/10 py-1.5 pl-3 pr-1.5 text-compact ${WARNING_TEXT}`}>
      <CloudOff size={14} className="flex-none" aria-hidden="true" />
      <span className="min-w-0 flex-1">{tr('processes.hubDown')}</span>
      <button
        type="button"
        disabled={busy}
        className={STOP_BUTTON}
        onClick={() => { setBusy(true); void Promise.all([refreshHubLive(), onRetry()]).finally(() => setBusy(false)); }}
      >
        {tr('processes.retry')}
      </button>
    </div>
  );
}

// ── Mac ──────────────────────────────────────────────────────────────────────

/**
 * The last 24 h of one gauge as a line, scaled to 0..100 %: the shape of the
 * day, not a second number.
 */
function Spark({ points, warn }: { points: HistoryPoint[]; warn: boolean }) {
  const tr = useT();
  const t0 = points[0].t;
  const span = Math.max(1, points[points.length - 1].t - t0);
  const W = 100;
  const H = 18;
  const xy = points.map((p) => `${((p.t - t0) / span * W).toFixed(1)},${(H - Math.max(0, Math.min(100, p.v)) / 100 * H).toFixed(1)}`);
  const peak = Math.round(Math.max(...points.map((p) => p.v)));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={`mt-1.5 block h-[18px] w-full ${warn ? 'text-amber-500' : 'text-app-text-tertiary'}`}
      role="img"
      aria-label={tr('processes.history', { peak })}
      data-testid="machine-gauge-history"
    >
      <title>{tr('processes.history', { peak })}</title>
      <polygon points={`0,${H} ${xy.join(' ')} ${W},${H}`} fill="currentColor" opacity={0.12} />
      <polyline points={xy.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Gauge({ label, value, unit, share, warn = false, history = [], note = null, testId }: { label: string; value: string; unit?: string; share: number | null; warn?: boolean; history?: HistoryPoint[]; note?: string | null; testId?: string }) {
  return (
    <div className="min-w-0 border-r border-app-border-subtle px-2.5 pb-2.5 pt-[9px] last:border-r-0 @max-3xl:[&:nth-child(3)]:border-r-0 @max-3xl:[&:nth-child(n+4)]:border-t" data-testid={testId} title={note ?? undefined}>
      <div className={`text-mini uppercase tracking-[0.04em] ${FAINT}`}>{label}</div>
      <div className="mt-0.5 whitespace-nowrap text-body-lg text-app-text @max-3xl:text-prose">
        {value}{unit && <span className={`text-mini ${FAINT}`}> {unit}</span>}
      </div>
      {note && <div className={`truncate text-mini ${warn ? WARNING_TEXT : FAINT}`} data-testid="machine-gauge-note">{note}</div>}
      {/* With a day of samples the line replaces the bar. */}
      {history.length >= 2 ? <Spark points={history} warn={warn} /> : (
        <div className={`mt-1.5 h-[3px] overflow-hidden rounded-sm ${TRACK}`}>
          {share !== null && <i className={`block h-full rounded-sm ${warn ? 'bg-amber-500' : 'bg-app-text-tertiary'}`} style={{ width: `${Math.round(Math.min(1, share) * 100)}%` }} />}
        </div>
      )}
    </div>
  );
}

function MacSection({ gauges: g, rows, onStopped }: { gauges: MacGauges; rows: ProcessRow[]; onStopped: () => void }) {
  const tr = useT();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, TOP_ROWS);
  const rest = rows.slice(TOP_ROWS);
  const restMem = rest.reduce((s, r) => s + r.memMB, 0);
  const memShare = g.memUsedGB !== null && g.totalGB ? g.memUsedGB / g.totalGB : null;
  // The pressure is its own measure, so it is named here and not drawn under the used GB.
  const summary = [
    g.cores !== null ? tr('processes.cores', { n: g.cores }) : null,
    g.totalGB !== null ? `${Math.round(g.totalGB)} GB` : null,
    g.state,
    g.memPressurePct !== null ? tr('processes.pressure', { n: Math.round(g.memPressurePct) }) : null,
  ].filter(Boolean).join(' · ');
  const strained = g.level >= 2;
  const swapShare = g.swapUsedGB !== null && g.swapTotalGB ? g.swapUsedGB / g.swapTotalGB : null;
  return (
    <section aria-label={tr('processes.mac')} className={SECTION} data-testid="machine-processes-mac" data-level={g.level}>
      <div className={SECTION_HEAD}>
        <Monitor size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="text-compact font-semibold text-app-text-heading">{tr('processes.mac')}</span>
        <span className={`min-w-0 flex-1 truncate text-mini tabular-nums ${g.level > 0 ? (strained ? DANGER_TEXT : WARNING_TEXT) : FAINT} @max-3xl:whitespace-normal @max-3xl:text-compact`}>{summary}</span>
      </div>
      <div className="grid grid-cols-6 border-b border-app-border-subtle tabular-nums @max-3xl:grid-cols-3">
        <Gauge label={tr('processes.cpu')} value={formatPct(g.cpuPct)} share={g.cpuPct === null ? null : g.cpuPct / 100} history={g.history.cpu} note={g.notes.cpu} />
        <Gauge label={tr('processes.memory')} value={g.memUsedGB === null ? NOT_MEASURED : g.memUsedGB.toFixed(1).replace('.', ',')} unit={g.totalGB ? `/ ${Math.round(g.totalGB)} GB` : undefined} share={memShare} warn={memShare !== null && memShare >= 0.8} />
        <Gauge label={tr('processes.swap')} value={g.swapUsedGB === null ? NOT_MEASURED : g.swapUsedGB.toFixed(1).replace('.', ',')} unit="GB" share={swapShare} warn={swapShare !== null && swapShare > 0.8} note={g.notes.swap} />
        <Gauge label={tr('processes.gpu')} value={formatPct(g.gpuPct)} share={g.gpuPct === null ? null : g.gpuPct / 100} history={g.history.gpu} />
        <Gauge label={tr('processes.net')} value={g.netInBps === null ? NOT_MEASURED : `↓${formatRate(g.netInBps)}`} unit={g.netOutBps === null ? undefined : `↑${formatRate(g.netOutBps)}`} share={null} />
        <Gauge label={tr('processes.disk')} value={formatPct(g.disk?.pct ?? null)} share={g.disk?.pct == null ? null : g.disk.pct / 100} warn={(g.disk?.pct ?? 0) >= 85} note={g.disk?.note ?? null} testId="machine-gauge-disk" />
      </div>
      {g.lines.map((line, i) => (
        <div key={i} className={`flex min-h-[34px] items-center gap-2.5 border-b border-app-border-subtle px-2.5 py-1 ${g.level > 0 ? 'bg-amber-500/[0.06]' : ''}`} data-testid="machine-mac-line">
          <Activity size={14} className={`flex-none ${g.level > 0 ? WARNING_TEXT : FAINT}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 text-compact text-app-text @max-3xl:text-prose">{line}</span>
        </div>
      ))}
      <div className={`${ROW_GRID} h-7 border-b border-app-border-subtle px-2.5 text-mini uppercase tracking-[0.04em] ${FAINT} hidden @3xl:grid`}>
        <span>{tr('processes.process')}</span>
        <span className="text-right">{tr('processes.cpu')}</span>
        <span className="inline-flex items-center justify-end gap-[3px] text-app-text-secondary">{tr('processes.memory')}<ChevronDown size={11} aria-hidden="true" /></span>
        <span className="text-right">{tr('processes.gpu')}</span>
        <span className="text-right">{tr('processes.net')}</span>
        <span />
      </div>
      <div data-testid="machine-processes-rows">
        {shown.map((r) => <ProcessRowView key={r.id} row={r} onStopped={onStopped} />)}
      </div>
      {rest.length > 0 && (
        <button type="button" onClick={() => setAll((v) => !v)} data-testid="machine-processes-more" className={`flex h-8 w-full items-center justify-center gap-1.5 border-t border-app-border-subtle text-mini ${FAINT} hover:bg-app-hover @max-3xl:h-11 @max-3xl:text-compact`}>
          <ChevronDown size={13} className={all ? 'rotate-180' : ''} aria-hidden="true" />
          {all ? tr('processes.less') : tr('processes.more', { n: rest.length, mem: formatMem(restMem) })}
        </button>
      )}
      <div className={`flex items-center gap-1.5 border-t border-app-border-subtle px-2.5 py-[7px] text-mini ${FAINT} @max-3xl:text-compact`}>
        <Square size={12} className="flex-none" aria-hidden="true" />
        {tr('processes.rule')}
      </div>
    </section>
  );
}

function Net({ inBps, outBps }: { inBps: number | null; outBps: number | null }) {
  if (inBps === null || outBps === null) return <span className={`text-right ${FAINT}`}>{NOT_MEASURED}</span>;
  return (
    <span className="flex flex-col items-end text-mini leading-tight text-app-text-secondary">
      <span className="whitespace-nowrap">↓ {formatRate(inBps)}</span>
      <span className={`whitespace-nowrap ${FAINT}`}>↑ {formatRate(outBps)}</span>
    </span>
  );
}

function ProcessRowView({ row: r, onStopped }: { row: ProcessRow; onStopped: () => void }) {
  const tr = useT();
  const Icon = KIND_ICON[r.kind];
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const memTone = r.memWarn ? WARNING_TEXT : '';
  // A reading of only some of the unit's processes is a floor, and says so.
  const cpu = r.cpuPartial ? `≥${formatPct(r.cpuPct)}` : formatPct(r.cpuPct);
  const cpuTitle = r.cpuPct === null ? tr('processes.notMeasured') : r.cpuPartial ? tr('processes.cpuPartial') : undefined;
  const stop = useCallback(async () => {
    if (!r.script) return;
    setStopping(true);
    setFailure(null);
    try { await scriptsApi.stop(r.script.processId); onStopped(); }
    catch (e) { setFailure(e instanceof Error ? e.message : String(e)); }
    finally { setStopping(false); }
  }, [r.script, onStopped]);
  const metric = (label: string, value: ReactNode, cls = '') => (
    <span className={cls}><span className={`mr-[3px] ${FAINT}`}>{label}</span>{value}</span>
  );
  return (
    <div
      className={`${ROW_GRID} grid grid-cols-[minmax(0,1fr)_auto] gap-y-1 border-b border-app-border-subtle px-2.5 py-[7px] last:border-b-0 hover:bg-app-hover @3xl:min-h-9 @3xl:py-[3px]`}
      data-testid="machine-process-row"
      data-kind={r.kind}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-xs bg-black/[0.035] dark:bg-white/[0.05] ${r.kind === 'sessione' ? 'text-orange-500 dark:text-orange-400' : 'text-app-text-secondary'}`}>{/* allow-italian: the census's wire value */}
          <Icon size={13} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-compact text-app-text @max-3xl:text-prose">{r.name}</span>
          {r.script ? (
            <button
              type="button"
              className="inline-flex w-fit max-w-full items-center gap-[3px] truncate rounded-xs bg-primary/10 px-1 -ml-1 text-mini text-primary @max-3xl:text-compact"
              title={tr('processes.openProject', { project: r.script.project })}
              onClick={() => window.dispatchEvent(new CustomEvent('topics:open-project', { detail: { projectPath: r.script?.projectPath } }))}
              data-testid="machine-process-script"
            >
              <Folder size={11} aria-hidden="true" />
              {r.script.project} › {r.script.scriptName}{r.script.port !== null && <span className="font-mono">{` :${r.script.port}`}</span>}
              <ArrowUpRight size={11} aria-hidden="true" />
            </button>
          ) : (
            <span className={`truncate text-mini ${FAINT} @max-3xl:text-compact`}>{[tr(`processes.kind.${r.kind}`), r.detail].filter(Boolean).join(' · ')}</span>
          )}
          {failure && <span className={`text-mini ${DANGER_TEXT}`}>{tr('processes.stopFailed', { why: failure })}</span>}
        </span>
      </div>
      <span className={`hidden text-right text-compact tabular-nums @3xl:block ${r.cpuPct === null ? FAINT : ''}`} data-testid="machine-process-cpu" title={cpuTitle}>{cpu}</span>
      <span className="hidden items-center justify-end gap-1.5 text-compact tabular-nums @3xl:flex">
        <span className={`h-1 max-w-[52px] flex-1 overflow-hidden rounded-sm ${TRACK}`}><i className={`block h-full ${r.memWarn ? 'bg-amber-500' : 'bg-app-text-tertiary'}`} style={{ width: `${Math.round(r.memShare * 100)}%` }} /></span>
        <span className={memTone}>{formatMem(r.memMB)}</span>
      </span>
      <span className={`hidden text-right text-compact tabular-nums @3xl:block ${r.gpuPct === null ? FAINT : ''}`} data-testid="machine-process-gpu">{formatPct(r.gpuPct)}</span>
      <span className="hidden justify-end tabular-nums @3xl:flex" data-testid="machine-process-net"><Net inBps={r.netInBps} outBps={r.netOutBps} /></span>
      <span className="flex justify-end">
        {r.script && (
          <button type="button" className={STOP_BUTTON} disabled={stopping} onClick={() => void stop()} title={tr('processes.stopTitle', { script: r.script.scriptName, project: r.script.project })} data-testid="machine-process-stop">
            <Square size={11} aria-hidden="true" />{tr('processes.stop')}
          </button>
        )}
      </span>
      <div className="col-span-2 flex flex-wrap gap-x-2.5 gap-y-1 whitespace-nowrap pl-[30px] text-compact tabular-nums text-app-text-secondary @3xl:hidden">
        {metric(tr('processes.cpu'), cpu)}
        {metric(tr('processes.memory'), formatMem(r.memMB), memTone)}
        {metric(tr('processes.gpu'), formatPct(r.gpuPct))}
        {metric(tr('processes.net'), r.netInBps === null || r.netOutBps === null ? NOT_MEASURED : `↓${formatRate(r.netInBps)} ↑${formatRate(r.netOutBps)}`)}
      </div>
    </div>
  );
}

// ── PC ───────────────────────────────────────────────────────────────────────

function PcSection({ pc, stale }: { pc: PcView; stale: boolean }) {
  const tr = useT();
  if (stale) return <PcUnread pc={pc} />;
  // On with ssh closed is a command away on the PC, not a dead machine: amber, as the hub had it.
  const dot = pc.state === 'lavora' || pc.state === 'acceso' ? 'bg-emerald-500 dark:bg-emerald-400' : pc.state === 'dorme' ? 'bg-app-text-faint opacity-50' : pc.state === 'closed' ? 'bg-amber-500' : 'bg-red-500'; // allow-italian: the hub's wire values
  const stateText = pc.state === 'lavora' || pc.state === 'acceso' ? SUCCESS_TEXT : pc.state === 'dorme' ? FAINT : pc.state === 'closed' ? WARNING_TEXT : DANGER_TEXT; // allow-italian: the hub's wire values
  return (
    <section aria-label={tr('processes.pc')} className={SECTION} data-testid="machine-processes-pc">
      <div className={SECTION_HEAD}>
        <Cpu size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="text-compact font-semibold text-app-text-heading">{tr('processes.pc')}</span>
        <span className={`min-w-0 flex-1 truncate text-mini ${FAINT} @max-3xl:text-compact`}>
          <span className={`inline-flex items-center gap-[5px] ${stateText}`} data-testid="machine-pc-state" data-state={pc.state}><span className={`h-[7px] w-[7px] rounded-full ${dot}`} />{tr(`processes.pc.${pc.state}`)}</span>
          {' · '}{pc.offload > 0 ? tr('processes.pc.jobs', { n: pc.offload }) : tr('processes.pc.noJobs')}
        </span>
      </div>
      {pc.metrics.length > 0 && (
        <div className="grid grid-cols-4 border-b border-app-border-subtle tabular-nums">
          {pc.metrics.slice(0, 4).map((m) => <Gauge key={m.key} label={m.name} value={formatPct(m.pct)} share={m.pct === null ? null : m.pct / 100} warn={m.pct !== null && m.pct >= 85} history={m.history} />)}
        </div>
      )}
      {[...pc.lines, ...pc.heavy.map((h) => tr('processes.pc.heavy', { name: h.name, cores: String(h.cores).replace('.', ',') }))].map((line, i) => (
        <div key={i} className="flex min-h-[38px] items-center gap-2.5 border-b border-app-border-subtle px-2.5 py-1 last:border-b-0">
          <Activity size={14} className={`flex-none ${FAINT}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 text-compact text-app-text @max-3xl:text-prose">{line}</span>
        </div>
      ))}
      <div className={`flex items-center gap-1.5 px-2.5 py-2 text-mini ${pc.state === 'closed' ? WARNING_TEXT : FAINT} @max-3xl:text-compact`} data-testid="machine-pc-caption">
        <Moon size={12} className="flex-none" aria-hidden="true" />
        {pc.state === 'dorme' ? tr('processes.pc.wakes') : pc.caption}{/* allow-italian: the hub's wire value */}
      </div>
    </section>
  );
}

/**
 * The PC with the hub gone: its state and jobs are unknown, so neither is
 * shown; the last numbers stay, under the band that says they are frozen.
 */
function PcUnread({ pc }: { pc: PcView }) {
  const tr = useT();
  return (
    <section aria-label={tr('processes.pc')} className={SECTION} data-testid="machine-processes-pc">
      <div className={SECTION_HEAD}>
        <Cpu size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="text-compact font-semibold text-app-text-heading">{tr('processes.pc')}</span>
        <span className={`inline-flex min-w-0 flex-1 items-center gap-[5px] truncate text-mini ${WARNING_TEXT} @max-3xl:text-compact`}>
          <span className="h-[7px] w-[7px] flex-none rounded-full bg-amber-500" />{tr('processes.pc.unread')}
        </span>
      </div>
      {pc.metrics.length > 0 && (
        <div className="grid grid-cols-4 tabular-nums">
          {pc.metrics.slice(0, 4).map((m) => <Gauge key={m.key} label={m.name} value={formatPct(m.pct)} share={m.pct === null ? null : m.pct / 100} history={m.history} />)}
        </div>
      )}
    </section>
  );
}

// ── Services and the proxy's log ─────────────────────────────────────────────

function ServicesAndLog({ services, readAt }: { services: ServiceRow[]; readAt: number | null }) {
  const tr = useT();
  const [logOpen, setLogOpen] = useState(true);
  const openLog = useCallback(() => setLogOpen(true), []);
  const shown = services.filter((s) => s.state !== 'spento'); // allow-italian: the hub's wire value
  const offRows = services.filter((s) => s.state === 'spento'); // allow-italian: the hub's wire value
  const off = offRows.length;
  const [offOpen, setOffOpen] = useState(false);
  const stopped = shown.filter((s) => s.state === 'fermo').length; // allow-italian: the hub's wire value
  const live = shown.filter((s) => s.state === 'vivo').length; // allow-italian: the hub's wire value
  // A service up with a problem asks for a look as much as a stopped one: «all on» would be a lie.
  const toWatch = servicesToWatch(services);
  const hasProxy = services.some((s) => s.id === PROXY_SERVICE_ID);
  // No list is not "all up": with the hub down the services are unknown, and
  // the view says so instead of a green dot.
  const unread = services.length === 0;
  return (
    <>
      <section aria-label={tr('processes.services')} className={SECTION} data-testid="machine-processes-services">
        <div className={SECTION_HEAD}>
          <Server size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
          <span className="text-compact font-semibold text-app-text-heading">{tr('processes.services')}</span>
          <span className={`min-w-0 flex-1 truncate text-mini tabular-nums ${FAINT} @max-3xl:text-compact`}>
            {!unread && tr('processes.services.liveOf', { n: live, total: services.length })}
            {!unread && readAt !== null && <> · <span data-testid="machine-services-read" title={tr('processes.services.readHint')}>{tr('processes.services.readAt', { time: new Date(readAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) })}</span></>}
            {stopped > 0 && <> · <span className={DANGER_TEXT}>{tr('processes.services.stopped', { n: stopped })}</span></>}
            {toWatch > 0 && <> · <span className={WARNING_TEXT} data-testid="machine-services-watch">{tr('processes.services.toWatch', { n: toWatch })}</span></>}
          </span>
        </div>
        {serviceGroups(shown).map((g) => (
          <div key={g.key} role="group" aria-label={g.label ?? tr(`processes.services.group.${g.key}`)} data-testid="machine-services-group" data-group={g.key}>
            <div className={`flex h-7 items-center gap-1.5 border-b border-app-border-subtle px-2.5 text-mini uppercase tracking-[0.04em] ${FAINT}`}>
              <span>{g.label ?? tr(`processes.services.group.${g.key}`)}</span>
              <span className="tabular-nums">{g.rows.length}</span>
            </div>
            {g.rows.map((s) => (
              <ServiceRowView key={s.id} s={s} log={s.id === PROXY_SERVICE_ID ? { open: logOpen, toggle: () => setLogOpen((v) => !v) } : null} />
            ))}
          </div>
        ))}
        {offOpen && offRows.map((s) => <ServiceRowView key={s.id} s={s} log={null} />)}
        <div className={`flex items-center gap-1.5 px-2.5 py-2 text-mini ${FAINT} @max-3xl:text-compact`} data-testid="machine-services-foot">
          {unread ? tr('processes.services.unread') : <>
          {toWatch === 0 && <span className="h-[7px] w-[7px] flex-none rounded-full bg-emerald-500 dark:bg-emerald-400" />}
          {toWatch === 0 && <span>{tr('processes.services.allOk')}</span>}
          {toWatch === 0 && off > 0 && <span aria-hidden="true">·</span>}
          {off > 0 && (
            <button type="button" onClick={() => setOffOpen((v) => !v)} aria-expanded={offOpen} className="inline-flex items-center gap-1 hover:text-app-text" data-testid="machine-services-off">
              <ChevronRight size={12} className={offOpen ? 'rotate-90' : ''} aria-hidden="true" />
              {tr('processes.services.off', { n: off })}
            </button>
          )}
          <span className="flex-1" />
          <span title={tr('processes.services.legend')} className="cursor-help underline decoration-dotted" data-testid="machine-services-legend">{tr('processes.services.legendLabel')}</span>
          </>}
        </div>
      </section>
      {hasProxy && <LogSection open={logOpen} onAsked={openLog} />}
    </>
  );
}

const SERVICE_DOT: Record<ServiceRow['state'], string> = {
  vivo: 'bg-emerald-500 dark:bg-emerald-400', 'in attesa': 'bg-app-text-faint', fermo: 'bg-red-500', spento: 'bg-app-text-faint opacity-50', // allow-italian: the hub's wire values
};
const STATE_KEY: Record<ServiceRow['state'], string> = { vivo: 'vivo', 'in attesa': 'attesa', fermo: 'fermo', spento: 'spento' }; // allow-italian: the hub's wire values

function ServiceRowView({ s, log }: { s: ServiceRow; log: { open: boolean; toggle: () => void } | null }) {
  const tr = useT();
  const bad = s.state === 'fermo'; // allow-italian: the hub's wire value
  const dot = s.problem && !bad ? 'bg-amber-500' : SERVICE_DOT[s.state];
  // Its own memory, and with the processes it started: the hub's figure, which the census splits elsewhere.
  const mem = s.memMB === null ? null : s.treeMB !== null && s.children > 0
    ? tr('processes.service.tree', { mem: formatMem(s.memMB), n: s.children, tree: formatMem(s.treeMB) })
    : formatMem(s.memMB);
  const detail = [mem, s.label].filter(Boolean).join(' · ');
  const off = s.state === 'spento'; // allow-italian: the hub's wire value
  return (
    <div
      className={`flex min-h-[38px] items-center gap-2.5 border-b border-app-border-subtle px-2.5 py-1 ${bad ? 'bg-red-500/[0.06]' : ''} ${log?.open ? 'bg-app-hover' : ''} ${off ? 'opacity-60' : ''}`}
      data-testid="machine-service-row"
      data-state={s.state}
      title={s.what ?? undefined}
    >
      <span className={`h-[7px] w-[7px] flex-none rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-compact text-app-text @max-3xl:text-prose">
          {s.url
            ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline" data-testid="machine-service-link">{s.name}</a>
            : s.name}
          {s.what && <span className={`ml-1.5 text-mini ${FAINT}`} data-testid="machine-service-what">{s.what}</span>}
        </div>
        <div className={`truncate text-mini ${FAINT} @max-3xl:whitespace-normal @max-3xl:text-compact`}>
          <span title={tr(`processes.state.${STATE_KEY[s.state]}.hint`)} className="cursor-help">{tr(`processes.state.${STATE_KEY[s.state]}`)}</span>
          {detail && <> · {detail}</>}
          {s.problem && <> · <span className={WARNING_TEXT}>{s.problem}</span></>}
        </div>
      </div>
      {s.port !== null && <span className={`font-mono text-mini ${FAINT} @max-3xl:text-compact`}>:{s.port}</span>}
      {log && (
        <button type="button" onClick={log.toggle} aria-label={log.open ? tr('processes.log.close') : tr('processes.log.open')} title={log.open ? tr('processes.log.close') : tr('processes.log.open')} data-testid="machine-service-log-toggle" className={`flex h-[26px] w-[26px] items-center justify-center rounded-xs ${FAINT} hover:bg-app-hover hover:text-app-text @max-3xl:h-9 @max-3xl:w-9`}>
          {log.open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

const LOG_TONE: Record<LogLine['tone'], string> = { error: DANGER_TEXT, warn: WARNING_TEXT, ok: SUCCESS_TEXT, plain: 'text-app-text-secondary' };

/** The proxy's stream, open while `open` and the view are: the effect's cleanup closes it. */
function useProxyLog(open: boolean, paused: boolean): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    if (!open || paused) return;
    const es = new EventSource(`${serverHttpBase()}/api/switchboard/logs/stream`);
    // The proxy replays its whole buffer on every connection: what was held goes, or each line shows twice.
    es.onopen = () => setLines([]);
    es.onmessage = (e: MessageEvent<string>) => {
      const line = parseLogEvent(e.data);
      if (line) setLines((prev) => pushLogLine(prev, line));
    };
    return () => es.close();
  }, [open, paused]);
  return lines;
}

function LogSection({ open, onAsked }: { open: boolean; onAsked: () => void }) {
  const tr = useT();
  const ref = useRef<HTMLElement>(null);
  // The palette's «Log» (HUBBR-19): a request set down before this section
  // mounted, or one heard while it is on screen, opens it and brings it in view.
  useEffect(() => {
    const answer = () => {
      if (!takeProcessesLogRequest()) return;
      onAsked();
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start' }));
    };
    answer();
    window.addEventListener(PROCESSES_LOG_EVENT, answer);
    return () => window.removeEventListener(PROCESSES_LOG_EVENT, answer);
  }, [onAsked]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [paused, setPaused] = useState(false);
  const lines = useProxyLog(open, paused);
  const shown = errorsOnly ? lines.filter((l) => l.tone === 'error') : lines;
  const pill = (on: boolean) => `inline-flex h-[22px] items-center rounded-sm px-2 text-mini @max-3xl:h-7 @max-3xl:text-compact ${on ? 'bg-primary/10 text-primary' : 'bg-black/[0.035] text-app-text-secondary dark:bg-white/[0.05]'}`;
  return (
    <section ref={ref} aria-label={tr('processes.log')} className={SECTION} data-testid="machine-processes-log" data-open={open ? 'true' : 'false'}>
      <div className={SECTION_HEAD}>
        <ScrollText size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="text-compact font-semibold text-app-text-heading">{tr('processes.log')}</span>
        <span className={`min-w-0 flex-1 truncate text-mini ${FAINT} @max-3xl:text-compact`}>{tr('processes.log.source')}</span>
      </div>
      {open ? (
        <>
          <div className="flex items-center gap-1.5 border-b border-app-border-subtle px-2.5 py-1.5">
            <span className={`inline-flex items-center gap-[5px] text-mini @max-3xl:text-compact ${paused ? FAINT : SUCCESS_TEXT}`}>
              <span className={`h-[7px] w-[7px] rounded-full ${paused ? 'bg-app-text-faint' : 'bg-emerald-500 dark:bg-emerald-400'}`} />
              {paused ? tr('processes.log.paused') : tr('processes.log.live')}
            </span>
            <span className="flex-1" />
            <button type="button" className={pill(!errorsOnly)} onClick={() => setErrorsOnly(false)}>{tr('processes.log.all')}</button>
            <button type="button" className={pill(errorsOnly)} onClick={() => setErrorsOnly(true)} data-testid="machine-log-errors">{tr('processes.log.errors')}</button>
            <button type="button" onClick={() => setPaused((v) => !v)} aria-label={paused ? tr('processes.log.resume') : tr('processes.log.pause')} title={paused ? tr('processes.log.resume') : tr('processes.log.pause')} className={`flex h-[26px] w-[26px] items-center justify-center rounded-xs ${FAINT} hover:bg-app-hover hover:text-app-text @max-3xl:h-9 @max-3xl:w-9`}>
              {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
            </button>
          </div>
          {/* A line is read whole: the project and branch at its end are what it says. */}
          <div role="log" aria-label={tr('processes.log.source')} tabIndex={0} className="max-h-[206px] overflow-auto bg-app-inset px-2.5 pb-2 pt-1.5 font-mono text-mini leading-[1.7] tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-primary/50 @max-3xl:max-h-none" data-testid="machine-log-lines">
            {shown.length === 0 && <div className={FAINT}>{tr('processes.log.empty')}</div>}
            {shown.map((l, i) => (
              <div key={`${l.ts}-${i}`} className="whitespace-pre-wrap break-all text-app-text-secondary" data-tone={l.tone} data-testid="machine-log-line">
                <span className={`mr-2 ${FAINT}`}>{l.ts}</span>
                {l.tag && <span className={`mr-1.5 ${LOG_TONE[l.tone]}`}>{l.tag}</span>}
                {l.msg}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={`px-2.5 py-2 text-mini ${FAINT} @max-3xl:text-compact`}>{tr('processes.log.closed')}</div>
      )}
    </section>
  );
}

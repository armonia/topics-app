/**
 * IL CRUSCOTTO DEI CONSUMI in testa al pannello «Come partono le card».
 *
 * Disegno scelto da Attilio (mock «come partono le card», pannello c): prima di
 * girare le manopole si legge cosa sta succedendo — quante card lavorano, quante
 * aspettano e in che ordine, quanta memoria ha il Mac e chi la tiene.
 *
 * Tutti i numeri arrivano dalle stesse sorgenti che il dispatcher usa per
 * decidere (`/system/dispatch-capacity` nello store del tetto, e
 * `/dispatch/memory-queue`, che porta anche la serie della memoria libera):
 * il pannello non rifà nessun conto. I testi di attesa sono quelli neutri del
 * server (`queueReason`), non una frase nostra.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Laptop } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { req } from '../../lib/board';
import type { BoardTask, DispatchCapacity } from '../../lib/board';
import type { DispatchMemoryQueueSnapshot } from '../../../../shared/board';
import { currentCapLimit, useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { queueReasonText } from '../../../../shared/queue-reason-text';

/** Una card in coda, come la riga la disegna. */
export interface QueuedCard {
  id: string;
  title: string;
  /** Millisecondi da quando aspetta (dall'ultimo aggiornamento). */
  waitingMs: number;
  /** Frase neutra decisa dal server, già tradotta; `null` = il server non ne ha. */
  reason: string | null;
}

/** Le card che aspettano un posto, nell'ordine in cui il dispatcher le serve. */
export function queuedCards(tasks: readonly BoardTask[], tr: (k: string, p?: Record<string, string | number>) => string, now: number): QueuedCard[] {
  return tasks
    .filter((t) => !t.parentTaskId && (t.dispatchState === 'queued' || t.dispatchState === 'waiting'))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .map((t) => {
      const text = t.queueReason ? queueReasonText(t.queueReason, tr) : null;
      return {
        id: t.id,
        title: t.text,
        waitingMs: Math.max(0, now - Date.parse(t.updatedAt)),
        reason: text ? `${text.head} · ${text.detail}` : null,
      };
    });
}

const LANG = 'it-IT';
const gb = (n: number) => `${n.toLocaleString(LANG, { maximumFractionDigits: 1 })} GB`;

/** «19 min» / «2 h 5 min»: quanto aspetta, mai un timestamp. */
export function waitingLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// ── lo snapshot della coda di memoria: UNA lettura ogni 15 s per tutte le superfici ──
let snap: DispatchMemoryQueueSnapshot | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function loadSnapshot() {
  req<DispatchMemoryQueueSnapshot>('/dispatch/memory-queue').then(
    (s) => { snap = s; listeners.forEach((l) => l()); },
    () => { /* senza dispatcher il cruscotto resta sulla sola capacità */ },
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
export function useMemoryQueueSnapshot(): DispatchMemoryQueueSnapshot | null {
  return useSyncExternalStore(subscribeSnapshot, () => snap, () => null);
}

/** Etichetta di sezione, come nel disegno: maiuscoletto 11 px con il riquadro a destra. */
export function SectionHead({ left, right }: { left: string; right?: string }) {
  return (
    <div data-testid="dispatch-section-head" className="mb-1.5 mt-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[.05em] text-app-text-muted">
      <span>{left}</span>{right && <span className="normal-case tracking-normal font-normal">{right}</span>}
    </div>
  );
}

// ── il grafico: memoria libera, ultima ora, con la soglia e le card al lavoro ──
const W = 606, PL = 30, PR = 8, PT = 8, CH = 96, SY = 110, SH = 18, YMAX = 6;

export function MemoryChart({ history, startGB, now }: {
  history: DispatchMemoryQueueSnapshot['history'];
  startGB: number | null;
  now: number;
}) {
  const tr = useT();
  const [hover, setHover] = useState<number | null>(null);
  const pts = history
    .map((p) => ({ t: Date.parse(p.at), v: p.freeGB, r: p.running }))
    .filter((p) => p.t >= now - 3_660_000); // un'ora piena, col minuto di bordo
  if (pts.length < 2) {
    return <p className="text-mini text-app-text-muted" data-testid="dispatch-chart-empty">{tr('board.dash.chartEmpty')}</p>;
  }
  const t0 = pts[0]!.t, span = Math.max(60_000, pts[pts.length - 1]!.t - t0);
  const x = (t: number) => PL + ((t - t0) / span) * (W - PL - PR);
  const y = (v: number) => PT + CH - (Math.min(v, YMAX) / YMAX) * CH;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts[pts.length - 1]!.t)} ${y(0)}L${x(t0)} ${y(0)}Z`;
  const last = pts[pts.length - 1]!;
  const hasRunning = pts.some((p) => p.r !== undefined);
  // un rettangolo per tratto con lo stesso numero di card: un rettangolo al minuto
  // lascia cuciture chiare fra un minuto e l'altro
  const bars: Array<{ x: number; w: number; c: number; first: boolean }> = [];
  if (hasRunning) {
    for (let i = 0; i < pts.length - 1;) {
      const c = pts[i]!.r ?? 0;
      let j = i;
      while (j < pts.length - 1 && (pts[j + 1]!.r ?? 0) === c) j++;
      const end = Math.min(j + 1, pts.length - 1);
      if (c) bars.push({ x: x(pts[i]!.t), w: x(pts[end]!.t) - x(pts[i]!.t), c: Math.min(c, 2), first: true });
      i = j + 1;
    }
  }
  const mins = Math.round(span / 60_000);
  const h = hover === null ? null : pts[hover]!;
  return (
    <div className="relative" data-testid="dispatch-chart">
      <svg viewBox={`0 0 ${W} ${hasRunning ? 150 : 124}`} className="block w-full" role="img" aria-label={tr('board.dash.chartTitle')}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - PL) / (W - PL - PR)) * (pts.length - 1));
          setHover(Math.max(0, Math.min(pts.length - 1, i)));
        }}>
        <g className="text-app-text-muted" fontSize="10.5" fill="currentColor">
          {[0, 2, 4, 6].map((v) => (
            <g key={v}>
              <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--border)" />
              <text x={PL - 6} y={y(v) + 3.5} textAnchor="end">{v} GB</text>
            </g>
          ))}
        </g>
        <path d={area} fill="var(--primary)" fillOpacity=".10" />
        {startGB !== null && (
          <g>
            <line x1={PL} x2={W - PR} y1={y(startGB)} y2={y(startGB)} stroke="currentColor" strokeWidth="1.25" strokeDasharray="4 3" className="text-app-text-secondary" />
            <text x={x(t0) + (W - PL - PR) / 60} y={y(startGB) + 14} fontSize="10.5" fontWeight="600" fill="currentColor" className="text-app-text-secondary">{tr('board.dash.chartThreshold', { start: gb(startGB) })}</text>
          </g>
        )}
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
        <circle cx={x(last.t)} cy={y(last.v)} r="4.5" fill="var(--primary)" stroke="var(--popover-bg, var(--bg-surface))" strokeWidth="2" />
        <text x={x(last.t)} y={y(last.v) + 17} textAnchor="end" fontSize="11" fontWeight="600" fill="currentColor" className="text-app-text">{gb(last.v)}</text>
        {hasRunning && (
          <g className="text-app-text-muted" fontSize="10.5" fill="currentColor">
            {bars.map((b, i) => <rect key={i} x={b.x} y={SY + SH - (b.c / 2) * SH} width={b.w} height={(b.c / 2) * SH} fill="var(--primary)" fillOpacity=".28" />)}
            {bars.filter((b) => b.first).map((b, i) => <text key={`l${i}`} x={b.x + 4} y={SY + 8 + (b.c > 1 ? 6 : 0)} fontSize="10" fill="currentColor" className="text-app-text-body">{tr('board.dash.chartN', { n: b.c })}</text>)}
            <line x1={PL} x2={W - PR} y1={SY + SH} y2={SY + SH} stroke="var(--border)" />
            {/* una tacca dove parte una card in più */}
            {bars.filter((b) => b.first).map((b, i) => <line key={`s${i}`} x1={b.x} x2={b.x} y1={SY - 3} y2={SY + SH} stroke="currentColor" />)}
            <text x={PL - 6} y={SY + SH - 2} textAnchor="end">{tr('board.dash.chartCards')}</text>
          </g>
        )}
        <g className="text-app-text-muted" fontSize="10.5" fill="currentColor">
          <text x={x(t0)} y={hasRunning ? 146 : 118}>{tr('board.dash.chartAgo', { min: mins })}</text>
          {mins >= 20 && <text x={(x(t0) + x(last.t)) / 2} y={hasRunning ? 146 : 118} textAnchor="middle">{tr('board.dash.chartAgo', { min: Math.round(mins / 2) })}</text>}
          <text x={x(last.t)} y={hasRunning ? 146 : 118} textAnchor="end">{tr('board.dash.chartNow')}</text>
        </g>
        {h && <line x1={x(h.t)} x2={x(h.t)} y1={PT} y2={SY + SH} stroke="currentColor" className="text-app-text-muted" />}
      </svg>
      {h && (
        <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-app-border-light bg-surface px-2 py-1 text-[11.5px] shadow">
          {tr('board.dash.chartTip', { ago: Math.max(0, Math.round((last.t - h.t) / 60_000)), free: gb(h.v) })}
        </div>
      )}
    </div>
  );
}

export function DispatchDashboardView({ capacity, snapshot, queue, dispatchOn, onToggleDispatch, broken = 0, now }: {
  capacity: DispatchCapacity | null;
  snapshot: DispatchMemoryQueueSnapshot | null;
  queue: QueuedCard[];
  dispatchOn?: boolean | null;
  onToggleDispatch?: () => void;
  /** Card ferme per un guasto vero (non per un'attesa). */
  broken?: number;
  now: number;
}) {
  const tr = useT();
  const running = capacity?.running ?? 0;
  const free = capacity?.availableMemGB ?? snapshot?.reading.freeGB ?? null;
  const startGB = snapshot?.threshold.startGB ?? null;
  const cpuHolds = capacity?.admission?.blockedBy === 'cpu';
  // Quanto resta alle app quando ne parte un'altra: la soglia meno il peso di una card
  // (dal tetto, o dal prezzo che il server dà alla prima in coda).
  const costGB = capacity?.agentCostMemGB ?? snapshot?.queue[0]?.costGB ?? null;
  const keepGB = startGB !== null && costGB != null ? Math.max(0, startGB - costGB) : null;
  const [heroLeft, heroRight] = tr('board.dash.hero', { running, queued: queue.length }).split(' · ');
  const num = (n: number) => n.toLocaleString(LANG, { maximumFractionDigits: 1 });
  // Il «3,5 GB liberi» in grassetto, come nel disegno: la frase si spezza sul segnaposto.
  const [waitHead, waitTail] = tr('board.dash.memoryWait', { start: '\u0000', free: free === null ? '' : num(free) }).split('\u0000');
  return (
    <section data-testid="dispatch-dashboard" className="text-xs leading-[1.45] text-app-text">
      {onToggleDispatch && (
        <div data-testid="dispatch-dashboard-sub" className="mb-3 flex items-center justify-between text-app-text-muted">
          <span>{tr('board.settings.sec.global')}</span>
          <label className="inline-flex cursor-pointer items-center gap-2 text-app-text-body" title={tr('board.settings.dispatchOnTitle')}>
            <span>{tr('board.dash.switch')}<span className="sr-only"> {tr('board.settings.autoDispatch')}</span></span>
            <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="peer sr-only" />
            <span aria-hidden className="relative h-[18px] w-[30px] shrink-0 rounded-full bg-app-text-faint/40 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-[14px] after:w-[14px] after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-3" />
          </label>
        </div>
      )}

      {/* Il riepilogo è una scheda bianca sul grigio del pannello: è la cosa da leggere per prima. */}
      <div className="grid grid-cols-[1fr_auto] items-end gap-x-4 gap-y-1 rounded-[10px] border border-app-border bg-surface px-3.5 py-3" data-testid="dispatch-dashboard-hero-card">
        <div className="text-[22px] font-semibold leading-[1.15] tracking-[-.01em] text-app-text" data-testid="dispatch-dashboard-hero">
          {heroLeft}{heroRight !== undefined && <><span data-sep className="whitespace-pre font-normal text-app-text-muted"> · </span>{heroRight}</>}
        </div>
        <span data-testid="dispatch-dashboard-live" className="inline-flex items-center gap-[5px] text-[11.5px] text-app-text-muted"><i className="h-1.5 w-1.5 rounded-full bg-emerald-600" />{tr('board.dash.live')}</span>
        <div className="col-span-2 flex items-center gap-1.5 text-[13px] font-medium text-app-text" data-testid="dispatch-dashboard-ok">
          <i className={`h-[7px] w-[7px] shrink-0 rounded-full ${broken ? 'bg-rose-500' : 'bg-emerald-600'}`} />
          {broken
            ? tr('board.dash.broken', { n: broken })
            : tr('board.dash.noBroken', { queued: queue.length })}
        </div>
        {free !== null && (
          <p className="col-span-2 text-[12.5px] text-app-text-secondary" data-testid="dispatch-dashboard-memory">
            {cpuHolds && queue.length > 0
              ? tr('board.dash.cpuWait')
              : startGB !== null && queue.length > 0
                ? <>{waitHead}<strong className="font-semibold text-app-text">{tr('board.dash.startFree', { start: gb(startGB) })}</strong>{waitTail}{keepGB !== null ? tr('board.dash.keep', { keep: num(keepGB) }) : ''}.</>
                : tr('board.dash.memoryFree', { free: gb(free), total: capacity?.totalMemGB != null ? gb(capacity.totalMemGB) : '' })}
          </p>
        )}
      </div>

      <div data-testid="dispatch-chart-block" className="mt-3 border-t border-app-border-subtle pt-1">
        <SectionHead left={tr('board.dash.chartTitle')} right={tr('board.dash.chartSub')} />
        <MemoryChart history={snapshot?.history ?? []} startGB={startGB} now={now} />
      </div>

      <div className="mt-3 border-t border-app-border-subtle pt-1">
        <SectionHead left={tr('board.dash.queue', { n: queue.length })} right={queue.length ? tr('board.dash.queueSub') : undefined} />
        {queue.length === 0 ? (
          <p className="text-mini text-app-text-muted" data-testid="dispatch-dashboard-queue-empty">{tr('board.dash.queueEmpty')}</p>
        ) : (
          <ol data-testid="dispatch-dashboard-queue">
            {queue.map((q, i) => (
              <li key={q.id} data-testid="dispatch-dashboard-queue-row" title={q.reason ?? undefined}
                className="grid min-h-[33px] grid-cols-[26px_1fr_62px] items-center gap-2 rounded-md px-1.5 py-[5px] text-xs hover:bg-app-hover [&+&]:border-t [&+&]:border-app-border-subtle">
                <span className="text-app-text-muted">{i + 1}ª</span>
                <span className="truncate text-app-text-body">{q.title}</span>
                <span className="text-right text-[11.5px] text-app-text-muted">{tr('board.dash.since', { time: waitingLabel(q.waitingMs) })}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** Colori delle serie del disegno (palette validata). */
const SERIES = ['#2a78d6', '#e87ba4', '#9a9ea6', '#6250d6', '#1baf7a'];

/** «Macchine»: il Mac con la barra a pezzi di chi tiene la memoria, come nel disegno. */
export function DispatchMachines({ capacity, snapshot }: { capacity: DispatchCapacity | null; snapshot: DispatchMemoryQueueSnapshot | null }) {
  const tr = useT();
  const total = capacity?.totalMemGB ?? null;
  const consumers = snapshot?.consumers ?? [];
  const free = capacity?.availableMemGB ?? snapshot?.reading.freeGB ?? null;
  if (total === null || consumers.length === 0) return null;
  const cpu = capacity?.machineCpuPct;
  const fmt = (n: number) => n.toLocaleString(LANG, { maximumFractionDigits: 1 });
  // Quanto pesano gli agenti al lavoro: la somma dei pesi che il dispatcher dà alle card in volo.
  const agentsGB = (snapshot?.running ?? []).reduce((sum, r) => sum + r.weightGB, 0);
  const legend = [
    ...consumers.map((c, i) => ({ label: c.label, gb: c.gb, color: SERIES[i % SERIES.length]! })),
    ...(free !== null ? [{ label: tr('board.dash.legFree'), gb: free, color: '' }] : []),
  ];
  return (
    <div className="mt-3 border-t border-app-border-subtle pt-1" data-testid="dispatch-machines">
      <SectionHead left={tr('board.dash.machines')} />
      <div data-mach className="rounded-[10px] border border-app-border bg-surface px-3 py-2.5 text-xs leading-[1.45]">
        <div data-testid="dispatch-mach-head" className="flex items-center gap-[7px] text-[13px] font-semibold text-app-text">
          <Laptop className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{tr('board.dash.thisMac')}</span>
          {free !== null && <span className="ml-auto text-[12.5px] font-medium">{tr('board.dash.freeOf', { free: gb(free) })}</span>}
        </div>
        <div data-testid="dispatch-mach-sub" className="mb-2 mt-px text-[11.5px] text-app-text-muted">{gb(total).replace(',0', '')}{cpu != null ? ` · ${tr('board.dash.cpu', { pct: Math.round(cpu) })}` : ''}</div>
        <div className="flex h-2 gap-[2px] overflow-hidden rounded-[4px] bg-app-border-light" data-testid="dispatch-machines-bar">
          {consumers.map((c, i) => <i key={c.label} title={`${c.label} ${gb(c.gb)}`} style={{ width: `${(c.gb / total) * 100}%`, background: SERIES[i % SERIES.length] }} />)}
        </div>
        <ul className="mt-2 grid grid-cols-2 gap-x-2.5 gap-y-[3px] text-[11.5px]" data-testid="dispatch-dashboard-holders">
          {legend.map((c) => (
            <li key={c.label} className="flex items-center gap-[5px] whitespace-nowrap text-app-text-secondary">
              <i className={`h-2 w-2 shrink-0 rounded-[2px] ${c.color ? '' : 'bg-app-border-light ring-1 ring-inset ring-app-border'}`} style={c.color ? { background: c.color } : undefined} />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              <em className="not-italic tabular-nums text-app-text">{fmt(c.gb)}</em>
            </li>
          ))}
        </ul>
        <div data-testid="dispatch-mach-foot" className="mt-2 border-t border-app-border-subtle pt-[7px] text-xs text-app-text-body">
          {tr('board.dash.here', { n: capacity?.running ?? 0 })}
          {agentsGB > 0 && <span className="mt-0.5 block text-[11.5px] text-app-text-muted">{tr('board.dash.machWeight', { gb: gb(agentsGB), total: gb(total).replace(',0', '') })}</span>}
        </div>
      </div>
    </div>
  );
}

/** Il cruscotto vivo: capacità dallo store, coda e serie dal server ogni 15 s. */
export function DispatchDashboard({ tasks, dispatchOn, onToggleDispatch }: { tasks: readonly BoardTask[]; dispatchOn?: boolean | null; onToggleDispatch?: () => void }) {
  const tr = useT();
  const { capacity } = useGlobalDispatchCap();
  const snapshot = useMemoryQueueSnapshot();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const broken = tasks.filter((t) => t.status === 'in_progress' && !t.parentTaskId && !!t.dispatchError).length;
  return <DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queuedCards(tasks, tr, now)} dispatchOn={dispatchOn} onToggleDispatch={onToggleDispatch} broken={broken} now={now} />;
}

/** «Quante card insieme sul Mac · al massimo N»: la testa della sezione del tetto, nello stile del cruscotto. */
export function CapSectionHead() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const limit = currentCapLimit(s);
  return <SectionHead left={tr('board.settings.sec.howMany')} right={limit ? tr('board.dash.capMax', { n: limit }) : undefined} />;
}

export function DispatchMachinesLive() {
  const { capacity } = useGlobalDispatchCap();
  const snapshot = useMemoryQueueSnapshot();
  return <DispatchMachines capacity={capacity} snapshot={snapshot} />;
}

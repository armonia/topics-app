/**
 * IL CRUSCOTTO DEI CONSUMI in testa al pannello «Impostazioni della board».
 *
 * Disegno scelto da Attilio (mock «come partono le card», pannello c): prima di
 * girare le manopole si legge cosa sta succedendo — quante card lavorano, quante
 * aspettano e in che ordine, quanta memoria ha il Mac e chi la tiene.
 *
 * Il 28/10 Attilio ha tenuto la prima versione del pannello e ci ha voluto sopra
 * tre migliorie del disegno: il grafico della memoria nell'ultima ora, la riga di
 * stato «nessuna card è ferma per un guasto» col pallino dal vivo, e la coda
 * numerata con progetto, età e «Avvia comunque» sulla prima.
 *
 * Tutti i numeri arrivano dalle stesse sorgenti che il dispatcher usa per
 * decidere (`/system/dispatch-capacity` nello store del tetto, e
 * `/dispatch/memory-queue`, che porta anche la serie della memoria libera):
 * il pannello non rifà nessun conto. I testi di attesa sono quelli neutri del
 * server (`queueReason`), non una frase nostra.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Hourglass, Play } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { boardApi, isProjectlessId, req } from '../../lib/board';
import { projectNameFromId } from '../../lib/boardProjectsStore';
import type { BoardTask, DispatchCapacity } from '../../lib/board';
import { WAITING_MEMORY_REASON, type DispatchMemoryQueueSnapshot } from '../../../../shared/board';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { queueReasonText } from '../../../../shared/queue-reason-text';
import { DANGER_TEXT } from '../../lib/popoverStyles';

/** Una card in coda, come la riga la disegna. */
export interface QueuedCard {
  id: string;
  title: string;
  /** Il progetto della card, per nome; `null` = non si sa. */
  project: string | null;
  /** Millisecondi da quando aspetta (dall'ultimo aggiornamento). */
  waitingMs: number;
  /** Frase neutra decisa dal server, già tradotta; `null` = il server non ne ha. */
  reason: string | null;
  /** Aspetta solo memoria libera: è la sola attesa che «Avvia comunque» può saltare. */
  memoryWaiter: boolean;
  /** Il server la dà per incagliata (tono `stalled`): non parte da sola. */
  stalled: boolean;
  projectId: string;
}

/** Le card che aspettano un posto, nell'ordine in cui il dispatcher le serve. */
export function queuedCards(
  tasks: readonly BoardTask[],
  tr: (k: string, p?: Record<string, string | number>) => string,
  now: number,
  projectName: (t: BoardTask) => string | null = () => null,
): QueuedCard[] {
  return tasks
    .filter((t) => !t.parentTaskId && (t.dispatchState === 'queued' || t.dispatchState === 'waiting'))
    // La disciplina di coda del dispatcher (task-dispatcher, il tick): prima la
    // priorità, poi la più vecchia. È l'ordine in cui partiranno, e la «1ª» è
    // quella a cui va «Avvia comunque».
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
    .map((t) => {
      const text = t.queueReason ? queueReasonText(t.queueReason, tr) : null;
      return {
        id: t.id,
        title: t.text,
        project: projectName(t),
        waitingMs: Math.max(0, now - Date.parse(t.updatedAt)),
        reason: text ? `${text.head} · ${text.detail}` : null,
        // Lo stesso test del server (`isMemoryWaiter`): fuori da qui risponde 409.
        memoryWaiter: t.status === 'todo' && t.dispatchState === 'queued' && t.dispatchError === WAITING_MEMORY_REASON,
        stalled: t.queueReason?.tone === 'stalled',
        projectId: t.projectId,
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
/** Quando è arrivata l'ultima lettura buona: senza, «dal vivo» sarebbe una promessa. */
let snapAt = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function loadSnapshot() {
  req<DispatchMemoryQueueSnapshot>('/dispatch/memory-queue').then(
    (s) => { snap = s; snapAt = Date.now(); listeners.forEach((l) => l()); },
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
/** La lettura è viva se è arrivata negli ultimi due giri (15 s l'uno) più margine. */
export const snapshotIsLive = (now: number) => snap !== null && now - snapAt < 45_000;
export function useMemoryQueueSnapshot(): DispatchMemoryQueueSnapshot | null {
  return useSyncExternalStore(subscribeSnapshot, () => snap, () => null);
}

/** Titolo di sezione, lo stesso maiuscoletto delle altre sezioni del pannello. */
function SectionLabel({ children, right }: { children: React.ReactNode; right?: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2 text-mini font-medium uppercase tracking-wide text-app-text-secondary">
      <span>{children}</span>
      {right && <span className="normal-case tracking-normal font-normal text-app-text-muted">{right}</span>}
    </div>
  );
}

// ── il grafico: memoria libera, ultima ora, con la soglia e le card al lavoro ──
// Lo spazio del disegno è largo quanto il grafico sullo schermo: i testi restano
// a 10 px veri anche nel pannello stretto (400) e nel foglio del telefono.
const PL = 30, PR = 8, PT = 8, CH = 84, SY = 98, SH = 16, VH_CARDS = 136, VH_PLAIN = 112;

/** Il tetto dell'asse: almeno 6 GB, poi il pari sopra il massimo, così un Mac largo non schiaccia la curva in alto. */
export function chartMax(values: readonly number[], startGB: number | null): number {
  const top = Math.max(6, startGB ?? 0, ...values);
  return top <= 6 ? 6 : Math.ceil(top / 3) * 3;
}

export function MemoryChart({ history, startGB, now, width: initialWidth = 372, cpuHolds = false }: {
  history: DispatchMemoryQueueSnapshot['history'];
  startGB: number | null;
  now: number;
  /** Frena la CPU, non la memoria: la soglia resta disegnata ma non promette «ne parte un'altra». */
  cpuHolds?: boolean;
  /** Larghezza prima della misura (e nel render statico dei test). */
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
  const pts = history
    .map((p) => ({ t: Date.parse(p.at), v: p.freeGB, r: p.running }))
    .filter((p) => p.t >= now - 3_660_000); // un'ora piena, col minuto di bordo
  // Il contenitore misurato è SEMPRE questo div: se fosse il <p> del vuoto, all'arrivo
  // della serie l'osservatore resterebbe attaccato a un nodo sparito.
  if (pts.length < 2) {
    return <div ref={wrap}><p className="text-mini text-app-text-secondary" data-testid="dispatch-chart-empty">{tr('board.dash.chartEmpty')}</p></div>;
  }
  // L'asse arriva ad ADESSO, non all'ultimo campione: se il campionatore si ferma
  // la linea finisce prima di «ora», invece di spacciare un dato vecchio per attuale.
  const t0 = pts[0]!.t, tEnd = Math.max(now, pts[pts.length - 1]!.t), span = Math.max(60_000, tEnd - t0);
  const YMAX = chartMax(pts.map((p) => p.v), startGB);
  const ticks = [0, 1, 2, 3].map((k) => (YMAX / 3) * k);
  const x = (t: number) => PL + ((t - t0) / span) * (W - PL - PR);
  const y = (v: number) => PT + CH - (Math.min(v, YMAX) / YMAX) * CH;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts[pts.length - 1]!.t)} ${y(0)}L${x(t0)} ${y(0)}Z`;
  const last = pts[pts.length - 1]!;
  const hasRunning = pts.some((p) => p.r !== undefined);
  // un rettangolo per tratto con lo stesso numero di card: un rettangolo al minuto
  // lascia cuciture chiare fra un minuto e l'altro
  const bars: Array<{ x: number; w: number; c: number }> = [];
  if (hasRunning) {
    for (let i = 0; i < pts.length - 1;) {
      const c = pts[i]!.r ?? 0;
      let j = i;
      while (j < pts.length - 1 && (pts[j + 1]!.r ?? 0) === c) j++;
      const end = Math.min(j + 1, pts.length - 1);
      if (c) bars.push({ x: x(pts[i]!.t), w: x(pts[end]!.t) - x(pts[i]!.t), c });
      i = j + 1;
    }
  }
  const VH = hasRunning ? VH_CARDS : VH_PLAIN;
  const axisY = VH - 3;
  const mins = Math.round(span / 60_000);
  const h = hover === null ? null : pts[hover]!;
  // Il valore di adesso sotto il punto, o sopra quando cadrebbe nella fascia delle card.
  const lastLabelY = y(last.v) + 16 > PT + CH - 2 ? y(last.v) - 8 : y(last.v) + 16;
  // Un'etichetta «N card» solo dove c'è posto, e mai sopra quella prima.
  let labelEnd = -Infinity;
  const labelled = bars.map((b) => { const ok = b.x >= labelEnd && b.w >= 30; if (ok) labelEnd = b.x + 36; return ok; });
  return (
    <div ref={wrap} className="relative" data-testid="dispatch-chart">
      <svg viewBox={`0 0 ${W} ${VH}`} width="100%" height={VH} className="block" role="img" aria-label={tr('board.dash.chartTitle')}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          // Il punto più vicino nel TEMPO: i campioni non sono equidistanti.
          const t = t0 + ((px - PL) / (W - PL - PR)) * span;
          let best = 0;
          for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.t - t) < Math.abs(pts[best]!.t - t)) best = i;
          setHover(best);
        }}>
        <g className="text-app-text-muted" fontSize="10" fill="currentColor">
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
          <g className="text-app-text-muted" fontSize="10" fill="currentColor">
            {/* l'altezza si ferma a 2 card, il numero scritto è quello vero */}
            {bars.map((b, i) => <rect key={i} x={b.x} y={SY + SH - (Math.min(b.c, 2) / 2) * SH} width={b.w} height={(Math.min(b.c, 2) / 2) * SH} fill="var(--primary)" fillOpacity=".28" />)}
            <line x1={PL} x2={W - PR} y1={SY + SH} y2={SY + SH} stroke="var(--border)" />
            {/* una tacca dove cambia il numero di card al lavoro, con il numero */}
            {bars.map((b, i) => <line key={`s${i}`} x1={b.x} x2={b.x} y1={SY - 3} y2={SY + SH} stroke="currentColor" />)}
            {bars.map((b, i) => labelled[i] && <text key={`l${i}`} x={b.x + 3} y={SY + 6 + (b.c > 1 ? 4 : 0)} fontSize="9.5" fill="currentColor" className="text-app-text-body">{tr('board.dash.chartN', { n: b.c })}</text>)}
            <text x={PL - 5} y={SY + SH - 2} textAnchor="end">{tr('board.dash.chartCards')}</text>
          </g>
        )}
        <g className="text-app-text-muted" fontSize="10" fill="currentColor">
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

/** Perché «Avvia comunque» non è partita, dal `code` del server. */
export type StartFailure = { id: string; code: string | null };
const START_ERR: Record<string, string> = {
  memory_slot_busy: 'board.dash.startErr.busy',
  start_rejected: 'board.dash.startErr.rejected',
  not_memory_queued: 'board.dash.startErr.moved',
  dispatcher_unavailable: 'board.dash.startErr.noDispatcher',
};

export function DispatchDashboardView({ capacity, snapshot, queue, broken = 0, now, onStartNow, starting, dispatchOn, live, startFailure }: {
  capacity: DispatchCapacity | null;
  /** La lettura del server è fresca; assente = c'è uno snapshot. */
  live?: boolean;
  /** L'ultimo «Avvia comunque» rifiutato; si mostra solo finché quella card è ancora in coda. */
  startFailure?: StartFailure | null;
  /** L'interruttore globale: spento, la coda NON parte da sola, e la riga di stato lo dice. */
  dispatchOn?: boolean | null;
  snapshot: DispatchMemoryQueueSnapshot | null;
  queue: QueuedCard[];
  /** Card ferme per un guasto vero (non per un'attesa). */
  broken?: number;
  now: number;
  /** «Avvia comunque» sulla prima in coda; assente = niente bottone. */
  onStartNow?: (card: QueuedCard) => void;
  /** La card che sta partendo per «Avvia comunque». */
  starting?: string | null;
}) {
  const tr = useT();
  const running = capacity?.running ?? 0;
  const free = capacity?.availableMemGB ?? snapshot?.reading.freeGB ?? null;
  const total = capacity?.totalMemGB ?? null;
  const startGB = snapshot?.threshold.startGB ?? null;
  const consumers = snapshot?.consumers ?? [];
  const biggest = Math.max(1, ...consumers.map((c) => c.gb));
  const cpuHolds = capacity?.admission?.blockedBy === 'cpu';
  const stalled = queue.filter((q) => q.stalled).length;
  const isLive = live ?? snapshot !== null;
  // Il server tiene un solo posto «a mano» e lo rifiuta finché un turno locale è in volo
  // (dispatch-memory-start: `localMemorySeatTaken`): con card al lavoro il bottone non
  // può riuscire, e lo dice invece di rispondere con un errore.
  const seatBusy = running > 0;
  const failure = startFailure && queue.some((q) => q.id === startFailure.id) ? startFailure : null;
  // Lo stato in una riga, e il colore dice se serve fare qualcosa.
  const status: { tone: 'ok' | 'warn' | 'bad'; text: string } = broken
    ? { tone: 'bad', text: tr(broken === 1 ? 'board.dash.broken1' : 'board.dash.broken', { n: broken }) }
    : !queue.length ? { tone: 'ok', text: tr('board.dash.noBrokenEmpty') }
    : dispatchOn === false ? { tone: 'warn', text: tr('board.dash.dispatchOff', { queued: queue.length }) }
    : stalled ? { tone: 'warn', text: tr(stalled === 1 ? 'board.dash.stalled1' : 'board.dash.stalled', { n: stalled }) }
    : dispatchOn == null ? { tone: 'ok', text: tr('board.dash.noBrokenEmpty') }
    : { tone: 'ok', text: tr('board.dash.noBroken', { queued: queue.length }) };
  return (
    <section data-testid="dispatch-dashboard" className="space-y-2 rounded-md bg-white/5 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-base font-semibold text-app-text" data-testid="dispatch-dashboard-hero">
          {tr('board.dash.hero', { running, queued: queue.length })}
        </div>
        {isLive && (
          <span data-testid="dispatch-dashboard-live" className="inline-flex shrink-0 items-center gap-1 text-mini text-app-text-secondary">
            <i className="h-1.5 w-1.5 rounded-full bg-emerald-600" />{tr('board.dash.live')}
          </span>
        )}
      </div>
      {/* La riga di stato: un'attesa non è un guasto, e qui si dice quale delle due. */}
      <p className="flex items-center gap-1.5 font-medium text-app-text" data-testid="dispatch-dashboard-ok">
        <i className={`h-[7px] w-[7px] shrink-0 rounded-full ${status.tone === 'bad' ? 'bg-rose-500' : status.tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-600'}`} />
        {status.text}
      </p>
      {free !== null && (
        <p className="text-mini text-app-text-secondary" data-testid="dispatch-dashboard-memory">
          {cpuHolds && queue.length > 0 && dispatchOn !== false
            ? tr('board.dash.cpuWait')
            : startGB !== null && queue.length > 0 && dispatchOn !== false
            ? tr('board.dash.memoryWait', { free: gb(free), start: gb(startGB) })
            : tr('board.dash.memoryFree', { free: gb(free), total: total !== null ? gb(total) : '' })}
        </p>
      )}
      <div data-testid="dispatch-chart-block">
        <SectionLabel right={tr('board.dash.chartSub')}>{tr('board.dash.chartTitle')}</SectionLabel>
        <MemoryChart history={snapshot?.history ?? []} startGB={startGB} now={now} cpuHolds={cpuHolds} />
      </div>
      <div>
        <SectionLabel>{tr('board.dash.queue', { n: queue.length })}</SectionLabel>
        {queue.length === 0 ? (
          <p className="text-mini text-app-text-secondary" data-testid="dispatch-dashboard-queue-empty">{tr('board.dash.queueEmpty')}</p>
        ) : (
          <ol className="space-y-1" data-testid="dispatch-dashboard-queue">
            {queue.map((q, i) => (
              <li key={q.id} className="flex flex-wrap items-start gap-x-1.5" data-testid="dispatch-dashboard-queue-row">
                <span className="w-5 shrink-0 text-mini text-app-text-secondary">{i + 1}ª</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={q.title}>{q.title}</span>
                  <span className="flex items-center gap-1 text-mini text-app-text-secondary">
                    <Hourglass className="h-3 w-3 shrink-0" />
                    {q.project && <span className="shrink-0 rounded bg-white/5 px-1" data-testid="dispatch-dashboard-queue-project">{q.project}</span>}
                    <span className="truncate" title={q.reason ?? undefined}>{q.reason ?? tr('board.dash.waiting')}</span>
                    <span className="shrink-0">· {tr('board.dash.since', { time: waitingLabel(q.waitingMs) })}</span>
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
        <div>
          <SectionLabel>{tr('board.dash.holders', { total: total !== null ? gb(total) : '' })}</SectionLabel>
          <ul className="space-y-0.5" data-testid="dispatch-dashboard-holders">
            {consumers.map((c) => (
              <li key={c.label} className="flex items-center gap-2 text-mini">
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded bg-white/10">
                  <i className="block h-full bg-sky-500/80" style={{ width: `${Math.round((c.gb / biggest) * 100)}%` }} />
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums">{gb(c.gb)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Il cruscotto vivo: capacità dallo store, coda e serie dal server ogni 15 s. */
export function DispatchDashboard({ tasks, dispatchOn }: { tasks: readonly BoardTask[]; dispatchOn?: boolean | null }) {
  const tr = useT();
  const { capacity } = useGlobalDispatchCap();
  const snapshot = useMemoryQueueSnapshot();
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  // Un guasto vero: il dispatcher parcheggia la card con `failed` (l'agente non ha
  // consegnato) o `blocked` (configurazione da sistemare). Un'attesa non lo è.
  const broken = tasks.filter((t) => !t.parentTaskId && t.status !== 'done' && (t.dispatchState === 'failed' || t.dispatchState === 'blocked')).length;
  // Il nome del progetto dall'id (`<cartella>-<hash>`); le card senza progetto non ne mostrano.
  const projectName = (t: BoardTask) => (isProjectlessId(t.projectId) ? null : projectNameFromId(t.projectId));
  const start = (card: QueuedCard) => {
    if (starting) return;
    setStarting(card.id);
    setStartFailure(null);
    // La card cambia stato da sola: il server la trasmette (`task:updated`) e la coda si rilegge.
    boardApi.startAnyway(card.projectId, card.id)
      .then(() => loadSnapshot(), (e: unknown) => setStartFailure({ id: card.id, code: (e as { code?: string } | null)?.code ?? null }))
      .finally(() => setStarting(null));
  };
  return <DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queuedCards(tasks, tr, now, projectName)} broken={broken}
    now={now} onStartNow={start} starting={starting} dispatchOn={dispatchOn} live={snapshotIsLive(now)} startFailure={startFailure} />;
}

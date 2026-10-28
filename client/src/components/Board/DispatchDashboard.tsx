/**
 * IL CRUSCOTTO DEI CONSUMI in testa al pannello «Impostazioni auto-dispatch».
 *
 * Disegno scelto da Attilio (mock «come partono le card», pannello c): prima di
 * girare le manopole si legge cosa sta succedendo — quante card lavorano, quante
 * aspettano e in che ordine, quanta memoria ha il Mac e chi la tiene.
 *
 * Tutti i numeri arrivano dalle stesse due sorgenti che il dispatcher usa per
 * decidere (`/system/dispatch-capacity` nello store del tetto, e
 * `/dispatch/memory-queue`): il pannello non rifà nessun conto. I testi di
 * attesa sono quelli neutri del server (`queueReason`), non una frase nostra.
 */
import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { req } from '../../lib/board';
import type { BoardTask, DispatchCapacity } from '../../lib/board';
import type { DispatchMemoryQueueSnapshot } from '../../../../shared/board';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
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

const gb = (n: number, lang: string) => `${n.toLocaleString(lang, { maximumFractionDigits: 1 })} GB`;

/** «19 min» / «2 h 5 min»: quanto aspetta, mai un timestamp. */
export function waitingLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function DispatchDashboardView({ capacity, snapshot, queue }: {
  capacity: DispatchCapacity | null;
  snapshot: DispatchMemoryQueueSnapshot | null;
  queue: QueuedCard[];
}) {
  const tr = useT();
  const lang = 'it-IT';
  const running = capacity?.running ?? 0;
  const free = capacity?.availableMemGB ?? snapshot?.reading.freeGB ?? null;
  const total = capacity?.totalMemGB ?? null;
  const startGB = snapshot?.threshold.startGB ?? null;
  const consumers = snapshot?.consumers ?? [];
  const biggest = Math.max(1, ...consumers.map((c) => c.gb));
  return (
    <section data-testid="dispatch-dashboard" className="space-y-2 rounded-md bg-white/5 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-base font-semibold text-app-text" data-testid="dispatch-dashboard-hero">
          {tr('board.dash.hero', { running, queued: queue.length })}
        </div>
      </div>
      {free !== null && (
        <p className="text-mini text-app-text-secondary" data-testid="dispatch-dashboard-memory">
          {startGB !== null && queue.length > 0
            ? tr('board.dash.memoryWait', { free: gb(free, lang), start: gb(startGB, lang) })
            : tr('board.dash.memoryFree', { free: gb(free, lang), total: total !== null ? gb(total, lang) : '' })}
        </p>
      )}
      <div>
        <div className="mb-1 text-mini font-medium uppercase tracking-wide text-app-text-secondary">
          {tr('board.dash.queue', { n: queue.length })}
        </div>
        {queue.length === 0 ? (
          <p className="text-mini text-app-text-secondary" data-testid="dispatch-dashboard-queue-empty">{tr('board.dash.queueEmpty')}</p>
        ) : (
          <ol className="space-y-1" data-testid="dispatch-dashboard-queue">
            {queue.map((q, i) => (
              <li key={q.id} className="flex items-start gap-1.5" data-testid="dispatch-dashboard-queue-row">
                <span className="w-5 shrink-0 text-mini text-app-text-secondary">{i + 1}ª</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={q.title}>{q.title}</span>
                  <span className="flex items-center gap-1 text-mini text-app-text-secondary">
                    <Hourglass className="h-3 w-3 shrink-0" />
                    <span className="truncate">{q.reason ?? tr('board.dash.waiting')}</span>
                    <span className="shrink-0">· {tr('board.dash.since', { time: waitingLabel(q.waitingMs) })}</span>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {consumers.length > 0 && (
        <div>
          <div className="mb-1 text-mini font-medium uppercase tracking-wide text-app-text-secondary">
            {tr('board.dash.holders', { total: total !== null ? gb(total, lang) : '' })}
          </div>
          <ul className="space-y-0.5" data-testid="dispatch-dashboard-holders">
            {consumers.map((c) => (
              <li key={c.label} className="flex items-center gap-2 text-mini">
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded bg-white/10">
                  <i className="block h-full bg-sky-500/80" style={{ width: `${Math.round((c.gb / biggest) * 100)}%` }} />
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums">{gb(c.gb, lang)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Il cruscotto vivo: legge la capacità dallo store e la coda dal server ogni 15 s. */
export function DispatchDashboard({ tasks }: { tasks: readonly BoardTask[] }) {
  const tr = useT();
  const { capacity } = useGlobalDispatchCap();
  const [snapshot, setSnapshot] = useState<DispatchMemoryQueueSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => { req<DispatchMemoryQueueSnapshot>('/dispatch/memory-queue').then((s) => { if (alive) setSnapshot(s); }, () => { /* senza dispatcher il cruscotto resta sulla sola capacità */ }); };
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return <DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queuedCards(tasks, tr, Date.now())} />;
}

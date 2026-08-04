/**
 * Consumo per pane, condiviso fra tutte le tab bar.
 *
 * PERCHÉ UNO STORE E NON `useSystemStatus`: quell'hook fa polling PER ISTANZA
 * (un `setInterval` per chiamante). `PaneTabBar` è montata una volta per gruppo
 * di tab, quindi usarlo là avrebbe moltiplicato le fetch per il numero di
 * gruppi aperti — cioè esattamente ciò che RES-ATTR-04 vieta: il costo della
 * misura non deve crescere col numero di pane. Qui la fetch è UNA, condivisa,
 * deduplicata e con una finestra di validità; N tab bar che chiedono nello
 * stesso istante producono una sola richiesta.
 *
 * E non c'è polling affatto: si aggiorna quando qualcuno passa il mouse su una
 * tab. Un numero che nessuno sta guardando non vale una richiesta ogni N
 * secondi.
 */

/** Allineata a `FLEET_TTL_MS` lato server: chiedere più spesso della finestra
 *  in cui il server ricampiona restituirebbe lo stesso oggetto. */
const TTL_MS = 4000;

export interface PaneUsageEntry {
  memoryMB: number;
  /** `null` = NON MISURATO (nessuna base CPU ancora), che non è zero. */
  cpuPercent: number | null;
  processCount: number;
}

interface UsageSnapshot {
  at: number;
  bySession: Map<string, PaneUsageEntry>;
  cpuCores: number;
  /** `footprint` | `rss` | `mixed` — per etichettare la memoria come fa la barra. */
  memMetric: string;
}

let snapshot: UsageSnapshot | null = null;
let inFlight: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const fn of listeners) {
    try { fn(); } catch { /* un listener rotto non deve fermare gli altri */ }
  }
}

/** Per `useSyncExternalStore`: cambia solo quando arriva uno snapshot nuovo,
 *  così le tab si ridisegnano al dato e non a ogni render del padre. */
export function getPaneUsageVersion(): number {
  return version;
}

export function subscribePaneUsage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Aggiorna se il dato è più vecchio della finestra. Chiamate concorrenti
 * condividono la stessa richiesta: `inFlight` è il dedup.
 */
export function ensurePaneUsageFresh(): void {
  if (snapshot && Date.now() - snapshot.at < TTL_MS) return;
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const res = await fetch('/api/system/status');
      if (!res.ok) return;
      const data = await res.json();
      const fleet = data?.server?.fleet;
      if (!fleet) return;
      const bySession = new Map<string, PaneUsageEntry>();
      for (const s of fleet.sessions ?? []) {
        bySession.set(s.sessionId, {
          memoryMB: s.memoryMB,
          cpuPercent: s.cpuPercent,
          processCount: s.processCount,
        });
      }
      snapshot = {
        at: Date.now(),
        bySession,
        cpuCores: fleet.cpuCores ?? 1,
        memMetric: fleet.memMetric ?? 'rss',
      };
      emit();
    } catch {
      // Offline o server che riparte: si tiene l'ultimo dato buono e il
      // tooltip resta quello di prima, invece di lampeggiare a vuoto.
    } finally {
      inFlight = null;
    }
  })();
}

export function getPaneUsage(sessionId: string | null | undefined): PaneUsageEntry | null {
  if (!sessionId || !snapshot) return null;
  return snapshot.bySession.get(sessionId) ?? null;
}

/** Metrica con cui è misurata la memoria, per dirlo quando è solo una stima. */
export function getPaneUsageMemMetric(): string | null {
  return snapshot?.memMetric ?? null;
}

/**
 * La riga di consumo da appendere al `title` di una tab.
 *
 * TRE STATI, mai collassati in uno zero o in un trattino (RES-ATTR-05):
 * - `hasOwnProcess === false` → la pane vive nel renderer condiviso (topic,
 *   kanban, chat, file, editor): non esiste una misura, e una quota stimata
 *   sarebbe un numero inventato con l'aria di un dato.
 * - misura assente → ha un processo ma non lo abbiamo ancora letto.
 * - misura presente, `cpuPercent === null` → processo appena nato, senza
 *   ancora un delta di CPU: "CPU non misurata", non "CPU 0%".
 */
export function formatPaneUsageLine(
  sessionId: string | null | undefined,
  hasOwnProcess: boolean,
): string {
  if (!hasOwnProcess) return '\nConsumo: questa scheda non ha un processo proprio';
  const u = getPaneUsage(sessionId);
  if (!u) return '\nConsumo: non ancora misurato';
  const cpu = u.cpuPercent === null
    ? 'CPU non ancora misurata'
    : `CPU ${u.cpuPercent < 1 && u.cpuPercent > 0 ? '<1' : Math.round(u.cpuPercent)}%`;
  const proc = u.processCount === 1 ? '1 processo' : `${u.processCount} processi`;
  return `\nConsumo: ${u.memoryMB} MB · ${cpu} · ${proc}`;
}

/** Test seam. */
export function _resetPaneUsage(): void {
  snapshot = null;
  inFlight = null;
  listeners.clear();
}

/** Test seam: inietta uno snapshot senza passare dalla rete. */
export function _setPaneUsageSnapshot(
  sessions: { sessionId: string; memoryMB: number; cpuPercent: number | null; processCount: number }[],
  opts?: { cpuCores?: number; memMetric?: string },
): void {
  snapshot = {
    at: Date.now(),
    bySession: new Map(sessions.map(s => [s.sessionId, {
      memoryMB: s.memoryMB, cpuPercent: s.cpuPercent, processCount: s.processCount,
    }])),
    cpuCores: opts?.cpuCores ?? 12,
    memMetric: opts?.memMetric ?? 'footprint',
  };
}

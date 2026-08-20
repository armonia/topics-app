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

import { isTauri } from './shell';
import { tauriInvoke } from './shell/tauri';

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
  /** Terminali e sessioni Claude: dal SERVER, che tiene il pid di testa di
   *  ciascuna sessione PTY. */
  bySession: Map<string, PaneUsageEntry>;
  /** Pane browser: dalla SHELL, che sa quale processo WebContent rende quale
   *  webview. Chiave = il label con cui la webview è stata creata
   *  (`browserpane-<paneId>`, vedi `browser_label` in `lib.rs`).
   *
   *  Sono due sorgenti perché sono due mondi: il server non vede le webview
   *  (vivono nella shell) e la shell non vede i sidecar (sono figli del server
   *  reparentati a launchd). Si uniscono qui, sulle stesse unità. */
  byWebviewLabel: Map<string, PaneUsageEntry>;
  cpuCores: number;
  /** `footprint` | `rss` | `mixed` — per etichettare la memoria come fa la barra. */
  memMetric: string;
}

/** Il label con cui la shell registra la webview di una pane browser. Deve
 *  restare allineato a `browser_label` in `desktop-tauri/src-tauri/src/lib.rs`. */
export function browserPaneLabel(paneId: string): string {
  return `browserpane-${paneId}`;
}

/**
 * Dalla label alla pane, inverso di `browser_label` (lib.rs).
 *
 * Non basta togliere il prefisso: una pane la cui vista ha rifiutato di
 * chiudersi (mutex del dispatcher avvelenato) riapre sotto un'etichetta di
 * GENERAZIONE nuova — `browserpane-~1~<id>` — mentre la morta resta registrata
 * sotto la vecchia. Le due webview sono processi diversi che pesano entrambi, e
 * appartengono alla stessa pane: qui si riconoscono uguali, così la misura non
 * sparisce dalla tab proprio dopo una ricreazione.
 */
export function paneIdFromWebviewLabel(label: string): string | null {
  if (!label.startsWith('browserpane-')) return null;
  const rest = label.slice('browserpane-'.length);
  if (!rest.startsWith('~')) return rest;
  const end = rest.indexOf('~', 1);
  if (end < 0) return rest;
  const gen = rest.slice(1, end);
  // `~` che non racchiude una generazione: è parte dell'id, non si taglia.
  if (gen.length === 0 || !/^\d+$/.test(gen)) return rest;
  return rest.slice(end + 1);
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

/** Core logici, per riportare la CPU per-core della shell sulla scala della
 *  macchina — la stessa normalizzazione che fa `usePerfMetrics`. */
const CPU_CORES = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 1) || 1);

interface FleetPayload {
  sessions?: { sessionId: string; memoryMB: number; cpuPercent: number | null; processCount: number }[];
  cpuCores?: number;
  memMetric?: string;
}

interface ShellWebview {
  label: string;
  memory_mb: number;
  cpu_percent: number | null;
}

async function fetchFleet(): Promise<FleetPayload | null> {
  try {
    const res = await fetch('/api/system/status');
    if (!res.ok) return null;
    return (await res.json())?.server?.fleet ?? null;
  } catch {
    return null;
  }
}

/** Le webview dalla shell. Su web non esiste `perf_metrics` e si torna `null`,
 *  che il chiamante tratta come "nessuna webview attribuita" — le pane browser
 *  restano "non ancora misurate" invece di sembrare a zero. */
async function fetchWebviews(): Promise<ShellWebview[] | null> {
  if (!isTauri) return null;
  try {
    const m = await tauriInvoke<{ webviews?: ShellWebview[] }>('perf_metrics');
    return m?.webviews ?? null;
  } catch {
    return null;
  }
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
      // Le due sorgenti in parallelo, e una che cade non porta giù l'altra:
      // senza shell (web) restano i terminali, senza server restano le webview.
      const [fleet, shell] = await Promise.all([fetchFleet(), fetchWebviews()]);
      if (!fleet && !shell) return;

      const bySession = new Map<string, PaneUsageEntry>();
      for (const s of fleet?.sessions ?? []) {
        bySession.set(s.sessionId, {
          memoryMB: s.memoryMB,
          cpuPercent: s.cpuPercent,
          processCount: s.processCount,
        });
      }
      const byWebviewLabel = new Map<string, PaneUsageEntry>();
      for (const w of shell ?? []) {
        byWebviewLabel.set(w.label, {
          memoryMB: Math.round(w.memory_mb),
          // La shell riporta per-core (come `ps`); qui si normalizza sui core
          // per parlare la stessa lingua della sessione e della status bar.
          cpuPercent: w.cpu_percent == null ? null : w.cpu_percent / CPU_CORES,
          // Una webview = un processo WebContent.
          processCount: 1,
        });
      }
      snapshot = {
        at: Date.now(),
        bySession,
        byWebviewLabel,
        cpuCores: fleet?.cpuCores ?? CPU_CORES,
        memMetric: fleet?.memMetric ?? 'rss',
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

/**
 * Consumo di una pane browser, per id di pane.
 *
 * SOMMA tutte le webview che appartengono a questa pane. Normalmente è una
 * sola; sono due quando una vista si è rifiutata di morire e la pane è stata
 * ricreata sotto un'etichetta nuova (vedi {@link paneIdFromWebviewLabel}). Il
 * processo della morta è ancora lì e lo paga questa pane: nasconderlo
 * mostrerebbe meno memoria proprio dove ce n'è di più.
 */
export function getBrowserPaneUsage(paneId: string | null | undefined): PaneUsageEntry | null {
  if (!paneId || !snapshot) return null;
  const exact = snapshot.byWebviewLabel.get(browserPaneLabel(paneId));
  let total: PaneUsageEntry | null = exact ?? null;
  for (const [label, entry] of snapshot.byWebviewLabel) {
    if (label === browserPaneLabel(paneId)) continue;
    if (paneIdFromWebviewLabel(label) !== paneId) continue;
    total = total
      ? {
          memoryMB: total.memoryMB + entry.memoryMB,
          cpuPercent: total.cpuPercent == null && entry.cpuPercent == null
            ? null
            : (total.cpuPercent ?? 0) + (entry.cpuPercent ?? 0),
          processCount: total.processCount + entry.processCount,
        }
      : entry;
  }
  return total;
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
  /** Pane browser: il consumo si cerca per label di webview, non per sessione. */
  browserPaneId?: string | null,
): string {
  if (!hasOwnProcess) return '\nConsumo: questa scheda non ha un processo proprio';
  const u = browserPaneId ? getBrowserPaneUsage(browserPaneId) : getPaneUsage(sessionId);
  if (!u) return '\nConsumo: non ancora misurato';
  const cpu = u.cpuPercent === null
    ? 'CPU non ancora misurata'
    : `CPU ${u.cpuPercent < 1 && u.cpuPercent > 0 ? '<1' : Math.round(u.cpuPercent)}%`;
  const proc = u.processCount === 1 ? '1 processo' : `${u.processCount} processi`;
  return `\nConsumo: ${u.memoryMB} MB · ${cpu} · ${proc}`;
}

/**
 * Le webview misurate nell'ultimo campione, per l'inventario del peso.
 *
 * NON MISURA NIENTE: legge lo snapshot che il tooltip delle tab ha gia' pagato.
 * E' la regola di RES-ATTR-04 (il costo della misura non cresce col numero di
 * superfici che la mostrano) applicata all'inventario: se lo snapshot non c'e'
 * ancora, torna una lista vuota e la voce «Pannelli browser» semplicemente non
 * compare, invece di comparire a zero.
 */
export function webviewSnapshot(): { label: string; memoryMB: number }[] {
  if (!snapshot) return [];
  return [...snapshot.byWebviewLabel.entries()]
    .map(([label, e]) => ({ label, memoryMB: e.memoryMB }));
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
  opts?: { cpuCores?: number; memMetric?: string; webviews?: { label: string; memoryMB: number; cpuPercent: number | null }[] },
): void {
  snapshot = {
    at: Date.now(),
    bySession: new Map(sessions.map(s => [s.sessionId, {
      memoryMB: s.memoryMB, cpuPercent: s.cpuPercent, processCount: s.processCount,
    }])),
    byWebviewLabel: new Map((opts?.webviews ?? []).map(w => [w.label, {
      memoryMB: w.memoryMB, cpuPercent: w.cpuPercent, processCount: 1,
    }])),
    cpuCores: opts?.cpuCores ?? 12,
    memMetric: opts?.memMetric ?? 'footprint',
  };
}

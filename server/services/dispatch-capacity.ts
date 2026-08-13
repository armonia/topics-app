// Auto-sizing for the dispatch concurrency cap (board "Agent in parallelo").
//
// A dispatched agent is a full headless Claude session in its own git worktree.
// It is mostly I/O-bound (waiting on the API), so we can run more than one per
// core — but each still holds a process, does git work, and bursts CPU while a
// turn streams. We size the cap from stable signals:
//   - CPU cores: the primary budget (I/O-bound → modest oversubscription).
//   - Total RAM: a floor guard for small machines (a ~3 GB/agent budget).
//   - 1-min load average: a LIVE throttle — back off when the box is already busy.
//
// We deliberately IGNORE os.freemem(): on macOS it reports almost nothing "free"
// (the OS keeps reclaimable pages as cache), so it would peg the cap at 1 on a
// perfectly healthy 32 GB machine. Load average is the honest live signal.

import os from "node:os";
import type { Database } from "bun:sqlite";

// La forma sta in `shared/board.ts` (la legge la UI delle impostazioni board).
export type { DispatchCapacity } from "../../shared/board";
import type { DispatchCapacity } from "../../shared/board";
import { GLOBAL_CAP_MIN, GLOBAL_CAP_MAX } from "../../shared/board";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Riga riservata di `board_settings` che porta il tetto GLOBALE (una per macchina). */
const GLOBAL_SETTINGS_KEY = "*";

/**
 * Il tetto di concorrenza globale come sta scritto: `auto` (dimensionato dalla
 * capacità viva) oppure il numero fisso scelto nel menu.
 *
 * Sta qui e non in `tasks.ts` perché ora ha DUE lettori — il tick del
 * dispatcher e la quota di core dello spawn (`agent-job-quota.ts`) — e due
 * copie di «cosa vuol dire NULL in questa colonna» sono esattamente il modo in
 * cui i default di questo repo sono già andati in deriva. `TaskService.getGlobalCap`
 * delega qui.
 */
export function readGlobalCap(db: Database): { auto: boolean; max: number } {
  const r = db
    .prepare("SELECT max_agents, max_agents_auto FROM board_settings WHERE project_id = ?")
    .get(GLOBAL_SETTINGS_KEY) as { max_agents?: number | null; max_agents_auto?: number | null } | undefined;
  // Auto è il default finché non si sceglie un numero a mano (NULL = mai
  // impostato → auto), così un'installazione nuova protegge la macchina da sé.
  const auto = r?.max_agents_auto == null ? true : !!r.max_agents_auto;
  return { auto, max: clamp(Math.floor(r?.max_agents ?? 3), GLOBAL_CAP_MIN, GLOBAL_CAP_MAX) };
}

/**
 * Quanti agenti insieme, davvero, adesso. La formula sta in `shared/board.ts`:
 * la legge anche il client, che con essa scrive «3 di 8» nel pannello
 * impostazioni della board. Qui resta il nome da cui la importano il dispatcher
 * e la quota di core.
 */
export { effectiveDispatchCap } from "../../shared/board";

/** Absolute ceiling — never auto-recommend more than this regardless of the box. */
const MAX_AUTO_CAP = 8;

/**
 * La parte STRUTTURALE della capacità: quanti agenti questa macchina regge in
 * regime, per core e per RAM. Non guarda il carico, ed è il punto.
 *
 * Serve a rispondere a una domanda diversa da `computeDispatchCapacity()`.
 * Quella dice «quanti agenti NUOVI posso ammettere ADESSO», ed è apposta
 * reattiva al carico: più la macchina è occupata, più si tira indietro. La
 * quota di core (`agent-job-quota.ts`) chiede invece «quanti agenti possono
 * girare ACCANTO a me», che è una domanda sul regime, non sull'istante.
 *
 * Usare il numero reattivo come divisore le invertiva: macchina carica →
 * raccomandazione 1 → «sono solo» → fetta INTERA. Misurato l'11/08 su questo
 * host con il tetto su `auto` (il default di un'installazione nuova) e load
 * 45: la quota usciva `-j11`, cioè nessun recinto, proprio nel momento in cui
 * serviva. Gli agenti già partiti non si fermano quando la raccomandazione
 * scende — al respawn si sarebbero presi la macchina uno per uno.
 *
 * Il pavimento di `byCores` è 2, quindi in `auto` questo numero non vale mai 1:
 * il caso «da solo» resta riservato a chi ha scelto un tetto fisso di 1 a mano.
 */
export function structuralDispatchCapacity(): number {
  const cores = Math.max(1, os.cpus().length);
  const totalMemGB = os.totalmem() / 1e9;
  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // ~3 GB/agent incl. OS headroom — only binding on small-RAM machines.
  const byMem = Math.max(1, Math.floor(totalMemGB / 3));
  return clamp(Math.min(byCores, byMem), 1, MAX_AUTO_CAP);
}

/**
 * @param running quanti turni sono in volo ADESSO (`dispatcher.busyCount()`).
 *   Non entra nel calcolo del tetto — la raccomandazione è una proprietà della
 *   macchina, non di chi la sta usando: serve a chi legge, per sapere se fra
 *   «consigliati N» e la realtà c'è uno scarto su cui agire.
 */
export function computeDispatchCapacity(running = 0): DispatchCapacity {
  const cores = Math.max(1, os.cpus().length);
  const totalMemGB = os.totalmem() / 1e9;
  const load1 = os.loadavg()[0] ?? 0;

  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // ~3 GB/agent incl. OS headroom — only binding on small-RAM machines.
  const byMem = Math.max(1, Math.floor(totalMemGB / 3));
  // Spare core-units right now (idle → ~cores, saturated → 0); halve into slots.
  const loadFree = clamp(cores - load1, 0, cores);
  const byLoad = Math.max(1, Math.ceil(loadFree / 2));

  const recommended = clamp(Math.min(byCores, byMem, byLoad), 1, MAX_AUTO_CAP);
  const reason =
    `${cores} core → base ${byCores}` +
    (byMem < byCores ? `, limitato dalla RAM (${totalMemGB.toFixed(0)}GB → ${byMem})` : "") +
    (byLoad < Math.min(byCores, byMem) ? `, ridotto per carico (load ${load1.toFixed(1)})` : "");
  return { recommended, cores, totalMemGB: Math.round(totalMemGB * 10) / 10, load1: Math.round(load1 * 100) / 100, reason, running };
}

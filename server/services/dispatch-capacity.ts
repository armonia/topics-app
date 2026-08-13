// Auto-sizing for the dispatch concurrency cap (board "Agent in parallelo").
//
// A dispatched agent is a full headless Claude session in its own git worktree.
// It is mostly I/O-bound (waiting on the API), so we can run more than one per
// core — but each still holds a process, does git work, and bursts CPU while a
// turn streams. We size the cap from stable signals:
//   - CPU cores: the primary budget (I/O-bound → modest oversubscription).
//   - Total RAM: a floor guard for small machines (a ~3 GB/agent budget).
//   - La CPU che la NOSTRA flotta sta consumando: il freno vivo (vedi sotto).
//
// We deliberately IGNORE os.freemem(): on macOS it reports almost nothing "free"
// (the OS keeps reclaimable pages as cache), so it would peg the cap at 1 on a
// perfectly healthy 32 GB machine.
//
// IL FRENO VIVO NON È PIÙ IL LOAD AVERAGE. Lo era, e il conto era
// `byLoad = ceil((core - load1) / 2)`. Su questo host, load 13 su 12 core, dava
// 1: cinque card in coda dietro a un agente solo, per ore. Ma il load average è
// della MACCHINA INTERA, e in quel momento i nostri agenti tenevano 0,75 core su
// 12. Il carico era di WindowServer, Dia, Beeper. Ci si ritirava per far posto a
// un carico non nostro, che non sarebbe sceso perché non dipendeva da noi. E il
// freno si autoavverava: ogni agente che partiva alzava il load di 2-3 punti e
// chiudeva la porta al successivo.
//
// La domanda giusta non è «quanto è carica la macchina» ma «quanto di questo
// carico è MIO»: il carico altrui non riduce il tetto (la CPU non si prenota, e
// un agente aspetta la rete quasi sempre), il carico nostro sì. La misura è
// `fleetLoadSync()` in `server/lib/fleet-usage.ts`; qui c'è solo l'aritmetica.

import os from "node:os";
import { statfsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { fleetLoadSync } from "../lib/fleet-usage";

// La forma sta in `shared/board.ts` (la legge la UI delle impostazioni board).
export type { DispatchCapacity } from "../../shared/board";
import type { DispatchCapacity } from "../../shared/board";
import { clampGlobalCap } from "../../shared/board";

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
  // `clampGlobalCap`, non il clamp locale: quello stringeva a 1..20 e avrebbe
  // riletto lo zero di «nessun tetto» come 1, cioè come il tetto più stretto
  // possibile. Il sentinella deve sopravvivere al giro attraverso il DB.
  return { auto, max: clampGlobalCap(Math.floor(r?.max_agents ?? 3)) };
}

/**
 * Quanti agenti insieme, davvero, adesso. La formula sta in `shared/board.ts`:
 * la legge anche il client, che con essa scrive «3 di 8» nel pannello
 * impostazioni della board. Qui resta il nome da cui la importano il dispatcher
 * e la quota di core.
 */
export { effectiveDispatchCap, sizingDispatchCap } from "../../shared/board";

/** Absolute ceiling — never auto-recommend more than this regardless of the box. */
const MAX_AUTO_CAP = 8;

/**
 * IL PAVIMENTO, che è una cosa diversa dal tetto.
 *
 * Il tetto dice quanti agenti si vogliono insieme, e da quando esiste
 * `GLOBAL_CAP_OFF` la risposta può essere «nessun limite». Questo dice quando la
 * macchina non ne regge un altro comunque, e non è negoziabile dalle
 * impostazioni: senza, «nessun limite» significa che la coda si ferma soltanto
 * quando il disco è pieno.
 *
 * PERCHÉ IL DISCO E NON LA CPU. Misurato il 13/08 su questo host: gli agenti
 * costavano il 5,7% di CPU in otto e 0,24-0,43 GB di RSS ciascuno — non è lì che
 * si muore. Ogni agente dispatchato però apre una WORKTREE, e le 33 presenti
 * pesavano 30 GB, cioè **0,91 GB l'una**, contro 56 GB liberi su un disco al
 * 94%: sessantuno worktree e il disco è finito. E un disco pieno non rallenta,
 * rompe — le scritture SQLite del server di produzione (DB + WAL) falliscono, e
 * quello è un guasto che non si riassorbe da solo quando il carico cala.
 *
 * La CPU si è già presa il suo freno altrove, e più mirato: `scripts/slot.ts`
 * recinta i CANCELLI, che sono ciò che la consuma davvero.
 */
export const DISPATCH_DISK_FLOOR_GB = 12;

/**
 * Spazio libero sul volume che ospita le worktree, in GB. `null` quando non si
 * riesce a misurare — e chi chiama deve trattarlo come «non lo so», non come
 * «zero»: un errore di lettura che blocca ogni dispatch sarebbe un guasto peggio
 * di quello che previene.
 */
export function freeDiskGB(path: string): number | null {
  try {
    const s = statfsSync(path);
    return (Number(s.bsize) * Number(s.bavail)) / 1e9;
  } catch {
    return null;
  }
}

/**
 * Perché NON si può ammettere un altro agente adesso, o `null` se si può.
 * La frase finisce sulla card, quindi dice il numero: «non c'è posto» senza il
 * dato è esattamente la coda invisibile che il chip `queued` esiste per evitare.
 */
export function dispatchResourceBlock(
  worktreesPath: string,
  /** La misura, iniettabile: il caso che conta è «disco quasi pieno», e senza
   *  questa cucitura si potrebbe provare solo riempiendo il disco per davvero —
   *  cioè non si proverebbe, e la frase che finisce sulla card non l'avrebbe mai
   *  letta nessuno prima di un incidente. */
  readFreeGB: (p: string) => number | null = freeDiskGB,
): string | null {
  const free = readFreeGB(worktreesPath);
  if (free == null || free >= DISPATCH_DISK_FLOOR_GB) return null;
  return `Disco quasi pieno: ${free.toFixed(1)} GB liberi, sotto il pavimento di ${DISPATCH_DISK_FLOOR_GB} GB. ` +
    `Ogni agente apre una worktree (~0,9 GB), e un disco pieno fa fallire le scritture del DB. ` +
    `Riprendo appena si libera spazio: niente è andato perso.`;
}

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
 * La quota di macchina che la flotta può occupare: metà dei core.
 *
 * È la linea che decide quando il freno morde. Con gli agenti che aspettano la
 * rete (0,75 core su 12, il caso rotto) qualunque quota lascia intatto il tetto
 * strutturale: non è lì che si gioca. Con agenti che compilano davvero (1-2 core
 * l'uno) la metà della macchina ne fa stare pochi, e il tetto scende. L'altra
 * metà resta all'umano che sta usando il suo computer.
 */
const FLEET_CPU_SHARE = 0.5;

/**
 * Quanto costa uno slot NUOVO, in unità di core. Uno: un agente che lavora tiene
 * grosso modo un core, e quello si prenota prima di ammetterlo.
 *
 * È un costo FISSO e non l'appetito medio osservato, di proposito. Un divisore
 * vivo si inverte: sotto carico l'appetito medio cresce, la quota per agente si
 * allarga e il freno si allenta proprio quando dovrebbe stringere.
 */
const NEW_SLOT_CORE_COST = 1;

/**
 * Il pavimento del termine vivo: due slot.
 *
 * Un agente solo non deve poter chiudere la porta al secondo, qualunque cosa
 * stia facendo. È la protezione contro l'autoavveramento vecchio in una riga:
 * il primo che parte consuma, quello che consuma alza il numero, e il numero
 * alzato vieta il secondo. Sotto due la coda si stabilizza a un agente e la
 * board sembra ferma per una decisione umana che non esiste.
 */
const FLEET_SLOT_FLOOR = 2;

/**
 * Quanti agenti stanno nella quota di CPU della flotta: quelli che GIÀ girano,
 * più quelli che ci stanno ancora dentro a `NEW_SLOT_CORE_COST` l'uno. Pura, la
 * misura la passa chi chiama.
 *
 * `fleetCores` è la CPU della NOSTRA flotta in unità di core (1 = un core
 * saturo), la stessa scala del load average ma con dentro solo i processi
 * nostri. `null` significa NON MISURATO, che non è «zero»: chi chiama ripiega
 * sul conto storico invece di trattare un numero assente come via libera.
 */
export function fleetCapacityLimit(input: { cores: number; fleetCores: number; running: number }): number {
  const budgetCores = Math.max(1, input.cores * FLEET_CPU_SHARE);
  const freeCores = Math.max(0, budgetCores - input.fleetCores);
  const newSlots = Math.floor(freeCores / NEW_SLOT_CORE_COST);
  return Math.max(FLEET_SLOT_FLOOR, input.running + newSlots);
}

/**
 * @param running quanti turni sono in volo ADESSO (`dispatcher.busyCount()`).
 *   Entra nel conto: il termine vivo è «i vivi più quelli che ci stanno ancora»,
 *   e senza sapere quanti sono già partiti la CPU che stanno consumando non dice
 *   quanto spazio resta. Chi lo omette ottiene solo gli slot liberi.
 * @param readFleet la sonda, iniettabile. I casi che contano sono «la macchina è
 *   carica ma non per colpa nostra» e «la flotta si mangia tutto», e senza
 *   questa cucitura si potrebbero provare solo caricando davvero la macchina che
 *   fa girare i test, cioè non si proverebbero.
 */
export function computeDispatchCapacity(
  running = 0,
  readFleet: () => { coreUnits: number; cores: number } | null = fleetLoadSync,
): DispatchCapacity {
  const cores = Math.max(1, os.cpus().length);
  const totalMemGB = os.totalmem() / 1e9;
  const load1 = os.loadavg()[0] ?? 0;
  let fleetCores: number | null = null;
  try { fleetCores = readFleet()?.coreUnits ?? null; } catch { fleetCores = null; }

  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // ~3 GB/agent incl. OS headroom — only binding on small-RAM machines.
  const byMem = Math.max(1, Math.floor(totalMemGB / 3));
  const structural = Math.min(byCores, byMem);

  // Il freno vivo. Con la sonda si misura la flotta; senza (Windows, o la cache
  // ancora fredda al primo tick) resta il conto storico sul load average, che è
  // impreciso ma è l'unico numero disponibile: meglio del nulla, e la sonda
  // arriva al giro dopo.
  const byFleet =
    fleetCores != null
      ? fleetCapacityLimit({ cores, fleetCores, running })
      : Math.max(1, Math.ceil(clamp(cores - load1, 0, cores) / 2));

  const recommended = clamp(Math.min(structural, byFleet), 1, MAX_AUTO_CAP);
  const reason =
    `${cores} core → base ${byCores}` +
    (byMem < byCores ? `, limitato dalla RAM (${totalMemGB.toFixed(0)}GB → ${byMem})` : "") +
    (byFleet >= structural
      ? fleetCores != null
        ? `; la flotta usa ${fleetCores.toFixed(1)} core su ${(cores * FLEET_CPU_SHARE).toFixed(0)} di quota`
        : ""
      : fleetCores != null
        ? `, ridotto a ${byFleet}: la flotta usa ${fleetCores.toFixed(1)} core su ${(cores * FLEET_CPU_SHARE).toFixed(0)} di quota`
        : `, ridotto per carico (load ${load1.toFixed(1)})`);
  return { recommended, cores, totalMemGB: Math.round(totalMemGB * 10) / 10, load1: Math.round(load1 * 100) / 100, reason, running };
}

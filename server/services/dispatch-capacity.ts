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
// IL FRENO VIVO NON È PIÙ IL LOAD AVERAGE (cambiato il 12/08/2026).
//
// Lo era, e il conto era `byLoad = ceil((core - load1) / 2)`. Il load average è
// della MACCHINA INTERA: il 12/08 su questo host valeva 13 su 12 core mentre i
// nostri agenti tenevano 0,75 core: il carico erano WindowServer, il browser,
// ActivityWatch, un player video. Il tetto è sceso a 1 con cinque card in coda,
// per far posto a un carico che non era nostro e che non sarebbe sceso perché
// non dipendeva da noi.
//
// E si autoavverava, che è il difetto peggiore: ogni agente che partiva alzava
// il load di due o tre punti e chiudeva la porta al successivo. Un freno che
// misura sé stesso si stabilizza a un agente, sempre.
//
// La domanda giusta non è «quanto è carica la macchina» ma «quanto di questo
// carico è MIO»:
//  · il carico ALTRUI non riduce il tetto. Un agente aspetta la rete quasi
//    sempre, e la CPU non è una risorsa che si prenota: se il Mac è occupato al
//    100% da qualcun altro, gli agenti si spartiscono comunque il tempo che
//    serve loro. Ritirarsi da un carico che non controlliamo è solo una coda
//    ferma.
//  · il carico NOSTRO sì, e a credito: la flotta ha un budget di core-unità
//    (metà macchina), quello che gli agenti vivi stanno già bruciando è speso,
//    e ogni slot NUOVO costa una core-unità di quel che resta.
//
// A credito e non a divisione, ed è la differenza che conta: dividere il budget
// per il costo MEDIO osservato di un agente è ancora un freno che misura sé
// stesso (una macchina carica → raccomandazione bassa → vedi
// `structuralDispatchCapacity`, dove lo stesso errore è già costato). Qui un
// agente che costa una core-unità alza `running` di 1 e abbassa il residuo di
// 1: il tetto non si muove, e la porta resta aperta a quello dopo. Si stringe
// solo quando gli agenti vivi costano davvero più di così.
//
// La misura è quella della flotta (`server/lib/fleet-usage.ts`), la stessa che
// usa il gate del task pesante: due freni che leggono due sonde diverse sono
// due freni che prima o poi si contraddicono.

import os from "node:os";
import { statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { fleetLoadSync, fleetSessionCoreUnits, type FleetLoadReading } from "../lib/fleet-usage";
import { machineCpuPct as sampleMachineCpuPct } from "../lib/machine-cpu";
import { recentCardMemPeaksGB } from "../lib/card-memory-peaks";
import { machineCores } from "../lib/machine-cores";
import { MEM_WINDOW_MS, parseSwapTotalMB, parseSwapUsedMB, type HeldMemory, type MemSample } from "./mem-signal";
import { formatMemoryOwners, type MemoryFamily } from "./memory-owners";

// La forma sta in `shared/board.ts` (la legge la UI delle impostazioni board).
export type { DispatchCapacity } from "../../shared/board";
import type { DispatchCapacity, GlobalDispatchCap, GlobalDispatchCapExtras, MachineBudgetSample } from "../../shared/board";
import { AGENT_COST_FLOOR_MEM_GB, BUDGET_SHARE_DEFAULT, BUDGET_SHARE_MAX, BUDGET_SHARE_MIN, clampGlobalCap, estimatedAgentCost, estimatedAgentMemCost, machineBudget } from "../../shared/board";
import { CHECKS_MEM_FLOOR_DEFAULT_GB, checksMemFloorGB } from "../../shared/checks-memory-floor";

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
export function readGlobalCap(db: Database): GlobalDispatchCap {
  type Row = {
    max_agents?: number | null;
    max_agents_auto?: number | null;
    max_agents_mode?: string | null;
    machine_budget_share?: number | null;
  };
  let r: Row | undefined;
  try {
    r = db
      .prepare(
        "SELECT max_agents, max_agents_auto, max_agents_mode, machine_budget_share FROM board_settings WHERE project_id = ?",
      )
      .get(GLOBAL_SETTINGS_KEY) as Row | undefined;
  } catch {
    // The two "by resources" columns are absent (a db older than their
    // migration, a minimal test harness): read the two the row has always had.
    // Falling back instead of throwing, for the same reason `readSpendCaps`
    // does: this runs inside the dispatcher tick, and a tick that dies over a
    // setting nobody has turned on is a frozen queue with no message anywhere.
    r = db
      .prepare("SELECT max_agents, max_agents_auto FROM board_settings WHERE project_id = ?")
      .get(GLOBAL_SETTINGS_KEY) as Row | undefined;
  }
  // Auto è il default finché non si sceglie un numero a mano (NULL = mai
  // impostato → auto), così un'installazione nuova protegge la macchina da sé.
  const auto = r?.max_agents_auto == null ? true : !!r.max_agents_auto;
  // The mode and the knob travel only when the row SAYS them: this function
  // returns the cap "as written", and the contract in `shared/board.ts` reads
  // an absent field as "count, default budget" (`capMode`, `budgetShare`).
  // Filling the defaults here would be a second copy of them, and the value a
  // caller uses must come from one reader.
  const extras: GlobalDispatchCapExtras = {};
  if (r?.max_agents_mode === "resources") extras.mode = "resources";
  if (typeof r?.machine_budget_share === "number" && Number.isFinite(r.machine_budget_share)) {
    extras.budgetShare = r.machine_budget_share;
  }
  // `clampGlobalCap`, non il clamp locale: quello stringeva a 1..20 e avrebbe
  // riletto lo zero di «nessun tetto» come 1, cioè come il tetto più stretto
  // possibile. Il sentinella deve sopravvivere al giro attraverso il DB.
  return { auto, max: clampGlobalCap(Math.floor(r?.max_agents ?? 3)), ...extras };
}

/**
 * THE TWO SPEND CAPS, in USD cents, from the same reserved row.
 *
 * Zero (and NULL, i.e. a db that does not have the column yet) means UNLIMITED,
 * and that is not a defensive fallback: it is the state a fresh install is born
 * in. The brake exists as a lever, not as a behaviour, so the neutral value has
 * to be the one that does nothing.
 *
 * It sits next to `readGlobalCap` for the same reason that one sits here: there
 * are two readers (the dispatcher tick and the settings route) and "what zero
 * means in this column" has to be written once. The read is ONE query on the '*'
 * row, the same shape as above: with the caps off, the whole cost of the brake
 * inside the dispatcher loop is this single row.
 */
export function readSpendCaps(db: Database): { perTaskCents: number; perDayCents: number } {
  let r: { agent_cost_cap_cents?: number | null; agent_cost_cap_cents_24h?: number | null } | undefined;
  try {
    r = db
      .prepare("SELECT agent_cost_cap_cents, agent_cost_cap_cents_24h FROM board_settings WHERE project_id = ?")
      .get(GLOBAL_SETTINGS_KEY) as typeof r;
  } catch {
    // Column absent (minimal harness, db older than the migration): no cap. A
    // `throw` here would stop the tick over a read that, switched off, decides
    // nothing at all.
    return { perTaskCents: 0, perDayCents: 0 };
  }
  const clean = (v: number | null | undefined) =>
    Number.isFinite(v) && (v as number) > 0 ? Math.trunc(v as number) : 0;
  return { perTaskCents: clean(r?.agent_cost_cap_cents), perDayCents: clean(r?.agent_cost_cap_cents_24h) };
}

/**
 * THE MEMORY FLOOR IN FRONT OF A CHECK COMMAND, from the same reserved row.
 *
 * Read every time the brake is about to wait, not once at boot: that is what
 * makes the setting take effect on the next round instead of at the next
 * restart. The query is one indexed row by primary key, and the brake polls
 * every 5 s, so re-reading costs nothing worth a cache that could go stale.
 *
 * An absent column or an unreadable row is the DEFAULT, never zero: zero means
 * "the owner switched the brake off", and a missing migration must not be able
 * to say that on their behalf.
 */
export function readChecksMemFloorGB(db: Database): number {
  let r: { checks_mem_floor_gb?: number | null } | undefined;
  try {
    r = db
      .prepare("SELECT checks_mem_floor_gb FROM board_settings WHERE project_id = ?")
      .get(GLOBAL_SETTINGS_KEY) as typeof r;
  } catch {
    return CHECKS_MEM_FLOOR_DEFAULT_GB;
  }
  // NULL = never set: `checksMemFloorGB` turns a non-number into the default,
  // and clamps anything else with the same reader the panel applies.
  return checksMemFloorGB({ checksMemFloorGB: r?.checks_mem_floor_gb ?? undefined });
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
 * IL PAVIMENTO SULLA MEMORIA, accanto a quello sul disco e per la stessa
 * ragione: da quando il tetto sugli agenti si può togliere, «nessun limite»
 * deve comunque voler dire «finché la macchina regge».
 *
 * PERCHÉ SERVE, misurato. `bun run scripts/bench/memory.ts --agents 2,4,8` su
 * questo host: 2 agenti fermi al prompt 704,9 MB, 4 → 1239,2 MB, 8 → 2145,5 MB,
 * cioè una pendenza di **240 MB per agente** (la CLI nuda ne fa 203,6, Topics
 * aggiunge 34,5). Venti task in coda proiettano ~5,0 GB fermi al prompt e ~7,6
 * GB al lavoro. Non è un'ipotesi: il 2026-08-16, con la coda che dispacciava,
 * questa macchina aveva 5,7 GB di swap su 7 occupati. In swap il rallentamento
 * non è degli agenti, è di tutto — la persona che sta usando il computer
 * compresa.
 *
 * DODICI GB, e il numero viene dalla rampa e non da un pollice alzato: è quanto
 * serve per far lavorare cinque agenti veri (320-420 MB l'uno misurati con una
 * conversazione dentro, non fermi al prompt) lasciando ~10 GB a chi sta usando
 * il Mac. Sotto quella riga il prossimo agente non trova RAM: la prende in
 * prestito dal disco, ed è la prestazione di tutto a pagarla.
 *
 * LIBERI + INATTIVI, non `memory_pressure` e non `os.freemem()`. Le pagine
 * INATTIVE sono memoria che il kernel riprende senza swappare, quindi contarle
 * è corretto e ometterle direbbe «finita» su una macchina sana: qui, nella
 * stessa lettura, i liberi erano 2,65 GB e gli inattivi 9,69. La percentuale di
 * `memory_pressure` è l'altra trappola, ed è nel task che ha aperto questo
 * lavoro: dava 48% mentre di liberi ce n'erano 1,9 GB, cioè un numero che non
 * dice quanti agenti ci stanno.
 */
/**
 * ── WHERE THIS FLOOR FALLS ON THIS MACHINE ──────────────────────────────────
 * Written here instead of left for whoever finds the queue stopped with no
 * explanation. Measured 2026-09-11 over 14 `vm_stat` samples in 56 s, machine
 * healthy: 12,4-13,1 GB available. The floor is 12. It lives right up against
 * it, and it did with the old sum too (mean 12,37 against the new 12,78): this
 * is not a strictness introduced by the change of formula, it is the working
 * point of a 32 GB Mac with a browser, an app and a server on it.
 *
 * The practical consequence: with an agent CLI at ~240 MB idle, about three
 * agents are enough for the floor to bite. Whoever finds the queue stopped with
 * "Memoria quasi finita" on a machine that looks fine is seeing this, not a
 * fault.
 *
 * AND THE FLOOR IS NOT THE MISSING BRAKE: it governs the NEXT admissions,
 * including the next turn of an agent already in flight (it goes through
 * `admissionBlock`, inside the resume chain in `task-dispatcher.ts`). What does
 * not exist is a lever on memory already committed DURING a turn: on
 * 2026-09-10 the seven cards had been admitted while memory was still good, and
 * the RAM ran out while they worked. See card 5edd2e5f.
 */
export const DISPATCH_MEM_FLOOR_GB = 12;

/**
 * Il pavimento quando gli agenti NON sono processi: il runtime nativo.
 *
 * Tutta la rampa qui sopra misura una cosa sola — il costo di una CLI. 240 MB
 * fermi, 320-420 al lavoro, e dodici GB di margine perché cinque agenti veri
 * ci stiano dentro senza mandare in swap la macchina di chi la sta usando.
 *
 * Col runtime nativo quel conto non descrive più niente. Una sessione è un
 * array di messaggi dentro il server che è già acceso: misurati 2,3 MB
 * marginali per sessione, contro 432 della CLI sulla stessa macchina
 * (`bench/results/session-memory.json`, 2026-08-16). Dieci agenti nativi
 * costano meno di UN agente CLI.
 *
 * Tenere 12 GB per roba che ne chiede 23 di megabyte non è prudenza: è una coda
 * ferma su una macchina che sta benissimo, ed è successo — il dispatch bloccato
 * con 8,7 GB liberi mentre gli agenti che doveva lanciare ne avrebbero chiesti
 * venti di megabyte.
 *
 * DUE GB E NON ZERO. Il pavimento resta, perché il server fa anche altro: i
 * turni tengono la conversazione in memoria, i tool leggono file, e una
 * macchina già in swap non deve peggiorare comunque. Ma è il margine di
 * un'applicazione che lavora, non di N processi Node.
 *
 * ── AND TWO WAS STILL THE WRONG NUMBER: IT PRICED THE SESSION, NOT THE WORK ──
 * Everything above measures the session OBJECT - 2,3 MB of messages inside a
 * server that is already running. True, and beside the point. What a card
 * actually costs is the CHECK RUN it launches: `test:unit:shards` forks four
 * shards (the e2e ran here too until 15/09/2026; now it runs on the PR CI). Those are
 * processes, and they are exactly the thing the native floor decided not to
 * count.
 *
 * MEASURED on 2026-09-11 with the board at work - the loaded case every earlier
 * calibration was missing, because all of them sampled an idle Mac:
 *
 *   server alone, no card in checks .............. 0,57 GB   (10 processes)
 *   one card inside test:unit:shards ............. 2,4 GB    (13-15)
 *   three cards together, peak ................... 4,94 GB   (23)
 *   -> marginal cost of one admitted card ........ ~1,5 GB
 *
 * 18 samples over that stretch: `availableMemGB` stayed between 7,74 and 10,94
 * and Swapouts did not move (258.707, the same cumulative value as before the
 * 10/09 crisis). That band IS the working point under real load.
 *
 * So a floor of 2 admits a card when the machine has 2 GB left, and that one
 * card then asks for about 1,5 of them. That is not a brake that failed to
 * hold: it is a brake set below the weight of a single admission, and it is the
 * mechanism of the 10/09 freeze - seven cards admitted while `availableMemGB`
 * read 9,69, which against a floor of 2 was wide open. Card 5edd2e5f says the
 * gate "was already refusing"; it was not, and that line is corrected there.
 *
 * SIX, AND WHY THAT AND NOT A ROUNDER NUMBER. Three grounds, in order: it never
 * bites inside the measured working band (7,74-10,94); it is four times the
 * marginal cost of the admission it governs, so the card it lets in lands the
 * machine near 4,5 GB and not near zero; and above all it stops short of the
 * region where there are no measurements at all - between 7,7 GB (fine, seen)
 * and 0,08 GB (the freeze, seen) nobody has ever sampled anything.
 *
 * HOW BIG THE UNMEASURED GAP REALLY IS - narrower than "7,4 down to 0,08".
 * From a standing start the gate flips at SIX (the dispatcher adds the turns
 * still warming up and, once holding, one card's price: see `MemoryFloorHold`),
 * so below 6 the verdict is REFUSE whatever the reading. The unknown that
 * matters is 6,00 .. 7,39 GB, gate open and never sampled; at the worst healthy
 * peak under real load (7,39 GB, ten checks at once) the gate still admits.
 *
 * The other thing still unknown is different in kind and does NOT change the
 * verdict: where the machine starts to PAY - the first swapout. Anchors are the
 * compressor share, 0,210 at the healthy peak and 0,291 at the 10/09 freeze; the
 * onset is between them, and pinning it down means going near the damage.
 *
 * WHAT WOULD MOVE IT, so the next person re-measures instead of re-guessing:
 * the check suite is the load, so if the shards or the e2e set change size,
 * this number is stale. Re-run the measurement the same way - the tree of the
 * server process (`lsof -nP -iTCP:3333`, then walk the children) against
 * `vm_stat`, while the board actually works.
 */
export const DISPATCH_MEM_FLOOR_NATIVE_GB = 6;

/**
 * Quanta RAM prenotare per UN agente quando decidi quanti posti ha la macchina.
 *
 * Sono i due prezzi di ammissione, e la differenza fra loro è il motivo per cui
 * questo parametro esiste invece di essere il 3 scritto a mano che c'era prima.
 *
 * `CLI` — 3 GB: un processo Node per sessione (240 MB fermo, 320-420 al lavoro)
 * più il margine di sistema che gli sta intorno. È il numero che ha sempre
 * governato `byMem`, e per le CLI resta giusto.
 *
 * `NATIVE` — 0,25 GB: una sessione nativa è un array di messaggi dentro il
 * server già acceso, misurata **2,3 MB** marginali contro i 432 della CLI sulla
 * stessa macchina (`bench/results/session-memory.json`, 2026-08-16). Un quarto
 * di giga è più di cento volte il costo misurato: non stima la sessione, tiene
 * il margine perché il server intorno fa anche altro (i turni tengono la
 * conversazione, i tool leggono file). Prezzare a 2,3 MB darebbe posti
 * illimitati su qualunque macchina, e il tetto smetterebbe di essere un tetto.
 *
 * RAISED TO 1,5 FOR THE SAME REASON AS THE FLOOR ABOVE, and it is the same
 * mistake in the other parameter: a quarter of a giga was "a hundred times the
 * measured session", but the session is not what occupies the machine. One card
 * inside its checks was measured at ~1,5 GB of real processes on 2026-09-11.
 * A seat has to be priced at what the occupant weighs, and 0,25 handed out six
 * times more seats than the machine has room for.
 *
 * PERCHÉ CONTA. Il pavimento (`dispatchResourceBlock`) sa già distinguere i due
 * runtime; il TETTO no, e si vedeva: quattro task nativi su questa macchina
 * partivano a scaglioni di due perché `byMem` prenotava 3 GB a testa per
 * sessioni che ne chiedono due di megabyte.
 */
export const GB_PER_AGENT_CLI = 3;
export const GB_PER_AGENT_NATIVE = 1.5;

/**
 * Memoria REALMENTE disponibile, in GB: quella che la macchina puo' dare SENZA
 * comprimere e senza swappare. `null` quando non si riesce a misurare, con la
 * stessa regola del disco: «non lo so» non è «zero», o un errore di lettura
 * fermerebbe la coda per sempre.
 *
 * `vm_stat` e non `os.freemem()`: su macOS la seconda riporta quasi nulla di
 * libero perché il kernel tiene le pagine reclamabili come cache, e userebbe
 * questo pavimento per bloccare il dispatch su un Mac da 32 GB in perfetta
 * salute. È lo stesso motivo per cui il commento in testa a questo file dice
 * che `os.freemem()` va ignorata.
 *
 * ── WHY `inactive` IS GONE, AND WHAT IT COST ────────────────────────────────
 * This sum used to be `free + speculative + inactive`, with a comment above it
 * saying INACTIVE pages are memory the kernel reclaims without swapping. Half
 * true: an inactive FILE-BACKED page is simply dropped, while an inactive
 * ANONYMOUS one is reclaimed only by compressing or swapping it - which is
 * exactly the I/O storm the floor exists to avoid. `vm_stat` does not separate
 * the two states, so the sum counted them together.
 *
 * The night of 2026-09-10, with seven cards running: `Pages free` 4.877 (76 MB
 * of 32 GB), inactive 586.288, compressor 1.712.833 pages (26 GB), 258.707
 * swapouts, the disk at 6.000-18.000 IOPS and the CPU at 40% IDLE - the
 * processes were not computing, they were waiting on the disk. This function
 * reported **9,7 GB available** - which is BELOW `DISPATCH_MEM_FLOOR_GB` (12),
 * so the admission gate was already refusing. The seven cards had been admitted
 * EARLIER, while memory was still good, and the RAM ran out while they worked.
 * The Mac became unusable and the agents had to be stopped by hand.
 *
 * So this is a fix to the MEASUREMENT, not to that blockage: what is missing is
 * a lever on memory already committed during a turn, and that has a card of its
 * own (5edd2e5f). Said here because the first version of this comment claimed
 * the gate had admitted, which is false, and a false diagnosis carved into a
 * file outlives the board note that corrects it.
 *
 * ── THE SUM AS IT IS NOW, and why it is not merely "stricter" ───────────────
 * `free + speculative + purgeable + file-backed`: everything obtainable without
 * making the disk work. On the same machine once RECOVERED it reads 11,70 GB
 * against the old 11,64 - that is, on a healthy machine the two agree, because
 * there the inactive pages really ARE cache. They part company once the cache
 * has been evicted and what is left inactive is dirty anonymous memory: the old
 * sum kept counting it, this one does not. It discriminates where that matters
 * and stays quiet where it does not, which is the only useful shape for a gate.
 *
 * ── WHERE THIS SUM SITS IN THE THREE STAGES OF PRESSURE ─────────────────────
 * macOS gives memory back in three moves, in order: (1) evict the file-backed
 * cache, which is free; (2) COMPRESS the dirty anonymous pages, which costs
 * CPU while the RAM still holds; (3) SWAP to disk, which is the I/O storm.
 *
 * This sum is 92% file-backed cache - measured, 11,70 GB of 12,78 on a healthy
 * sample - so it collapses at stage ONE, before the compressor starts filling
 * at stage two. That is what makes it an early warning rather than a post
 * mortem, and it is also why a second gate on the compressor's share would sit
 * DOWNSTREAM of this one rather than ahead of it: by the time the compressor is
 * a third of the machine, the cache this number is made of is long gone and the
 * floor has already bitten. A swapout rate is later still - stage three is
 * damage in progress, not a precursor.
 *
 * THE THIN PART, said out loud because it is where this will break: the floor
 * (12 GB) sits about 0,8 GB under the healthy reading. On the night of
 * 2026-09-10 purgeable and file-backed were not recorded, and under the most
 * generous assumption possible - the cache still intact - this sum would have
 * read 12,19 GB and the floor would NOT have bitten. That assumption is
 * physically incoherent with 10 GB already compressed (stage one precedes stage
 * two), but the margin it exposes is real: what protects this machine is a gap
 * of a few hundred megabytes. Whoever measures the loaded case - the board at
 * work, not an idle Mac - should check that gap first.
 *
 * Fuori da macOS la sonda non c'è e la risposta è `null`: su Linux le stesse
 * pagine si leggono da `/proc/meminfo` con nomi diversi, e inventare una
 * conversione non verificata sarebbe peggio che dire «non lo so» — con `null`
 * il pavimento si limita a non mordere, che è il verso giusto in cui sbagliare.
 */
export function availableMemGB(
  run: () => string | null = readVmStatSync,
): number | null {
  const out = run();
  return out ? parseVmStat(out).availGB : null;
}

function readVmStatSync(): string | null {
  try {
    if (process.platform !== "darwin") return null;
    return spawnSync(VM_STAT_BIN, { encoding: "utf8", timeout: 2000 }).stdout ?? null;
  } catch {
    return null;
  }
}

/**
 * The memory reading `computeDispatchCapacity` uses when nobody injects one.
 *
 * Out of the box it is `availableMemGB`, a SYNCHRONOUS `vm_stat`: 1,4 ms of
 * event loop stopped on a quiet Mac (median of 50, 23/09) and seconds under
 * thrash, paid on every board poll, every night-mode tick and every terminal
 * cap check. The server already samples the very same number asynchronously
 * every 10 s (`mem-signal.ts`), so it plugs that sample in here at boot and
 * the sync spawn is left only for when no fresh sample exists (first beat,
 * a probe that failed).
 */
let availMemReader: () => number | null = () => availableMemGB();

export function setAvailableMemReader(read: (() => number | null) | null): void {
  availMemReader = read ?? (() => availableMemGB());
}

function currentAvailableMemGB(): number | null {
  return availMemReader();
}

/** The fields of one `vm_stat` answer the memory readers use; `null` = the line is missing. */
export interface VmStat {
  /** The sum `availableMemGB` returns (see its comment), or `null` if any term is unreadable. */
  availGB: number | null;
  pageSize: number | null;
  compressorPages: number | null;
  /** Cumulative since boot. */
  swapins: number | null;
  swapouts: number | null;
}

/** One parse for every reader: the synchronous probes here and the sampler of `mem-signal.ts`. */
export function parseVmStat(out: string): VmStat {
  const num = (re: RegExp): number | null => {
    const n = Number(out.match(re)?.[1] ?? NaN);
    return Number.isFinite(n) ? n : null;
  };
  const pageSize = num(/page size of (\d+) bytes/) || null;
  const pages = (name: string) => num(new RegExp(`Pages ${name}:\\s+(\\d+)`));
  const free = pages("free");
  const speculative = pages("speculative");
  const purgeable = pages("purgeable");
  // NOT `Pages ...`: the line is called "File-backed pages", with the words the
  // other way round. Read with the other pattern it yields NaN, hence `null`,
  // hence a gate that stops measuring without saying so.
  const fileBacked = num(/File-backed pages:\s+(\d+)/);
  // One of the four unreadable and the total would be a silent understatement,
  // i.e. a floor that bites when it must not: better "I do not know".
  const terms = [free, speculative, purgeable, fileBacked];
  const availGB = pageSize && terms.every((t) => t != null)
    ? ((terms as number[]).reduce((a, b) => a + b, 0) * pageSize) / 1e9
    : null;
  return {
    availGB,
    pageSize,
    compressorPages: num(/Pages occupied by compressor:\s+(\d+)/),
    swapins: num(/Swapins:\s+(\d+)/),
    swapouts: num(/Swapouts:\s+(\d+)/),
  };
}

/** Reads a command's stdout asynchronously, killed after 2 s: `null` on any failure. */
async function readCommand(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, 2_000);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 ? out : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * ABSOLUTE PATHS. The server runs under launchd with a PATH that has no
 * `/usr/sbin`, where `sysctl` lives: spelled bare, the swap reading was null on
 * every sample of the live server (15/09/2026, `swapUsedGB=?` in every
 * `[memsig]` line with 14 GB of swap in use), so the swap verdict could never
 * be sustained and the brake never fired. Same trap as `taskpolicy` on 06/09.
 */
export const VM_STAT_BIN = "/usr/bin/vm_stat";
export const SYSCTL_BIN = "/usr/sbin/sysctl";

/**
 * The probe of `mem-signal.ts`: `vm_stat` and `sysctl -n vm.swapusage` as async
 * spawns (a synchronous one blocks the loop for as long as a fork takes under
 * thrash), plus the 1-minute load. `null` off macOS or when `vm_stat` fails.
 */
export async function probeVm(
  run: (argv: string[]) => Promise<string | null> = readCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<Omit<MemSample, "at"> | null> {
  if (platform !== "darwin") return null;
  const [vm, swap] = await Promise.all([run([VM_STAT_BIN]), run([SYSCTL_BIN, "-n", "vm.swapusage"])]);
  if (!vm) return null;
  const parsed = parseVmStat(vm);
  return {
    availGB: parsed.availGB,
    swapins: parsed.swapins,
    compressorPages: parsed.compressorPages,
    pageSize: parsed.pageSize,
    swapUsedMB: swap ? parseSwapUsedMB(swap) : null,
    swapTotalMB: swap ? parseSwapTotalMB(swap) : null,
    load1: os.loadavg()[0] ?? 0,
  };
}

/**
 * How much RAM the compressor is holding, in GB, or `null` when unmeasurable.
 *
 * The SECOND signal, independent of the first, and it exists because the first
 * one can be fooled: on a machine that has just finished compressing, the
 * file-backed cache can climb back for a moment and make it look as if there
 * were room. The compressor cannot - those pages are memory already spent and
 * NOT cedible, and to get them back the kernel has to decompress, which is
 * work.
 *
 * On 2026-09-10 it held 26 GB of 32. Not an edge case invented out of caution:
 * the measurement of the one night this machine locked up.
 */
export function compressorGB(
  run: () => string | null = readVmStatSync,
): number | null {
  const out = run();
  if (!out) return null;
  const vm = parseVmStat(out);
  return vm.pageSize && vm.compressorPages != null ? (vm.compressorPages * vm.pageSize) / 1e9 : null;
}

/**
 * HOW MANY PAGES THE MACHINE HAS SWAPPED OUT SINCE BOOT, cumulative, or `null`.
 *
 * A counter, not a rate: the difference between two readings over the elapsed
 * time is the rate, the same shape `fleet-usage.ts` already uses for CPU. And
 * the same trap applies - a reading with no previous base is NOT zero, it is
 * "I do not know".
 *
 * Reported and not gated, deliberately: see the note on the compressor below.
 */
export function swapoutPages(
  run: () => string | null = readVmStatSync,
): number | null {
  const out = run();
  return out ? parseVmStat(out).swapouts : null;
}

/**
 * Il pavimento come predicato puro: prende i GB disponibili e risponde sì/no.
 * Separato dalla sonda apposta — è la forma che il task chiedeva, la stessa di
 * `machineTooLoaded`, e permette di provarlo nei DUE versi senza riempire la
 * RAM di una macchina vera.
 */
export function memoryTooTight(availableGB: number | null, floorGB = DISPATCH_MEM_FLOOR_GB): boolean {
  if (availableGB == null || !Number.isFinite(availableGB)) return false;
  return availableGB < floorGB;
}

/**
 * What the dispatcher knows and the reading cannot say, as separate facts so the
 * sentence names each: one card's price, the memory kept for the local turns in
 * flight (only in count mode, see `floorReason`), and whether any of our work is
 * on the machine. With none, the floor asks for itself alone: this Mac reads
 * 6.1-11.7 GB with no Topics work at all, so "floor + price" (10-12 GB) would
 * keep an idle board shut for good.
 *
 * TWO QUESTIONS, TWO CENSUSES, and each one decides its own line end to end.
 */
export interface MemoryFloorHold {
  cardGB: number;
  reservedGB: number;
  reservedCards: number;
  /**
   * Is any of our work going to SPEND here memory the reading cannot see yet -
   * the SAME list `reservedGB` is priced from, so branch and figure agree. A
   * card parked on the pull request CI keeps a session alive but runs no
   * commands: its ~240 MB is resident NOW, already inside the window, with no
   * later burst to cover. Read off `ourWorkRunning` instead, the line asked
   * `floor + cardGB + 0` = 10 GB of a machine where nothing was spending.
   */
  spendingHere: boolean;
  /** Is any of our work ALIVE here, the cards parked on the CI included. It
   *  decides the EXEMPTION and nothing else: "none of our work on this machine"
   *  is the whole condition for one card under the floor, and an off-lane agent
   *  resident on this Mac is not none. */
  ourWorkRunning: boolean;
}

/** Memory that cannot be measured here (not macOS): it never blocks. */
const MEMORY_NOT_MEASURABLE: HeldMemory = { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 };

/**
 * WHICH floor wrote the sentence, and it is NOT derivable from the sentence.
 *
 * Every wait keyed on the first word of its reason ("Memoria", "Disco"), which
 * put the 120 s warm-up ("Memoria: la sto misurando…") and the real floor
 * ("Memoria quasi finita…") under one key. The warm-up is guaranteed at every
 * boot, so it always got there first and the real reason was never written on
 * the card: 80 comments out of 80 after 15/09/2026 17:49 carried the warm-up
 * and zero carried the floor, while the `dispatch_error` column next to them
 * was refreshed every 60 s with the right text.
 *
 * The kind travels instead of the words for the reason PR #63 reduced that key
 * to one word: the memory sentence now ends with the names of the apps holding
 * the RAM, and keying on the text rewrote the card at every retry.
 */
export type ResourceFloorKind = "disk" | "memory" | "memory_warmup";

/**
 * The floor's answer with the two facts a `string | null` cannot carry: which
 * floor spoke, and whether the memory floor stood down.
 */
export interface ResourceFloorVerdict {
  /** The sentence for the card, or `null` when nothing holds. */
  reason: string | null;
  kind: ResourceFloorKind | null;
  /**
   * The memory floor WOULD have held and let one card through because none of
   * our work is on the machine (`reason` is then `null`). Reported so the
   * verdict declares it, the way the budget axis declares `firstAgentExempt`.
   */
  memoryFirstCardExempt: boolean;
}

const NOTHING_HOLDS: ResourceFloorVerdict = { reason: null, kind: null, memoryFirstCardExempt: false };

/**
 * Perché NON si può ammettere un altro agente adesso, o `null` se si può.
 * La frase finisce sulla card, quindi dice il numero: «non c'è posto» senza il
 * dato è esattamente la coda invisibile che il chip `queued` esiste per evitare.
 *
 * DUE PAVIMENTI, disco e memoria, e si guardano in quest'ordine perché un disco
 * pieno rompe (le scritture SQLite falliscono, e il guasto non si riassorbe
 * quando il carico cala) mentre la RAM finita degrada. Il primo che morde
 * scrive la frase: due frasi insieme su una card sono rumore, e la seconda si
 * legge appena la prima è rientrata.
 *
 * THE MEMORY FLOOR READS A WINDOW, NOT AN INSTANT (`mem-signal.ts`). On
 * 15/09/2026 it reopened three times on one reading (14.5 GB with 12 GB of
 * swap, then 10.4 between two 5.5) and held again within 19-115 s. Now it holds
 * while the LOWEST reading of the last 2 minutes is under the line, and while
 * the window is not full (at boot too). One line for both directions: time is
 * the hysteresis.
 *
 * THE MEMORY FLOOR STANDS DOWN FOR THE FIRST CARD, THE DISK NEVER DOES, and the
 * asymmetry is the whole point. A full disk does not reabsorb itself: no
 * exemption, the queue waits for a person. Memory does - it is the OTHER
 * applications holding it, and they give it back when they are done - but the
 * floor had no way out at all, and on a Mac somebody is using that does not
 * produce a wait, it produces a queue that never restarts. Measured on 1455
 * `[memsig]` lines over 25.7 h of 16-17/09/2026: `held2m >= 6 GB` happened ZERO
 * times, the instant reading cleared 6 GB 11 times out of 1444 (0.76%) and never
 * twice in a row, while the floor needs at least 12-13 consecutive readings
 * over the line. Seven cards sat still between 45 and 51 hours, 314 comments
 * saying "Memoria quasi finita", one single restart in 26 hours and only because
 * a person closed some apps. Every one of those samples printed `inFlight=0
 * checkRuns=0`: the RAM was not Topics'.
 *
 * So with NONE of our work on the machine one card goes through - the same
 * "zero" `firstAgentExempt` already counts for the budget axis, agents plus
 * pre-review check runs, which the caller folds into `hold.ourWorkRunning`. With
 * even one agent or one check run in flight the floor holds in full: the 10/09
 * incident was seven cards admitted together, not one.
 *
 * The exemption covers the WARM-UP branch too, and refusing it there would be
 * incoherent: holding on "I do not know yet" while admitting on a reading that
 * is measured and bad says the unknown is worse than the bad. It is still one
 * card - the moment it starts, `ourWorkRunning` is true and the next one waits.
 */
export function dispatchResourceVerdict(
  worktreesPath: string,
  /** Injectable probe: "disk almost full" is otherwise provable only by filling a real disk. */
  readFreeGB: (p: string) => number | null = freeDiskGB,
  /** The memory window: proving "RAM almost gone" for real would send the developer's Mac into swap. */
  readMemory: () => HeldMemory = () => MEMORY_NOT_MEASURABLE,
  /** Are this machine's agents PROCESSES? It decides the floor (CLI or native); the caller knows it
   *  from `agent_runtime`, and this file measures the machine without setting policy. */
  agentsAreProcesses = true,
  /** What the dispatcher knows and the reading cannot see (see `MemoryFloorHold`). */
  hold: MemoryFloorHold = { cardGB: AGENT_COST_FLOOR_MEM_GB, reservedGB: 0, reservedCards: 0, spendingHere: false, ourWorkRunning: false },
  /** Who is holding the memory outside Topics (`memory-owners.ts`), heaviest first.
   *  Only the MEMORY sentence carries it: a full disk is not somebody's app. */
  foreign: readonly MemoryFamily[] = [],
): ResourceFloorVerdict {
  const free = readFreeGB(worktreesPath);
  if (free != null && free < DISPATCH_DISK_FLOOR_GB) {
    return {
      reason: `Disco quasi pieno: ${free.toFixed(1)} GB liberi, sotto il pavimento di ${DISPATCH_DISK_FLOOR_GB} GB. ` +
        `Ogni agente apre una worktree (~0,9 GB), e un disco pieno fa fallire le scritture del DB. ` +
        `Riprendo appena si libera spazio: niente è andato perso.`,
      kind: "disk",
      memoryFirstCardExempt: false,
    };
  }
  const mem = (() => { try { return readMemory(); } catch { return MEMORY_NOT_MEASURABLE; } })();
  if (!mem.measurable) return NOTHING_HOLDS;
  const floor = agentsAreProcesses ? DISPATCH_MEM_FLOOR_GB : DISPATCH_MEM_FLOOR_NATIVE_GB;
  const gb = (n: number) => n.toFixed(1);
  /** Nothing of ours on the machine: one card goes through, and it is declared. */
  const exempt = !hold.ourWorkRunning;
  if (mem.heldGB == null) {
    if (exempt) return { reason: null, kind: null, memoryFirstCardExempt: true };
    const seconds = Math.min(Math.round(MEM_WINDOW_MS / 1000), Math.max(0, Math.round(mem.coveredMs / 1000)));
    return {
      reason: `Memoria: la sto misurando da ${seconds} s su ${Math.round(MEM_WINDOW_MS / 1000)}, e non parto su una lettura sola. Niente è andato perso.`,
      kind: "memory_warmup",
      memoryFirstCardExempt: false,
    };
  }
  const cardGB = Math.max(0, hold.cardGB);
  const reservedGB = Math.max(0, hold.reservedGB);
  // The "floor alone" branch is not dead: it decides whether the exemption
  // below has anything to waive, and reading the line as floor + price on an
  // idle machine would declare one on a Mac with 8 GB free and nothing
  // running. Its condition is the PRICE LIST, the same list the figure comes
  // from (see `spendingHere`): taking the branch from the census instead held
  // at 7.0, 8.0 and 9.9 GB with two cards parked on the CI and a third asking.
  const line = hold.spendingHere ? floor + cardGB + reservedGB : floor;
  const low = mem.heldGB;
  if (low >= line) return NOTHING_HOLDS;
  if (exempt) return { reason: null, kind: null, memoryFirstCardExempt: true };
  // Past here `ourWorkRunning` is true, so the sentences below always describe a
  // machine that is carrying some of our work.
  const n = Math.max(0, hold.reservedCards);
  const kept = reservedGB > 0
    ? ` (il pavimento, il prezzo di una card e ${gb(reservedGB)} GB tenuti per ${n === 1 ? "l'agente al lavoro" : `i ${n} agenti al lavoro`})`
    : "";
  const head = low < floor
    ? `Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è ${gb(low)} GB, sotto il pavimento di ${floor} GB.`
    : `Memoria in risalita: la lettura più bassa degli ultimi 2 minuti è ${gb(low)} GB, sopra il pavimento di ${floor} GB ma sotto i ${gb(line)} GB che servono per una card in più${kept}.`;
  const costo = agentsAreProcesses
    ? "Ogni agente costa ~240 MB fermo e fino a 420 MB al lavoro"
    : `Con il runtime nativo la sessione pesa 2,3 MB, ma una card nei suoi check si prezza ${gb(cardGB)} GB`;
  const tail = `Parto quando la memoria resta sopra ${gb(line)} GB per 2 minuti di fila: una lettura sola sopra la riga non basta. Niente è andato perso.`;
  // The way OUT of the wait, and the only part of this sentence a person can
  // act on: on 16/09/2026 seven cards were held for hours by memory that was
  // not Topics' at all. `holdKey` keys a machine-floor wait on the verdict's
  // `kind`, so these names never make the chip rewrite itself.
  const who = formatMemoryOwners(foreign);
  return {
    reason: `${head} ${costo}, e sotto questa riga la macchina va in swap. ${tail}${who ? ` ${who}` : ""}`,
    kind: "memory",
    memoryFirstCardExempt: false,
  };
}

/**
 * The same verdict as a bare sentence, for every caller that only writes it.
 * The dispatcher reads `dispatchResourceVerdict`: it needs the kind to key the
 * wait and the exemption to declare it.
 */
export function dispatchResourceBlock(
  ...args: Parameters<typeof dispatchResourceVerdict>
): string | null {
  return dispatchResourceVerdict(...args).reason;
}

// THE COMPRESSOR IS MEASURED AND REPORTED, NOT GATED, and taking the gate back
// out is the honest move rather than the tidy one.
//
// It was added here with a ceiling of one third, calibrated on "26 GB of 32
// on 2026-09-10". That number came from `Pages stored in compressor`
// (1.712.833 pages), which is LOGICAL compressed pages; what `compressorGB`
// reads - correctly - is `Pages occupied by compressor`, the physical RAM,
// which that night was 610.054 pages, 10,0 GB, a share of 0,291. The ceiling
// was therefore set from a number this code never computes, and 0,291 is
// BELOW one third: the guard would not have fired on the night it was written
// for. The arithmetic settles which line is which - 1.712.833 pages is 28,1
// GB, and with 9,6 GB inactive and 0,08 free that is 37,7 GB on a 34,36 GB
// machine, which cannot be.
//
// AND 0,25 IS NOT A SAFER RETUNE - IT IS A GUARANTEED FALSE POSITIVE. With
// the queue running again the share was sampled against the number of agents,
// and it rises with them, linearly:
//
//     0 agents (idle) 0,165 · 1 agent 0,186 · 2 agents 0,200
//     slope ~0,018 per agent -> ~0,237 at four, ~0,255 at FIVE
//
// So a ceiling of 0,25 fires at about five agents on a healthy machine: zero
// swapouts, `availableMemGB` well over the floor, nothing wrong. It would
// stop the board in normal operation before ever approaching a crisis, which
// is the opposite of what it was for. (Measured 2026-09-11 across three
// series, 0/55 samples ever showed the only reading that would justify it:
// available memory above the floor AND the share over 0,25.)
//
// The claim that used to stand here - "that night the floor was ALREADY
// refusing, 9,69 GB against a floor of 12" - is false and is corrected at
// DISPATCH_MEM_FLOOR_NATIVE_GB: the floor in force on this machine is the
// native one, and against it the gate was wide open. So the compressor is not
// a second brake behind a working first one; the first one simply had the
// wrong price. That is fixed there, and it is the fix that was needed.
//
// The numbers travel in the capacity payload instead, where they can earn a
// threshold if an incident ever gives them one.

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
export function structuralDispatchCapacity(agentsAreProcesses = true): number {
  const cores = machineCores();
  const totalMemGB = os.totalmem() / 1e9;
  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // Il prezzo di ammissione dipende dal runtime (vedi `GB_PER_AGENT_*`): 3 GB
  // per una CLI, 0,25 per una sessione nativa. Vincola solo le macchine piccole.
  const byMem = Math.max(1, Math.floor(totalMemGB / (agentsAreProcesses ? GB_PER_AGENT_CLI : GB_PER_AGENT_NATIVE)));
  return clamp(Math.min(byCores, byMem), 1, MAX_AUTO_CAP);
}

/**
 * La fetta di macchina che la flotta può occupare: metà dei core.
 *
 * È la linea che decide quando il freno morde, e si sceglie guardando i due
 * estremi misurati. Con gli agenti che aspettano la rete (0,75 core su 12, il
 * caso del 12/08) qualunque quota lascia intatto il tetto strutturale: non è lì
 * che si gioca. Con quattro o cinque agenti che compilano davvero (fra 1 e 2
 * core l'uno) la metà della macchina si esaurisce, e il tetto smette di
 * ammetterne altri: che è esattamente ciò che deve succedere. L'altra metà
 * resta a chi sta usando il computer, che di solito è una persona.
 */
const FLEET_CPU_SHARE = 0.5;

/**
 * Quanto costa uno slot NUOVO, in core-unità di budget.
 *
 * Un costo FISSO, non l'appetito medio osservato. Il costo medio come divisore
 * è il freno che misura sé stesso in un'altra veste: gli agenti vivi costano
 * tanto → il divisore cresce → il tetto crolla → resta un agente solo, che
 * essendo l'unico a costare tanto tiene il divisore alto per sempre. Una
 * core-unità è la stima onesta del prezzo di ammissione: un agente in regime
 * sta molto sotto (aspetta la rete), un agente che compila sta sopra, e la
 * differenza la paga il residuo di budget al giro successivo.
 */
const CORES_PER_NEW_SLOT = 1;

/**
 * Il pavimento del termine vivo: due slot.
 *
 * Perché due e non uno: un agente da solo non deve poter chiudere la porta al
 * secondo. Se il primo si mette a compilare e si mangia l'intera quota, il
 * residuo va a zero e il conto darebbe «uno», cioè lui: la flotta si
 * congelerebbe sul primo che è partito, con la coda ferma dietro. Il pavimento
 * garantisce che ci sia sempre un secondo posto, e il tetto strutturale (che
 * non scende mai sotto 2) resta comunque il limite superiore.
 */
const FLEET_MIN_SLOTS = 2;

/**
 * Quanti agenti insieme può reggere la quota di CPU della flotta, dato quanto
 * ne stanno già bruciando quelli vivi. Pura: la misura la passa il chiamante.
 *
 * `running` sono gli agenti già in volo, e vanno SOMMATI: il loro costo è già
 * dentro `ourCoreUnits`, quindi il residuo di budget risponde alla domanda
 * «quanti ne ammetto ANCORA», non «quanti in tutto». Ometterlo era il modo
 * elegante di ricreare il difetto: il carico dei nostri agenti avrebbe
 * abbassato il tetto TOTALE invece dei posti residui, e il primo che compila
 * avrebbe di nuovo chiuso la porta.
 */
export function fleetSlotBudget(input: {
  cores: number;
  ourCoreUnits: number;
  running: number;
  /** The CPU of whoever is NOT ours, when measured. The fleet share is taken
   *  from what is left: what Topics did not open comes first (decided on
   *  14/09/2026, see `shared/machine-budget.ts`). `null` = not measured, and
   *  then the whole machine counts, never zero. */
  otherCoreUnits?: number | null;
}): {
  slots: number;
  /** Core-unità che la flotta può occupare in tutto. */
  budgetCores: number;
  /** Core-unità di budget ancora libere. */
  freeCores: number;
} {
  const freeOfOthers = input.otherCoreUnits == null
    ? input.cores
    : Math.max(0, input.cores - Math.max(0, input.otherCoreUnits));
  const budgetCores = Math.max(1, freeOfOthers * FLEET_CPU_SHARE);
  const freeCores = clamp(budgetCores - Math.max(0, input.ourCoreUnits), 0, budgetCores);
  const nuovi = Math.floor(freeCores / CORES_PER_NEW_SLOT);
  return { slots: Math.max(FLEET_MIN_SLOTS, Math.max(0, input.running) + nuovi), budgetCores, freeCores };
}

/**
 * SOMEBODY ELSE'S CPU, SMOOTHED, and this is the hysteresis of the whole
 * budget. The ceiling is now taken on the FREE part of the machine, so every
 * one second spike of somebody else would shut the door on a card that then
 * sits still for a whole tick, and a load that comes and goes would make the
 * ceiling jump between its extremes with nothing having changed.
 *
 * THE WINDOW IS 45 SECONDS OF WALL CLOCK, not a count of readings, and the
 * difference matters because this smoother has several callers at different
 * cadences: the dispatcher tick (~10 s), the settings panel, the governor.
 * With a window of five readings, three callers would have squeezed it down to
 * fifteen seconds without anybody choosing that. 45 s is the scale on which
 * somebody else's `bun test` or build is visibly there while a burst of `tsc`
 * is not; under 30 s the ceiling follows every breath of the machine, over a
 * minute it answers with a load that is already over.
 *
 * NARROWING AND WIDENING ARE NOT SYMMETRIC, and that asymmetry IS the band:
 *  · we narrow (their load counts as higher) on the MEDIAN of the window, so it
 *    takes a load that holds for half of it. One isolated spike never moves a
 *    median, which is why it is not the mean.
 *  · we widen only when the WHOLE window is under the value in force. Half a
 *    window of quiet is not a machine that has gone quiet: it is the trough of
 *    something still running, and taking it would give back a ceiling we are
 *    about to take away again. The alternating burst of the card stabilises
 *    here, on the busy reading, instead of flipping every ten seconds.
 * Their load has the priority, so the ambiguous case resolves their way; the
 * floor of slots is what keeps the board moving anyway.
 *
 * `null` (not measured) does not enter the history and does not consume it: it
 * returns `null`, that is "the whole machine", the prudent answer as always.
 */
export const OTHER_WINDOW_MS = 45_000;
type OtherSample = { at: number; coreUnits: number };
export type OtherLoadState = { samples: OtherSample[]; held: number | null };
export const newOtherLoadState = (): OtherLoadState => ({ samples: [], held: null });
const otherState = newOtherLoadState();

export function smoothedOther(
  other: number | null | undefined,
  state: OtherLoadState = otherState,
  now: number = Date.now(),
): number | null {
  if (other == null || !Number.isFinite(other)) return null;
  const samples = state.samples;
  samples.push({ at: now, coreUnits: Math.max(0, other) });
  // Drop what fell out of the window. Anything dated in the future is kept: a
  // clock that jumped backwards must not empty the history.
  let cut = 0;
  while (cut < samples.length && now - samples[cut]!.at > OTHER_WINDOW_MS) cut++;
  if (cut) samples.splice(0, cut);
  const sorted = samples.map((s) => s.coreUnits).sort((a, b) => a - b);
  const median = sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const held = state.held;
  if (held == null || median >= held || peak < held) state.held = median;
  return state.held;
}

/**
 * IL CONTO STORICO, per gli host senza sonda della flotta (Windows, e i primi
 * secondi dopo l'avvio finché la cache è fredda). Sbaglia esattamente come
 * sbagliava prima, ma sbagliare come prima su un host che non sa misurare è
 * meglio che non avere nessuna guardia.
 */
function loadAverageSlots(cores: number, load1: number): number {
  const loadFree = clamp(cores - load1, 0, cores);
  return Math.max(1, Math.ceil(loadFree / 2));
}

/**
 * @param running quanti turni sono in volo ADESSO (`dispatcher.busyCount()`, o
 *   il conteggio degli agenti vivi che il CAS del claim fa valere). Entra nel
 *   conto: è il termine che rende il freno un credito invece di una divisione
 *   (vedi `fleetSlotBudget`). Chi lo omette ottiene un tetto più prudente, mai
 *   uno più largo.
 * @param probe la sonda della flotta. Iniettabile per i test, che devono poter
 *   fissare la misura: leggerla dalla macchina vera renderebbe l'asserzione
 *   dipendente da cosa sta girando mentre la suite passa.
 * @param readAvailMemGB the memory probe (`availableMemGB`), injectable for the
 *   same reason. It does not enter `recommended`: it travels so the "by
 *   resources" mode and the settings panel read the machine's memory from the
 *   same reading as its load, instead of each spawning their own `vm_stat`.
 */
export function computeDispatchCapacity(
  running = 0,
  probe: () => FleetLoadReading | null = fleetLoadSync,
  agentsAreProcesses = true,
  readAvailMemGB: () => number | null = currentAvailableMemGB,
  /** The knob of the "by resources" mode and how many runs the governor has
   *  frozen right now. They travel through the capacity because the panel, the
   *  gauge and the gate must read ONE reading: a second probe for the same
   *  question is two numbers that disagree on screen. */
  budgetKnob: { share: number; frozen: number } = { share: BUDGET_SHARE_DEFAULT, frozen: 0 },
  /** The live price list of one agent, per session, injectable for the same
   *  reason as the probes: a test must be able to fix what an agent costs. */
  priceList: { coreUnits: () => number[]; memGB: () => number[] } = {
    coreUnits: fleetSessionCoreUnits,
    memGB: recentCardMemPeaksGB,
  },
  /** The whole-machine CPU%, injectable like every other probe. It receives
   *  the fleet's own sum as the fallback for when it has nothing to diff. */
  readMachineCpuPct: (fallbackPct: number | null) => number | null = sampleMachineCpuPct,
): DispatchCapacity {
  const cores = machineCores();
  const totalMemGB = os.totalmem() / 1e9;
  const load1 = os.loadavg()[0] ?? 0;
  // Una sonda che esplode vale «non lo so», mai «via libera» e mai un tick
  // caduto: si ripiega sul conto storico, come su un host senza sonda.
  const fleet = (() => { try { return probe(); } catch { return null; } })();
  // Same rule for memory: a probe that throws reads as "not measured" (`null`),
  // which the pressure verdict treats as "cannot block", never as zero.
  const availMemGB = (() => { try { return readAvailMemGB(); } catch { return null; } })();

  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // Il prezzo di ammissione dipende dal runtime (vedi `GB_PER_AGENT_*`).
  const byMem = Math.max(1, Math.floor(totalMemGB / (agentsAreProcesses ? GB_PER_AGENT_CLI : GB_PER_AGENT_NATIVE)));
  const structural = Math.min(byCores, byMem);
  // ONE SAMPLE FOR BOTH BRAKES, and it is where somebody else's CPU gets
  // smoothed (`budgetSample` calls `smoothedOther`). Assembled before the live
  // brake so the slot count and the "by resources" budget decide on the very
  // same number: two smoothers over one machine are two ceilings that
  // contradict each other on screen sooner or later.
  const sample = budgetSample(fleet, availMemGB, cores, totalMemGB, running);
  // Il freno vivo: la CPU che la flotta si sta già mangiando, non quella della
  // macchina intera (vedi la nota in testa al file).
  const budget = fleet
    ? fleetSlotBudget({ cores, ourCoreUnits: fleet.coreUnits, running, otherCoreUnits: sample.otherCoreUnits })
    : null;
  const live = budget ? budget.slots : loadAverageSlots(cores, load1);

  const recommended = clamp(Math.min(structural, live), 1, MAX_AUTO_CAP);
  const reason =
    `${cores} core → base ${byCores}` +
    (byMem < byCores ? `, limitato dalla RAM (${totalMemGB.toFixed(0)}GB → ${byMem})` : "") +
    (budget
      ? live < structural
        ? `, ridotto a ${live}: gli agent tengono ${fleet!.coreUnits.toFixed(1)} core sui ${budget.budgetCores.toFixed(0)} di quota`
        // WITHOUT "the rest of the load is not ours" (card 363bbbc8): it was
        // true and it explained nothing to whoever read it, because in this
        // mode nobody else's load enters the decision at all.
        : `; gli agent tengono ${fleet!.coreUnits.toFixed(1)} core sui ${budget.budgetCores.toFixed(0)} di quota`
      : live < structural
        ? `, ridotto per carico (load ${load1.toFixed(1)})`
        : "");
  // The budget half of the answer, from the SAME reading: what we may take,
  // what is left of it once the rest of the machine has taken its share, and
  // what we are taking now (agents and their gates together).
  const share = clamp(budgetKnob.share, BUDGET_SHARE_MIN, BUDGET_SHARE_MAX);
  const budgetNow = machineBudget(sample, share);
  const round = (n: number) => Math.round(n * 10) / 10;
  // What one more agent is priced at in memory, from the check peaks of the
  // last cards (the same price list the gate uses). WHICH AXIS BLOCKS is not computed here:
  // it travels as `admission`, the dispatcher's own verdict with its
  // reservation and hysteresis, so there is one answer and not two.
  const agentCost = {
    coreUnits: estimatedAgentCost((() => { try { return priceList.coreUnits(); } catch { return []; } })()),
    memGB: estimatedAgentMemCost((() => { try { return priceList.memGB(); } catch { return []; } })()),
  };
  return {
    recommended,
    cores,
    totalMemGB: Math.round(totalMemGB * 10) / 10,
    load1: Math.round(load1 * 100) / 100,
    oursCores: fleet ? Math.round(fleet.coreUnits * 10) / 10 : null,
    // The fleet share is of the FREE like everything else: report the real one
    // here, not `cores x share`, or the panel shows a ceiling the brake does not
    // apply.
    budgetCores: budget ? Math.round(budget.budgetCores * 10) / 10 : Math.round(cores * FLEET_CPU_SHARE * 10) / 10,
    budgetShare: share,
    budgetCoreUnits: round(budgetNow.cpuCoreUnits),
    usableCoreUnits: round(budgetNow.usableCoreUnits),
    usedCoreUnits: fleet ? round(sample.ourCoreUnits) : null,
    usedMemGB: fleet ? round(sample.ourMemGB) : null,
    // The SMOOTHED reading, not the raw one: the panel has to show the number
    // the gate decided on, otherwise a spike appears on screen that no ceiling
    // ever reacted to.
    otherCoreUnits: sample.otherCoreUnits == null ? null : round(sample.otherCoreUnits),
    frozen: Math.max(0, budgetKnob.frozen),
    availableMemGB: availMemGB != null && Number.isFinite(availMemGB) ? Math.round(availMemGB * 10) / 10 : null,
    agentCostMemGB: round(agentCost.memGB),
    freeQuotaMemGB: budgetNow.freeQuotaMemGB == null ? null : round(budgetNow.freeQuotaMemGB),
    ...machinePercents(fleet, availMemGB, cores, totalMemGB, readMachineCpuPct),
    reason,
    running,
  };
}

/**
 * THE WHOLE MAC IN TWO PERCENTAGES, for the one number a person is shown.
 *
 * CPU comes from the kernel's tick counters (`machine-cpu.ts` says why they
 * beat the fleet's process sum). The fleet sum, RAW and not the smoothed
 * `otherCoreUnits` the gate reads, is passed as the fallback for the first
 * reading after boot. Memory is the share not available, from the same
 * `availableMemGB` the gate reads; `null` off macOS stays `null`.
 */
export function machinePercents(
  fleet: FleetLoadReading | null,
  availMemGB: number | null,
  cores: number,
  totalMemGB: number,
  readCpu: (fallbackPct: number | null) => number | null,
): { machineCpuPct: number | null; machineMemPct: number | null } {
  const fleetPct = fleet && cores > 0
    ? ((fleet.coreUnits + fleet.scriptsCoreUnits + fleet.otherCoreUnits) / cores) * 100
    : null;
  let cpu: number | null = null;
  try { cpu = readCpu(fleetPct); } catch { cpu = null; }
  const mem = availMemGB != null && Number.isFinite(availMemGB) && totalMemGB > 0
    ? (1 - Math.max(0, availMemGB) / totalMemGB) * 100
    : null;
  const pct = (n: number | null) => n == null || !Number.isFinite(n) ? null : Math.round(Math.min(100, Math.max(0, n)));
  return { machineCpuPct: pct(cpu), machineMemPct: pct(mem) };
}

/**
 * The measure the budget decides on, assembled once from the fleet reading.
 *
 * OUR SHARE INCLUDES THE SCRIPTS. `coreUnits` alone is the fleet without the
 * work the agents launched, which is the number the count cap has always read;
 * for a budget that would exclude precisely what costs (a `tsc`, an `eslint`, a
 * `bun test`, the Chromium of an e2e run). Without the probe every one of our
 * own terms is `null` or zero, and `machineBudget` then reads the budget as the
 * whole answer: not measured must never be able to shrink it.
 *
 * SOMEBODY ELSE'S CPU ENTERS SMOOTHED (`smoothedOther`), and it enters HERE
 * because this is the one door every reader of the "by resources" mode goes
 * through: the admission gate, the governor that freezes running work, and the
 * settings panel. Smoothing it further up would have left the gate deciding on
 * the raw reading, which is the ceiling that jumps at every breath of the
 * machine.
 */
export function budgetSample(
  fleet: FleetLoadReading | null,
  availMemGB: number | null,
  cores: number,
  totalMemGB: number,
  running: number,
): MachineBudgetSample {
  return {
    cores,
    totalMemGB,
    ourCoreUnits: fleet ? fleet.coreUnits + fleet.scriptsCoreUnits : 0,
    otherCoreUnits: fleet ? smoothedOther(fleet.otherCoreUnits) : null,
    ourMemGB: fleet ? fleet.memGB : 0,
    availableMemGB: availMemGB != null && Number.isFinite(availMemGB) ? availMemGB : null,
    running,
  };
}

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
import type { Database } from "bun:sqlite";
import { fleetLoadSync } from "../lib/fleet-usage";
import { machineCores } from "../lib/machine-cores";

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
  const cores = machineCores();
  const totalMemGB = os.totalmem() / 1e9;
  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // ~3 GB/agent incl. OS headroom — only binding on small-RAM machines.
  const byMem = Math.max(1, Math.floor(totalMemGB / 3));
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
export function fleetSlotBudget(input: { cores: number; ourCoreUnits: number; running: number }): {
  slots: number;
  /** Core-unità che la flotta può occupare in tutto. */
  budgetCores: number;
  /** Core-unità di budget ancora libere. */
  freeCores: number;
} {
  const budgetCores = Math.max(1, input.cores * FLEET_CPU_SHARE);
  const freeCores = clamp(budgetCores - Math.max(0, input.ourCoreUnits), 0, budgetCores);
  const nuovi = Math.floor(freeCores / CORES_PER_NEW_SLOT);
  return { slots: Math.max(FLEET_MIN_SLOTS, Math.max(0, input.running) + nuovi), budgetCores, freeCores };
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
 */
export function computeDispatchCapacity(
  running = 0,
  probe: () => { coreUnits: number; cores: number } | null = fleetLoadSync,
): DispatchCapacity {
  const cores = machineCores();
  const totalMemGB = os.totalmem() / 1e9;
  const load1 = os.loadavg()[0] ?? 0;
  // Una sonda che esplode vale «non lo so», mai «via libera» e mai un tick
  // caduto: si ripiega sul conto storico, come su un host senza sonda.
  const fleet = (() => { try { return probe(); } catch { return null; } })();

  // I/O-bound agents → ~cores/3 as the CPU budget (2–6 band).
  const byCores = clamp(Math.round(cores / 3), 2, 6);
  // ~3 GB/agent incl. OS headroom — only binding on small-RAM machines.
  const byMem = Math.max(1, Math.floor(totalMemGB / 3));
  const structural = Math.min(byCores, byMem);
  // Il freno vivo: la CPU che la flotta si sta già mangiando, non quella della
  // macchina intera (vedi la nota in testa al file).
  const budget = fleet ? fleetSlotBudget({ cores, ourCoreUnits: fleet.coreUnits, running }) : null;
  const live = budget ? budget.slots : loadAverageSlots(cores, load1);

  const recommended = clamp(Math.min(structural, live), 1, MAX_AUTO_CAP);
  const reason =
    `${cores} core → base ${byCores}` +
    (byMem < byCores ? `, limitato dalla RAM (${totalMemGB.toFixed(0)}GB → ${byMem})` : "") +
    (budget
      ? live < structural
        ? `, ridotto a ${live}: gli agent tengono ${fleet!.coreUnits.toFixed(1)} core sui ${budget.budgetCores.toFixed(0)} di quota`
        : `; gli agent tengono ${fleet!.coreUnits.toFixed(1)} core sui ${budget.budgetCores.toFixed(0)} di quota (il resto del carico non è nostro)`
      : live < structural
        ? `, ridotto per carico (load ${load1.toFixed(1)})`
        : "");
  return {
    recommended,
    cores,
    totalMemGB: Math.round(totalMemGB * 10) / 10,
    load1: Math.round(load1 * 100) / 100,
    oursCores: fleet ? Math.round(fleet.coreUnits * 10) / 10 : null,
    budgetCores: Math.round(cores * FLEET_CPU_SHARE * 10) / 10,
    reason,
    running,
  };
}

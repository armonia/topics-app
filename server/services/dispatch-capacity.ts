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
import { fleetLoadSync } from "../lib/fleet-usage";
import { machineCores } from "../lib/machine-cores";

// La forma sta in `shared/board.ts` (la legge la UI delle impostazioni board).
export type { DispatchCapacity } from "../../shared/board";
import type { DispatchCapacity, GlobalDispatchCap, GlobalDispatchCapExtras } from "../../shared/board";
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
export function readGlobalCap(db: Database): GlobalDispatchCap {
  type Row = {
    max_agents?: number | null;
    max_agents_auto?: number | null;
    max_agents_mode?: string | null;
    max_load_ratio?: number | null;
    max_mem_ratio?: number | null;
  };
  let r: Row | undefined;
  try {
    r = db
      .prepare(
        "SELECT max_agents, max_agents_auto, max_agents_mode, max_load_ratio, max_mem_ratio FROM board_settings WHERE project_id = ?",
      )
      .get(GLOBAL_SETTINGS_KEY) as Row | undefined;
  } catch {
    // The three "by resources" columns are absent (a db older than their
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
  // The mode and the two thresholds travel only when the row SAYS them: this
  // function returns the cap "as written", and the contract in
  // `shared/board.ts` reads an absent field as "count, default threshold"
  // (`capMode`, `capThresholds`). Filling the defaults here would be a second
  // copy of them, and the value a caller uses must come from one reader.
  const extras: GlobalDispatchCapExtras = {};
  if (r?.max_agents_mode === "resources") extras.mode = "resources";
  if (typeof r?.max_load_ratio === "number" && Number.isFinite(r.max_load_ratio)) extras.maxLoadRatio = r.max_load_ratio;
  if (typeof r?.max_mem_ratio === "number" && Number.isFinite(r.max_mem_ratio)) extras.maxMemRatio = r.max_mem_ratio;
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
 */
export const DISPATCH_MEM_FLOOR_NATIVE_GB = 2;

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
 * PERCHÉ CONTA. Il pavimento (`dispatchResourceBlock`) sa già distinguere i due
 * runtime; il TETTO no, e si vedeva: quattro task nativi su questa macchina
 * partivano a scaglioni di due perché `byMem` prenotava 3 GB a testa per
 * sessioni che ne chiedono due di megabyte.
 */
export const GB_PER_AGENT_CLI = 3;
export const GB_PER_AGENT_NATIVE = 0.25;

/**
 * Memoria REALMENTE disponibile (libera + inattiva reclamabile), in GB.
 * `null` quando non si riesce a misurare, con la stessa regola del disco: «non
 * lo so» non è «zero», o un errore di lettura fermerebbe la coda per sempre.
 *
 * `vm_stat` e non `os.freemem()`: su macOS la seconda riporta quasi nulla di
 * libero perché il kernel tiene le pagine reclamabili come cache, e userebbe
 * questo pavimento per bloccare il dispatch su un Mac da 32 GB in perfetta
 * salute. È lo stesso motivo per cui il commento in testa a questo file dice
 * che `os.freemem()` va ignorata.
 *
 * Fuori da macOS la sonda non c'è e la risposta è `null`: su Linux le stesse
 * pagine si leggono da `/proc/meminfo` con nomi diversi, e inventare una
 * conversione non verificata sarebbe peggio che dire «non lo so» — con `null`
 * il pavimento si limita a non mordere, che è il verso giusto in cui sbagliare.
 */
export function availableMemGB(
  run: () => string | null = () => {
    try {
      if (process.platform !== "darwin") return null;
      return spawnSync("vm_stat", { encoding: "utf8", timeout: 2000 }).stdout ?? null;
    } catch {
      return null;
    }
  },
): number | null {
  const out = run();
  if (!out) return null;
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 0);
  const pages = (nome: string): number =>
    Number(out.match(new RegExp(`Pages ${nome}:\\s+(\\d+)`))?.[1] ?? NaN);
  const free = pages("free");
  const speculative = pages("speculative");
  const inactive = pages("inactive");
  // Una sola delle tre illeggibile e il totale sarebbe una sottostima
  // silenziosa, cioè un pavimento che morde quando non deve: meglio «non lo so».
  if (!pageSize || !Number.isFinite(free) || !Number.isFinite(speculative) || !Number.isFinite(inactive)) return null;
  return ((free + speculative + inactive) * pageSize) / 1e9;
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
 * Perché NON si può ammettere un altro agente adesso, o `null` se si può.
 * La frase finisce sulla card, quindi dice il numero: «non c'è posto» senza il
 * dato è esattamente la coda invisibile che il chip `queued` esiste per evitare.
 *
 * DUE PAVIMENTI, disco e memoria, e si guardano in quest'ordine perché un disco
 * pieno rompe (le scritture SQLite falliscono, e il guasto non si riassorbe
 * quando il carico cala) mentre la RAM finita degrada. Il primo che morde
 * scrive la frase: due frasi insieme su una card sono rumore, e la seconda si
 * legge appena la prima è rientrata.
 */
export function dispatchResourceBlock(
  worktreesPath: string,
  /** La misura, iniettabile: il caso che conta è «disco quasi pieno», e senza
   *  questa cucitura si potrebbe provare solo riempiendo il disco per davvero —
   *  cioè non si proverebbe, e la frase che finisce sulla card non l'avrebbe mai
   *  letta nessuno prima di un incidente. */
  readFreeGB: (p: string) => number | null = freeDiskGB,
  /** Idem per la memoria: il caso che conta è «RAM quasi finita», e provarlo
   *  per davvero vorrebbe dire mandare in swap la macchina di chi sviluppa. */
  readAvailMemGB: () => number | null = availableMemGB,
  /**
   * Gli agenti di questa macchina sono PROCESSI o no?
   *
   * È la domanda che decide il pavimento, e prima non veniva fatta: si teneva
   * il margine di cinque CLI anche quando gli agenti costano 2,3 MB l'uno. Il
   * chiamante lo sa (legge `agent_runtime`), qui si riceve e basta — questo
   * file misura la macchina, non decide le politiche.
   */
  agentsAreProcesses = true,
): string | null {
  const free = readFreeGB(worktreesPath);
  if (free != null && free < DISPATCH_DISK_FLOOR_GB) {
    return `Disco quasi pieno: ${free.toFixed(1)} GB liberi, sotto il pavimento di ${DISPATCH_DISK_FLOOR_GB} GB. ` +
      `Ogni agente apre una worktree (~0,9 GB), e un disco pieno fa fallire le scritture del DB. ` +
      `Riprendo appena si libera spazio: niente è andato perso.`;
  }
  const mem = (() => { try { return readAvailMemGB(); } catch { return null; } })();
  const floor = agentsAreProcesses ? DISPATCH_MEM_FLOOR_GB : DISPATCH_MEM_FLOOR_NATIVE_GB;
  if (memoryTooTight(mem, floor)) {
    const costo = agentsAreProcesses
      ? "Ogni agente costa ~240 MB fermo e fino a 420 MB al lavoro"
      : "Anche col runtime nativo (~2,3 MB per sessione) qui non c'è margine nemmeno per il server";
    return `Memoria quasi finita: ${mem!.toFixed(1)} GB disponibili, sotto il pavimento di ${floor} GB. ` +
      `${costo}, e sotto questa riga la macchina va in swap. ` +
      `Riprendo appena si libera memoria: niente è andato perso.`;
  }
  return null;
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
 * @param readAvailMemGB the memory probe (`availableMemGB`), injectable for the
 *   same reason. It does not enter `recommended`: it travels so the "by
 *   resources" mode and the settings panel read the machine's memory from the
 *   same reading as its load, instead of each spawning their own `vm_stat`.
 */
export function computeDispatchCapacity(
  running = 0,
  probe: () => { coreUnits: number; cores: number } | null = fleetLoadSync,
  agentsAreProcesses = true,
  readAvailMemGB: () => number | null = availableMemGB,
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
    availableMemGB: availMemGB != null && Number.isFinite(availMemGB) ? Math.round(availMemGB * 10) / 10 : null,
    reason,
    running,
  };
}

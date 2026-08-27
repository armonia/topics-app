// La QUOTA DI CORE di un agente dispatchato: quanti job paralleli può prendersi
// la sua toolchain (`CARGO_BUILD_JOBS`, `MAKEFLAGS=-jN`) quando compila.
//
// PERCHÉ ESISTE — è una CINTURA, non lo scheduler.
// Lo scheduler ha già una leva sul peso (migration 090): un task classificato
// `heavy` si prende la macchina da solo, perché un claim pesante blocca gli
// altri. Ma quella leva dipende da una risposta del classificatore, e la
// risposta può mancare o essere sbagliata — un task «rinomina una variabile»
// che tocca una riga di Rust ricompila mezzo albero delle dipendenze, e per il
// gate era leggero. Da lì in poi `cargo` fa quello che fa di default: prende
// TUTTI i core logici. Quattro agenti «leggeri» così e la macchina non è più
// di nessuno, umano compreso.
//
// La cintura recinta il caso che il gate non ha visto: ogni agente dispatchato
// parte con una quota pari alla SUA FETTA della macchina — i core divisi per
// quanti agenti stanno lavorando ADESSO, questo compreso (e per il tetto di
// concorrenza quando quel conteggio non si sa fare). Se sono in quattro, ognuno
// ne ha tre su dodici e la somma torna: la macchina resta prenotabile anche
// quando tutti e quattro compilano insieme. Se resta solo lui, se la riprende.
//
// L'ASIMMETRIA che la rende una cintura e non un secondo scheduler: il peso può
// solo ALLARGARE la quota, mai stringerla. Senza risposta (colonna NULL = come
// si legge un `light`) si prende il recinto stretto; solo un `heavy` esplicito
// la allarga, e lo fa perché in quel caso è lo scheduler stesso a garantire che
// non ci sia nessun altro claim accanto. Un classificatore che smette di
// rispondere fa restringere, non allargare: sbagliare verso il recinto è il
// verso giusto.
//
// UN CORE RESTA SEMPRE FUORI. Anche l'agente che è solo sulla macchina si ferma
// a `cores - 1`: quel core è del server di Topics, della UI e di chi sta
// guardando. Una build a dodici vie su dodici core non è più veloce in modo
// misurabile, ma rende la finestra a scatti — ed è esattamente il momento in
// cui l'umano vorrebbe leggere cosa sta facendo l'agente.
//
// DOVE NON VA: non in `buildSafeEnv()`. Quello è l'ambiente di OGNI sessione,
// comprese le chat interattive dell'umano — recintare quelle vorrebbe dire
// dimezzare la build che uno lancia a mano, senza che l'abbia chiesto nessuno.
// La quota viaggia sul canale per-topic dello spawn, accanto a effort, modello
// e policy MCP (vedi `getTopicSpawnOverridesForSession` in
// providers/claude-code.ts): si applica se e solo se quel topic è la chat di un
// task dispatchato.

// IL NUMERO SI RILEGGE A METÀ SESSIONE, e non è un lusso.
//
// Le due variabili qui sotto sono l'ambiente di un processo, e l'ambiente di un
// processo si scrive una volta sola: quando l'agente nasce. Una sessione però
// vive ore, e in quelle ore la macchina cambia sotto di lei — gli altri tre
// agenti finiscono, l'umano alza il tetto in Impostazioni, un fan-out ne fa
// nascere altri due. Il recinto congelato allo spawn è quindi giusto per un
// istante e sbagliato per tutto il resto, in tutte e due le direzioni: largo
// quando la macchina si riempie, stretto quando si svuota.
//
// E il verso sbagliato costa davvero, perché IL PREZZO DEL RECINTO NON È ZERO:
// `scripts/measure-job-quota.sh` misura la stessa build recintata e libera, e la
// differenza è il conto che paga un agente che sta compilando DA SOLO su dodici
// core con la fetta di quando erano in quattro.
//
// Da qui il CANALE VIVO (`quotaChannelDir`): un file con dentro un numero, uno
// per topic, riscritto dal polling del dispatcher (server.ts, ogni 10s), e due
// shim di `cargo`/`make` in testa al PATH che quel file lo leggono AL MOMENTO
// DELL'INVOCAZIONE. L'ambiente congelato resta, e resta apposta: è il ripiego di
// chiunque scavalchi gli shim (un PATH riscritto da un profilo, un `make`
// risolto prima del nostro). Sbagliare verso il recinto di prima è il verso
// giusto in cui sbagliare.

import os from "node:os";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Database } from "bun:sqlite";
import { readTaskWeight, type TaskWeight } from "../../shared/board";
import { readGlobalCap, sizingDispatchCap, structuralDispatchCapacity } from "./dispatch-capacity";
import { resolveAgentRuntime } from "./app-settings";

/** Cosa sa lo spawn del topic che sta per far partire. */
export type DispatchBinding = {
  /** Il topic è la chat di un task dispatchato (o di un suo tentativo di fan-out). */
  dispatched: boolean;
  /** Il peso letto sul task. `null` = mai classificato, che vale `light`. */
  weight: TaskWeight | null;
};

/**
 * Quanti job paralleli spettano a questo agente.
 *
 * `cores` sono i core logici, `cap` il tetto di concorrenza EFFETTIVO (quanti
 * agenti la board ammette insieme), `weight` il peso letto sul task, `peers`
 * quanti agenti dispatchati hanno un turno VIVO adesso — questo compreso.
 * Il risultato è sempre ≥ 1: una quota di zero job non è un recinto, è una
 * toolchain che non parte.
 *
 * IL DIVISORE È `peers` QUANDO SI SA CONTARLO, il tetto quando no. Sono due
 * risposte alla stessa domanda — «quanti girano ACCANTO a me» — e il tetto è la
 * risposta pessimista: dice quanti POTREBBERO essercene, non quanti ce ne sono.
 * Su un tetto di 4 con un agente solo, la differenza è tre quarti di macchina
 * lasciati fermi per compagni che non esistono.
 *
 * Il verso è quello sicuro, ed è la ragione per cui `peers` si può usare mentre
 * la raccomandazione viva del dispatcher no (vedi `structuralDispatchCapacity`):
 * più agenti → divisore più GRANDE → fetta più stretta. Una grandezza che sale
 * quando la macchina si affolla stringe il recinto; la raccomandazione, che
 * SCENDE sotto carico, lo apriva. Una lettura fallita (`null`) ricade sul tetto,
 * che è il comportamento di prima.
 */
export function computeJobQuota(input: {
  cores: number;
  cap: number;
  weight: TaskWeight | null;
  peers?: number | null;
}): number {
  const cores = Math.max(1, Math.floor(input.cores) || 1);
  const cap = Math.max(1, Math.floor(input.cap) || 1);
  const peers = input.peers == null ? null : Math.floor(input.peers);
  // Il caso «da solo»: tutto tranne il core che resta all'umano.
  const solo = Math.max(1, cores - 1);
  // Un pesante è solo per costruzione (un claim pesante blocca gli altri), e un
  // tetto di 1 dice la stessa cosa in un altro modo — entrambi i casi finiscono
  // qui, e la fetta non può comunque superare il caso «da solo».
  if (input.weight === "heavy") return solo;
  // Un conteggio di zero agenti vivi mentre uno di essi chiede la sua quota è
  // una lettura che si contraddice: non si dà la macchina intera a chi non
  // risulta esistere, si torna al tetto.
  const divisore = peers != null && peers >= 1 ? peers : cap;
  return Math.max(1, Math.min(Math.floor(cores / divisore), solo));
}

/**
 * Le variabili che portano la quota nella toolchain del figlio.
 *
 * Due, perché sono due mondi diversi che nessuna delle due copre da sola:
 * `CARGO_BUILD_JOBS` è cargo (che altrimenti legge `num_cpus`), `MAKEFLAGS=-jN`
 * è make e chiunque lo invochi (build.rs di mezzo mondo C, `cc-rs`, cmake via
 * make). Un flag `-j` scritto a mano dentro un Makefile vince ancora: la quota
 * è un default sano, non una gabbia.
 */
export function jobQuotaEnv(jobs: number): Record<string, string> {
  const n = Math.max(1, Math.floor(jobs) || 1);
  return { CARGO_BUILD_JOBS: String(n), MAKEFLAGS: `-j${n}` };
}

/**
 * Il topic è la chat di un task dispatchato? E con che peso?
 *
 * Due legature possibili, ed è dispatchato in entrambi i casi:
 *  - `tasks.assigned_topic_id` — il caso normale, uno-a-uno;
 *  - `task_attempts.topic_id` — i tentativi di un fan-out, di cui solo il primo
 *    tiene anche `assigned_topic_id` (vedi migration 065): guardare solo la
 *    prima colonna lascerebbe i tentativi 2..N fuori dal recinto, cioè proprio
 *    gli N agenti che compilano lo STESSO progetto nello stesso momento.
 *
 * Entrambe le legature esistono PRIMA del turno (`bindTopic` e `store.bind`
 * girano prima di `runTurn`), quindi sono già in tabella quando lo spawn le
 * chiede.
 *
 * La LEGATURA e il PESO si leggono SEPARATI, e non è pulizia: sono due domande
 * con due risposte di ripiego OPPOSTE. `dispatch_weight` è NULL anche per un
 * task dispatchato che nessuno ha ancora classificato, quindi una sola colonna
 * coalescata renderebbe «chat umana» e «task mai classificato» indistinguibili
 * — e sono i due casi che qui decidono in verso contrario (nessun recinto /
 * recinto stretto).
 *
 * Soprattutto: una lettura sola le legherebbe anche nel GUASTO. Misurato l'11/08
 * su una copia del DB vivo, dove la colonna del peso non c'era ancora (migration
 * 090 non applicata da quel processo): la query unica falliva per intero e ogni
 * agente usciva «non dispatchato», cioè zero recinto proprio sulla macchina che
 * lo stava chiedendo. Ora la colonna che manca costa solo l'ALLARGAMENTO —
 * si resta sulla fetta stretta, che è il verso giusto in cui sbagliare.
 */
export function readDispatchBinding(db: Database, sessionKey: string): DispatchBinding {
  const spento: DispatchBinding = { dispatched: false, weight: null };
  if (!sessionKey) return spento;

  const topicId = interroga<{ id?: string }>(db, "SELECT id FROM topics WHERE session_key = ? LIMIT 1", sessionKey)?.id;
  if (!topicId) return spento;

  // Il caso normale, uno-a-uno. Poi i tentativi di fan-out, di cui solo il primo
  // tiene anche `assigned_topic_id`.
  return (
    legatura(db, "tasks k", "k.assigned_topic_id = ?", topicId)
    ?? legatura(db, "task_attempts a JOIN tasks k ON k.id = a.task_id", "a.topic_id = ?", topicId)
    ?? spento
  );
}

/** Una lettura che non può travolgere lo spawn: schema parziale o DB non pronto ⇒ `null`. */
function interroga<T>(db: Database, sql: string, ...parametri: unknown[]): T | null {
  try {
    return (db.prepare(sql).get(...(parametri as never[])) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Come `interroga`, per le liste: uno schema parziale vale una lista vuota. */
function tutte<T>(db: Database, sql: string, ...parametri: unknown[]): T[] {
  try {
    return (db.prepare(sql).all(...(parametri as never[])) as T[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/**
 * Il topic è legato a un task per questa via? E con che peso?
 *
 * Due tentativi apposta: prima chiedendo anche il peso, poi la sola esistenza.
 * Se il primo cade perché `dispatch_weight` non c'è (DB non ancora migrato), il
 * secondo tiene in piedi la LEGATURA — l'agente resta recintato, semplicemente
 * senza la parola che avrebbe potuto allargargli il recinto.
 */
function legatura(db: Database, da: string, dove: string, topicId: string): DispatchBinding | null {
  const conPeso = interroga<{ peso?: string | null }>(db, `SELECT k.dispatch_weight AS peso FROM ${da} WHERE ${dove} LIMIT 1`, topicId);
  if (conPeso) return { dispatched: true, weight: readTaskWeight(conPeso.peso) };
  const withoutWeight = interroga<{ uno?: number }>(db, `SELECT 1 AS uno FROM ${da} WHERE ${dove} LIMIT 1`, topicId);
  return withoutWeight ? { dispatched: true, weight: null } : null;
}

/**
 * Il tetto di concorrenza EFFETTIVO, cioè quanti agenti la board ammette
 * insieme. È il ripiego del divisore quando il roster non si sa contare.
 *
 * IL DIVISORE NON È MAI LA RACCOMANDAZIONE VIVA. In `auto` la raccomandazione è
 * apposta reattiva al carico — si tira indietro quando la macchina è occupata —
 * e come divisore si invertiva: load alto → raccomandazione 1 → «sono solo» →
 * fetta intera. Misurato su questo host in `auto` con load 45: usciva `-j11`,
 * cioè nessun recinto proprio dove serviva. `structuralDispatchCapacity()`
 * risponde alla domanda giusta («quanti ne regge questa macchina in regime»), e
 * un tetto FISSO resta la parola dell'umano.
 */
function capOfConcurrency(db: Database): number {
  try {
    // `sizingDispatchCap`, non `effectiveDispatchCap`: la seconda risponde
    // «ne ammetto un altro?» e con il tetto disattivato dice Infinity, che come
    // divisore darebbe a ogni agente una fetta di zero. Questa risponde alla
    // domanda del divisore, e senza tetto ricade sul numero STRUTTURALE.
    return sizingDispatchCap(readGlobalCap(db), structuralDispatchCapacity(resolveAgentRuntime() === "cli"));
  } catch {
    return 3; // impostazioni illeggibili: il default della board
  }
}

/** I due predicati che la board usa per dire «questo task ha un agente vivo». */
const TASK_VIVO = "k.status = 'in_progress' AND k.dispatch_state IN ('starting','working') AND k.archived = 0";

/**
 * Quanti agenti dispatchati stanno lavorando ADESSO, questo compreso.
 * `null` = non misurabile (schema parziale, DB non pronto): il chiamante ricade
 * sul tetto, che è il numero di prima.
 *
 * Si conta per AGENTE, non per card, e la differenza è il fan-out: N tentativi
 * dello stesso task sono N processi che compilano lo STESSO progetto nello
 * stesso momento, ma una riga sola in `tasks`. Contare le righe li vedrebbe come
 * uno e allargherebbe la fetta di tutti proprio nel caso peggiore.
 *
 * Se `task_attempts` non si legge si torna al conteggio delle card: è un
 * SOTTOconteggio, quindi un recinto più largo — l'unico verso sbagliato che
 * questa funzione può prendere, e lo prende solo su un host già degradato.
 */
export function countLiveDispatchedAgents(db: Database): number | null {
  const card = interroga<{ c?: number }>(db, `SELECT COUNT(*) AS c FROM tasks k WHERE ${TASK_VIVO}`);
  if (!card) return null;
  const base = Math.max(0, Math.floor(card.c ?? 0));
  // I tentativi vivi rimpiazzano la card che li ha generati: +N, −1 per ogni
  // card che ne ha almeno uno.
  const fanOut = interroga<{ vivi?: number; card?: number }>(
    db,
    `SELECT COUNT(*) AS vivi, COUNT(DISTINCT k.id) AS card
       FROM task_attempts a JOIN tasks k ON k.id = a.task_id
      WHERE ${TASK_VIVO} AND a.state = 'running' AND a.topic_id IS NOT NULL`,
  );
  if (!fanOut) return base;
  return Math.max(0, base - Math.floor(fanOut.card ?? 0) + Math.floor(fanOut.vivi ?? 0));
}

/** Le chat degli agenti vivi: a chi va riscritto il numero a ogni giro. */
export function liveDispatchedSessions(db: Database): Array<{ sessionKey: string; weight: TaskWeight | null }> {
  const righe = [
    ...tutte<{ k?: string; w?: string | null }>(
      db,
      `SELECT t.session_key AS k, k.dispatch_weight AS w
         FROM tasks k JOIN topics t ON t.id = k.assigned_topic_id WHERE ${TASK_VIVO}`,
    ),
    ...tutte<{ k?: string; w?: string | null }>(
      db,
      `SELECT t.session_key AS k, k.dispatch_weight AS w
         FROM task_attempts a JOIN tasks k ON k.id = a.task_id JOIN topics t ON t.id = a.topic_id
        WHERE ${TASK_VIVO} AND a.state = 'running'`,
    ),
  ];
  const perKey = new Map<string, TaskWeight | null>();
  for (const r of righe) if (r.k) perKey.set(r.k, readTaskWeight(r.w));
  return [...perKey].map(([sessionKey, weight]) => ({ sessionKey, weight }));
}

/**
 * La quota di QUESTO agente, adesso. `null` se il topic non è la chat di un
 * task dispatchato (chat umana → niente recinto).
 */
function liveJobQuota(db: Database, sessionKey: string): number | null {
  const binding = readDispatchBinding(db, sessionKey);
  if (!binding.dispatched) return null;
  return computeJobQuota({
    cores: Math.max(1, os.cpus().length),
    cap: capOfConcurrency(db),
    weight: binding.weight,
    peers: countLiveDispatchedAgents(db),
  });
}

/**
 * L'ambiente da fondere in quello dello spawn, o `null` se questo topic non è
 * un agente dispatchato (chat umana → niente recinto, niente da fondere).
 *
 * Il numero si RILEGGE a ogni spawn, come effort e modello — e, dallo spawn in
 * poi, anche a ogni giro del dispatcher attraverso il canale vivo.
 */
export function resolveJobQuotaEnv(db: Database, sessionKey: string): Record<string, string> | null {
  const jobs = liveJobQuota(db, sessionKey);
  return jobs == null ? null : jobQuotaEnv(jobs);
}

// ============ Il canale VIVO ============

/** Un solo file per topic, e il PATH che ci porta. Sovrascrivibile per i test. */
function rootChannel(): string {
  return process.env.TOPICS_JOB_QUOTA_DIR || join(os.homedir(), ".topics", "job-quota");
}

/** La cartella del canale vivo di un topic: dentro, `jobs` e `bin/`. */
export function quotaChannelDir(sessionKey: string): string {
  const slug = sessionKey.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "senza-nome";
  return join(rootChannel(), slug);
}

/**
 * Scrive il numero che gli shim leggeranno. Rinomina invece di sovrascrivere:
 * un `cargo` che parte a metà scrittura leggerebbe un file troncato, e un
 * numero a metà è peggio di nessun numero.
 */
export function writeLiveQuota(sessionKey: string, jobs: number): boolean {
  const n = Math.max(1, Math.floor(jobs) || 1);
  try {
    const dir = quotaChannelDir(sessionKey);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `jobs.${process.pid}.tmp`);
    writeFileSync(tmp, `${n}\n`);
    renameSync(tmp, join(dir, "jobs"));
    return true;
  } catch {
    return false;
  }
}

/** Il numero letto dagli shim, per i test e per chi vuole verificare a mano. */
export function readLiveQuota(sessionKey: string): number | null {
  try {
    const testo = readFileSync(join(quotaChannelDir(sessionKey), "jobs"), "utf8");
    const n = Number(String(testo).trim());
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

/** I due comandi che prendono tutti i core di default se nessuno glielo impedisce. */
const COMANDI_RECINTATI = ["cargo", "make"] as const;

/**
 * I posti dove una toolchain vive anche quando il PATH del server non la
 * nomina, e va cercata lo stesso.
 *
 * Non è una comodità: il PATH del processo che fa lo spawn è quello di un
 * daemon (launchd, `bun run server.ts`), non quello di una shell di login.
 * Misurato su questo host: il server ha `~/.bun/bin`, homebrew e `/usr/bin`, e
 * NON ha `~/.cargo/bin` — cercando solo lì, `cargo` non si trovava e l'unico
 * comando che il recinto esiste per fermare restava senza shim. La shell
 * dell'agente invece ce l'ha, perché ce la mette il suo profilo.
 */
const POSTI_DI_TOOLCHAIN = ["/.cargo/bin", "/.local/bin"];

/** Dove sta davvero questo comando, ignorando la cartella degli shim. */
function binarioReale(nome: string, path: string, cartellaShim: string): string | null {
  const casa = os.homedir();
  const dove = [
    ...path.split(delimiter),
    ...POSTI_DI_TOOLCHAIN.map((p) => `${casa}${p}`),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const dir of dove) {
    if (!dir || dir === cartellaShim) continue;
    const candidato = join(dir, nome);
    try {
      accessSync(candidato, constants.X_OK);
      return candidato;
    } catch { /* non qui */ }
  }
  return null;
}

/** Un percorso dentro uno script `sh`, con gli apici che ci vogliono. */
function apici(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Lo shim: legge il numero AL MOMENTO DELL'INVOCAZIONE e passa il testimone al
 * binario vero. Non tocca gli argomenti — passa per le stesse variabili
 * d'ambiente dello spawn, quindi un `cargo build -j8` scritto a mano continua a
 * vincere e i sottocomandi non gli passano nemmeno davanti.
 *
 * Un file assente, vuoto o non numerico NON è un errore: si esegue il binario e
 * vale l'ambiente congelato allo spawn, cioè il recinto di prima.
 */
export function quotaShimScript(fileJobs: string, reale: string): string {
  return [
    "#!/bin/sh",
    "# Topics: quota di core VIVA per un agente dispatchato.",
    "# Il numero sta in un file perché l'ambiente di un processo si scrive una",
    "# volta sola, allo spawn, e una sessione vive più a lungo della macchina",
    "# che aveva intorno quando è nata. Vedi server/services/agent-job-quota.ts.",
    `j=$(cat ${apici(fileJobs)} 2>/dev/null)`,
    "case \"$j\" in",
    `  ''|*[!0-9]*) exec ${apici(reale)} "$@" ;;`,
    "esac",
    `[ "$j" -ge 1 ] 2>/dev/null || exec ${apici(reale)} "$@"`,
    `CARGO_BUILD_JOBS="$j" MAKEFLAGS="-j$j" exec ${apici(reale)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Installa gli shim e restituisce il PATH da dare al figlio.
 *
 * DUE MOSSE, e la seconda sembra inutile finché non la si misura. La prima è
 * ovvia: la cartella degli shim va in TESTA. La seconda è che quella testa non
 * sopravvive da sola — la CLI fotografa il PATH facendo girare il profilo
 * dell'utente, e `~/.cargo/env` fa `case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;;
 * *) export PATH="$HOME/.cargo/bin:$PATH"` : se quella cartella NON è già nel
 * PATH se la mette davanti a tutti, shim compresi. Misurato su questo host:
 * `.cargo/bin` in posizione 12 e lo shim in 13, cioè shim mai eseguito.
 * Rimettendo `.cargo/bin` in CODA al PATH del figlio la guardia di idempotenza
 * la trova già presente, non la ripropone, e lo shim resta davanti.
 */
export function installQuotaShims(
  sessionKey: string,
  basePath: string,
): { path: string; installed: string[] } | null {
  const dir = quotaChannelDir(sessionKey);
  const binDir = join(dir, "bin");
  const fileJobs = join(dir, "jobs");
  try {
    mkdirSync(binDir, { recursive: true });
  } catch {
    return null;
  }
  const installed: string[] = [];
  const codaDaTenere: string[] = [];
  for (const nome of COMANDI_RECINTATI) {
    const reale = binarioReale(nome, basePath, binDir);
    if (!reale) continue; // toolchain non installata: niente da recintare
    try {
      writeFileSync(join(binDir, nome), quotaShimScript(fileJobs, reale), { mode: 0o755 });
      installed.push(nome);
      const suaDir = reale.slice(0, reale.lastIndexOf("/")) || "/";
      if (!codaDaTenere.includes(suaDir)) codaDaTenere.push(suaDir);
    } catch { /* uno shim in meno: resta l'ambiente congelato */ }
  }
  if (!installed.length) return null;
  const pezzi = basePath ? basePath.split(delimiter).filter(Boolean) : [];
  for (const d of codaDaTenere) if (!pezzi.includes(d)) pezzi.push(d);
  return { path: [binDir, ...pezzi.filter((d) => d !== binDir)].join(delimiter), installed };
}

/**
 * Tutto quello che la quota fa all'ambiente di uno spawn: le due variabili (il
 * ripiego congelato), il numero sul canale vivo e gli shim in testa al PATH.
 * Torna il numero applicato, o `null` per una chat che non è un agente
 * dispatchato — nel qual caso `env` resta byte per byte quello di prima.
 */
export function applyJobQuota(db: Database, sessionKey: string, env: Record<string, string>): number | null {
  const congelato = resolveJobQuotaEnv(db, sessionKey);
  if (!congelato) return null;
  Object.assign(env, congelato);
  const jobs = Number(congelato.CARGO_BUILD_JOBS);
  writeLiveQuota(sessionKey, jobs);
  const shim = installQuotaShims(sessionKey, env.PATH || process.env.PATH || "");
  if (shim) env.PATH = shim.path;
  return jobs;
}

/**
 * LA RILETTURA A METÀ SESSIONE: riscrive il numero di ogni agente vivo con il
 * roster di adesso. La chiama il polling del dispatcher (server.ts, ogni 10s),
 * cioè lo stesso giro che fa nascere e morire gli agenti — l'unico momento in
 * cui il denominatore può essere cambiato.
 *
 * Un solo conteggio per giro, condiviso da tutti: se ogni agente contasse per
 * sé, due letture a cavallo di uno spawn darebbero due divisori diversi e la
 * somma delle fette non tornerebbe più alla macchina.
 *
 * Torna quanti file ha aggiornato.
 */
export function refreshLiveJobQuotas(db: Database): number {
  let vive: Array<{ sessionKey: string; weight: TaskWeight | null }> = [];
  try { vive = liveDispatchedSessions(db); } catch { return 0; }
  if (!vive.length) return 0;
  const peers = countLiveDispatchedAgents(db);
  const cap = capOfConcurrency(db);
  const cores = Math.max(1, os.cpus().length);
  let scritti = 0;
  for (const a of vive) {
    if (writeLiveQuota(a.sessionKey, computeJobQuota({ cores, cap, weight: a.weight, peers }))) scritti++;
  }
  return scritti;
}

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
// parte con una quota pari alla SUA FETTA della macchina — i core divisi per il
// tetto di concorrenza, cioè per quanti agenti quel tetto ammette accanto a lui.
// Se sono in quattro, ognuno ne ha tre su dodici e la somma torna: la macchina
// resta prenotabile anche quando tutti e quattro compilano insieme.
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

import os from "node:os";
import type { Database } from "bun:sqlite";
import { readTaskWeight, type TaskWeight } from "../../shared/board";
import { effectiveDispatchCap, readGlobalCap, structuralDispatchCapacity } from "./dispatch-capacity";

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
 * agenti la board ammette insieme), `weight` il peso letto sul task.
 * Il risultato è sempre ≥ 1: una quota di zero job non è un recinto, è una
 * toolchain che non parte.
 */
export function computeJobQuota(input: { cores: number; cap: number; weight: TaskWeight | null }): number {
  const cores = Math.max(1, Math.floor(input.cores) || 1);
  const cap = Math.max(1, Math.floor(input.cap) || 1);
  // Il caso «da solo»: tutto tranne il core che resta all'umano.
  const solo = Math.max(1, cores - 1);
  // Un pesante è solo per costruzione (un claim pesante blocca gli altri), e un
  // tetto di 1 dice la stessa cosa in un altro modo — entrambi i casi finiscono
  // qui, e la fetta non può comunque superare il caso «da solo».
  if (input.weight === "heavy") return solo;
  return Math.max(1, Math.min(Math.floor(cores / cap), solo));
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
  const senzaPeso = interroga<{ uno?: number }>(db, `SELECT 1 AS uno FROM ${da} WHERE ${dove} LIMIT 1`, topicId);
  return senzaPeso ? { dispatched: true, weight: null } : null;
}

/**
 * L'ambiente da fondere in quello dello spawn, o `null` se questo topic non è
 * un agente dispatchato (chat umana → niente recinto, niente da fondere).
 *
 * Il tetto si RILEGGE a ogni spawn, come effort e modello: alzare "Agent in
 * parallelo" nelle impostazioni stringe la quota dalla sessione dopo, senza
 * riavviare niente.
 *
 * IL DIVISORE È IL TETTO STRUTTURALE, non la raccomandazione viva. In `auto` la
 * raccomandazione è apposta reattiva al carico — si tira indietro quando la
 * macchina è occupata — e come divisore si invertiva: load alto →
 * raccomandazione 1 → «sono solo» → fetta intera. Misurato su questo host in
 * `auto` con load 45: usciva `-j11`, cioè nessun recinto proprio dove serviva.
 * `structuralDispatchCapacity()` risponde alla domanda giusta («quanti ne regge
 * questa macchina in regime»), e un tetto FISSO resta la parola dell'umano.
 */
export function resolveJobQuotaEnv(db: Database, sessionKey: string): Record<string, string> | null {
  const binding = readDispatchBinding(db, sessionKey);
  if (!binding.dispatched) return null;
  let cap = 3;
  try {
    const globale = readGlobalCap(db);
    cap = effectiveDispatchCap(globale, globale.auto ? structuralDispatchCapacity() : null);
  } catch { /* impostazioni illeggibili: si resta sul default della board */ }
  const cores = Math.max(1, os.cpus().length);
  return jobQuotaEnv(computeJobQuota({ cores, cap, weight: binding.weight }));
}

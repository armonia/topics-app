/**
 * Il ritiro: un fatto solo, e i tre registri come viste su quello.
 *
 * PERCHE' ESISTE. «Aperto» era scritto in tre posti che non si parlano — il
 * pane store (`ui_state/pane-store-v2`, dentro un blob JSON), le righe di
 * `terminal_sessions`, e il booleano `topics.archived`. Nessuno dei tre e'
 * interrogabile insieme agli altri, quindi «cosa e' aperto?» costava tre query
 * e dava tre risposte. Misurato il 03/08: 11 sessioni vive per tab chiuse a
 * luglio, 2 topic «aperti» chiusi da settimane. Vedi `migrations/089`.
 *
 * IL FATTO. La tabella `retirements`: una riga per cosa ritirata, con la data.
 * Questo modulo e' l'UNICO posto che la scrive. Non perche' sia elegante, ma
 * perche' un fatto con due scrittori e' di nuovo due registri.
 *
 * LA REGOLA (Attilio, 03/08). Chiudere una tab E' il ritiro di cio' che
 * contiene: la chat si archivia, la sessione si ritira. Niente terzo stato
 * «chiusa ma non archiviata». Quindi il ritiro di una PANE cascata sul suo
 * contenuto — ed e' `paneCascade` a dire su cosa, non chi chiama.
 *
 * PRIMA SCRITTURA VINCE. Ri-ritirare qualcosa di gia' ritirato non sposta la
 * data: `retired_at` risponde a «quando e' stato chiuso», e una seconda
 * chiusura (l'eco di un altro dispositivo, un riconcilio al boot) non e' un
 * evento nuovo. E' anche cio' che rende la cascata IDEMPOTENTE: la riga stessa
 * e' la guardia «questa pane l'ho gia' processata», quindi un PUT ripetuto del
 * medesimo snapshot non ri-uccide niente.
 *
 * IL RIENTRO E' ESPLICITO. `clearRetirement` esiste perche' riaprire e'
 * un'operazione vera (l'unarchive di una chat, l'annulla-chiusura di una tab):
 * senza, il fatto sarebbe una lapide e ogni riapertura verrebbe richiusa al
 * riconcilio successivo.
 */
import type { Database } from "bun:sqlite";
import type { CascadeResult } from "./pane-retirement-cascade";

export type RetirementKind = "pane" | "topic" | "terminal";

/**
 * Timbra il ritiro. Ritorna `true` solo se la riga e' NUOVA — il valore su cui
 * un chiamante decide se fare anche le conseguenze (uccidere un PTY,
 * archiviare un topic), cosi' che rifarle non sia possibile.
 */
export function recordRetirement(
  db: Database,
  kind: RetirementKind,
  refId: string,
  at: string = new Date().toISOString(),
  reason?: string,
): boolean {
  if (!refId) return false;
  const res = db.run(
    "INSERT OR IGNORE INTO retirements (kind, ref_id, retired_at, reason) VALUES (?, ?, ?, ?)",
    [kind, refId, at, reason ?? null],
  );
  return (res?.changes ?? 0) > 0;
}

/** Il rientro. Ritorna `true` se c'era davvero qualcosa da ritrattare. */
export function clearRetirement(db: Database, kind: RetirementKind, refId: string): boolean {
  if (!refId) return false;
  const res = db.run("DELETE FROM retirements WHERE kind = ? AND ref_id = ?", [kind, refId]);
  return (res?.changes ?? 0) > 0;
}

export function isRetired(db: Database, kind: RetirementKind, refId: string): boolean {
  const row = db.query("SELECT 1 AS x FROM retirements WHERE kind = ? AND ref_id = ?").get(kind, refId);
  return !!row;
}

/** Gli id ritirati di una specie, come insieme — per i confronti in memoria. */
export function retiredIds(db: Database, kind: RetirementKind): Set<string> {
  const rows = db.query("SELECT ref_id FROM retirements WHERE kind = ?").all(kind) as { ref_id: string }[];
  return new Set(rows.map((r) => r.ref_id));
}

// ---------------------------------------------------------------------------
// LA QUERY SOLA
// ---------------------------------------------------------------------------

export interface OpenTopic {
  id: string;
  name: string;
  projectPath: string | null;
  sessionKey: string;
}

export interface OpenTerminal {
  id: string;
  name: string;
  cwd: string;
  type: string;
  status: string;
  topicId: string | null;
}

/**
 * Una divergenza fra il fatto e un registro. Non e' un errore da lanciare: e'
 * il numero che il task chiedeva di poter leggere («oggi ce ne vogliono tre e
 * danno tre risposte diverse»). Una lista vuota E' la prova che i tre registri
 * concordano; una lista piena dice esattamente dove non concordano, e
 * `reconcile` sa ripararla.
 */
export interface Divergence {
  kind: RetirementKind;
  refId: string;
  /**
   * `registry-open-fact-retired`  — il registro lo mostra, il fatto dice che e'
   *   stato chiuso. E' la classe che teneva vive 11 sessioni per tab chiuse a
   *   luglio, e quella del topic rimasto «aperto» da meta' luglio.
   * `registry-closed-fact-open`   — il registro lo nasconde, il fatto non sa di
   *   nessuna chiusura. Un archivio passato da una strada che non timbrava.
   */
  reason: "registry-open-fact-retired" | "registry-closed-fact-open";
  label?: string;
}

export interface OpenInventory {
  /** Quando e' stata scattata: una risposta a «cosa e' aperto» senza istante non si confronta. */
  at: string;
  topics: OpenTopic[];
  terminals: OpenTerminal[];
  /** Le pane che il fatto sa chiuse — l'input della cascata, utile al triage. */
  retiredPanes: number;
  divergences: Divergence[];
}

/**
 * «Cosa e' aperto», da un posto solo.
 *
 * Aperto = il registro ha la riga E il fatto non ha un ritiro. Le due
 * condizioni insieme, non una delle due: prendere solo il registro e' la
 * domanda di prima (che mentiva), prendere solo il fatto significa mostrare
 * cose cancellate.
 */
export function listOpen(db: Database): OpenInventory {
  const retiredTopics = retiredIds(db, "topic");
  const retiredTerminals = retiredIds(db, "terminal");

  const topicRows = db
    .query("SELECT id, name, project_path, session_key, archived FROM topics")
    .all() as { id: string; name: string; project_path: string | null; session_key: string; archived: number }[];

  const termRows = db
    .query("SELECT id, name, cwd, type, status, topic_id FROM terminal_sessions")
    .all() as { id: string; name: string; cwd: string; type: string; status: string; topic_id: string | null }[];

  const divergences: Divergence[] = [];
  const topics: OpenTopic[] = [];

  for (const r of topicRows) {
    const archived = r.archived === 1;
    const retired = retiredTopics.has(r.id);
    if (!archived && retired) {
      divergences.push({ kind: "topic", refId: r.id, reason: "registry-open-fact-retired", label: r.name });
    } else if (archived && !retired) {
      divergences.push({ kind: "topic", refId: r.id, reason: "registry-closed-fact-open", label: r.name });
    }
    if (!archived && !retired) {
      topics.push({ id: r.id, name: r.name, projectPath: r.project_path, sessionKey: r.session_key });
    }
  }

  const terminals: OpenTerminal[] = [];
  for (const r of termRows) {
    if (retiredTerminals.has(r.id)) {
      // Una riga che esiste ancora per una tab che il fatto sa chiusa: e' la
      // sessione viva senza finestra, cioe' il guasto misurato.
      divergences.push({ kind: "terminal", refId: r.id, reason: "registry-open-fact-retired", label: r.name });
      continue;
    }
    terminals.push({ id: r.id, name: r.name, cwd: r.cwd, type: r.type, status: r.status, topicId: r.topic_id });
  }

  const retiredPanes = (db.query("SELECT COUNT(*) AS n FROM retirements WHERE kind = 'pane'").get() as { n: number }).n;

  return { at: new Date().toISOString(), topics, terminals, retiredPanes, divergences };
}

// ---------------------------------------------------------------------------
// LA CASCATA DI UNA TAB CHIUSA
// ---------------------------------------------------------------------------

export interface CascadeApplyResult {
  panes: number;
  topics: number;
  terminals: number;
  reopened: number;
}

/**
 * Applica cio' che `computeCascade` ha deciso: prima il fatto, poi le
 * conseguenze.
 *
 * L'ORDINE E' LA GARANZIA. Il timbro va scritto PRIMA di archiviare o
 * uccidere, non dopo: se il processo muore a meta', lo stato che resta e' «so
 * che andava ritirato, non l'ho ancora fatto» — che il riconcilio al boot sa
 * finire. Timbrando dopo, la stessa morte lascerebbe «l'ho fatto a meta' e
 * nessuno sa perche'», che e' precisamente il guasto da cui si viene.
 *
 * Ogni conseguenza e' best-effort e isolata: una tab che ne contiene due non
 * deve perderne una perche' l'altra e' esplosa.
 */
export function applyPaneCascade(db: Database, deps: ReconcileDeps, result: CascadeResult): CascadeApplyResult {
  const out: CascadeApplyResult = { panes: 0, topics: 0, terminals: 0, reopened: 0 };

  // La ritrattazione prima dei ritiri: nello stesso snapshot una pane puo'
  // rientrare e un'altra uscire, e il fatto deve finire coerente con l'ultima
  // cosa detta, non con l'ordine in cui si legge la mappa.
  //
  // Si ritratta anche il CONTENUTO, non solo la pane. Un topic timbrato
  // «ritirato» con la sua chat di nuovo sullo schermo e' una divergenza che il
  // riconcilio al riavvio successivo risolverebbe archiviando — cioe'
  // chiudendo una conversazione aperta. La pane viva e' l'autorita' che dice
  // il contrario, ed e' la stessa con cui l'avevamo chiusa.
  for (const r of result.reopen) {
    if (clearRetirement(db, "pane", r.paneId)) out.reopened++;
    if (r.topicId) clearRetirement(db, "topic", r.topicId);
    if (r.terminalSessionId) clearRetirement(db, "terminal", r.terminalSessionId);
  }

  for (const r of result.retire) {
    const at = new Date(r.closedAt).toISOString();
    if (!recordRetirement(db, "pane", r.paneId, at, "tab-close")) continue;
    out.panes++;
    if (r.topicId) {
      // A durable coordinator remains a real Topic even after its panel is
      // closed. Do not stamp it first and try to undo it later: a crash between
      // those two actions would let boot reconciliation archive it forever.
      if (deps.shouldRetireTopic?.(r.topicId) === false) {
        clearRetirement(db, "topic", r.topicId);
      } else {
        recordRetirement(db, "topic", r.topicId, at, "tab-close");
        try { deps.archiveTopic(r.topicId); out.topics++; }
        catch (err) { console.error(`[retirement] cascata topic ${r.topicId}`, err); }
      }
    }
    if (r.terminalSessionId) {
      recordRetirement(db, "terminal", r.terminalSessionId, at, "tab-close");
      try { deps.retireTerminal(r.terminalSessionId); out.terminals++; }
      catch (err) { console.error(`[retirement] cascata terminale ${r.terminalSessionId}`, err); }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// IL RICONCILIO
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  /** Archivia il topic per intero (`archiveTopicFully` legato alle sue dipendenze). */
  archiveTopic: (topicId: string) => void;
  /**
   * Rare durable Topic roles may opt out of panel-driven retirement. The
   * predicate must be identity-based (never a mutable title/UI field).
   */
  shouldRetireTopic?: (topicId: string) => boolean;
  /** Repair a protected Topic that an older path archived before the exemption. */
  restoreTopic?: (topicId: string) => void;
  /** Ritira la sessione di terminale: uccide il PTY se c'e' e butta la riga. */
  retireTerminal: (sessionId: string) => void;
}

export interface ReconcileResult {
  topicsArchived: number;
  terminalsRetired: number;
  topicsStamped: number;
  examined: number;
}

/**
 * Porta i registri d'accordo col fatto. Gira al boot, ed e' cio' che rende vera
 * la verifica del task: «riavvia il server, riapri il progetto: niente
 * ricompare, niente processo resta».
 *
 * LA DIREZIONE NON E' SIMMETRICA, ed e' deliberato.
 *   · fatto ritirato, registro aperto → si CHIUDE il registro. Il ritiro e' un
 *     gesto umano esplicito (una tab chiusa); onorarlo in ritardo e' il punto.
 *   · registro chiuso, fatto muto → si TIMBRA il fatto, non si riapre niente.
 *     E' un'archiviazione passata da una strada che non timbrava: la verita' e'
 *     il registro, e riaprire quel topic sarebbe resuscitare una chat che
 *     l'utente aveva chiuso — l'esatto contrario di cio' che si sta riparando.
 *
 * Convergente: rigirarlo su uno stato gia' pulito non fa scritture.
 */
export function reconcile(db: Database, deps: ReconcileDeps): ReconcileResult {
  const inv = listOpen(db);
  const now = new Date().toISOString();
  let topicsArchived = 0;
  let terminalsRetired = 0;
  let topicsStamped = 0;

  for (const d of inv.divergences) {
    if (d.kind === "topic" && deps.shouldRetireTopic?.(d.refId) === false) {
      // A protected Topic may have a stale fact from before its exemption was
      // introduced. Clear it instead of treating a closed panel as authority to
      // archive the durable conversation during boot reconciliation.
      if (d.reason === "registry-open-fact-retired") {
        clearRetirement(db, "topic", d.refId);
      } else {
        try { deps.restoreTopic?.(d.refId); }
        catch (err) { console.error(`[retirement] restore protected topic ${d.refId}`, err); }
      }
      continue;
    }
    if (d.reason === "registry-closed-fact-open") {
      // Il registro sa una chiusura che il fatto non sa: si timbra il fatto.
      if (recordRetirement(db, d.kind, d.refId, now, "reconcile:registry")) topicsStamped++;
      continue;
    }
    // Il fatto sa una chiusura che il registro non ha applicato.
    try {
      if (d.kind === "topic") { deps.archiveTopic(d.refId); topicsArchived++; }
      else if (d.kind === "terminal") { deps.retireTerminal(d.refId); terminalsRetired++; }
    } catch (err) {
      // Best-effort per riga: un topic che non si archivia non deve impedire
      // di ritirare le sessioni, che sono quelle che consumano.
      console.error(`[retirement] reconcile ${d.kind} ${d.refId}`, err);
    }
  }

  return { topicsArchived, terminalsRetired, topicsStamped, examined: inv.divergences.length };
}

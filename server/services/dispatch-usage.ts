// dispatch-usage.ts — quanto ha consumato la sessione di un task, FIGLIE COMPRESE.
//
// PERCHÉ NON BASTA LA TRASCRIZIONE DEL PADRE. `tasks.agent_tokens` nasce da una
// differenza: il dispatcher legge il consumo della sessione all'inizio del
// turno e alla fine, e scrive la differenza sulla card (`recordAgentUsage`). La
// lettura era «il .jsonl di QUELLA sessione», e reggeva finché la sessione del
// task era anche quella che faceva il lavoro.
//
// Col coordinatore non è più così: il lavoro vero gira in sessioni figlie, con
// il LORO transcript. Lasciando la lettura com'era, il costo di una card
// diventerebbe quello del solo coordinamento — poche migliaia di token per un
// lavoro che ne è costati centinaia di migliaia. Non sarebbe un numero
// impreciso, sarebbe un numero che dice il contrario del vero: la board
// mostrerebbe le card che delegano come le più economiche proprio perché
// spendono di più.
//
// IL LEDGER, e perché la somma nuda non basta. Le figlie muoiono: quando una
// finisce, la sua riga sparisce e il suo transcript smette di essere
// raggiungibile da qui. Una somma calcolata sulle figlie VIVE scenderebbe, e
// siccome il dispatcher scrive `max(0, fine - inizio)` quel calo diventa uno
// zero: i token di una figlia che ha finito dentro il turno non arriverebbero
// mai sulla card. Il ledger tiene l'ULTIMO valore letto di ogni figlia, per id,
// e continua a sommarlo dopo la sua morte. La lettura del padre non scende mai,
// che è la proprietà su cui il dispatcher fa la sottrazione.
//
// PURO RISPETTO ALL'AMBIENTE: niente `getDatabase()`, niente fs diretto. Il db
// e il lettore di transcript arrivano come dipendenze, quindi il modulo si
// prova con un db temporaneo e due file finti invece che con una macchina viva.

import type { Database } from "bun:sqlite";
import { ZERO_USAGE, type SessionUsage } from "./transcript-usage";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";

/** Somma componente per componente. `billableTokens` resta input+output+cacheWrite. */
export function addUsage(a: SessionUsage, b: SessionUsage): SessionUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    billableTokens: a.billableTokens + b.billableTokens,
  };
}

export interface DispatchUsageDeps {
  db: Database;
  /** Il lettore incrementale vero (`createTranscriptUsageReader().read`). */
  read: (path: string) => SessionUsage;
  /** Sovrascrivibile nei test: dove sta il .jsonl di una figlia. */
  transcriptPath?: (cwd: string, claudeSessionId: string) => string;
}

export interface DispatchUsageReader {
  /** Consumo della sessione + di tutte le sue figlie, mai decrescente. */
  read(sessionKey: string): SessionUsage;
  /** Solo le figlie: serve ai test e a chi vuole spaccare il conto in due. */
  readChildren(sessionKey: string): SessionUsage;
  /** Scorda un padre (fine turno / fine task): il ledger non è una perdita. */
  forget(sessionKey: string): void;
}

/**
 * Il lettore che il dispatcher riceve come `getSessionUsage`.
 *
 * Una istanza sola per processo, perché il ledger è memoria: due istanze
 * terrebbero due storie parziali e chi legge vedrebbe la somma di quella che ha
 * in mano, cioè un numero che cambia a seconda di chi chiede.
 */
export function createDispatchUsageReader(deps: DispatchUsageDeps): DispatchUsageReader {
  const pathOf = deps.transcriptPath ?? claudeTranscriptPath;
  /** parentSessionKey → (childId → ultimo consumo letto). */
  const ledger = new Map<string, Map<string, SessionUsage>>();

  function ownUsage(sessionKey: string): SessionUsage {
    try {
      const row = deps.db
        .prepare("SELECT jsonl_path FROM claude_code_sessions WHERE session_key = ?")
        .get(sessionKey) as { jsonl_path?: string | null } | null;
      if (!row?.jsonl_path) return ZERO_USAGE;
      return deps.read(row.jsonl_path);
    } catch {
      return ZERO_USAGE;
    }
  }

  function readChildren(sessionKey: string): SessionUsage {
    let seen = ledger.get(sessionKey);
    if (!seen) {
      seen = new Map();
      ledger.set(sessionKey, seen);
    }
    try {
      const rows = deps.db
        .prepare(
          "SELECT id, cwd, claude_session_id FROM terminal_sessions WHERE parent_session_key = ? AND claude_session_id IS NOT NULL",
        )
        .all(sessionKey) as Array<{ id: string; cwd: string; claude_session_id: string }>;
      for (const r of rows) {
        if (!r.cwd || !r.claude_session_id) continue;
        let u: SessionUsage;
        try { u = deps.read(pathOf(r.cwd, r.claude_session_id)); } catch { continue; }
        const prev = seen.get(r.id);
        // Non torna mai indietro: un transcript ruotato o illeggibile vale
        // «quanto sapevo prima», mai «zero». Uno zero qui diventerebbe un calo
        // della lettura del padre, e il dispatcher i cali li appiattisce.
        if (!prev || u.billableTokens >= prev.billableTokens) seen.set(r.id, u);
      }
    } catch { /* il ledger risponde con quello che ha */ }
    let total = ZERO_USAGE;
    for (const u of seen.values()) total = addUsage(total, u);
    return total;
  }

  return {
    readChildren,
    read(sessionKey: string): SessionUsage {
      return addUsage(ownUsage(sessionKey), readChildren(sessionKey));
    },
    forget(sessionKey: string): void {
      ledger.delete(sessionKey);
    },
  };
}

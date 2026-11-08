/**
 * Stato del contesto reale per sessione (1b.5).
 *
 * Una riga per sessione, sovrascritta a ogni misura: quanto era grande il
 * prompt dell'ULTIMA chiamata al modello, contro la finestra di quel modello.
 * Serve a una cosa sola: alla riapertura dell'app il ring sa già dove sta,
 * invece di restare vuoto fino al turno successivo.
 *
 * Deliberatamente separata dai `compaction_markers`: quelli sono eventi (la
 * storia dei confini), questa è lo STATO corrente. Mischiarle vorrebbe dire
 * far crescere una tabella di eventi a ogni chiamata di ogni turno.
 */

import type { Database } from "bun:sqlite";

export interface SessionContextRow {
  sessionKey: string;
  /** Token del prompt dell'ultima chiamata (`input + cache_read + cache_creation`). */
  usedTokens: number;
  /** Finestra del modello che ha prodotto quella chiamata. */
  windowTokens: number;
  /** true = finestra dedotta dal default, il modello non è in tabella. */
  estimated: boolean;
  model: string | null;
  measuredAt: string;
}

function mapRow(r: Record<string, unknown>): SessionContextRow {
  return {
    sessionKey: String(r.session_key),
    usedTokens: Number(r.used_tokens) || 0,
    windowTokens: Number(r.window_tokens) || 0,
    estimated: Number(r.estimated) === 1,
    model: r.model != null ? String(r.model) : null,
    measuredAt: String(r.measured_at),
  };
}

/**
 * Registra l'ultima misura. Best-effort per scelta: una sessione senza topic
 * (la FK non trova nulla) NON deve far fallire il turno — il ring è
 * un'informazione, non una transazione. Torna la riga scritta, o null se non
 * si è potuto scrivere.
 */
export function recordSessionContext(
  db: Database,
  input: { sessionKey: string; usedTokens: number; windowTokens: number; estimated?: boolean; model?: string | null },
): SessionContextRow | null {
  if (!Number.isFinite(input.usedTokens) || input.usedTokens <= 0) return null;
  const row: SessionContextRow = {
    sessionKey: input.sessionKey,
    usedTokens: Math.round(input.usedTokens),
    windowTokens: Math.round(input.windowTokens),
    estimated: !!input.estimated,
    model: input.model ?? null,
    measuredAt: new Date().toISOString(),
  };
  try {
    db.prepare(
      `INSERT INTO session_context (session_key, used_tokens, window_tokens, estimated, model, measured_at)
         VALUES ($key, $used, $window, $estimated, $model, $at)
       ON CONFLICT(session_key) DO UPDATE SET
         used_tokens = $used, window_tokens = $window, estimated = $estimated,
         model = $model, measured_at = $at`,
    ).run({
      $key: row.sessionKey,
      $used: row.usedTokens,
      $window: row.windowTokens,
      $estimated: row.estimated ? 1 : 0,
      $model: row.model,
      $at: row.measuredAt,
    });
    return row;
  } catch (err) {
    console.warn(`[context] impossibile registrare la misura per ${input.sessionKey}:`, err);
    return null;
  }
}

/** Ultima misura nota per la sessione, o null se non ne esiste una. */
export function getSessionContext(db: Database, sessionKey: string): SessionContextRow | null {
  const r = db
    .prepare(`SELECT * FROM session_context WHERE session_key = ?`)
    .get(sessionKey) as Record<string, unknown> | undefined;
  return r ? mapRow(r) : null;
}

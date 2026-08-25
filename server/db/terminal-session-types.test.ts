/**
 * @covers SCHEMA-02
 */
// DRIFT GATE fra l'union TypeScript dei tipi di sessione e il CHECK di SQLite.
//
// Il disallineamento fra i due è già costato due bug identici: la migration 029
// per 'codex'/'claude-code-team' e la 066 per 'opencode'. In entrambi i casi il
// tipo era stato aggiunto al codice e non al vincolo, quindi OGNI insert lo
// violava — e `createSession` logga l'errore e tira avanti, così la sessione
// girava in memoria e al riavvio la pane spariva col suo PTY. Un bug che non si
// vede al momento in cui lo si introduce: si vede al riavvio successivo.
//
// Questo test ricostruisce lo schema dalle migration EMBEDDED (le stesse che
// gira il server), estrae l'elenco dal CHECK e lo confronta con
// TERMINAL_SESSION_TYPES. Aggiungere un tipo senza migration ora è rosso qui.

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "./migrations-embedded";
import {
  TERMINAL_SESSION_TYPES,
  TERMINAL_AGENT_TYPES,
  isTerminalSessionType,
} from "../../shared/terminal-session-types";

/** DB in memoria con lo schema completo, migrato come in produzione. */
function migratedDb(): Database {
  const db = new Database(":memory:");
  for (const m of EMBEDDED_MIGRATIONS.slice().sort((a, b) => a.version - b.version)) {
    db.exec(m.sql);
  }
  return db;
}

/** I valori enumerati dal CHECK di `terminal_sessions.type`, letti dallo schema. */
function checkedTypes(db: Database): string[] {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='terminal_sessions'`)
    .get() as { sql: string } | undefined;
  expect(row?.sql, "la tabella terminal_sessions non esiste nello schema migrato").toBeTruthy();
  const m = row!.sql.match(/CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)/i);
  expect(m, `nessun CHECK su type nello schema:\n${row!.sql}`).toBeTruthy();
  return m![1]!
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

describe("terminal_sessions.type — schema e codice dicono la stessa cosa", () => {
  test("il CHECK enumera esattamente TERMINAL_SESSION_TYPES", () => {
    const db = migratedDb();
    try {
      expect(checkedTypes(db).slice().sort()).toEqual(
        [...TERMINAL_SESSION_TYPES].slice().sort(),
      );
    } finally {
      db.close();
    }
  });

  test("ogni tipo dichiarato è davvero inseribile", () => {
    // Il confronto di insiemi sopra può passare mentre l'insert fallisce per
    // altro (una NOT NULL dimenticata). Qui si prova l'insert vero, uno per tipo.
    const db = migratedDb();
    try {
      for (const t of TERMINAL_SESSION_TYPES) {
        db.run(
          `INSERT INTO terminal_sessions (id, name, cwd, type, created_at) VALUES (?, ?, ?, ?, ?)`,
          [`t-${t}`, t, "/tmp", t, "2026-01-01T00:00:00.000Z"],
        );
      }
      const stored = db
        .prepare(`SELECT type FROM terminal_sessions ORDER BY type`)
        .all() as { type: string }[];
      expect(stored.map((r) => r.type).sort()).toEqual([...TERMINAL_SESSION_TYPES].slice().sort());
    } finally {
      db.close();
    }
  });

  test("un tipo fuori elenco è ancora rifiutato dal vincolo", () => {
    // Il CHECK deve restare un vincolo, non diventare decorativo: se qualcuno lo
    // allargasse a piacere il test sopra passerebbe comunque.
    const db = migratedDb();
    try {
      expect(() =>
        db.run(
          `INSERT INTO terminal_sessions (id, name, cwd, type, created_at) VALUES (?, ?, ?, ?, ?)`,
          ["t-x", "x", "/tmp", "tipo-inventato", "2026-01-01T00:00:00.000Z"],
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("i tipi creabili dalla UI sono un sottoinsieme di quelli persistibili", () => {
    for (const t of TERMINAL_AGENT_TYPES) {
      expect(isTerminalSessionType(t), `${t} è creabile ma non persistibile`).toBe(true);
    }
  });

  test("isTerminalSessionType non lancia su input non-stringa", () => {
    expect(isTerminalSessionType(undefined)).toBe(false);
    expect(isTerminalSessionType(null)).toBe(false);
    expect(isTerminalSessionType(42)).toBe(false);
    expect(isTerminalSessionType("opencode")).toBe(true);
  });
});

/**
 * `074-messages-timestamp-index.sql` — l'indice che mancava su
 * `messages(timestamp)`.
 *
 * Cosa vale la pena provare, di una migration che crea un indice: che il FILE
 * gira davvero (non una sua copia riscritta qui), che è ri-eseguibile — il DB
 * di chi ha indagato può già avere l'indice creato a mano — e soprattutto che
 * il PIANO delle query cambia. Un indice che esiste ma che il planner non
 * sceglie non ha risolto niente, e questo è l'unico modo di accorgersene senza
 * aprire la dashboard e cronometrare a occhio.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/074-messages-timestamp-index.sql"),
  "utf-8",
);

/** Le due query KPI della dashboard, alla lettera da server/routes/dashboard.ts. */
const TOKEN_SPEND_DAY =
  "SELECT COALESCE(SUM(cost_cents), 0) / 100.0 as total FROM messages WHERE timestamp >= date('now', 'start of day')";
const TOKEN_SPEND_WEEK =
  "SELECT COALESCE(SUM(cost_cents), 0) / 100.0 as total FROM messages WHERE timestamp >= date('now', '-7 days')";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    cost_cents INTEGER,
    timestamp TEXT
  )`);
  // Abbastanza righe perché il planner abbia un motivo per preferire l'indice
  // a una scansione: su una tabella minuscola sceglierebbe lo SCAN comunque, e
  // il test proverebbe il contrario di quello che vuole provare.
  const ins = db.prepare("INSERT INTO messages (id, session_key, role, content, cost_cents, timestamp) VALUES (?, ?, 'assistant', '', ?, ?)");
  const tx = db.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      // Sparse su ~400 giorni, così la finestra "ultimi 7" ne prende una fetta
      // piccola: è la forma reale del dato.
      const d = new Date(Date.UTC(2025, 0, 1) + i * 5 * 3600 * 1000).toISOString();
      ins.run(`m${i}`, `topic:${i % 50}`, i, d);
    }
  });
  tx();
  db.run("ANALYZE");
  return db;
}

const planOf = (db: Database, sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail)
    .join(" | ");

describe("migration 074 — indice su messages(timestamp)", () => {
  test("prima della migration le KPI scandiscono tutta la tabella", () => {
    const db = makeDb();
    expect(planOf(db, TOKEN_SPEND_DAY)).toContain("SCAN messages");
    expect(planOf(db, TOKEN_SPEND_WEEK)).toContain("SCAN messages");
    db.close();
  });

  test("dopo la migration il planner USA l'indice (è il punto: esistere non basta)", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    db.run("ANALYZE");
    for (const sql of [TOKEN_SPEND_DAY, TOKEN_SPEND_WEEK]) {
      const plan = planOf(db, sql);
      expect(plan).toContain("idx_messages_timestamp");
      expect(plan).not.toContain("SCAN messages");
    }
    db.close();
  });

  test("è ri-eseguibile: applicarla due volte non solleva", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    expect(() => db.run(MIGRATION_SQL)).not.toThrow();
    db.close();
  });

  test("non cambia NESSUN dato — è solo un indice", () => {
    const db = makeDb();
    const before = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_cents),0) s FROM messages").get() as { n: number; s: number };
    db.run(MIGRATION_SQL);
    const after = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_cents),0) s FROM messages").get() as { n: number; s: number };
    expect(after).toEqual(before);
    db.close();
  });
});

/**
 * `20260815013610-task-comments-author-kind-index.sql` — l'indice sotto il
 * contatore dei messaggi umani.
 *
 * `withSubtaskCounts` (server/services/tasks.ts) chiede a `task_comments`
 * quante righe una PERSONA ha scritto su ciascuna card, e lo fa su ogni lista
 * della board e su ogni apertura di task. L'unico indice che c'era
 * (`idx_task_comments_task`) copre `task_id`: il filtro su `author` e `kind`
 * restava una lettura riga per riga, sulla tabella che cresce più in fretta di
 * tutte (11.994 righe misurate il 2026-08-15 contro 2.135 task).
 *
 * Di una migration che crea un indice vale la pena provare tre cose, e la terza
 * è quella che conta: che gira il FILE (non una copia riscritta qui), che è
 * ri-eseguibile — un database può già avere l'indice creato a mano — e che il
 * PLANNER lo SCEGLIE. Un indice che esiste e che il planner ignora non ha
 * risolto niente, e senza `EXPLAIN QUERY PLAN` non c'è modo di accorgersene.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260815013610-task-comments-author-kind-index.sql"),
  "utf-8",
);

/** L'aggregazione di `withSubtaskCounts`, alla lettera. */
const HUMAN_COUNT = `
  SELECT task_id AS tid, COUNT(*) AS n
    FROM task_comments
   WHERE task_id IN (SELECT value FROM json_each('["t0","t1"]'))
     AND author = 'user' AND kind = 'comment'
   GROUP BY task_id`;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL,
    mentions TEXT, media TEXT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  // L'indice che c'era già: senza di lui il confronto misurerebbe la differenza
  // fra «nessun indice» e «l'indice nuovo», che non è la domanda.
  db.run("CREATE INDEX idx_task_comments_task ON task_comments(task_id)");
  const ins = db.prepare(
    "INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES (?, ?, ?, '', '2026-08-15T10:00:00.000Z', ?)",
  );
  // Abbastanza righe perché il planner abbia un motivo per preferire l'indice a
  // una scansione: su una tabella minuscola sceglierebbe lo SCAN comunque, e il
  // test proverebbe il contrario di quello che vuole provare. Le proporzioni
  // sono quelle misurate: la stragrande maggioranza delle righe NON è umana.
  const tx = db.transaction(() => {
    for (let i = 0; i < 12000; i++) {
      const umano = i % 20 === 0;
      ins.run(`c${i}`, `t${i % 400}`, umano ? "user" : "agent:top-1", umano ? "comment" : "status");
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

describe("migration 20260815013610 — indice su task_comments(task_id, author, kind)", () => {
  test("prima: il planner si ferma a `task_id` e legge la tabella per autore e tipo", () => {
    const db = makeDb();
    const plan = planOf(db, HUMAN_COUNT);
    expect(plan).toContain("idx_task_comments_task");
    expect(plan).not.toContain("idx_task_comments_task_author_kind");
    db.close();
  });

  test("dopo: il planner USA l'indice nuovo (esistere non basta)", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    db.run("ANALYZE");
    expect(planOf(db, HUMAN_COUNT)).toContain("idx_task_comments_task_author_kind");
    db.close();
  });

  test("è ri-eseguibile: applicarla due volte non solleva", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    expect(() => db.run(MIGRATION_SQL)).not.toThrow();
    db.close();
  });

  test("non cambia NESSUN dato, e il conto resta lo stesso", () => {
    const db = makeDb();
    const prima = db.prepare(HUMAN_COUNT).all();
    const righe = db.prepare("SELECT COUNT(*) AS n FROM task_comments").get() as { n: number };
    db.run(MIGRATION_SQL);
    expect(db.prepare(HUMAN_COUNT).all()).toEqual(prima);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_comments").get()).toEqual(righe);
    db.close();
  });
});

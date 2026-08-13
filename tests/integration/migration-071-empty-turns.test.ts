/**
 * Bonifica dello storico: `071-drop-empty-assistant-turns.sql`.
 *
 * Dal 30/07 le bolle vuote non nascono più (`discardIfEmptyTurn`), ma nel DB ne
 * restavano 170, seminate fra un turno vero e l'altro. La migration le toglie —
 * e siccome tocca il thread di conversazioni reali, quello che conta non è che
 * cancelli, è COSA NON cancella: una riga con dei fratelli, dentro una catena,
 * con del costo registrato o con un ramo attivo appeso resta dov'è. Meglio una
 * bolla vuota di troppo che un turno perso.
 *
 * Il test esegue il FILE della migration, non una sua copia: se il predicato
 * cambia, cambia sotto questi casi.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, PROJECT_ROOT, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_DATA = testTmpDir("migration-071-data");

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/071-drop-empty-assistant-turns.sql"),
  "utf-8",
);

beforeAll(() => setupTestDataDir(TEST_DATA));

type Row = {
  id: string;
  role?: "user" | "assistant";
  content?: string;
  parent?: string | null;
  branch?: number;
  partial?: 0 | 1;
  cost?: number;
  thinking?: string;
  toolCalls?: string;
};

let seq = 0;

/** Scrive righe grezze: qui serve costruire forme che l'API non produrrebbe. */
function insert(ctx: AppContext, sessionKey: string, rows: Row[]): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO messages (id, session_key, role, content, thinking, tool_calls, partial,
                           timestamp, sort_order, parent_id, branch_index, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      sessionKey,
      r.role ?? "assistant",
      r.content ?? "",
      r.thinking ?? null,
      r.toolCalls ?? null,
      r.partial ?? 0,
      new Date(Date.now() + seq++ * 1000).toISOString(),
      seq,
      r.parent ?? null,
      r.branch ?? 0,
      r.cost ?? 0,
    );
  }
}

function runMigration(ctx: AppContext): void {
  ctx.db.exec(MIGRATION_SQL);
}

const idsOf = (ctx: AppContext, sessionKey: string) =>
  (ctx.db.query(`SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order`).all(sessionKey) as Array<{ id: string }>)
    .map(r => r.id);

describe("migration 071 — le bolle vuote dello storico", () => {
  test("la muta in mezzo sparisce e il turno dopo passa al nonno", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:mezzo";
    insert(ctx, sk, [
      { id: "u1", role: "user", content: "che ore sono?" },
      { id: "vuota", parent: "u1" },
      { id: "u2", role: "user", content: "e poi?", parent: "vuota" },
      { id: "a2", content: "le tre", parent: "u2" },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["u1", "u2", "a2"]);
    // Il thread si legge ancora tutto, nell'ordine giusto: nessun figlio appeso.
    expect(ctx.loadActiveThread(sk).map(m => m.content)).toEqual(["che ore sono?", "e poi?", "le tre"]);
    const orfani = ctx.db.query(
      `SELECT COUNT(*) n FROM messages c WHERE c.parent_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.id = c.parent_id)`,
    ).get() as { n: number };
    expect(orfani.n).toBe(0);
  });

  test("la muta in coda sparisce e lascia la domanda", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:coda";
    insert(ctx, sk, [
      { id: "cu1", role: "user", content: "domanda" },
      { id: "cvuota", parent: "cu1" },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["cu1"]);
    expect(ctx.loadActiveThread(sk).map(m => m.content)).toEqual(["domanda"]);
  });

  test("una muta CON FRATELLI resta: toglierla vorrebbe dire rinumerare i rami", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:fratelli";
    insert(ctx, sk, [
      { id: "fu1", role: "user", content: "domanda" },
      { id: "fvuota", parent: "fu1", branch: 0 },
      { id: "frisposta", content: "rigenerata", parent: "fu1", branch: 1 },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["fu1", "fvuota", "frisposta"]);
  });

  test("una CATENA vuoto→vuoto resta intera: nessun anello appeso", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:catena";
    insert(ctx, sk, [
      { id: "ku1", role: "user", content: "domanda" },
      { id: "kv1", parent: "ku1" },
      { id: "kv2", parent: "kv1" },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["ku1", "kv1", "kv2"]);
  });

  test("chi è ancora PARTIAL non si tocca: è un turno vivo", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:vivo";
    insert(ctx, sk, [
      { id: "pu1", role: "user", content: "domanda" },
      { id: "psegnaposto", parent: "pu1", partial: 1 },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["pu1", "psegnaposto"]);
  });

  test("vuota ma COSTATA: la contabilità resta a memoria", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:costo";
    insert(ctx, sk, [
      { id: "xu1", role: "user", content: "domanda" },
      { id: "xvuota", parent: "xu1", cost: 12 },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["xu1", "xvuota"]);
  });

  test("una RADICE vuota resta: non ha un nonno a cui appendere i figli", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:radice";
    insert(ctx, sk, [
      { id: "rvuota", parent: null },
      { id: "ru1", role: "user", content: "domanda", parent: "rvuota" },
    ]);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["rvuota", "ru1"]);
  });

  test("con un ramo attivo appeso addosso resta: quel puntatore va tenuto buono", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:ramo";
    insert(ctx, sk, [
      { id: "bu1", role: "user", content: "domanda" },
      { id: "bvuota", parent: "bu1" },
      { id: "bu2", role: "user", content: "seguito", parent: "bvuota", branch: 0 },
      { id: "bu3", role: "user", content: "altro seguito", parent: "bvuota", branch: 1 },
    ]);
    ctx.db.prepare(
      `INSERT INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)`,
    ).run("bvuota", sk, 1);

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["bu1", "bvuota", "bu2", "bu3"]);
    // E il puntatore indica ancora il ramo scelto dall'umano.
    const ab = ctx.db.query(
      `SELECT active_branch_index i FROM active_branches WHERE parent_id = ? AND session_key = ?`,
    ).get("bvuota", sk) as { i: number };
    expect(ab.i).toBe(1);
  });

  test("pin e menzioni sulla muta se ne vanno, il marcatore di compattazione eredita il padre", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:riferimenti";
    insert(ctx, sk, [
      { id: "zu1", role: "user", content: "domanda" },
      { id: "zvuota", parent: "zu1" },
      { id: "zu2", role: "user", content: "seguito", parent: "zvuota" },
    ]);
    // `topic_pinned_messages.topic_id` ha una FK verso `topics`: il topic deve esistere.
    ctx.db.prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("t-071", "riferimenti", "riferimenti", sk);
    ctx.db.prepare(`INSERT INTO topic_pinned_messages (topic_id, message_id) VALUES (?, ?)`).run("t-071", "zvuota");
    ctx.db.prepare(
      `INSERT INTO mentions (message_id, session_key, mentioned_entity, entity_type, created_at)
       VALUES (?, ?, ?, 'agent', datetime('now'))`,
    ).run("zvuota", sk, "@qualcuno");
    ctx.db.prepare(
      `INSERT INTO compaction_markers (id, topic_id, session_key, after_message_id, trigger)
       VALUES (?, ?, ?, ?, 'manual')`,
    ).run("cm-071", "t-071", sk, "zvuota");

    runMigration(ctx);

    expect(idsOf(ctx, sk)).toEqual(["zu1", "zu2"]);
    const pin = ctx.db.query(`SELECT COUNT(*) n FROM topic_pinned_messages WHERE message_id = 'zvuota'`).get() as { n: number };
    const men = ctx.db.query(`SELECT COUNT(*) n FROM mentions WHERE message_id = 'zvuota'`).get() as { n: number };
    const cm = ctx.db.query(`SELECT after_message_id a FROM compaction_markers WHERE id = 'cm-071'`).get() as { a: string };
    expect(pin.n).toBe(0);
    expect(men.n).toBe(0);
    expect(cm.a).toBe("zu1");
  });
});

/**
 * THE REJECTION NOBODY EVER HANDED TO THE AGENT.
 *
 * When a person rejects a delivery, the words that say WHY live in the thread
 * and the row records who reopened the card (`reopened_actor`). The dispatcher
 * kept that text in a Map in memory, so a restart lost it and the card came
 * back with "your turn was interrupted, carry on with the work that is left" -
 * the opposite of "a human rejected this delivery".
 *
 * What is pinned here is the reader, `pendingHumanReopen`, and above all the
 * two traps a naive query does not survive.
 *
 * @covers KANBAN-92
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";

/**
 * The bench: the service's own tables PLUS the bridge to the chat.
 *
 * `topics.session_key` and `messages.blocks` are not decoration: a resume
 * envelope records there the ids of the comments it carried, and that - not
 * the clock - is the answer to "did the agent ever receive these words".
 */
function banco(): Database {
  const db = freshDb();
  db.run("ALTER TABLE topics ADD COLUMN session_key TEXT");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT, content TEXT, timestamp TEXT, blocks TEXT)");
  return db;
}

describe("pendingHumanReopen", () => {
  let db: Database; let s: TaskService;
  const clock = { t: Date.parse("2026-09-15T13:49:00.000Z") };
  beforeEach(() => { clock.t = Date.parse("2026-09-15T13:49:00.000Z"); db = banco(); s = svc(db, clock); });

  /** A card a person rejected, in the exact shape measured on the live DB. */
  function rejected(testo: string, opts: { scarto?: number } = {}): { id: string; commentId: string } {
    const t = s.create({ projectId: PID, text: "la consegna", status: "in_progress" });
    db.run("INSERT INTO topics (id, session_key) VALUES ('tp1', 'topic:tp1')");
    db.run("UPDATE tasks SET assigned_topic_id = 'tp1' WHERE id = ?", [t.id]);
    const c = s.addComment({ taskId: t.id, author: "user", content: testo });
    // The comment lands BEFORE the status row, not after: 16 ms on
    // `f981f62c`, 2 and 1 ms on the other two cards. The default reproduces it.
    const at = new Date(Date.parse(c.createdAt) + (opts.scarto ?? 16)).toISOString();
    db.run("UPDATE tasks SET reopened_actor = 'human', reopened_at = ? WHERE id = ?", [at, t.id]);
    return { id: t.id, commentId: c.id };
  }

  test("le parole scritte 16 ms PRIMA della riapertura sono la bocciatura, non il turno di prima", () => {
    // Trap 1. With `created_at > reopened_at` this test is red while the fix
    // looks done: on the live DB it found nothing on 3 cards out of 3.
    const { id, commentId } = rejected("Non si fonde ancora: il prefisso e' scaduto.");
    const r = s.pendingHumanReopen({ taskId: id })!;
    expect(r).not.toBeNull();
    expect(r.text).toContain("Non si fonde ancora");
    expect(r.commentIds).toEqual([commentId]);
  });

  test("una busta che ha GIA' portato quelle parole le toglie dalla coda", () => {
    // Trap 2: "already seen" is not "a turn has run". The resume envelope is
    // what records the ids it delivered, and without that check the same
    // rejection would be re-sent on every restart, forever.
    const { id, commentId } = rejected("Tre obiezioni.");
    expect(s.pendingHumanReopen({ taskId: id })).not.toBeNull();

    db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, blocks) VALUES ('m1', 'topic:tp1', 'user', 'Human update', ?, ?)",
      [new Date(clock.t).toISOString(), JSON.stringify([{ kind: "dispatched-envelope", commentIds: [commentId] }])],
    );
    expect(s.pendingHumanReopen({ taskId: id })).toBeNull();
  });

  test("una busta che ha portato ALTRI commenti non zittisce questo", () => {
    const { id } = rejected("Tre obiezioni.");
    db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, blocks) VALUES ('m1', 'topic:tp1', 'user', 'Human update', ?, ?)",
      [new Date(clock.t).toISOString(), JSON.stringify([{ kind: "dispatched-envelope", commentIds: ["id-di-un-altro"] }])],
    );
    expect(s.pendingHumanReopen({ taskId: id })).not.toBeNull();
  });

  test("piu' obiezioni arrivano tutte, nell'ordine in cui sono state scritte", () => {
    const { id } = rejected("Prima obiezione.");
    clock.t += 1000;
    s.addComment({ taskId: id, author: "user", content: "Seconda obiezione." });
    const r = s.pendingHumanReopen({ taskId: id })!;
    expect(r.commentIds).toHaveLength(2);
    expect(r.text.indexOf("Prima")).toBeLessThan(r.text.indexOf("Seconda"));
  });

  test("chi ha riaperto non e' una persona: non c'e' niente da consegnare", () => {
    const { id } = rejected("la macchina l'ha riaperta");
    db.run("UPDATE tasks SET reopened_actor = 'system' WHERE id = ?", [id]);
    expect(s.pendingHumanReopen({ taskId: id })).toBeNull();
  });

  test("le parole di PRIMA della riapertura restano fuori", () => {
    // The gap is seconds, not milliseconds: this comment belongs to the round
    // before, and fishing it out would be re-reading a story already closed.
    const { id } = rejected("roba vecchia", { scarto: 60_000 });
    expect(s.pendingHumanReopen({ taskId: id })).toBeNull();
  });

  test("una nota di servizio e la voce dell'agente non sono la voce di una persona", () => {
    const { id } = rejected("l'obiezione vera");
    clock.t += 1000;
    s.addComment({ taskId: id, author: "user", content: "contabilita'", kind: "service" });
    s.addComment({ taskId: id, author: "agent:xyz", content: "risposta dell'agente" });
    const r = s.pendingHumanReopen({ taskId: id })!;
    expect(r.commentIds).toHaveLength(1);
    expect(r.text).toBe("l'obiezione vera");
  });

  test("una card mai riaperta non ha niente da dire", () => {
    const t = s.create({ projectId: PID, text: "mai bocciata", status: "in_progress" });
    expect(s.pendingHumanReopen({ taskId: t.id })).toBeNull();
    expect(s.pendingHumanReopen({ taskId: "non-esiste" })).toBeNull();
  });
});

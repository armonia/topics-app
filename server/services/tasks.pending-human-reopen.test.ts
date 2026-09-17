/**
 * LA BOCCIATURA CHE NESSUNO AVEVA MAI CONSEGNATO ALL'AGENTE.
 *
 * Quando una persona rifiuta una consegna, le parole che dicono PERCHE' stanno
 * nel thread e la riga registra chi ha riaperto (`reopened_actor`). Il
 * dispatcher teneva quel testo in una Map in memoria, quindi un riavvio lo
 * perdeva e la card ripartiva con «il tuo turno e' stato interrotto, continua
 * il lavoro rimasto» — il contrario di «un umano ha bocciato questa consegna».
 *
 * Qui si prova il lettore: `pendingHumanReopen`, e soprattutto le due trappole
 * che una query ingenua non supera.
 *
 * @covers KANBAN-84
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";

/**
 * Il banco: le tabelle del servizio PIU' il ponte verso la chat.
 *
 * `topics.session_key` e `messages.blocks` non sono decorazione: la busta di un
 * resume registra li' gli id dei commenti che ha portato, ed e' quella — non
 * l'orologio — la risposta a «l'agente queste parole le ha mai ricevute».
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

  /** Una card bocciata da una persona, nella forma esatta misurata sul DB vivo. */
  function bocciata(testo: string, opts: { scarto?: number } = {}): { id: string; commentId: string } {
    const t = s.create({ projectId: PID, text: "la consegna", status: "in_progress" });
    db.run("INSERT INTO topics (id, session_key) VALUES ('tp1', 'topic:tp1')");
    db.run("UPDATE tasks SET assigned_topic_id = 'tp1' WHERE id = ?", [t.id]);
    const c = s.addComment({ taskId: t.id, author: "user", content: testo });
    // Il commento arriva PRIMA della riga di stato, non dopo: 16 ms su
    // `f981f62c`, 2 e 1 ms sulle altre due card. Il default riproduce quello.
    const at = new Date(Date.parse(c.createdAt) + (opts.scarto ?? 16)).toISOString();
    db.run("UPDATE tasks SET reopened_actor = 'human', reopened_at = ? WHERE id = ?", [at, t.id]);
    return { id: t.id, commentId: c.id };
  }

  test("le parole scritte 16 ms PRIMA della riapertura sono la bocciatura, non il turno di prima", () => {
    // Trappola 1. Con `created_at > reopened_at` questo test e' rosso e il fix
    // sembra fatto: sul DB vivo non trovava niente su 3 card su 3.
    const { id, commentId } = bocciata("Non si fonde ancora: il prefisso e' scaduto.");
    const r = s.pendingHumanReopen({ taskId: id })!;
    expect(r).not.toBeNull();
    expect(r.text).toContain("Non si fonde ancora");
    expect(r.commentIds).toEqual([commentId]);
  });

  test("una busta che ha GIA' portato quelle parole le toglie dalla coda", () => {
    // Trappola 2: «gia' visto» non e' «un turno e' girato». E' la busta del
    // resume a registrare gli id che ha consegnato, e senza questo controllo la
    // stessa bocciatura ripartirebbe a ogni riavvio per sempre.
    const { id, commentId } = bocciata("Tre obiezioni.");
    expect(s.pendingHumanReopen({ taskId: id })).not.toBeNull();

    db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, blocks) VALUES ('m1', 'topic:tp1', 'user', 'Human update', ?, ?)",
      [new Date(clock.t).toISOString(), JSON.stringify([{ kind: "dispatched-envelope", commentIds: [commentId] }])],
    );
    expect(s.pendingHumanReopen({ taskId: id })).toBeNull();
  });

  test("una busta che ha portato ALTRI commenti non zittisce questo", () => {
    const { id } = bocciata("Tre obiezioni.");
    db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, blocks) VALUES ('m1', 'topic:tp1', 'user', 'Human update', ?, ?)",
      [new Date(clock.t).toISOString(), JSON.stringify([{ kind: "dispatched-envelope", commentIds: ["id-di-un-altro"] }])],
    );
    expect(s.pendingHumanReopen({ taskId: id })).not.toBeNull();
  });

  test("piu' obiezioni arrivano tutte, nell'ordine in cui sono state scritte", () => {
    const { id } = bocciata("Prima obiezione.");
    clock.t += 1000;
    s.addComment({ taskId: id, author: "user", content: "Seconda obiezione." });
    const r = s.pendingHumanReopen({ taskId: id })!;
    expect(r.commentIds).toHaveLength(2);
    expect(r.text.indexOf("Prima")).toBeLessThan(r.text.indexOf("Seconda"));
  });

  test("chi ha riaperto non e' una persona: non c'e' niente da consegnare", () => {
    const { id } = bocciata("la macchina l'ha riaperta");
    db.run("UPDATE tasks SET reopened_actor = 'system' WHERE id = ?", [id]);
    expect(s.pendingHumanReopen({ taskId: id })).toBeNull();
  });

  test("le parole di PRIMA della riapertura restano fuori", () => {
    // Lo scarto e' di secondi, non di millisecondi: qui il commento appartiene
    // al giro precedente, e ripescarlo sarebbe rileggere una storia chiusa.
    const { id } = bocciata("roba vecchia", { scarto: 60_000 });
    expect(s.pendingHumanReopen({ taskId: id })).toBeNull();
  });

  test("una nota di servizio e la voce dell'agente non sono la voce di una persona", () => {
    const { id } = bocciata("l'obiezione vera");
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

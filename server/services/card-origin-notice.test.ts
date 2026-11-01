/**
 * La richiesta che diventa card si conferma nella chat d'origine: una riga
 * d'assistente con titolo e link, in coda alla catena, e una riga nel log per il
 * coordinatore. Nessun turno dell'agente parte da qui.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { cardOriginText, confirmCardOrigin } from "./card-origin-notice";

describe("conferma della richiesta diventata card", () => {
  let db: Database;
  let sent: any[];
  let logged: any[];
  const deps = () => ({
    db,
    broadcast: (m: any) => { sent.push(m); },
    recordActivity: (e: any) => { logged.push(e); },
  });
  const input = (over: Partial<Parameters<typeof confirmCardOrigin>[1]> = {}) => ({
    taskId: "task-1", projectId: "p1", title: "Sistemare il login", createdBy: "agent:session",
    sessionKey: "sk-1", topicId: "topic-1", ...over,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      blocks TEXT, partial INTEGER DEFAULT 0, timestamp TEXT, sort_order INTEGER, parent_id TEXT,
      branch_index INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE activity_log (id TEXT PRIMARY KEY)`);
    sent = [];
    logged = [];
  });

  test("il testo dice che è diventata una card, col titolo fra «» e il link alla card", () => {
    expect(cardOriginText("abc", "Sistemare il login")).toBe(
      "È diventata una card: «Sistemare il login». [Apri la card](/task/abc)",
    );
  });

  test("titolo su più righe o troppo lungo resta una riga sola e tagliata", () => {
    const long = `prima riga\n\n${"x".repeat(300)}`;
    const text = cardOriginText("abc", long);
    expect(text).not.toContain("\n");
    expect(text.startsWith("È diventata una card: «prima riga x")).toBe(true);
    expect(text).toContain("…»");
    expect(text.endsWith("(/task/abc)")).toBe(true);
  });

  test("scrive una riga d'assistente in coda alla chat d'origine e la manda sul socket", () => {
    db.run(`INSERT INTO messages (id, session_key, role, content, sort_order, parent_id) VALUES ('m0', 'sk-1', 'user', 'chiedi', 0, NULL)`);
    const text = confirmCardOrigin(deps(), input());

    const row = db.query("SELECT role, content, sort_order, parent_id FROM messages WHERE session_key = 'sk-1' AND id != 'm0'").get() as any;
    expect(row.role).toBe("assistant");
    expect(row.content).toBe(text);
    expect(row.sort_order).toBe(1);
    expect(row.parent_id).toBe("m0");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "message:new", topicId: "topic-1", sessionKey: "sk-1", role: "assistant", content: text });
  });

  test("lascia una traccia nel log attività per il coordinatore, con chi l'ha aperta", () => {
    confirmCardOrigin(deps(), input({ createdBy: "agent:coordinator" }));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      category: "board", level: "info", entityType: "task", entityId: "task-1",
      actor: "agent:coordinator", sessionKey: "sk-1",
      metadata: { projectId: "p1", createdBy: "agent:coordinator", topicId: "topic-1" },
    });
  });

  test("se la chat non si lascia scrivere non lancia e non registra come riuscita", () => {
    db.run("DROP TABLE messages");
    expect(confirmCardOrigin(deps(), input())).toBeNull();
    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(0);
  });
});

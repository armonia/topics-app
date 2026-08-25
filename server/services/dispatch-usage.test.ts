/**
 * @covers USAGE-16
 */
// La BARRA numero 2: il consumo delle figlie compare su `agent_tokens` del task
// padre.
//
// Il test arriva fino alla COLONNA, non si ferma alla somma: fra il lettore e la
// card c'è la sottrazione del dispatcher (`max(0, fine - inizio)`), ed è li' che
// una somma che scende diventa uno zero. Provare solo `read()` lascerebbe scoperto
// esattamente il pezzo che si rompe quando una figlia finisce dentro il turno.
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDispatchUsageReader } from "./dispatch-usage";
import { ZERO_USAGE, type SessionUsage } from "./transcript-usage";
import { createTaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

/** Un consumo finto: quel che conta qui e' che i numeri si sommino. */
function usage(billable: number, cacheRead = 0): SessionUsage {
  return { ...ZERO_USAGE, inputTokens: billable, billableTokens: billable, cacheReadTokens: cacheRead };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, jsonl_path TEXT)`);
  // `terminal_sessions` arriva da TASKS_FK_STUBS_DDL: il claim la legge.
  return db;
}

/** Il transcript di una sessione, indicizzato dal percorso che il lettore chiede. */
function harness(db: Database) {
  const byPath = new Map<string, SessionUsage>();
  const reader = createDispatchUsageReader({
    db,
    read: (p) => byPath.get(p) ?? ZERO_USAGE,
    transcriptPath: (cwd, id) => `${cwd}/${id}.jsonl`,
  });
  return {
    reader,
    /** La sessione del coordinatore e il suo transcript. */
    parent(sessionKey: string, u: SessionUsage) {
      db.run("INSERT OR REPLACE INTO claude_code_sessions (session_key, jsonl_path) VALUES (?, ?)", [sessionKey, `/p/${sessionKey}.jsonl`]);
      byPath.set(`/p/${sessionKey}.jsonl`, u);
    },
    /** Una figlia con il suo transcript. */
    child(id: string, parentSessionKey: string, u: SessionUsage) {
      db.run(
        "INSERT OR REPLACE INTO terminal_sessions (id, name, cwd, type, created_at, claude_session_id, status, parent_session_key) VALUES (?, ?, '/w', 'claude-code', '2026-08-12', ?, 'active', ?)",
        [id, id, id, parentSessionKey],
      );
      byPath.set(`/w/${id}.jsonl`, u);
    },
    grow(path: string, u: SessionUsage) { byPath.set(path, u); },
  };
}

describe("il consumo delle figlie e' consumo del padre", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("la lettura del padre somma il suo transcript e quelli delle figlie", () => {
    const h = harness(db);
    h.parent("topic:c", usage(1_000, 500));
    h.child("kid-1", "topic:c", usage(40_000, 900_000));
    h.child("kid-2", "topic:c", usage(60_000, 100_000));
    const u = h.reader.read("topic:c");
    expect(u.billableTokens).toBe(101_000);
    expect(u.cacheReadTokens).toBe(1_000_500);
    // E le due meta' restano separabili: il coordinamento e' il thread.
    expect(h.reader.readChildren("topic:c").billableTokens).toBe(100_000);
  });

  test("le figlie di un'ALTRA sessione non entrano nel conto", () => {
    const h = harness(db);
    h.parent("topic:c", usage(1_000));
    h.child("kid-1", "topic:c", usage(10_000));
    h.child("estranea", "topic:altro", usage(999_000));
    expect(h.reader.read("topic:c").billableTokens).toBe(11_000);
  });

  test("una figlia che MUORE dentro il turno lascia i suoi token: la lettura non scende", () => {
    const h = harness(db);
    h.parent("topic:c", usage(1_000));
    h.child("kid-1", "topic:c", usage(70_000));
    expect(h.reader.read("topic:c").billableTokens).toBe(71_000);
    // La figlia finisce: la sua riga sparisce, come fa la rotta di /stop.
    db.run("DELETE FROM terminal_sessions WHERE id = 'kid-1'");
    expect(h.reader.read("topic:c").billableTokens).toBe(71_000);
  });

  test("un transcript illeggibile vale l'ultimo valore noto, mai zero", () => {
    const h = harness(db);
    h.parent("topic:c", ZERO_USAGE);
    h.child("kid-1", "topic:c", usage(50_000));
    expect(h.reader.read("topic:c").billableTokens).toBe(50_000);
    h.grow("/w/kid-1.jsonl", ZERO_USAGE); // il file si e' fatto illeggibile
    expect(h.reader.read("topic:c").billableTokens).toBe(50_000);
  });
});

describe("dal lettore fino alla colonna", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("i token di due figlie finiscono su agent_tokens del task padre", () => {
    const h = harness(db);
    const svc = createTaskService(db);
    const task = svc.create({ projectId: "proj-a", text: "coordina" });
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-c' WHERE id = ?", [task.id]);

    // Inizio turno: il coordinatore ha appena aperto bocca, nessuna figlia.
    h.parent("topic:c", usage(2_000, 10_000));
    const usage0 = h.reader.read("topic:c");
    expect(usage0.billableTokens).toBe(2_000);

    // Il turno delega: due figlie lavorano, il coordinatore legge e decide.
    h.child("kid-1", "topic:c", usage(120_000, 3_000_000));
    h.child("kid-2", "topic:c", usage(80_000, 2_000_000));
    h.parent("topic:c", usage(5_000, 40_000));

    // Fine turno: esattamente il calcolo del dispatcher (recordUsage).
    const u1 = h.reader.read("topic:c");
    const after = svc.recordAgentUsage({
      taskId: task.id,
      addMs: 1_000,
      addTokens: Math.max(0, u1.billableTokens - usage0.billableTokens),
      addCacheReadTokens: Math.max(0, u1.cacheReadTokens - usage0.cacheReadTokens),
    });
    // 3k di coordinamento + 200k di lavoro delegato.
    expect(after.agentTokens).toBe(203_000);
    expect(after.agentCacheReadTokens).toBe(5_030_000);
  });
});

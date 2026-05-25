import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMasterIngest } from "./master-ingest";
import { GLOBAL_BOARD_ID } from "./master-proposals";

// Minimal real schema: tasks (001 + migration 026 columns) + task_events (026).
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    text TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('backlog','todo','in_progress','review','done')),
    priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0,
    assigned_to TEXT, fingerprint TEXT, due_date TEXT, chat_id TEXT,
    created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    assigned_topic_id TEXT, claude_task_id TEXT
  )`);
  db.run("CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL");
  db.run(`CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claude_task_id TEXT NOT NULL, topic_id TEXT NOT NULL,
    ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL
  )`);
  return db;
}

const sessions = [
  { topicId: "11111111-1111-4111-8111-111111111111", name: "Auth refactor" },
  { topicId: "terminal:abc", name: "Claude Code" },
];
const resolveProjectId = (id: string) => (id.startsWith("terminal:") ? null : "proj-" + id.slice(0, 4));

function ingest(db: Database, content: string, sink: unknown[] = []) {
  return runMasterIngest({
    db, resolveProjectId,
    broadcast: (m) => sink.push(m),
    leadTopicId: "lead-1", sessions, content,
  });
}

describe("runMasterIngest", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("APRI creates a todo proposal card bound to its topic", () => {
    const sink: any[] = [];
    const res = ingest(db, "## Next\n- APRI **Auth refactor** — rispondi alla domanda", sink);
    expect(res.proposals).toBe(1);
    const row = db.prepare("SELECT * FROM tasks").get() as any;
    expect(row.status).toBe("todo");
    expect(row.claude_task_id).toBeTruthy();
    expect(row.assigned_topic_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(row.chat_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(row.project_id).toBe("proj-1111");
    expect(row.text).toBe("Rispondi alla domanda");
    expect(sink[0]).toMatchObject({ type: "task:created" });
  });

  test("re-emitting the same session updates the same card (no duplicate)", () => {
    ingest(db, "## Next\n- APRI **Auth refactor** — primo testo");
    const sink: any[] = [];
    ingest(db, "## Next\n- APRI **Auth refactor** — testo aggiornato", sink);
    const rows = db.prepare("SELECT * FROM tasks").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Testo aggiornato");
    expect(sink[0]).toMatchObject({ type: "task:updated" });
  });

  test("COMPLETA flips the same card to done with completed_at", () => {
    ingest(db, "## Next\n- APRI **Auth refactor** — fai");
    ingest(db, "## Next\n- COMPLETA **Auth refactor** — fatto");
    const rows = db.prepare("SELECT * FROM tasks").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    expect(rows[0].completed_at).toBeTruthy();
  });

  test("terminal ref → no assigned_topic_id, chat_id holds ref, global board", () => {
    ingest(db, "## Next\n- COMPLETA Claude Code — la CLI è inattiva");
    const row = db.prepare("SELECT * FROM tasks").get() as any;
    expect(row.assigned_topic_id).toBeNull();
    expect(row.chat_id).toBe("terminal:abc");
    expect(row.project_id).toBe(GLOBAL_BOARD_ID);
    expect(row.status).toBe("done");
  });

  test("each ingest records a task_events proposal row", () => {
    ingest(db, "## Next\n- APRI **Auth refactor** — x");
    ingest(db, "## Next\n- COMPLETA **Auth refactor** — done");
    const ev = db.prepare("SELECT COUNT(*) AS n, MAX(type) AS t FROM task_events").get() as any;
    expect(ev.n).toBe(2);
    expect(ev.t).toBe("proposal");
    const payload = JSON.parse((db.prepare("SELECT payload FROM task_events LIMIT 1").get() as any).payload);
    expect(payload).toMatchObject({ ref: "11111111-1111-4111-8111-111111111111" });
  });

  test("no ## Next block → no cards, no events", () => {
    const res = ingest(db, "just a normal reply, nothing actionable");
    expect(res.proposals).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as any).n).toBe(0);
  });
});

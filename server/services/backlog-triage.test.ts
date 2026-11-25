/**
 * Backlog triage: a workable card goes to todo, a card that needs a person gets
 * its question and moves to review, and a card that looks done closes only with
 * a proof found by the code AND confirmed by a second model. Taking either half
 * of the proof away must turn the "stays" tests red.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb, svc as makeSvc, PID } from "./tasks-test-db";
import { runBacklogTriage, triageBoard, parseVerdicts, type TriageDeps } from "./backlog-triage";
import type { TaskService } from "./tasks";

let db: Database;
let s: TaskService;
// 2026-07-09 10:00 UTC is past the 07:00 slot in any timezone from UTC-3 to UTC+14; pin the clock to local noon instead.
const NOON = new Date(2026, 6, 9, 12, 0, 0).getTime();

beforeEach(() => {
  db = freshDb();
  db.run("ALTER TABLE board_settings ADD COLUMN backlog_triage INTEGER NOT NULL DEFAULT 0");
  db.run("CREATE TABLE backlog_triage_runs (board_id TEXT NOT NULL, slot TEXT NOT NULL, at TEXT NOT NULL, summary TEXT, PRIMARY KEY (board_id, slot))");
  s = makeSvc(db);
});

const card = (text: string, extra: Record<string, unknown> = {}) => s.create({ projectId: PID, text, status: "backlog", ...extra });
const statusOf = (id: string) => (db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
const commentsOf = (id: string) => (db.query("SELECT content FROM task_comments WHERE task_id = ?").all(id) as { content: string }[]).map((r) => r.content);

/** A model that answers the sorting with `verdicts` and the proof check with `verify`. */
const model = (verdicts: unknown[], verify = "YES"): TriageDeps["ask"] => async (_p, tier) => (tier === "triage" ? JSON.stringify(verdicts) : verify);

describe("triageBoard", () => {
  test("three cards: workable goes to todo, human decision asks and moves to review, done without proof stays", async () => {
    const a = card("add a retry to the exporter");
    const b = card("pick a pricing tier for the new plan");
    const c = card("fix the typo in the footer");
    const ask = model([
      { id: a.id, action: "todo", reason: "plain code change" },
      { id: b.id, action: "ask", reason: "spend", question: "Which tier?", options: ["Tier A", "Tier B"] },
      { id: c.id, action: "done", reason: "I think it was fixed" },
    ]);
    const report = await triageBoard(db, s, PID, { ask, commitOnMain: () => true });
    expect(report).toEqual({ todo: 1, ask: 1, done: 0, stay: 1 });
    expect(statusOf(a.id)).toBe("todo");
    expect(statusOf(b.id)).toBe("review");
    expect(commentsOf(b.id).some((t) => t.includes("Which tier?") && t.includes("- Tier A"))).toBe(true);
    expect(statusOf(c.id)).toBe("backlog");
    expect(commentsOf(c.id).join()).toContain("no verified proof");
  });

  test("a done card with a commit on main and a confirming second model closes", async () => {
    const c = card("fix the typo in the footer");
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "done", reason: "fixed", proof: "commit:abc1234" }], "YES, it covers it"), commitOnMain: () => true });
    expect(statusOf(c.id)).toBe("done");
  });

  test("a proof the code cannot find does not close, even when the second model agrees", async () => {
    const c = card("fix the typo in the footer");
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "done", reason: "fixed", proof: "commit:abc1234" }], "YES"), commitOnMain: () => false });
    expect(statusOf(c.id)).toBe("backlog");
  });

  test("a proof the second model rejects does not close, even when the code finds it", async () => {
    const c = card("fix the typo in the footer");
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "done", reason: "fixed", proof: "commit:abc1234" }], "NO, it covers half"), commitOnMain: () => true });
    expect(statusOf(c.id)).toBe("backlog");
  });

  test("a card proof must name a finished card of the same board", async () => {
    const other = s.create({ projectId: PID, text: "the work", status: "todo" });
    db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [other.id]);
    const c = card("do the work");
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "done", reason: "done by that card", proof: `card:${other.id}` }]), commitOnMain: () => false });
    expect(statusOf(c.id)).toBe("done");
    const d = card("do other work");
    await triageBoard(db, s, PID, { ask: model([{ id: d.id, action: "done", reason: "x", proof: "card:no-such-card" }]), commitOnMain: () => false });
    expect(statusOf(d.id)).toBe("backlog");
  });

  test("an open blocker overrules the model's todo", async () => {
    const blocker = s.create({ projectId: PID, text: "first", status: "todo" });
    const c = card("second", { blockedByTaskId: blocker.id });
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "todo", reason: "ok" }]) });
    expect(statusOf(c.id)).toBe("backlog");
  });

  test("a model that cannot be asked leaves the backlog alone", async () => {
    const c = card("anything");
    await triageBoard(db, s, PID, { ask: async () => { throw new Error("no model connected"); } });
    expect(statusOf(c.id)).toBe("backlog");
  });
});

describe("runBacklogTriage", () => {
  test("off by default, and a switched-on board is sorted once per slot", async () => {
    const c = card("add a retry");
    let calls = 0;
    const ask: TriageDeps["ask"] = async () => { calls++; return JSON.stringify([{ id: c.id, action: "stay", reason: "idea" }]); };
    expect(await runBacklogTriage(db, s, { now: () => NOON, ask })).toEqual({});
    db.run("INSERT OR IGNORE INTO board_settings (project_id) VALUES (?)", [PID]);
    db.run("UPDATE board_settings SET backlog_triage = 1 WHERE project_id = ?", [PID]);
    await runBacklogTriage(db, s, { now: () => NOON, ask });
    await runBacklogTriage(db, s, { now: () => NOON + 60_000, ask });
    expect(calls).toBe(1);
  });

  test("nothing runs before the first slot of the day", async () => {
    db.run("INSERT OR IGNORE INTO board_settings (project_id) VALUES (?)", [PID]);
    db.run("UPDATE board_settings SET backlog_triage = 1 WHERE project_id = ?", [PID]);
    let calls = 0;
    await runBacklogTriage(db, s, { now: () => new Date(2026, 6, 9, 3, 0, 0).getTime(), ask: async () => { calls++; return "[]"; } });
    expect(calls).toBe(0);
  });
});

describe("parseVerdicts", () => {
  test("reads a fenced array and drops unknown actions", () => {
    expect(parseVerdicts('```json\n[{"id":"a","action":"todo","reason":"r"},{"id":"b","action":"nope"}]\n```').map((v) => v.id)).toEqual(["a"]);
    expect(parseVerdicts("not json")).toEqual([]);
  });
});

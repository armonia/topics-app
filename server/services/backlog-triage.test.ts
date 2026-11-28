/**
 * @covers KANBAN-125
 * Backlog triage: a workable card goes to todo, a card that needs a person gets
 * its question and moves to review, and a card that looks done closes only with
 * a proof found by the code AND confirmed by a second model. Taking either half
 * of the proof away must turn the "stays" tests red.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { freshDb, svc as makeSvc, PID } from "./tasks-test-db";
import { runBacklogTriage, triageBoard, parseVerdicts, type TriageDeps } from "./backlog-triage";
import type { TaskService } from "./tasks";

let db: Database;
let s: TaskService;
// 2026-07-09 10:00 UTC is past the 07:00 slot in any timezone from UTC-3 to UTC+14; pin the clock to local noon instead.
const NOON = new Date(2026, 6, 9, 12, 0, 0).getTime();

beforeEach(() => {
  db = freshDb();
  db.exec(readFileSync(join(import.meta.dir, "../db/migrations/20261125100000-board-backlog-triage.sql"), "utf8"));
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
    expect(commentsOf(b.id).filter((t) => t.includes("Which tier?")).length).toBe(1);
    expect(commentsOf(b.id).join()).not.toContain("Consegna non leggibile");
    const row = db.query("SELECT delivered_by, dispatch_state, human_ask FROM tasks WHERE id = ?").get(b.id) as Record<string, string | null>;
    expect(row).toMatchObject({ delivered_by: "system", dispatch_state: "needs_input", human_ask: "Which tier?" });
    expect((db.query("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").get(b.id) as { n: number }).n).toBe(0);
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

describe("backlog dead ends", () => {
  test("a card whose blocker is done moves to todo", async () => {
    const blocker = s.create({ projectId: PID, text: "first", status: "todo" });
    db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [blocker.id]);
    const c = card("second", { blockedByTaskId: blocker.id });
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "todo", reason: "blocker is done" }]) });
    expect(statusOf(c.id)).toBe("todo");
  });

  test("a subtask moves to todo and keeps its parent, with no approval row", async () => {
    const parent = s.create({ projectId: PID, text: "parent", status: "in_progress" });
    const step = card("step", { parentTaskId: parent.id });
    await triageBoard(db, s, PID, { ask: model([{ id: step.id, action: "todo", reason: "workable" }]) });
    const row = db.query("SELECT status, parent_task_id AS p FROM tasks WHERE id = ?").get(step.id) as { status: string; p: string | null };
    expect(row).toEqual({ status: "todo", p: parent.id });
    expect((db.query("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").get(step.id) as { n: number }).n).toBe(0);
  });

  test("a done verdict does not close when there is no second model", async () => {
    const c = card("fix the typo in the footer");
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "done", reason: "fixed", proof: "commit:abc1234" }]), commitOnMain: () => true, hasSecondModel: () => false });
    expect(statusOf(c.id)).toBe("backlog");
  });
});

describe("who the history names", () => {
  const statusLines = (id: string) => (db.query("SELECT author, content FROM task_comments WHERE task_id = ? AND kind = 'status'").all(id) as { author: string; content: string }[]);

  test("a closed card says the system closed it, and the proof is in the thread", async () => {
    const c = card("fix the typo in the footer");
    await triageBoard(db, s, PID, { ask: model([{ id: c.id, action: "done", reason: "fixed", proof: "commit:abc1234" }]), commitOnMain: () => true });
    expect(statusOf(c.id)).toBe("done");
    expect((db.query("SELECT done_actor FROM tasks WHERE id = ?").get(c.id) as { done_actor: string }).done_actor).toBe("system");
    expect(statusLines(c.id).some((l) => l.author === "backlog-triage" && l.content.includes("done"))).toBe(true);
    expect(commentsOf(c.id).join()).toContain("commit:abc1234");
  });

  test("a system close without a proof is refused by the gate", () => {
    const c = card("anything");
    expect(() => s.update({ taskId: c.id, actor: "agent", by: "backlog-triage", patch: { status: "done" }, systemAction: { reason: "backlog_triage" } })).toThrow(/only a human/);
    expect(statusOf(c.id)).toBe("backlog");
  });

  test("an ask goes through the service: the history records the move to review", async () => {
    const b = card("pick a pricing tier");
    await triageBoard(db, s, PID, { ask: model([{ id: b.id, action: "ask", reason: "spend", question: "Which tier?", options: ["A", "B"] }]) });
    expect(statusLines(b.id).some((l) => l.author === "backlog-triage" && l.content.includes("review"))).toBe(true);
  });
});

describe("on main means on origin after a fetch", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: gitEnv() }).trim();

  test("a commit only on origin/main counts, one only on the local main does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "triage-git-"));
    try {
      const origin = join(root, "origin.git");
      const work = join(root, "work");
      git(root, "init", "--bare", "-b", "main", origin);
      git(root, "clone", origin, work);
      git(work, "commit", "--allow-empty", "-m", "base");
      git(work, "push", "origin", "HEAD:main");
      git(work, "commit", "--allow-empty", "-m", "published");
      git(work, "push", "origin", "HEAD:main");
      const published = git(work, "rev-parse", "HEAD");
      // The local main falls behind the remote and gains a commit nobody published.
      git(work, "reset", "--hard", "HEAD~1");
      git(work, "commit", "--allow-empty", "-m", "local only");
      const localOnly = git(work, "rev-parse", "HEAD");
      db.run("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT)");
      db.run("INSERT OR REPLACE INTO projects (id, path) VALUES (?, ?)", [PID, work]);
      const a = card("published work");
      const b = card("local work");
      await triageBoard(db, s, PID, { ask: model([
        { id: a.id, action: "done", reason: "x", proof: `commit:${published}` },
        { id: b.id, action: "done", reason: "x", proof: `commit:${localOnly}` },
      ]) });
      expect(statusOf(a.id)).toBe("done");
      expect(statusOf(b.id)).toBe("backlog");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/**
 * A resumed turn that hands in the tip that was just sent back, with no word
 * from the agent, must not reach review (and so must not open a CI run).
 * First time: back to todo with the reason. Second time: review, flagged.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { type Database } from "bun:sqlite";
import { freshDb } from "./tasks-test-db";
import { createTaskService } from "./tasks";

function seed(db: Database, svc: ReturnType<typeof createTaskService>, priorCommit: string | null): string {
  const t = svc.create({ text: "feat", projectId: "pX" });
  db.run("INSERT INTO topics (id) VALUES ('t1') ON CONFLICT DO NOTHING");
  db.prepare(
    "UPDATE tasks SET status = 'in_progress', assigned_topic_id = 't1', dispatch_attempts = 1, prior_commit = ? WHERE id = ?",
  ).run(priorCommit, t.id);
  db.prepare(
    "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)",
  ).run("st-1", t.id, "dispatcher", "in_progress->in_progress", "status", new Date().toISOString());
  return t.id;
}

describe("deliverToReviewBySystem: same tip as the one sent back", () => {
  let db: Database;
  let svc: ReturnType<typeof createTaskService>;
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

  test("same tip, no summary: back to todo with the reason, no review", () => {
    const id = seed(db, svc, "e4dd6c92");
    const out = svc.deliverToReviewBySystem({ taskId: id, reason: "", deliveredTip: "e4dd6c92" });
    expect(out.status).toBe("todo");
    expect(svc.get(id)!.comments.some((c) => c.content.includes("stesso commit"))).toBe(true);
  });

  test("second time: review flagged as no work done", () => {
    const id = seed(db, svc, "e4dd6c92");
    svc.deliverToReviewBySystem({ taskId: id, reason: "", deliveredTip: "e4dd6c92" });
    db.prepare("UPDATE tasks SET status = 'in_progress', assigned_topic_id = 't1' WHERE id = ?").run(id);
    const out = svc.deliverToReviewBySystem({ taskId: id, reason: "", deliveredTip: "e4dd6c92" });
    expect(out.status).toBe("review");
    expect(svc.get(id)!.comments.some((c) => c.content.startsWith("Nessun lavoro fatto"))).toBe(true);
  });

  test("a new tip goes to review as usual", () => {
    const id = seed(db, svc, "e4dd6c92");
    const out = svc.deliverToReviewBySystem({ taskId: id, reason: "", deliveredTip: "f00dfeed" });
    expect(out.status).toBe("review");
  });
});

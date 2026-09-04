/**
 * The gate on the ROUND-TRIP of a comment's kind.
 *
 * A kind is a mark the writer sets so a reader can act on it. That only works
 * if the mark survives the trip to disk and back, and `rowToComment` is the one
 * place it can die: it whitelists the kinds it knows and reduces everything
 * else to 'comment'. A kind missing from that whitelist is written correctly,
 * stored correctly, and read back WRONG - by both `addComment` (which returns
 * the row it just inserted) and `get()` (which feeds
 * `GET /api/boards/:pid/tasks/:id` and therefore the whole client).
 *
 * That is exactly how the dispatcher's `kind: 'service'` mark - set at 13 call
 * sites so the thread can fold a wall of bookkeeping without matching on
 * wording - reached the client stripped. Every mark was written, none arrived,
 * and the feature it exists for could only ever work on rows nobody was
 * writing any more. The failure is silent by construction: the row still shows,
 * the fold just never folds, and no type error is possible because the mapper
 * satisfies its return type by lying.
 *
 * So the test asserts the mark end to end, on both readers, plus the fallback
 * that keeps an unknown value harmless. Adding a kind to `TaskComment` without
 * adding it here leaves the same hole open.
 *
 * @covers THREAD-03
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { isServiceComment } from "../../shared/task-comment-service";
import { freshDb } from "./tasks-test-db";


const PID = "topics-app-abc123";

describe("a comment's kind survives the round-trip", () => {
  let db: Database; let s: TaskService; let taskId: string;
  beforeEach(() => {
    db = freshDb();
    let n = 0;
    s = createTaskService(db, { now: () => "2026-08-13T09:00:00.000Z", uuid: () => `id-${++n}` });
    taskId = s.create({ projectId: PID, text: "Fold the dispatcher's bookkeeping" }).id;
  });

  test("addComment gives back the 'service' mark it was handed", () => {
    const written = s.addComment({
      taskId, author: "system", kind: "service",
      content: "In attesa di uno slot: il tetto di concorrenza (3) e' pieno.",
    });
    expect(written.kind).toBe("service");
  });

  test("the mark reaches the disk", () => {
    s.addComment({ taskId, author: "system", kind: "service", content: "Riavvio del server: ripreso in diretta." });
    const row = db.prepare("SELECT kind FROM task_comments WHERE task_id = ?").get(taskId) as { kind: string };
    expect(row.kind).toBe("service");
  });

  test("get() - the reader behind the API and the whole client - keeps it", () => {
    s.addComment({ taskId, author: "system", kind: "service", content: "Riavvio del server: ripreso in diretta." });
    const comments = s.get(taskId)?.comments ?? [];
    expect(comments.map((c) => c.kind)).toEqual(["service"]);
  });

  test("a marked note is service to the thread even when its wording is brand new", () => {
    // The whole point of marking at the source: a REWORDED note keeps folding.
    // No entry in the legacy wording list can match this text.
    const written = s.addComment({
      taskId, author: "system", kind: "service",
      content: "Zzz un testo che nessuna regola di scrittura ha mai visto.",
    });
    expect(isServiceComment(written)).toBe(true);
  });

  test("the other kinds still round-trip, and an unknown one falls back to 'comment'", () => {
    const note = s.addComment({ taskId, author: "verifier", kind: "review-note", content: "Anteprima live." });
    expect(note.kind).toBe("review-note");
    const plain = s.addComment({ taskId, author: "user", content: "Guardo io." });
    expect(plain.kind).toBe("comment");
    // A row already on disk with a kind nobody knows must read as a plain
    // comment: an unrecognised mark costs a VISIBLE row, never a hidden one.
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?,?,?,?,?,?)")
      .run("stray-1", taskId, "system", "Un domani che non conosciamo.", "future-kind", "2026-08-13T09:00:01.000Z");
    const stray = (s.get(taskId)?.comments ?? []).find((c) => c.id === "stray-1");
    expect(stray?.kind).toBe("comment");
  });

  /**
   * The anchor is a mark like the kind, and it dies in the same one place: a
   * mapper that forgets it satisfies its return type by saying "no anchor",
   * which is exactly what a row written before the column says. Nothing would
   * fail; the thread would simply stop relating a comment to the step that
   * produced it.
   */
  test("the message anchor round-trips through both readers", () => {
    const anchored = s.addComment({ taskId, author: "agent", content: "Fatto, guarda /demo.", messageId: "m1" }); // allow-italian: comment body a card really carries
    expect(anchored.messageId).toBe("m1");
    const fromGet = (s.get(taskId)?.comments ?? []).find((c) => c.id === anchored.id);
    expect(fromGet?.messageId).toBe("m1");
  });

  test("a comment nobody anchored reads as no anchor, never as an error", () => {
    const plain = s.addComment({ taskId, author: "user", content: "Guardo io domani." }); // allow-italian: comment body a card really carries
    expect(plain.messageId).toBeNull();
  });
});

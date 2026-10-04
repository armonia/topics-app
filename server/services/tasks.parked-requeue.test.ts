/**
 * A parked card that stops waiting switches its subject off, and its history
 * row with it (ATTN-04, T15, NOTIF-SEEN-01; defects D4 and F3).
 *
 * Today only an exit from `review` clears `task:<id>` rows: a parked card put
 * back in the queue ("Rimetti in coda" = PATCH status todo), archived, or
 * closed keeps its `task-parked` row unseen on the bell and the Dock until the
 * panel is opened.
 *
 * The card's state is an input of the attention store, written by the task
 * service at every transition: the store is what announces, so the row of the
 * park is the store's own.
 * @covers ATTN-04
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import { createTaskService } from "./tasks";
import { freshDb } from "./tasks-test-db";
import { configureAttentionStore, getAttention, resetAttentionStore } from "../attention/store";
import { taskSubject } from "../../shared/attention";

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "parked-requeue-attn-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const real = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(real)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(real, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ announce: () => {}, announceSeen: () => {}, isTopicArchived: () => false });
});
afterAll(() => { __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeEach(() => {
  resetAttentionStore();
  getDatabase().run("DELETE FROM notification_log");
  // The store's table outlives a test like it outlives a restart: each case starts empty.
  getDatabase().run("DELETE FROM subject_attention");
  configureAttentionStore({ sendPush: () => {} });
});

const PID = "proj-notif";
function svc() {
  let n = 0; let clock = 0;
  return createTaskService(freshDb(), { now: () => new Date(Date.UTC(2026, 9, 3, 9, clock++)).toISOString(), uuid: () => `task-${Date.now()}-${++n}` });
}
const mv = (s: ReturnType<typeof svc>, taskId: string, status: string) =>
  s.update({ taskId, actor: "human", by: "user", patch: { status: status as never } });

function park(s: ReturnType<typeof svc>, text: string) {
  const t = s.create({ projectId: PID, text });
  mv(s, t.id, "todo");
  s.release({ taskId: t.id, requeue: false, parkState: "failed", reason: "nessuna consegna" });
  return t;
}

const unseenRows = (taskId: string) =>
  (getDatabase().query("SELECT COUNT(*) AS c FROM notification_log WHERE group_key = ? AND seen_at IS NULL").get(taskSubject(taskId)) as { c: number }).c;

describe("a parked card", () => {
  test("is needs-you(parked), with one unseen row of its own", () => {
    const s = svc();
    const t = park(s, "parcheggiata");
    expect(getAttention(taskSubject(t.id))).toMatchObject({ state: "needs-you", reason: "parked", lit: true, epoch: 1 });
    expect(unseenRows(t.id)).toBe(1);
  });

  test("put back in the queue: the subject switches off and the task-parked row is seen", () => {
    const s = svc();
    const t = park(s, "rimessa in coda");
    mv(s, t.id, "todo");
    expect(getAttention(taskSubject(t.id)).lit).toBe(false);
    expect(unseenRows(t.id)).toBe(0);
  });

  test("archived: the same", () => {
    const s = svc();
    const t = park(s, "archiviata");
    s.archive({ taskId: t.id, projectId: PID });
    expect(getAttention(taskSubject(t.id)).lit).toBe(false);
    expect(unseenRows(t.id)).toBe(0);
  });

  test("closed by hand (done): the same", () => {
    const s = svc();
    const t = park(s, "chiusa");
    mv(s, t.id, "done");
    expect(getAttention(taskSubject(t.id)).lit).toBe(false);
    expect(unseenRows(t.id)).toBe(0);
  });

  test("a card that enters review lights once; another write to it does not make a second epoch", () => {
    const s = svc();
    const t = s.create({ projectId: PID, text: "in review" });
    mv(s, t.id, "review");
    expect(getAttention(taskSubject(t.id))).toMatchObject({ state: "needs-you", reason: "review", epoch: 1 });
    // Another write to the card in review (its priority) is the same fact.
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { priority: 1 as never } });
    expect(getAttention(taskSubject(t.id)).epoch).toBe(1);
    mv(s, t.id, "done");
    expect(getAttention(taskSubject(t.id)).lit).toBe(false);
    expect(unseenRows(t.id)).toBe(0);
  });
});

describe("a step pulled out of review by a new session of its parent", () => {
  test("bindTopic with a fresh session puts the step back in todo and switches its subject off (ATTN-04)", () => {
    const db = freshDb();
    db.run("INSERT INTO topics (id) VALUES ('old-topic'), ('new-topic')");
    let n = 0; let clock = 0;
    const s = createTaskService(db, { now: () => new Date(Date.UTC(2026, 9, 3, 9, clock++)).toISOString(), uuid: () => `bind-${++n}` });
    const parent = s.create({ projectId: PID, text: "parent" });
    s.bindTopic({ taskId: parent.id, topicId: "old-topic" });
    const step = s.create({ projectId: PID, text: "step", parentTaskId: parent.id, createdByTopicId: "old-topic" });
    const parked = s.create({ projectId: PID, text: "parked step", parentTaskId: parent.id, createdByTopicId: "old-topic" });
    mv(s, step.id, "review");
    mv(s, parked.id, "todo");
    s.release({ taskId: parked.id, requeue: false, parkState: "failed", reason: "nessuna consegna" });
    expect(getAttention(taskSubject(step.id))).toMatchObject({ state: "needs-you", reason: "review" });
    expect(getAttention(taskSubject(parked.id))).toMatchObject({ state: "needs-you", reason: "parked" });
    s.bindTopic({ taskId: parent.id, topicId: "new-topic", freshSession: true });
    expect((db.query("SELECT status FROM tasks WHERE id = ?").get(step.id) as { status: string }).status).toBe("todo");
    expect(getAttention(taskSubject(step.id)).lit).toBe(false);
    expect(getAttention(taskSubject(parked.id)).lit).toBe(false);
    expect(unseenRows(step.id)).toBe(0);
  });
});

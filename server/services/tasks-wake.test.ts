/**
 * «Rimanda a»: a card parked in `backlog` with a `wakeAt` one minute away goes
 * back to `todo` BY ITSELF after the tick passes that instant — no agent, no
 * external script.
 *
 * @covers KANBAN-126
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";
import { releaseWakingTasks } from "./tasks-wake";

describe("rimanda a una data", () => {
  let db: Database;
  let tasks: TaskService;
  let current: Date;

  beforeEach(() => {
    db = freshDb();
    current = new Date("2026-11-25T10:00:00.000Z");
    tasks = createTaskService(db, { now: () => current.toISOString() });
  });

  test("una card rimandata a +1 minuto torna in todo dopo il tick", () => {
    const task = tasks.create({ projectId: PID, text: "Riprendere dopo" });
    const wakeAt = new Date(current.getTime() + 60_000).toISOString();
    tasks.update({ taskId: task.id, actor: "human", by: "human", patch: { status: "backlog", wakeAt } });
    expect(tasks.get(task.id)?.task.status).toBe("backlog");

    // Before the instant: still parked.
    expect(releaseWakingTasks(db, tasks, () => current)).toEqual([]);
    expect(tasks.get(task.id)?.task.status).toBe("backlog");

    // The tick after the instant releases it.
    current = new Date(current.getTime() + 61_000);
    const released = releaseWakingTasks(db, tasks, () => current);
    expect(released.map((t) => t.id)).toEqual([task.id]);
    const after = tasks.get(task.id)?.task;
    expect(after?.status).toBe("todo");
    expect(after?.wakeAt).toBeUndefined();
  });

  test("una card spostata a mano fuori dal backlog perde il rimando", () => {
    const task = tasks.create({ projectId: PID, text: "Da rimandare" });
    const wakeAt = new Date(current.getTime() + 60_000).toISOString();
    tasks.update({ taskId: task.id, actor: "human", by: "human", patch: { status: "backlog", wakeAt } });

    tasks.update({ taskId: task.id, actor: "human", by: "human", patch: { status: "todo" } });

    current = new Date(current.getTime() + 61_000);
    expect(releaseWakingTasks(db, tasks, () => current)).toEqual([]);
  });

  test("una data nel passato è rifiutata", () => {
    const task = tasks.create({ projectId: PID, text: "Rimando impossibile" });
    const past = new Date(current.getTime() - 1000).toISOString();
    expect(() => tasks.update({ taskId: task.id, actor: "human", by: "human", patch: { status: "backlog", wakeAt: past } }))
      .toThrow();
  });
});

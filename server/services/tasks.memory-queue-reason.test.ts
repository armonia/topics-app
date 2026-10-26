/**
 * Memory waits keep a reason code on the task payload.
 * @covers KANBAN-97
 */
import { describe, expect, it } from "bun:test";
import { createTaskService } from "./tasks";
import { setDispatchBlock } from "./dispatch-block-signal";
import { freshDb } from "./tasks-test-db";

describe("memory queue task reasons", () => {
  it("does not attach a technical machine paragraph to a memory waiter", () => {
    const db = freshDb();
    db.run("UPDATE app_settings SET auto_dispatch = 1");
    const svc = createTaskService(db);
    const task = svc.create({ projectId: "memory-board", text: "task waiting for memory" });
    svc.update({ taskId: task.id, actor: "human", by: "owner", patch: { status: "todo" } });
    svc.setDispatchState({ taskId: task.id, state: "queued", error: "waiting-memory" });
    setDispatchBlock({
      kind: "resources",
      reason: "runtime nativo: pavimento 6 GB; costo prezza 4 GB; id a93ded4b1b47",
    });

    try {
      const result = svc.get(task.id)!.task;
      expect(result.dispatchError).toBe("waiting-memory");
      expect(JSON.stringify(result.queueReason)).not.toMatch(/runtime|pavimento|prezza|nativo|[0-9a-f]{8,}/i);
    } finally {
      setDispatchBlock(null);
      db.close();
    }
  });
});

/**
 * A LANDED PARENT DOES NOT GO BACK TO WORK WHEN ITS LAST STEP CLOSES.
 *
 * Measured on 18/08: a parent that had already delivered AND landed was sitting
 * in `review` only because of the `open_subtasks` gate. Closing the step with
 * `PATCH {status:"done"}` answered 200, and within two seconds the parent moved
 * to `in_progress` with an agent on top of it. Two damages: the agent restarts
 * on work that is already on main, in a fresh empty worktree; and the re-queue
 * wipes `landing_state`, so the card stops saying it landed while git still
 * says it did. The second is the one nobody sees.
 *
 * Two doors reach the parent from a step, and both are nailed here: the PATCH
 * that closes the step, and the COMMENT left on it (which used to reject the
 * root in review and resume the agent).
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("landed parent + closing its last subtask", () => {
  let db: Database; let broadcasts: any[];
  let resumed: Array<[string, string]>; let unblocked: string[]; let router: any;

  beforeEach(() => {
    db = freshDb(); broadcasts = []; resumed = []; unblocked = [];
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {},
      onBlockerDone: (id: string) => { unblocked.push(id); },
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    router = createTasksRouter(makeCtx(db, broadcasts), dispatcher);
  });

  /** A parent that delivered and landed, held in review by one open step. */
  async function landedParentWithOpenStep(): Promise<{ parent: string; step: string }> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const parent = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    const step = await (await call(router, "POST", "/api/boards/pX/tasks",
      { text: "step", parentTaskId: parent.id }))!.json();
    db.prepare(
      "UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review', delivery_branch = 'topics/x', " +
        "delivery_commit = 'abc1234', landing_state = 'landed' WHERE id = ?",
    ).run(parent.id);
    return { parent: parent.id, step: step.id };
  }

  const read = (id: string) => createTaskService(db).get(id)!.task;

  test("closing the step leaves the parent in review, still landed", async () => {
    const { parent, step } = await landedParentWithOpenStep();

    const res = await call(router, "PATCH", `/api/boards/pX/tasks/${step}`, { status: "done" });
    expect(res!.status).toBe(200);

    expect(read(step).status).toBe("done");
    expect(read(parent).status).toBe("review");      // approvable now, not working
    expect(read(parent).landingState).toBe("landed"); // the git fact survives
    expect(read(parent).deliveryCommit).toBe("abc1234");
    expect(resumed).toEqual([]);                      // no agent dispatched on merged work
  });

  test("a comment on the step does not reject a landed parent", async () => {
    const { parent, step } = await landedParentWithOpenStep();

    const res = await call(router, "POST", `/api/boards/pX/tasks/${step}/comments`, { content: "visto, ok" });
    expect(res!.status).toBe(201);

    expect(read(parent).status).toBe("review");
    expect(read(parent).landingState).toBe("landed");
    expect(resumed).toEqual([]);
  });

  test("a comment on a delivered but NOT landed parent still reaches the agent", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET assigned_topic_id = 'top-2', status = 'review', delivery_commit = 'def5678' WHERE id = ?",
    ).run(t.id);

    await call(router, "POST", `/api/boards/pX/tasks/${t.id}/comments`, { content: "manca un pezzo" });

    expect(read(t.id).status).toBe("in_progress"); // rejected back to work, as before
    expect(resumed).toEqual([[t.id, "manca un pezzo"]]);
  });
});

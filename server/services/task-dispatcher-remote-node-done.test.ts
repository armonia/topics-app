/**
 * A card closed while its remote run is alive (12/11, 17436204 and 403aad1f):
 * the run is cancelled on the node, the chip is cleared, and nothing the lane
 * does afterwards carries the card back out of `done`.
 *
 * @covers KANBAN-116
 */
import { describe, expect, it } from "bun:test";
import { TASK, dispatch, flush, harness, poll, report } from "./task-dispatcher-remote-node-test-support";

function closeAsDone(h: ReturnType<typeof harness>): void {
  h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [TASK]);
}

describe("a done card with a live remote run", () => {
  it("cancels the run on the node and clears the dispatch state", async () => {
    const events: { type: string }[] = [];
    const h = harness(
      { readRun: async () => report({ status: "in_progress", dispatchState: "working" }) },
      { broadcast: (e: { type: string }) => { events.push(e); } },
    );
    h.seed();
    await dispatch(h);
    expect(h.task().dispatchState).toBe("working");

    closeAsDone(h);
    await poll(h);

    expect(h.calls).toContain("cancel:run-1");
    expect(h.task().status).toBe("done");
    expect(h.task().dispatchState ?? null).toBeNull();
    // Nothing changed for a finished card, so nobody is told it was parked.
    expect(events.filter((e) => e.type === "task:parked")).toEqual([]);
  });

  it("a delivery arriving after the closure does not reopen the card", async () => {
    let answer = report({ status: "in_progress", dispatchState: "working" });
    const h = harness({ readRun: async () => answer });
    h.seed();
    await dispatch(h);

    closeAsDone(h);
    answer = report({ status: "review", dispatchState: null, deliveryBranch: "topics/late", deliveryCommit: "abc1234" });
    await poll(h, 3);

    const task = h.task();
    expect(task.status).toBe("done");
    expect(task.reopenedBy ?? null).toBeNull();
    expect(h.calls.filter((c) => c === "create")).toEqual(["create"]);
  });
});

describe("the system gates never move a done card", () => {
  it("deliverToReviewBySystem leaves it done", () => {
    const h = harness();
    h.seed();
    closeAsDone(h);
    h.svc.deliverToReviewBySystem({ taskId: TASK, reason: "late delivery" });
    expect(h.task().status).toBe("done");
    expect(h.task().reopenedBy ?? null).toBeNull();
  });

  it("deferForWait leaves it done", () => {
    const h = harness();
    h.seed();
    closeAsDone(h);
    h.svc.deferForWait({ taskId: TASK, reason: "wait for the node", minutes: 5 });
    expect(h.task().status).toBe("done");
  });

  it("release keeps the reason as a note and changes nothing else", async () => {
    const h = harness();
    h.seed();
    closeAsDone(h);
    h.svc.release({ taskId: TASK, requeue: true, reason: "worktree abandoned by the GC" });
    await flush();
    expect(h.task().status).toBe("done");
    expect(h.comments().some((c) => c.content.includes("abandoned by the GC"))).toBe(true);
  });
});

describe("a closure that lands while the lane is awaiting the node", () => {
  it("closed during readRun: the report is not mirrored and the run is cancelled", async () => {
    let close = false;
    const holder: { h?: ReturnType<typeof harness> } = {};
    const h = harness({
      readRun: async () => {
        if (close) closeAsDone(holder.h!);
        return report({ status: "in_progress", dispatchState: "working" });
      },
    });
    holder.h = h;
    h.seed();
    await dispatch(h);
    close = true;
    await poll(h);

    expect(h.calls).toContain("cancel:run-1");
    expect(h.task().status).toBe("done");
    expect(h.task().dispatchState ?? null).toBeNull();
  });

  it("closed during the delivery download: the delivery of the done card is not overwritten", async () => {
    let close = false;
    const holder: { h?: ReturnType<typeof harness> } = {};
    const h = harness({
      readRun: async () => report({ status: "review", dispatchState: null, deliveryBranch: "topics/late", deliveryCommit: "abc1234" }),
      bundle: new Uint8Array([1, 2, 3]),
      onBundle: () => { if (close) closeAsDone(holder.h!); },
    });
    holder.h = h;
    h.seed();
    await dispatch(h);
    h.db.run("UPDATE tasks SET delivery_branch = 'topics/final', delivery_commit = 'fff0000' WHERE id = ?", [TASK]);
    close = true;
    await poll(h, 3);

    const task = h.task();
    expect(task.status).toBe("done");
    expect(task.deliveryBranch).toBe("topics/final");
    expect(task.deliveryCommit).toBe("fff0000");
    expect(h.calls).toContain("cancel:run-1");
  });
});

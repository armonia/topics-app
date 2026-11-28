/**
 * @covers MACHINE-07
 * A card running on a NODE while the primary is handed over (track T4).
 *
 * A run on a THIRD node is neither waited for nor parked: the run lives on the node and
 * its id is in `tasks.node_run_id`, so it travels with the DB. What must hold is
 * that, from the fence on, the OLD primary stops asking the node and writes
 * nothing about the run, and the NEW primary, booting on the copy, reattaches
 * it and takes its delivery. A run on the DESTINATION is the opposite case (its restart kills the
 * run and its DB is set aside): the drain waits for it and, at the end of the wait, parks it.
 *
 * Same bench as the restart file: a fake node, a clock in a variable, every poll
 * one `reconcile` driven by hand.
 */
import { describe, expect, it } from "bun:test";
import { createDeliveryCapture, type DeliveryCapture, type DeliveryRef } from "./task-delivery-capture";
import { flush, dispatch, harness, report, MACHINE, TASK } from "./task-dispatcher-remote-node-test-support";

describe("a node run in flight during a primary switch", () => {
  const BRANCH = "topics/run-across-the-switch";

  it("the fenced old primary writes nothing about it; the new primary reattaches it and takes the delivery", async () => {
    const phase = { current: "running" as "running" | "review" };
    let primary = true;
    let capture: DeliveryCapture | null = null;
    const h = harness({
      bundle: new Uint8Array([1, 2, 3]),
      planted: { planted: true, commit: "c0ffeec0ffee", commitCount: 1, reason: null },
      readRun: () => Promise.resolve(phase.current === "review"
        ? report({ status: "review", deliveryBranch: BRANCH, deliveryCommit: "deadbeefdeadbeef", baseSha: "abcdef0123456789" })
        : report({ status: "in_progress" })),
    }, {
      // What the boot wires: `isThisServerPrimary`, which the switch fence turns false.
      isActive: () => primary,
      captureDelivery: (id) => (capture ? capture(id) : Promise.resolve(false)),
      measureDelivery: async () => {},
    });
    capture = createDeliveryCapture({
      svc: h.svc,
      taskDeliveryRef: async (): Promise<DeliveryRef> => ({ branch: BRANCH, commit: "c0ffeec0ffee", repoPath: "/tmp/alpha" }),
      taskCheckoutRef: async () => null,
      ownCommitFiles: async () => { throw new Error("no worktree to read"); },
      ownBranchFiles: async () => [],
    });
    h.seed();
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");

    // The fence: from the snapshot on the old primary is no longer active.
    primary = false;
    const snapshot = JSON.stringify({ task: h.task(), comments: h.comments() });
    const readsBefore = h.calls.filter((c) => c.startsWith("read:")).length;
    phase.current = "review"; // the node finishes while the DB travels
    for (let i = 0; i < 3; i++) {
      await h.dispatcher.reconcile({ reason: "poll" });
      await flush();
    }
    expect(h.calls.filter((c) => c.startsWith("read:")).length).toBe(readsBefore);
    expect(JSON.stringify({ task: h.task(), comments: h.comments() })).toBe(snapshot);

    // The new primary boots on that same DB: a fresh dispatcher, active.
    primary = true;
    const receiver = h.restart();
    await receiver.reconcile({ reason: "boot" });
    await flush();
    await receiver.reconcile({ reason: "poll" });
    await flush();
    expect(h.task().status).toBe("review");
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(h.calls.some((c) => c.startsWith("cancel"))).toBe(false);
  });

  it("a run on the DESTINATION is listed, and parking it cancels the run, clears node_run_id and requeues the card with the note", async () => {
    const h = harness({ readRun: () => Promise.resolve(report({ status: "in_progress" })) });
    h.seed();
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");
    const runId = h.db.query("SELECT node_run_id FROM tasks WHERE id = ?").get(TASK) as { node_run_id: string | null };
    expect(runId.node_run_id, "the card is tied to a live run").not.toBeNull();

    // The node being switched TO owns the run; a third node owns nothing here.
    expect(h.dispatcher.nodeRunsOn(MACHINE).map((r) => r.taskId)).toEqual([TASK]);
    expect(h.dispatcher.nodeRunsOn("some-other-node")).toEqual([]);
    expect(h.dispatcher.busyTurns(), "a node run is not a local turn").toEqual([]);

    expect(await h.dispatcher.parkNodeRun(TASK, "Passaggio del principale in corso")).toBe(true);

    expect(h.calls.some((c) => c.startsWith("cancel")), "the run is stopped on the node").toBe(true);
    const after = h.db.query("SELECT status, node_run_id, node_run_open FROM tasks WHERE id = ?").get(TASK) as
      { status: string; node_run_id: string | null; node_run_open: number | null };
    expect(after.node_run_id, "no card stays tied to a run that is gone").toBeNull();
    expect(after.status).toBe("todo");
    expect(h.dispatcher.nodeRunsOn(MACHINE)).toEqual([]);
    expect(h.comments().some((c) => c.content.includes("Passaggio del principale"))).toBe(true);
    // Not a node card: nothing to park.
    expect(await h.dispatcher.parkNodeRun("no-such-card", "x")).toBeNull();
  });
});

/**
 * A remote slot never turns into a zombie: a run the node parked itself, or a
 * card a person sent back to `todo`, must free the slot instead of mirroring
 * the node's old chip onto the card for ever (15/11: a card stayed `todo` +
 * `blocked` through every requeue until the server restarted).
 *
 * Kept apart from `task-dispatcher-remote-node.test.ts`, which sits at its
 * size ceiling (`check:bloat`).
 *
 * @covers KANBAN-76
 * @covers KANBAN-77
 */
import { describe, it, expect } from "bun:test";
import { TASK, MACHINE, report, harness, poll, dispatch, flush } from "./task-dispatcher-remote-node-test-support";

describe("lo slot remoto non resta zombie", () => {
  it("il nodo riporta la corsa parcheggiata (backlog + blocked): la card si parcheggia col motivo del nodo, lo slot si libera", async () => {
    const h = harness({
      readRun: () => Promise.resolve(report({
        status: "backlog",
        dispatchState: "blocked",
        reason: "runtime claude-code non disponibile per sonnet",
      })),
    });
    h.seed();
    await dispatch(h);
    expect(h.dispatcher.busyIds()).toContain(TASK);

    await poll(h);

    const t = h.task();
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("blocked");
    expect(t.dispatchError ?? "").toContain("runtime claude-code non disponibile per sonnet");
    expect(h.dispatcher.busyIds()).not.toContain(TASK);
  });

  it("la stessa card ci torna SOLO se la ci aveva pinnata l'overflow: pinnata a mano resta sul nodo", async () => {
    const h = harness({
      readRun: () => Promise.resolve(report({
        status: "backlog",
        dispatchState: "blocked",
        reason: "runtime claude-code non disponibile per sonnet",
      })),
    });
    h.seed();
    await dispatch(h);
    await poll(h);
    expect(h.task().machineId).toBe(MACHINE);
  });

  it("il nodo ha parcheggiato una card che l'OVERFLOW ci aveva messa: il pin si libera, un requeue non torna sullo stesso nodo rotto", async () => {
    const h = harness({
      readRun: () => Promise.resolve(report({
        status: "backlog",
        dispatchState: "blocked",
        reason: "runtime claude-code non disponibile per sonnet",
      })),
    });
    h.seed();
    h.db.run("UPDATE tasks SET overflowed_at = ? WHERE id = ?", [new Date(h.nowMs()).toISOString(), TASK]);
    await dispatch(h);
    await poll(h);

    const t = h.task();
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("blocked");
    expect(t.machineId).toBeNull();
  });

  it("a node with no agent for the model: the card leaves it unparked, no attempt spent, and each refusal adds a skipped node", async () => {
    const h = harness({
      readRun: () => Promise.resolve(report({
        status: "backlog",
        dispatchState: "failed",
        reason: 'No coding agent is available for model "claude-sonnet-5-5".',
      })),
    });
    h.seed();
    h.db.run("UPDATE tasks SET overflow_skip_machine = ?, overflow_skip_until = ? WHERE id = ?", ["other-node", "2999-01-01T00:00:00.000Z", TASK]);
    await dispatch(h);
    await poll(h);

    const t = h.task();
    expect(t.machineId ?? null).toBeNull();
    expect(t.overflowSkipMachines).toEqual(["other-node", MACHINE]);
  });

  it("PATCH umano a todo su una card con slot remoto ancora aperto: la corsa si cancella, lo slot si libera e la card riparte con una corsa nuova", async () => {
    const h = harness({
      readRun: () => Promise.resolve(report({ status: "backlog", dispatchState: "blocked" })),
    });
    h.seed();
    await dispatch(h);
    expect(h.dispatcher.busyIds()).toContain(TASK);

    // The PATCH a human control makes, not a direct DB write: `actor: "human"`
    // is what a PATCH back to `todo` carries, and it is what the fix reads.
    h.svc.update({ taskId: TASK, actor: "human", by: "person", patch: { status: "todo" } });

    // The SAME reconcile pass both frees the stale slot and re-dispatches the
    // card: the old run is cancelled, and the freed slot is picked up by the
    // ordinary queue logic before the pass ends, no second tick needed.
    await poll(h);

    expect(h.calls).toEqual(["create", "cancel:run-1", "create"]);
    expect(h.task().status).toBe("in_progress");
    expect(h.dispatcher.busyIds()).toContain(TASK);
  });

  it("restart with an open run whose chip the poll copied from the node (needs_input): reattached, nothing cancelled or recreated", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);

    // The poll copied the node's chip onto the card; a chip filter would have called this one done.
    h.db.run("UPDATE tasks SET dispatch_state = 'needs_input' WHERE id = ?", [TASK]);
    const h2 = harness({}, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();

    // The run is still open on the node: the reconcile reattaches it instead of
    // queueing over it, so the tick right after finds the card already busy.
    await dispatch(h2);
    const order = h2.calls.filter((c) => c === "create" || c.startsWith("cancel"));
    expect(order).toEqual([]);
    expect(h.task().status).toBe("in_progress");
  });

  it("a done card dragged back to In Progress by hand, with no open run, is not relaunched after a restart", async () => {
    const h = harness();
    h.seed();
    h.db.run("UPDATE tasks SET status = 'in_progress', dispatch_state = 'working' WHERE id = ?", [TASK]);
    const h2 = harness({}, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();
    await dispatch(h2);

    expect(h2.calls.filter((c) => c === "create" || c.startsWith("cancel"))).toEqual([]);
    expect(h.task().status).toBe("in_progress");
  });

  it("a card the SERVER cut before its run existed (no open run, interrupted_at after entering in progress) goes back to the queue and launches", async () => {
    const h = harness();
    h.seed();
    h.db.run(
      "UPDATE tasks SET status = 'in_progress', dispatch_state = NULL, in_progress_at = '2026-11-17T04:36:29.591Z', interrupted_at = '2026-11-17T04:37:06.055Z', interrupted_by = 'SIGTERM' WHERE id = ?",
      [TASK],
    );
    const h2 = harness({}, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();
    await dispatch(h2);

    expect(h2.calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("a stale interrupted_at from BEFORE the last entry in progress does not count: the hand-dragged card stays put", async () => {
    const h = harness();
    h.seed();
    h.db.run(
      "UPDATE tasks SET status = 'in_progress', dispatch_state = 'working', in_progress_at = '2026-11-18T10:00:00.000Z', interrupted_at = '2026-11-17T04:37:06.055Z' WHERE id = ?",
      [TASK],
    );
    const h2 = harness({}, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();
    await dispatch(h2);

    expect(h2.calls.filter((c) => c === "create" || c.startsWith("cancel"))).toEqual([]);
  });
});

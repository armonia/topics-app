/**
 * @covers MACHINE-07
 * A launch toward a node that is still in the air while the primary is handed over.
 *
 * The slot of a launch carries a `node:<machine>:pending` key from its first instant, and the
 * window before the slot (origin lookup, branch push) is a launch too: a switch to that machine
 * has to count both, wait for them and, at the end of the wait, park them. And when `createRun`
 * succeeds but the write that follows is refused by the fence, the run born on the node is
 * cancelled, or it works orphaned.
 *
 * Same bench as the other switch file: a fake node, a clock in a variable, an in-memory DB.
 */
import { describe, expect, it } from "bun:test";
import type { HookOutcome } from "./lifecycle-hooks";
import { flush, dispatch, harness, TASK, MACHINE } from "./task-dispatcher-remote-node-test-support";

/** A promise that settles when the test says so: the node answering late. */
function gate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const storedRun = (h: ReturnType<typeof harness>) =>
  (h.db.query("SELECT node_run_id FROM tasks WHERE id = ?").get(TASK) as { node_run_id: string | null }).node_run_id;

describe("a launch toward the destination, still waiting for createRun", () => {
  it("is counted as running on that machine (and only that one), and parking it requeues the card; the run born later is cancelled", async () => {
    const created = gate<{ runId: string }>();
    const h = harness({ createRun: () => created.promise });
    h.seed();
    await dispatch(h);
    // createRun is asked and has not answered: the card is in progress with no run id yet.
    expect(h.calls).toContain("create");
    expect(h.task().status).toBe("in_progress");
    expect(storedRun(h)).toBeNull();

    expect(h.dispatcher.nodeRunsOn(MACHINE), "the launch counts from the moment it starts").toEqual([{ taskId: TASK, sessionKey: `node:${MACHINE}:pending` }]);
    expect(h.dispatcher.nodeRunsOn("some-other-node")).toEqual([]);
    expect(h.dispatcher.busyTurns(), "a node launch is not a local turn").toEqual([]);

    // The wait is over: the launch is parked, the card is back in the queue with the note.
    expect(await h.dispatcher.parkNodeRun(TASK, "Passaggio del principale in corso")).toBe(true);
    expect(h.task().status).toBe("todo");
    expect(storedRun(h)).toBeNull();
    expect(h.dispatcher.nodeRunsOn(MACHINE)).toEqual([]);
    expect(h.comments().some((c) => c.content.includes("Passaggio del principale"))).toBe(true);

    // The node answers after the park: the run it just created has no owner and dies.
    created.resolve({ runId: "run-late" });
    await flush();
    expect(h.calls).toContain("cancel:run-late");
    expect(h.task().status, "the card does not go back to in_progress with a dead link").toBe("todo");
    expect(storedRun(h)).toBeNull();
    expect(h.dispatcher.nodeRunsOn(MACHINE)).toEqual([]);
    expect(h.comments().some((c) => c.content.includes("gira sul nodo"))).toBe(false);
  });

  it("is counted and parked while it is still looking up origin, before it holds a slot, and never creates a run", async () => {
    const origin = gate<string | null>();
    const h = harness({ originUrlOf: () => origin.promise });
    h.seed();
    await dispatch(h);
    expect(h.calls).not.toContain("create");

    expect(h.dispatcher.nodeRunsOn(MACHINE)).toEqual([{ taskId: TASK, sessionKey: `node:${MACHINE}:pending` }]);
    expect(await h.dispatcher.parkNodeRun(TASK, "Passaggio del principale in corso")).toBe(true);
    expect(h.task().status).toBe("todo");

    origin.resolve("git@github.com:acme/alpha.git");
    await flush();
    expect(h.calls, "a parked launch does not reach the node").not.toContain("create");
    expect(h.task().status).toBe("todo");
    expect(h.dispatcher.nodeRunsOn(MACHINE)).toEqual([]);
  });
});

describe("a launch parked while it still checks the checkout", () => {
  it("a check that fails after the park does not park the card over the switch's requeue", async () => {
    const identity = gate<{ name: string; email: string } | null>();
    const h = harness({ gitIdentityOf: () => identity.promise });
    h.seed();
    await dispatch(h);
    expect(await h.dispatcher.parkNodeRun(TASK, "Passaggio del principale in corso")).toBe(true);
    expect(h.task().status).toBe("todo");

    // No git identity: a launch that still owned the card would park it blocked in the backlog.
    identity.resolve(null);
    await flush();
    expect(h.task().status, "the card stays in the queue the switch put it in").toBe("todo");
    expect(h.calls).not.toContain("create");
  });
});

describe("a launch parked while the node-run hook or createRun is still answering", () => {
  /** A hook runner that answers when the test says so. */
  function slowHook() {
    const answer = gate<HookOutcome>();
    return { answer, hooks: { run: () => answer.promise } };
  }

  it.each([
    ["the hook says ok", { ok: true } as HookOutcome],
    ["the hook vetoes", { ok: false, reason: "asleep" } as HookOutcome],
  ])("%s after the park: the old run is cancelled, its link cleared, nothing is created and the card is not deferred", async (_name, outcome) => {
    const hook = slowHook();
    const h = harness({ hooks: hook.hooks });
    h.seed();
    h.db.run("UPDATE tasks SET node_run_id = 'run-old' WHERE id = ?", [TASK]);
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");
    expect(h.dispatcher.nodeRunsOn(MACHINE).map((r) => r.taskId)).toEqual([TASK]);

    expect(await h.dispatcher.parkNodeRun(TASK, "Passaggio del principale in corso")).toBe(true);
    // The launch has not cancelled the previous run yet: the park does it, and drops the link.
    expect(h.calls).toContain("cancel:run-old");
    expect(storedRun(h), "no card stays tied to a run that is gone").toBeNull();

    hook.answer.resolve(outcome);
    await flush();
    expect(h.calls, "a parked launch never creates a run").not.toContain("create");
    expect(h.task().status).toBe("todo");
    expect(h.comments().some((c) => c.content.includes("non è pronto")), "a veto after the park does not defer the card").toBe(false);
  });

  it("createRun failing after the park does not defer the card the park already requeued", async () => {
    const failing = gate<{ runId: string }>();
    const h = harness({ createRun: () => failing.promise });
    h.seed();
    await dispatch(h);
    expect(h.calls).toContain("create");
    expect(await h.dispatcher.parkNodeRun(TASK, "Passaggio del principale in corso")).toBe(true);
    const notesAfterPark = h.comments().length;

    // `createRun` rejects once the park is done; the deferral would add a wait note on a queued card.
    failing.reject(new Error("down"));
    await flush();
    expect(h.task().status).toBe("todo");
    expect(h.comments().length, "no second note on the card").toBe(notesAfterPark);
  });
});

describe("createRun succeeds but the write after it is refused by the fence", () => {
  it("cancels the run just born on the node", async () => {
    const created = gate<{ runId: string }>();
    const h = harness({ createRun: () => created.promise });
    h.seed();
    await dispatch(h);
    expect(h.calls).toContain("create");

    // The fence: the live handle turns `query_only`, the PRAGMA `setDatabaseReadOnly` runs.
    h.db.run("PRAGMA query_only = ON");
    created.resolve({ runId: "run-born" });
    await flush();

    expect(h.calls.filter((c) => c === "cancel:run-born"), "the run born under the fence is cancelled once").toHaveLength(1);
    expect(storedRun(h), "nothing points at the cancelled run").toBeNull();
  });
});

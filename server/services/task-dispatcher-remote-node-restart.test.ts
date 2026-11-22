/**
 * THE RESTART OF THE SERVER, for a card that was running on a NODE.
 *
 * A run open on a node is not memory-only any more (13/11): the run id lives on
 * `tasks.node_run_id`, the node's address and token live in `machines`. A restart has
 * everything it needs to ask the node instead of cancelling and re-dispatching over a run
 * that may be minutes from a commit - a card lost 257 files and a clean typecheck to this
 * three times in one morning (22/11, card 4a1a6d3d).
 *
 * So the whole question of this file is: WHEN is a reattach wrong? A run the node no longer
 * has, one it closed, one whose card was archived over there, one whose delivery this card
 * already refused, an authorization that is gone, a node that never answers, and a relaunch
 * that happened while we were asking. Every one of those goes back to the queue, which is
 * exactly what main did for all of them.
 *
 * Its own file, on the lane's shared bench (`task-dispatcher-remote-node-test-support.ts`):
 * the lane's main test file was at its size ceiling.
 *
 * No network and no sleeps: the node is a fake, the clock is a variable, and every poll is
 * one `reconcile` call driven by hand.
 *
 * @covers KANBAN-76
 * @covers KANBAN-77
 */
import { describe, it, expect } from "bun:test";
import { MIRROR_CANCEL_TIMEOUT_MS } from "./task-dispatcher-remote-node";
import { createDeliveryCapture, type DeliveryCapture, type DeliveryRef } from "./task-delivery-capture";
import { NodeError, type NodeRunReport } from "./node-client";
import { PID, TASK, report, delegatedPolicy, harness, flush, dispatch } from "./task-dispatcher-remote-node-test-support";

const RESTART_NOTE = "Il server è ripartito"; // allow-italian: the note the card really carries

describe("una corsa sul nodo sopravvive al riavvio del server", () => {
  const BRANCH = "topics/corsa-dopo-il-riavvio";

  function restartHarness(phase: { current: "running" | "unknown" | "review" }) {
    let capture: DeliveryCapture | null = null;
    const h = harness({
      bundle: new Uint8Array([1, 2, 3]),
      planted: { planted: true, commit: "c0ffeec0ffee", commitCount: 1, reason: null },
      readRun: () => {
        if (phase.current === "unknown") {
          return Promise.reject(new NodeError("not_found", "read run: 404", 404));
        }
        if (phase.current === "review") {
          return Promise.resolve(report({
            status: "review", deliveryBranch: BRANCH, deliveryCommit: "deadbeefdeadbeef", baseSha: "abcdef0123456789",
          }));
        }
        return Promise.resolve(report({ status: "in_progress" }));
      },
    }, {
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
    return h;
  }

  it("il nodo risponde ancora running: lo slot si riaggancia, resta in_progress, nessun nuovo create né cancel — e a review atterra come sempre", async () => {
    const phase: { current: "running" | "unknown" | "review" } = { current: "running" };
    const h = restartHarness(phase);
    h.seed();
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);

    // The restart: same db, same node, a brand-new dispatcher - `inFlight` is empty.
    const afterRestart = h.restart();
    await afterRestart.reconcile({ reason: "boot" });
    await flush();

    expect(h.task().status).toBe("in_progress");
    expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(false);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1); // no new run
    expect(h.calls.some((c) => c.startsWith("cancel"))).toBe(false); // no cancel of a live run

    phase.current = "review";
    await afterRestart.reconcile({ reason: "poll" });
    await flush();

    expect(h.task().status).toBe("review");
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("il nodo dice che la corsa non esiste: la card torna in coda con la nota del riavvio", async () => {
    const phase: { current: "running" | "unknown" | "review" } = { current: "unknown" };
    const h = restartHarness(phase);
    h.seed();
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");

    // No auto-dispatch past this point: the assertion is on the requeue itself,
    // not on whatever the ordinary tick does with a `todo` card right after.
    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    const afterRestart = h.restart();
    await afterRestart.reconcile({ reason: "boot" });
    await flush();

    expect(h.task().status).toBe("todo");
    expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(true);
  });

  // The four defects a verifier found running `3fd09f8f` instead of only reading it (22/11).

  // THE THREE CLOSED STATUSES, not just `done`: `backlog` is the node PARKING the run
  // itself (it waits for a human over there and will not move on its own), `stopped` is a
  // cut one. Reattaching to any of them keeps the seat busy forever over a run that will
  // never answer again, where main put the card back in the queue.
  for (const closed of ["done", "backlog", "stopped"]) {
    it(`il nodo dice che la corsa è chiusa (${closed}): non resta agganciata per sempre, torna in coda`, async () => {
      const h = harness({
        bundle: new Uint8Array([1]),
        readRun: () => Promise.resolve(report({ status: closed })),
      });
      h.seed();
      await dispatch(h);
      expect(h.task().status).toBe("in_progress");

      // A 200 for a cancelled, parked or finished run (routes/nodes.ts, the paired GET) must
      // not read as "still open": the mutant that drops the status check reattaches forever.
      h.svc.updateBoardSettings(PID, { autoDispatch: false });
      const afterRestart = h.restart();
      await afterRestart.reconcile({ reason: "boot" });
      await flush();

      expect(h.task().status).toBe("todo");
      expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(true);
    });
  }

  // THE CARD ARCHIVED ON THE NODE. The board's DELETE over there archives the subtree and
  // leaves the status where it was, so an archived run still answers `in_progress`: without
  // the `archived` bit the GET now sends, a reattach follows a card nobody will ever move.
  it("il nodo dice che la card della corsa è archiviata: torna in coda, anche se lo status è ancora in_progress", async () => {
    const h = harness({
      bundle: new Uint8Array([1]),
      readRun: () => Promise.resolve(report({ status: "in_progress", archived: true })),
    });
    h.seed();
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");

    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    const afterRestart = h.restart();
    await afterRestart.reconcile({ reason: "boot" });
    await flush();

    expect(h.task().status).toBe("todo");
    expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(true);
  });

  it("un rilancio concorrente durante il readRun non sovrascrive lo slot della corsa nuova, e la corsa nuova resta seguita", async () => {
    // The relaunch lands WHILE the stale readRun is still in the air: another path cancels
    // run-1 and starts run-2, the real `cancel + create` of an ordinary dispatch, slot and
    // all. Faking it with `setNodeRun` alone would prove nothing about who polls run-2.
    let relaunch: (() => Promise<void>) | null = null;
    const h = harness({
      bundle: new Uint8Array([1]),
      readRun: async (runId) => {
        if (runId === "run-1" && relaunch) {
          const go = relaunch;
          relaunch = null;
          await go();
        }
        return report({ status: "in_progress" });
      },
    });
    h.seed();
    await dispatch(h);
    expect(h.calls).toEqual(["create"]);

    const afterRestart = h.restart();
    relaunch = async () => {
      h.db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [TASK]);
      await afterRestart.tick(PID);
      await flush();
    };
    await afterRestart.reconcile({ reason: "boot" });
    await flush();

    expect(h.svc.nodeRunOf(TASK)).toBe("run-2");
    // The slot of run-2 is still held right after the boot, before any poll: a later poll
    // would also read run-2 by adopting the card as an orphan, so it cannot prove this.
    expect(afterRestart.isInFlight(TASK)).toBe(true);
    expect(h.task().status).toBe("in_progress");
    expect(h.calls.filter((c) => c === "read:run-1")).toHaveLength(1);
    expect(h.calls).not.toContain("cancel:run-2");

    // The stale read must not have rebuilt a slot over run-2: the next poll round follows
    // RUN-2 and never asks about run-1 again (the mutant that skips the freshness re-check
    // polls run-1, stranding run-2 on the node with nobody following it).
    await afterRestart.reconcile({ reason: "poll" });
    await flush();
    expect(h.calls.filter((c) => c === "read:run-1")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "read:run-2").length).toBeGreaterThan(0);
  });

  // THE SAME RACE, with the stale read saying the run is CLOSED: the requeue is the branch
  // that does the damage here, because it would take the card away from the relaunch that
  // already owns it - and the next dispatch would cancel run-2 on the way out.
  for (const stale of ["closed", "gone"] as const) {
    it(`la corsa vecchia risponde ${stale === "closed" ? "done" : "404"} mentre la card è già rilanciata: nessuna rimessa in coda, run-2 resta seguita`, async () => {
      let relaunch: (() => Promise<void>) | null = null;
      const h = harness({
        bundle: new Uint8Array([1]),
        readRun: async (runId) => {
          if (runId === "run-1") {
            if (relaunch) {
              const go = relaunch;
              relaunch = null;
              await go();
            }
            if (stale === "gone") throw new NodeError("not_found", "read run: 404", 404);
            return report({ status: "done" });
          }
          return report({ status: "in_progress" });
        },
      });
      h.seed();
      await dispatch(h);

      const afterRestart = h.restart();
      relaunch = async () => {
        h.db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [TASK]);
        await afterRestart.tick(PID);
        await flush();
      };
      await afterRestart.reconcile({ reason: "boot" });
      await flush();

      expect(afterRestart.isInFlight(TASK)).toBe(true);
      expect(h.task().status).toBe("in_progress");
      expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(false);
      expect(h.calls).not.toContain("cancel:run-2");
      expect(h.svc.nodeRunOf(TASK)).toBe("run-2");

      await afterRestart.reconcile({ reason: "poll" });
      await flush();
      expect(h.calls.filter((c) => c === "read:run-2").length).toBeGreaterThan(0);
    });
  }

  it("un commento scritto dal nodo mentre il server era giù viene specchiato una volta sola", async () => {
    const mirrorNote = {
      id: "n-mirror", author: "system", kind: "service",
      content: "Card specchiata da github.com/acme/alpha (task origin-1).", // allow-italian: the node's own note
      createdAt: "2026-11-22T07:00:00.000Z",
    };
    const workComment = {
      id: "n-work", author: "agent", kind: "comment",
      content: "Ho finito, 257 file.", // allow-italian: what the agent on the node wrote
      createdAt: "2026-11-22T07:40:00.000Z",
    };
    const h = harness({
      bundle: new Uint8Array([1]),
      readRun: () => Promise.resolve(report({ status: "in_progress", comments: [mirrorNote, workComment] })),
    });
    h.seed();
    await dispatch(h);

    const afterRestart = h.restart();
    await afterRestart.reconcile({ reason: "boot" });
    await flush();
    // The node's own "mirrored from us" bookkeeping note must not show up here, and the
    // comment the agent wrote while this server was down is not lost (22/11).
    expect(h.comments().some((c) => c.content.startsWith("Card specchiata da"))).toBe(false);
    expect(h.comments().filter((c) => c.content === workComment.content)).toHaveLength(0);

    await afterRestart.reconcile({ reason: "poll" });
    await flush();
    expect(h.comments().filter((c) => c.content === workComment.content)).toHaveLength(1);
    // AND the bookkeeping note is still not here after the poll that brought the work
    // comment home: the mutant that stops seeding `seen` with it mirrors it as a comment.
    expect(h.comments().some((c) => c.content.startsWith("Card specchiata da"))).toBe(false);

    // And a further poll does not mirror the work comment again.
    await afterRestart.reconcile({ reason: "poll" });
    await flush();
    expect(h.comments().filter((c) => c.content === workComment.content)).toHaveLength(1);
    expect(h.comments().some((c) => c.content.startsWith("Card specchiata da"))).toBe(false);
  });

  it("il nodo non risponde mai: il riavvio non resta appeso, la card torna in coda entro il timeout", async () => {
    const h = harness({
      bundle: new Uint8Array([1]),
      readRun: () => new Promise<NodeRunReport>(() => {}),
    });
    h.seed();
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");

    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    const afterRestart = h.restart();
    const startedAt = Date.now();
    await afterRestart.reconcile({ reason: "boot" });
    await flush();
    const elapsedMs = Date.now() - startedAt;

    // Bounded by the timeout, not "forever": a sequential boot that reads one orphan at a
    // time must not let a single hung node hold up every other card behind it.
    expect(elapsedMs).toBeLessThan(MIRROR_CANCEL_TIMEOUT_MS + 5_000);
    expect(h.task().status).toBe("todo");
    expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(true);
  }, 20_000);

  // THE ANCHOR GUARD A REBUILT SLOT WOULD WALK PAST. Two shapes of "the node is handing
  // back work this card already has": the delivery it already carries, and the one a review
  // sent back (`prior_commit`). Reattaching to either plants that old branch again after a
  // restart, and only the same-tip bounce stops it.
  for (const anchor of ["delivery_commit", "prior_commit"] as const) {
    it(`il nodo è in review con la consegna già nota (${anchor}): torna in coda, nessun ramo ripiantato`, async () => {
      const KNOWN = "deadbeefdeadbeef";
      const h = harness({
        bundle: new Uint8Array([1, 2, 3]),
        planted: { planted: true, commit: "c0ffeec0ffee", commitCount: 1, reason: null },
        readRun: () => Promise.resolve(report({
          status: "review", deliveryBranch: "topics/consegna-vecchia",
          deliveryCommit: KNOWN, baseSha: "abcdef0123456789",
        })),
      });
      h.seed();
      await dispatch(h);
      expect(h.task().status).toBe("in_progress");
      h.db.run(`UPDATE tasks SET ${anchor} = ? WHERE id = ?`, [KNOWN, TASK]);

      h.svc.updateBoardSettings(PID, { autoDispatch: false });
      const afterRestart = h.restart();
      await afterRestart.reconcile({ reason: "boot" });
      await flush();
      await afterRestart.reconcile({ reason: "poll" });
      await flush();

      expect(h.task().status).toBe("todo");
      expect(h.task().status).not.toBe("review");
      expect(h.plantedWith).toHaveLength(0);
      expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(true);
    });
  }

  // THE DELEGATED AUTHORIZATION, the same guard `launchOnNode` puts before a token: one
  // that now names another capability or another machine must not be used to read the run
  // either. The queue sends the card through that launch, which parks it with its own reason.
  it("la capability delegata non è più quella della card: torna in coda e il token non viene usato", async () => {
    let policy = delegatedPolicy();
    const h = harness({}, { delegatedPolicyForTask: () => policy });
    h.seed();
    h.db.run("UPDATE tasks SET delegated_start_capability_id = 'capability-confined' WHERE id = ?", [TASK]);
    await dispatch(h);
    expect(h.task().status).toBe("in_progress");
    expect(h.calls).toEqual(["create"]);

    // The authorization now points at another machine: nothing about it authorizes a read
    // of this run on THIS node any more.
    policy = delegatedPolicy({ machineId: "node-2" });
    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    const afterRestart = h.restart();
    await afterRestart.reconcile({ reason: "boot" });
    await flush();

    expect(h.calls.some((c) => c.startsWith("read:"))).toBe(false);
    expect(h.task().status).toBe("todo");
    expect(h.comments().some((c) => c.content.includes(RESTART_NOTE))).toBe(true);
  });
});

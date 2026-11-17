/**
 * `queueAfterRestart` after this change: it asks the NODE what happened to
 * `node_run_id` before deciding anything, instead of always cancelling and
 * recreating the run.
 *
 *  - alive or finished there → the slot is rebuilt and the next poll carries
 *    it home, with zero `cancelRun`/`createRun`.
 *  - the node does not answer → the card and the run are left exactly as
 *    they are; the next reconcile asks again.
 *  - the node confirms the run is gone (404) → today's behaviour: back to
 *    the queue, a fresh run on the next dispatch.
 *
 * openspec/changes/nodo-principale-a-mano, traccia T0.
 */
import { describe, expect, it } from "bun:test";
import { NodeError } from "./node-client";
import { TASK, dispatch, flush, harness, poll, report } from "./task-dispatcher-remote-node-test-support";

describe("queueAfterRestart riaggancia una corsa viva o finita, senza cancel/create", () => {
  it("corsa gia' in review col ramo sul nodo al riavvio: si riaggancia, e il giro successivo porta a consegna", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);
    expect(h.calls.filter((c) => c === "create")).toHaveLength(1);

    // Same database, new dispatcher instance: nothing in memory survives the "restart".
    const h2 = harness({
      readRun: async () => report({ status: "review", deliveryBranch: "topics/corsa", baseSha: "abcdef0123456789" }),
    }, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();

    // Reattached, not requeued: the card stayed where it was, and nothing was cancelled or recreated.
    expect(h.task().status).toBe("in_progress");
    expect(h2.calls.filter((c) => c === "create" || c.startsWith("cancel"))).toEqual([]);

    await poll(h2);

    expect(h.task().status).toBe("review");
    expect(h2.calls.filter((c) => c === "create" || c.startsWith("cancel"))).toEqual([]);
  });

  it("corsa ancora viva (in_progress) sul nodo al riavvio: si riaggancia senza requeue", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);

    const h2 = harness({}, { svc: h.svc }); // default readRun answers "in_progress"
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();

    expect(h.task().status).toBe("in_progress");
    expect(h.task().dispatchState).toBe("working");
    expect(h2.calls.filter((c) => c === "create" || c.startsWith("cancel"))).toEqual([]);
    expect(h.svc.nodeRunOf(TASK)).toBe("run-1");
  });

  it("nodo muto al riavvio: la card resta com'e' e la corsa resta aperta", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);

    const h2 = harness({
      readRun: async () => { throw new NodeError("unreachable" as never, "down", null); },
    }, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();

    expect(h.task().status).toBe("in_progress");
    expect(h2.calls.filter((c) => c === "create" || c.startsWith("cancel"))).toEqual([]);
    // The run id persists: the next reconcile asks the same question again.
    expect(h.svc.nodeRunOf(TASK)).toBe("run-1");
  });

  it("corsa sparita (404) al riavvio: la card torna in coda, come oggi", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);

    const h2 = harness({
      readRun: async () => { throw new NodeError("not_found" as never, "gone", 404); },
    }, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();

    // The 404 is confirmed, so the card is sent back to the queue — same lane auto-dispatch
    // then re-dispatches it, same as any other requeue (see the 13/11 test above it).
    expect(h2.calls).toEqual(["read:run-1", "cancel:run-1", "create"]);
    expect(h.task().status).toBe("in_progress");
  });

  it("commenti scritti sul nodo mentre il server era spento arrivano sulla card riagganciata", async () => {
    const h = harness();
    h.seed();
    await dispatch(h);

    const h2 = harness({
      readRun: async () => report({
        status: "review",
        deliveryBranch: "topics/corsa",
        baseSha: "abcdef0123456789",
        comments: [{
          id: "msg-offline-1", author: "agent:nodo", kind: "comment",
          content: "scritto a Mac spento", createdAt: new Date().toISOString(),
        }],
      }),
    }, { svc: h.svc });
    await h2.dispatcher.reconcile({ reason: "boot" });
    await flush();
    await poll(h2);

    const texts = h.comments().map((c) => c.content);
    expect(texts).toContain("scritto a Mac spento");
  });
});

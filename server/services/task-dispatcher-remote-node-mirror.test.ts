/**
 * A run that came home leaves a mirror card on the node. Once the card here
 * leaves the cycle (done or archived) the mirror is archived on the node, so the
 * node GC can free its worktree (16/11: 117 mirrors in review on the PC).
 * A card still in review here keeps its mirror.
 *
 * @covers KANBAN-76
 */
import { describe, expect, it } from "bun:test";
import { NodeError } from "./node-client";
import { TASK, dispatch, harness, poll, report } from "./task-dispatcher-remote-node-test-support";

async function delivered(over: Parameters<typeof harness>[0] = {}) {
  const h = harness({
    readRun: async () => report({ status: "review", deliveryBranch: "topics/corsa", baseSha: "abcdef0123456789" }),
    ...over,
  });
  h.seed();
  await dispatch(h);
  await poll(h);
  expect(h.task().status).toBe("review");
  expect(h.svc.nodeRunOf(TASK)).toBe("run-1");
  return h;
}

describe("mirror of a delivered run", () => {
  it("stays on the node while the card is in review", async () => {
    const h = await delivered();
    await poll(h, 2);
    expect(h.calls).not.toContain("cancel:run-1");
    expect(h.svc.nodeRunOf(TASK)).toBe("run-1");
  });

  it("is archived once the card is done, and only once", async () => {
    const h = await delivered();
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [TASK]);
    await poll(h, 3);
    expect(h.calls.filter((c) => c === "cancel:run-1")).toEqual(["cancel:run-1"]);
    expect(h.svc.nodeRunOf(TASK)).toBeNull();
  });

  it("is archived once the card is archived", async () => {
    const h = await delivered();
    h.db.run("UPDATE tasks SET archived = 1 WHERE id = ?", [TASK]);
    await poll(h);
    expect(h.calls).toContain("cancel:run-1");
    expect(h.svc.nodeRunOf(TASK)).toBeNull();
  });

  it("a silent node is retried next round, a 404 counts as done", async () => {
    let answer: Error | null = new NodeError("unreachable" as never, "down", null);
    const h = await delivered({ cancelRun: async () => { if (answer) throw answer; } });
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [TASK]);
    await poll(h);
    expect(h.svc.nodeRunOf(TASK)).toBe("run-1");
    answer = new NodeError("not_found" as never, "gone", 404);
    await poll(h);
    expect(h.svc.nodeRunOf(TASK)).toBeNull();
    expect(h.calls.filter((c) => c === "cancel:run-1").length).toBe(2);
  });

  it("a node that never answers does not hold the poll", async () => {
    const h = await delivered({ cancelRun: () => new Promise<void>(() => {}) });
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [TASK]);
    const started = Date.now();
    await poll(h, 3);
    expect(Date.now() - started).toBeLessThan(2_000);
    // One sweep at a time: the hung cancel is not asked again while it is still pending.
    expect(h.calls.filter((c) => c === "cancel:run-1")).toEqual(["cancel:run-1"]);
    expect(h.svc.nodeRunOf(TASK)).toBe("run-1");
  });
});

describe("the node's spend comes home", () => {
  it("a finished remote card has tokens and cost here, and the same report twice adds nothing", async () => {
    const h = await delivered({
      readRun: async () => report({
        status: "review", deliveryBranch: "topics/corsa", baseSha: "abcdef0123456789",
        usage: { tokens: 120_000, cacheReadTokens: 900_000, costCents: 42 },
      }),
    });
    await poll(h, 2);
    const t = h.task();
    expect(t.agentTokens).toBe(120_000);
    expect(t.agentCacheReadTokens).toBe(900_000);
    expect(t.agentCostCents).toBe(42);
    const ledger = h.db.query("SELECT COALESCE(SUM(cents), 0) AS c FROM agent_spend WHERE task_id = ?").get(TASK) as { c: number };
    expect(ledger.c).toBe(42);
  });
});

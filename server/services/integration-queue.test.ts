/** @covers LAND-16 */
import { describe, expect, test } from "bun:test";
import { createIntegrationQueue, type IntegrationMeasure } from "./integration-queue";

/** A fake world: `bad` breaks the CI of any batch it is in, `conflicting` cannot be merged. */
function world(opts: { bad?: string[]; conflicting?: string[]; unmeasured?: boolean; maxBatch?: number } = {}) {
  const batches: string[][] = [];
  const landed: string[] = [];
  const bounced: Array<{ id: string; why: string }> = [];
  const gone = new Set<string>();
  let gate: Promise<void> = Promise.resolve();
  let openGate: () => void = () => undefined;
  const q = createIntegrationQueue({
    maxBatch: opts.maxBatch,
    collectMs: 0,
    measure: async (_p, ids): Promise<IntegrationMeasure> => {
      await gate;
      const conflicts = ids.filter((id) => opts.conflicting?.includes(id)).map((taskId) => ({ taskId, why: "conflitto su a.ts" }));
      const measured = ids.filter((id) => !opts.conflicting?.includes(id));
      batches.push(measured);
      if (opts.unmeasured) return { measured, conflicts, verdict: "unmeasured", why: "GitHub non risponde" };
      if (!measured.length) return { measured, conflicts, verdict: "empty" };
      const red = measured.some((id) => opts.bad?.includes(id));
      return { measured, conflicts, verdict: red ? "fail" : "pass", commit: "c0ffee12", why: red ? "unit-ci rosso" : undefined };
    },
    land: async (_p, id) => { landed.push(id); },
    bounce: async (_p, id, why) => { bounced.push({ id, why }); },
    stillWanted: (_p, id) => !gone.has(id) && !landed.includes(id),
  });
  return {
    q, batches, landed, bounced, gone,
    hold() { gate = new Promise((r) => { openGate = r; }); },
    release() { openGate(); },
  };
}

describe("integration queue", () => {
  test("cards asked while a batch is measured are measured together in ONE next batch", async () => {
    const w = world();
    w.hold();
    w.q.request("p", "a");
    await Bun.sleep(5);
    w.q.request("p", "b"); w.q.request("p", "c"); w.q.request("p", "b");
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a"], ["b", "c"]]);
    expect(w.landed).toEqual(["a", "b", "c"]);
  });

  test("a red batch is halved until the breaking card is alone; it goes back, the others land", async () => {
    const w = world({ bad: ["c"] });
    w.hold();
    for (const id of ["a", "b", "c", "d"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a", "b", "c", "d"], ["a", "b"], ["c", "d"], ["c"], ["d"]]);
    expect(w.landed).toEqual(["a", "b", "d"]);
    expect(w.bounced.map((b) => b.id)).toEqual(["c"]);
    expect(w.bounced[0]!.why).toContain("unit-ci");
  });

  test("a conflicting card goes back to its agent and the batch goes on without it", async () => {
    const w = world({ conflicting: ["b"] });
    w.hold();
    for (const id of ["a", "b", "c"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a", "c"]]);
    expect(w.bounced.map((b) => b.id)).toEqual(["b"]);
    expect(w.landed).toEqual(["a", "c"]);
  });

  test("unmeasured moves nothing: no land, no bounce, the queue empties for the sweep to ask again", async () => {
    const w = world({ unmeasured: true });
    w.q.request("p", "a");
    await w.q.idle("p");
    expect(w.landed).toEqual([]);
    expect(w.bounced).toEqual([]);
    expect(w.q.pending("p")).toEqual([]);
  });

  test("a card no longer wanted (rejected, archived, moved) is dropped before it is measured", async () => {
    const w = world();
    w.hold();
    w.q.request("p", "a");
    await Bun.sleep(5);
    w.q.request("p", "b");
    w.gone.add("b");
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a"]]);
    expect(w.landed).toEqual(["a"]);
  });

  test("the batch never exceeds its cap", async () => {
    const w = world({ maxBatch: 2 });
    w.hold();
    for (const id of ["a", "b", "c"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a", "b"], ["c"]]);
  });
});

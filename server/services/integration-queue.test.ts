/** @covers LAND-16 */
import { describe, expect, test } from "bun:test";
import { createIntegrationQueue, type IntegrationMeasure } from "./integration-queue";

/** A fake world: `bad` breaks the CI of any batch it is in, `conflicting` cannot be merged. */
function world(opts: {
  bad?: string[]; conflicting?: string[]; unmeasured?: boolean; maxBatch?: number; solo?: string[]; landed?: boolean; fault?: string;
  bisect?: (taskIds: string[]) => { guilty: string[]; why?: Record<string, string> } | null;
} = {}) {
  const batches: string[][] = [];
  const landed: string[] = [];
  const bounced: Array<{ id: string; why: string }> = [];
  const gone = new Set<string>();
  let gate: Promise<void> = Promise.resolve();
  let openGate: () => void = () => undefined;
  const gaveUp: string[] = [];
  const abandoned: string[] = [];
  const notes: Array<{ id: string; text: string }> = [];
  const q = createIntegrationQueue({
    landed: opts.landed,
    bisect: opts.bisect ? async (_p, ids) => opts.bisect!(ids) : undefined,
    note: (id, text) => { notes.push({ id, text }); },
    maxBatch: opts.maxBatch,
    giveUp: (_p, id) => { gaveUp.push(id); },
    abandon: (_p, id) => { abandoned.push(id); },
    collectMs: 0,
    measure: async (_p, ids): Promise<IntegrationMeasure> => {
      await gate;
      const conflicts = ids.filter((id) => opts.conflicting?.includes(id)).map((taskId) => ({ taskId, why: "conflitto su a.ts" }));
      const measured = ids.filter((id) => !opts.conflicting?.includes(id));
      batches.push(measured);
      if (opts.unmeasured) return { measured, conflicts, verdict: "unmeasured", why: "GitHub non risponde", fault: opts.fault };
      if (!measured.length) return { measured, conflicts, verdict: "empty" };
      const red = measured.some((id) => opts.bad?.includes(id));
      return { measured, conflicts, verdict: red ? "fail" : "pass", commit: "c0ffee12", why: red ? "unit-ci rosso" : undefined };
    },
    land: async (_p, id) => { landed.push(id); },
    bounce: async (_p, id, why) => { bounced.push({ id, why }); },
    stillWanted: (_p, id) => !gone.has(id) && !landed.includes(id),
    solo: opts.solo ? (_p, id) => opts.solo!.includes(id) : undefined,
  });
  return {
    q, batches, landed, bounced, gone, notes, gaveUp, abandoned,
    hold() { gate = new Promise((r) => { openGate = r; }); },
    release() { openGate(); },
  };
}

describe("integration queue, cards already on main", () => {
  test("a lotto of two lands where only the second breaks a cricchetto bisects to it alone: the first stays landed", async () => {
    const w = world({ landed: true, bad: ["second"], bisect: (ids) => (ids.includes("second") ? { guilty: ["second"], why: { second: "any-budget 399 contro 398" } } : null) });
    w.hold();
    for (const id of ["first", "second"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["first", "second"]]);
    expect(w.landed).toEqual(["first"]);
    expect(w.bounced.map((b) => b.id)).toEqual(["second"]);
    expect(w.bounced[0]!.why).toBe("any-budget 399 contro 398");
    expect(w.notes.find((n) => n.id === "first")!.text).toContain("second");
  });

  test("with no answer on who broke it (no bisect given, or it cannot place the cards), every card of the batch goes back, each reading who landed with it", async () => {
    const w = world({ landed: true, bad: ["c"] });
    w.hold();
    for (const id of ["a", "b", "c"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a", "b", "c"]]);
    expect(w.landed).toEqual([]);
    expect(w.bounced.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(w.bounced[0]!.why).toContain("unit-ci rosso");
    expect(w.bounced[0]!.why).toContain("insieme a altre 2 card (b, c)");
  });

  test("a green says the CI measured main after the land, never «atterra adesso»", async () => {
    const w = world({ landed: true });
    w.q.request("p", "a");
    await w.q.idle("p");
    expect(w.landed).toEqual(["a"]);
    expect(w.notes[0]!.text).toContain("dopo l'atterraggio");
    expect(w.notes[0]!.text).not.toContain("Atterra adesso");
  });
});

describe("integration queue, a fault of the board's own", () => {
  test("a landed card measured with no push stays done with a note, and after three rounds its mark closes: never asked back to a person", async () => {
    const w = world({ landed: true, unmeasured: true, fault: "push: killed after 300 s" });
    for (let i = 0; i < 4; i++) { if (!w.abandoned.length) w.q.request("p", "a"); await w.q.idle("p"); }
    expect(w.gaveUp).toEqual([]);
    expect(w.bounced).toEqual([]);
    expect(w.abandoned).toEqual(["a"]);
    expect(w.notes).toHaveLength(2);
    expect(w.notes[0]!.text).toContain("killed after 300 s");
  });

  test("a card not yet on main with a board fault still goes to a person, as a silent CI does", async () => {
    const w = world({ unmeasured: true, fault: "push: killed after 300 s" });
    for (let i = 0; i < 2; i++) { w.q.request("p", "a"); await w.q.idle("p"); }
    expect(w.gaveUp).toEqual(["a"]);
    expect(w.abandoned).toEqual([]);
  });
});

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

  test("a card without its own green bar is measured alone: its red costs one round and only itself", async () => {
    const w = world({ bad: ["c"], solo: ["c"] });
    w.hold();
    for (const id of ["a", "c", "b", "d"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a", "b", "d"], ["c"]]);
    expect(w.landed).toEqual(["a", "b", "d"]);
    expect(w.bounced.map((b) => b.id)).toEqual(["c"]);
  });

  test("an unproven card at the front is measured alone, the proven ones after it as one batch", async () => {
    const w = world({ solo: ["a"] });
    w.hold();
    for (const id of ["a", "b", "c"]) w.q.request("p", id);
    w.release();
    await w.q.idle("p");
    expect(w.batches).toEqual([["a"], ["b", "c"]]);
    expect(w.landed).toEqual(["a", "b", "c"]);
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

  test("a card archived while its batch was measured is not sent back to its agent", async () => {
    const w = world({ bad: ["a"] });
    w.hold();
    w.q.request("p", "a");
    await Bun.sleep(5);
    w.gone.add("a");
    w.release();
    await w.q.idle("p");
    expect(w.bounced).toEqual([]);
  });
});

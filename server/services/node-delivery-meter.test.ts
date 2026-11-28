/**
 * The bar of a delivery planted from another machine (`node-delivery-meter.ts`):
 * measured on a throwaway checkout, CI rows and local commands alike, and
 * followed by the offer to the automatic land.
 *
 * @covers LAND-05
 */
import { describe, expect, test } from "bun:test";
import { E2E_CI_CHECK } from "../../shared/board";
import { createNodeDeliveryMeter, type NodeDeliveryCheckout } from "./node-delivery-meter";
import type { ChecksLeg } from "./checks-gate";

const TASK = "card-pc";
const inReview = { status: "review", projectId: "p", deliveryBranch: "topics/x", deliveryCommit: "abc1234" };

function meter(over: {
  checks?: Array<{ name: string; cmd: string }>; legs?: ChecksLeg[]; lease?: boolean; task?: typeof inReview | undefined;
  existsSync?: (path: string) => boolean; leaseAfterFirst?: boolean; noCheckoutDep?: boolean;
} = {}) {
  const events: string[] = [];
  const notes: string[] = [];
  const legs = [...(over.legs ?? [{ ok: true, comment: "ok" } as unknown as ChecksLeg])];
  let checkoutCount = 0;
  const m = createNodeDeliveryMeter({
    readTask: () => (over.task === undefined && "task" in over ? undefined : (over.task ?? inReview)),
    declaredChecks: () => over.checks ?? [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd }],
    checkout: over.noCheckoutDep ? undefined : async () => {
      if (over.lease === false) return null;
      checkoutCount += 1;
      if (checkoutCount > 1 && over.leaseAfterFirst === false) return null;
      events.push("checkout");
      return { cwd: `/tmp/wt-${checkoutCount}`, head: async () => "abc1234", release: async () => { events.push("release"); } };
    },
    runGate: async (_id, _p, _leg, at) => {
      const ref = await at();
      events.push(`gate@${ref?.commit}`);
      return legs.shift() ?? null;
    },
    recapture: async () => { events.push("recapture"); },
    tryLand: async () => { events.push("land"); },
    note: (_id, text) => { notes.push(text); },
    legMs: 1,
    existsSync: over.existsSync ?? (() => true),
  });
  return { m, events, notes };
}

describe("node delivery meter", () => {
  test("a CI-only bar is measured on the throwaway checkout, then the card is offered to the land", async () => {
    const { m, events } = meter();
    await m.measure(TASK);
    expect(events).toEqual(["checkout", "gate@abc1234", "release", "recapture", "land"]);
  });

  test("a leg still pending is asked again until the round settles", async () => {
    const { m, events } = meter({ legs: [{ pending: true }, { pending: true }, { ok: true, comment: "" } as unknown as ChecksLeg] });
    await m.measure(TASK);
    expect(events.filter((e) => e.startsWith("gate"))).toHaveLength(3);
    expect(events.at(-1)).toBe("land");
  });

  test("a bar mixing CI and a local command is measured on the checkout too (card dcdee50e)", async () => {
    const { m, events } = meter({
      checks: [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd }, { name: "typecheck", cmd: "bun run typecheck" }],
    });
    await m.measure(TASK);
    expect(events).toEqual(["checkout", "gate@abc1234", "release", "recapture", "land"]);
  });

  test("a bar made entirely of local commands is measured on the checkout too", async () => {
    const { m, events } = meter({ checks: [{ name: "typecheck", cmd: "bun run typecheck" }] });
    await m.measure(TASK);
    expect(events).toEqual(["checkout", "gate@abc1234", "release", "recapture", "land"]);
  });

  test("no checkout to measure on: nothing runs, nothing lands, and the card says why", async () => {
    const { m, events, notes } = meter({ lease: false });
    await m.measure(TASK);
    expect(events).toEqual([]);
    expect(notes).toEqual(["nessun checkout su cui misurare"]);
  });

  test("no checkout function on this server: the card says why instead of staying mute", async () => {
    const notes: string[] = [];
    const m = createNodeDeliveryMeter({
      readTask: () => inReview,
      declaredChecks: () => [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd }],
      runGate: async () => ({ ok: true, comment: "ok" } as unknown as ChecksLeg),
      recapture: async () => {},
      tryLand: async () => {},
      note: (_id, text) => { notes.push(text); },
    });
    await m.measure(TASK);
    expect(notes).toEqual(["nessun checkout disponibile su questo server per misurare una consegna di nodo"]);
  });

  test("the checkout came back empty: nothing runs, nothing lands, and the card says why", async () => {
    const { m, events, notes } = meter({ lease: false });
    await m.measure(TASK);
    expect(events).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("nessun checkout su cui misurare");
  });

  test("the gate throws: the card says why instead of staying NULL mute", async () => {
    const { notes } = meter({ legs: [] });
    const broken = createNodeDeliveryMeter({
      readTask: () => inReview,
      declaredChecks: () => [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd }],
      checkout: async () => ({ cwd: "/tmp/wt", head: async () => "abc1234", release: async () => undefined }),
      runGate: async () => { throw new Error("boom"); },
      recapture: async () => undefined,
      tryLand: async () => undefined,
      note: (_taskId, text) => notes.push(text),
      existsSync: () => true,
    });
    await broken.measure(TASK);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("misura fallita");
  });

  test("a card that left review, or has no commit of its own, is left alone with no note: it is not stuck", async () => {
    expect((await (async () => { const x = meter({ task: { ...inReview, status: "done" } }); await x.m.measure(TASK); return x.notes; })())).toEqual([]);
    expect((await (async () => { const x = meter({ task: { ...inReview, deliveryCommit: null as unknown as string } }); await x.m.measure(TASK); return x.notes; })())).toEqual([]);
  });

  /**
   * The checkout's cwd can be gone before a leg ever runs: a process before
   * tore it down after this measure took its lease (card 88bcec11). Launching
   * a check on it would only write a `spawnError`, not measure anything: the
   * meter redoes the checkout on the same delivered commit instead.
   */
  test("a checkout gone before the first leg is redone on the same commit, with no leg on the void", async () => {
    // "/tmp/wt-1" (the first checkout) never exists; the retry's own path does.
    const { m, events } = meter({ existsSync: (p) => p !== "/tmp/wt-1" });
    await m.measure(TASK);
    expect(events).toEqual(["checkout", "checkout", "gate@abc1234", "release", "recapture", "land"]);
  });

  test("a checkout gone and the retry finds none either: no leg, no land", async () => {
    const { m, events } = meter({ existsSync: () => false, leaseAfterFirst: false });
    await m.measure(TASK);
    // The first lease is released once the retry comes back empty; no leg ever runs.
    expect(events).toEqual(["checkout", "release"]);
    expect(events.some((e) => e.startsWith("gate"))).toBe(false);
  });

  /**
   * Card 0a3fed8f (28/11): a node delivery approved for landing, realigned on
   * main while it was being measured. The realign moves the REAL branch in a
   * worktree of its own (`taskAutoMerge.realign`); this checkout is detached,
   * opened on whatever `deliveryCommit` was before that merge. Without
   * `reattach`, the gate keeps measuring the stale commit and `checksCommit`
   * never matches `deliveryCommit` again, so the card never lands on its own.
   */
  test("a realign mid-measure moves this SAME checkout, not a fresh one: the gate measures the merge, then the card is offered to land", async () => {
    const events: string[] = [];
    let onDisk = "pre-realign-sha";
    let reattachCalls = 0;
    const checkout: NodeDeliveryCheckout = {
      cwd: "/tmp/wt",
      head: async () => onDisk,
      reattach: async (commit) => { reattachCalls += 1; onDisk = commit; return true; },
      release: async () => { events.push("release"); },
    };
    const m = createNodeDeliveryMeter({
      readTask: () => inReview,
      declaredChecks: () => [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd }],
      checkout: async () => checkout,
      // Stands in for `runChecksGate`: asks the checkout BEFORE the realign
      // (the stale commit), then again with the commit the realign just
      // produced — exactly what `tasks-checks-delivery.ts` does once
      // `taskAutoMerge.realign` answers with a new `commit`.
      runGate: async (_id, _p, _leg, at) => {
        const before = await at();
        events.push(`before@${before?.commit}`);
        const after = await at("post-realign-sha");
        events.push(`measured@${after?.commit}`);
        return { ok: true, comment: "" } as unknown as ChecksLeg;
      },
      recapture: async () => { events.push("recapture"); },
      tryLand: async () => { events.push("land"); },
      existsSync: () => true,
    });
    await m.measure(TASK);
    expect(reattachCalls).toBe(1);
    expect(events).toEqual(["before@pre-realign-sha", "measured@post-realign-sha", "release", "recapture", "land"]);
  });
});

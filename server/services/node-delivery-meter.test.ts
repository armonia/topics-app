/**
 * The bar of a delivery planted from another machine (`node-delivery-meter.ts`):
 * measured on a throwaway checkout, only when the bar is made of CI rows, and
 * followed by the offer to the automatic land.
 *
 * @covers LAND-05
 */
import { describe, expect, test } from "bun:test";
import { E2E_CI_CHECK } from "../../shared/board";
import { createNodeDeliveryMeter } from "./node-delivery-meter";
import type { ChecksLeg } from "./checks-gate";

const TASK = "card-pc";
const inReview = { status: "review", projectId: "p", deliveryBranch: "topics/x", deliveryCommit: "abc1234" };

function meter(over: {
  checks?: Array<{ name: string; cmd: string }>; legs?: ChecksLeg[]; lease?: boolean; task?: typeof inReview | undefined;
  existsSync?: (path: string) => boolean; leaseAfterFirst?: boolean;
} = {}) {
  const events: string[] = [];
  const legs = [...(over.legs ?? [{ ok: true, comment: "ok" } as unknown as ChecksLeg])];
  let checkoutCount = 0;
  const m = createNodeDeliveryMeter({
    readTask: () => (over.task === undefined && "task" in over ? undefined : (over.task ?? inReview)),
    declaredChecks: () => over.checks ?? [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd }],
    checkout: async () => {
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
    legMs: 1,
    existsSync: over.existsSync ?? (() => true),
  });
  return { m, events };
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

  test("a bar with a local command is NOT measured on a bare checkout: nothing runs, nothing lands", async () => {
    const { m, events } = meter({ checks: [{ name: "typecheck", cmd: "bun run typecheck" }] });
    await m.measure(TASK);
    expect(events).toEqual([]);
  });

  test("no checkout to measure on: nothing runs, nothing lands", async () => {
    const { m, events } = meter({ lease: false });
    await m.measure(TASK);
    expect(events).toEqual([]);
  });

  test("a card that left review, or has no commit of its own, is left alone", async () => {
    expect((await (async () => { const x = meter({ task: { ...inReview, status: "done" } }); await x.m.measure(TASK); return x.events; })())).toEqual([]);
    expect((await (async () => { const x = meter({ task: { ...inReview, deliveryCommit: null as unknown as string } }); await x.m.measure(TASK); return x.events; })())).toEqual([]);
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
});

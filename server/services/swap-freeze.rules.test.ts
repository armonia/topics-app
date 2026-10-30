/**
 * THE TWO PURE RULES OF THE SWAP FREEZER, on their own: who is the victim and
 * what continues a frozen tree. The wired behaviour is in `swap-freeze.test.ts`.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { pickVictim, thawReason, type FreezeCandidate } from "./swap-freeze";
import { FREEZE_MAX_MS } from "../../shared/swap-freeze";

const T0 = 1_760_000_000_000;

describe("pickVictim", () => {
  test("the pure rule on its own: floor, CPU, ties and the two-freeze limit", () => {
    const c = (over: Partial<FreezeCandidate>): FreezeCandidate => ({
      root: { kind: "claude-background", pid: 1, pgid: 1, sessionKey: "s", command: "x", topicId: null, terminalId: null, taskId: null },
      treePids: [1], xpcPids: [], footprintGB: 1, residentGB: 1, cpuCores: 1, frozenCount: 0, ...over,
    });
    expect(pickVictim([c({ footprintGB: 0.49 })]).skipped).toBe("belowFloor");
    expect(pickVictim([c({ cpuCores: 0.05 })]).skipped).toBe("belowFloor");
    expect(pickVictim([c({ frozenCount: 2 })]).skipped).toBe("exhausted");
    const heavy = c({ footprintGB: 2, cpuCores: 0.2 });
    const withMoreCpu = c({ footprintGB: 2, cpuCores: 0.9 });
    expect(pickVictim([heavy, withMoreCpu]).victim).toBe(withMoreCpu);
  });

  test("the only work of Topics in flight is never the victim (card cda99908, finding 26)", () => {
    const only: FreezeCandidate = {
      root: { kind: "claude-background", pid: 1, pgid: 1, sessionKey: "s", command: "x", topicId: null, terminalId: null, taskId: "card" },
      treePids: [1], xpcPids: [], footprintGB: 3, residentGB: 2, cpuCores: 1, frozenCount: 0,
    };
    expect(pickVictim([only], 1)).toEqual({ victim: null, skipped: "onlyTurn" });
    expect(pickVictim([only], 2).victim).toBe(only);
  });
});

describe("thawReason", () => {
  test("the pure rule, in the order it is asked", () => {
    const base = {
      now: T0 + 60_000, frozenAt: T0, ownerGone: false, sustained: true, calmForMs: 0, heldGB: 12, heldGBAtFreeze: 6,
      residentGBAtFreeze: 1.4, pagesReadBackPerS: 30, pagesReadBackAtFreeze: 33, effectAlreadyRead: false,
    };
    expect(thawReason({ ...base, ownerGone: true })).toBe("owner gone");
    expect(thawReason({ ...base, sustained: false, heldGB: 7.5 })).toBe("room");
    expect(thawReason({ ...base, sustained: false, heldGB: 7.0 }), "6 GB at the freeze plus the 1.4 the tree takes back").toBeNull();
    expect(thawReason({ ...base, now: T0 + 130_000 })).toBe("no effect");
    expect(thawReason({ ...base, now: T0 + 130_000, effectAlreadyRead: true })).toBeNull();
    expect(thawReason({ ...base, now: T0 + FREEZE_MAX_MS })).toBe("max");
    expect(thawReason(base)).toBeNull();
  });

  test("room after a calm that outlasts an episode, whatever the other apps hold (card cda99908, finding 27)", () => {
    const calm = {
      now: T0 + 5 * 60_000, frozenAt: T0, ownerGone: false, sustained: false, calmForMs: 5 * 60_000, heldGB: 4, heldGBAtFreeze: 4,
      residentGBAtFreeze: 1.4, pagesReadBackPerS: 2, pagesReadBackAtFreeze: 33, effectAlreadyRead: true,
    };
    expect(thawReason(calm)).toBe("room");
    expect(thawReason({ ...calm, calmForMs: 4 * 60_000 }), "a shorter calm is the freeze's own effect").toBeNull();
    expect(thawReason({ ...calm, sustained: true, calmForMs: 0 })).toBeNull();
  });
});

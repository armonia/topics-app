/**
 * The witness of life of a scheduled command is the identity of its process
 * group, and a probe that does not answer is not a death (rule R12).
 *
 * Mutation: with `ps -o lstart` in place of the group identity, the test of the
 * probe that does not answer goes red (a live command reads as dead and is
 * started a second time).
 *
 * @covers SCHED-04
 */
import { describe, expect, test } from "bun:test";
import { commandLife, type LifeProbes, type RecordedGroup } from "./command-life";

const group: RecordedGroup = { pgid: 4242, leaderPid: 4242, leaderStartTime: "t0" };
const probes = (over: Partial<LifeProbes>): LifeProbes => ({ groupAlive: () => true, identityOf: () => ({ pid: 4242, pgid: 4242, startTime: "t0" }), ...over });

describe("commandLife", () => {
  test("the recorded identity is alive", () => {
    expect(commandLife(group, probes({}))).toBe("alive");
  });

  test("a group that is gone is dead", () => {
    expect(commandLife(group, probes({ groupAlive: () => false }))).toBe("dead");
  });

  test("no record of the group is dead", () => {
    expect(commandLife(undefined, probes({}))).toBe("dead");
  });

  test("a leader pid that now belongs to another process is dead, not adopted", () => {
    expect(commandLife(group, probes({ identityOf: () => ({ pid: 4242, pgid: 4242, startTime: "another" }) }))).toBe("dead");
  });

  test("the probe that does not answer is unknown, never dead", () => {
    expect(commandLife(group, probes({ identityOf: () => null }))).toBe("unknown");
    expect(commandLife(group, probes({ identityOf: () => { throw new Error("timed out"); } }))).toBe("unknown");
    expect(commandLife(group, probes({ groupAlive: () => { throw new Error("timed out"); } }))).toBe("unknown");
  });
});

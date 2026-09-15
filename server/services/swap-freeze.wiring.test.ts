/**
 * F19 - THE ORDER OF THE WIRING, which is not decoration.
 *
 * Four facts live in `server.ts` and in one library, and each of them is a
 * defect if it moves:
 *
 *  - the brake runs BEFORE the freezer on the beat: the lever that gives memory
 *    back is always tried first;
 *  - the boot thaw runs BEFORE the memory signal starts: a tree the previous
 *    server left stopped is continued before anything can freeze again;
 *  - `gracefulShutdown` thaws AFTER the CPU governor and BEFORE the check trees
 *    are killed: a stopped process holds its SIGTERM until it is continued;
 *  - `killAgentProcessTree` releases the freeze BEFORE it signals.
 *
 * Every one of them is an ORDER, so no unit test of the modules can see it -
 * the same shape `review-checks-brakes.test.ts` already pins by reading the
 * source. This is that test for the freezer.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const server = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
const killTree = readFileSync(join(import.meta.dir, "../lib/kill-agent-tree.ts"), "utf8");

/** The index of a piece of wiring, with a readable failure when it is gone. */
function at(source: string, needle: string, label: string): number {
  const i = source.indexOf(needle);
  expect(i, `${label} is not wired any more (looked for \`${needle}\`)`).toBeGreaterThan(-1);
  return i;
}

describe("the freezer is wired in the one order that works", () => {
  test("the check brake acts before the freezer, on the same beat and the same window", () => {
    const brake = at(server, "swapBrake.tick(memSignal.swap(), freezableRuns(), swapFreezer.lastActionAt())", "the brake's tick");
    const freezer = at(server, "swapFreezer.tick({ swap: memSignal.swap()", "the freezer's tick");
    expect(brake, "a freeze gives no memory back: the kill is tried first").toBeLessThan(freezer);
  });

  test("the boot thaw comes before the memory signal exists", () => {
    const boot = at(server, "thawLedgerAtBoot({", "the boot thaw");
    const signal = at(server, "const memSignal = createMemSignal(", "the memory signal");
    expect(boot).toBeLessThan(signal);
  });

  test("the shutdown thaws after the CPU governor and before the check trees are killed", () => {
    const governor = at(server, "await budgetGovernor.thawAll()", "the CPU governor's thaw");
    const freezer = at(server, 'await swapFreezer.thawAll("shutdown")', "the swap freezer's thaw");
    const checks = at(server, "await stopReviewChecks()", "the check trees' kill");
    expect(governor).toBeLessThan(freezer);
    expect(freezer, "a stopped process holds a SIGTERM until it is continued").toBeLessThan(checks);
  });

  test("a reconnecting client is told about the frozen trees", () => {
    at(server, 'inviaIniziale({ type: "swap-freeze:state"', "the snapshot on connect");
    at(server, 'setSwapFreezeBroadcast((views) => broadcastToAll({ type: "swap-freeze:state", views }))', "the broadcast");
  });

  test("stopping a session continues its frozen tree before killing anything", () => {
    const release = at(killTree, "await releaseSwapFreeze(sessionKey)", "the release");
    const kill = at(killTree, "await killProcessTree(pid)", "the kill");
    expect(release).toBeLessThan(kill);
  });

  test("the silence clocks read the hold", () => {
    at(server, "isFrozen: () => isSwapFreezeHold(sessionKey)", "the stall detector's hold");
    at(server, "frozenMsSince: (sk, since) => swapFrozenMsSince(sk, since)", "the sweeper's subtraction");
  });
});

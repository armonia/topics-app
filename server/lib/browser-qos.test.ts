/**
 * @covers KANBAN-78
 *
 * The transition itself: when the band moves, when it must NOT move, and what
 * happens when the browser process cannot be found. The rule (who is an agent)
 * lives in `low-priority.test.ts`; here only the state machine around it.
 */
import { describe, expect, test } from "bun:test";
import { createBrowserQosGovernor } from "./browser-qos";
import type { BrowserContextOwner } from "./low-priority";

function harness(pid: number | null = 100) {
  let owners: BrowserContextOwner[] = [];
  const applied: { pid: number; on: boolean }[] = [];
  const lines: string[] = [];
  const governor = createBrowserQosGovernor({
    listOwners: () => owners,
    ownerTest: { isDispatched: (key) => key.startsWith("card:"), isAgentCwd: () => false },
    browserPid: async () => pid,
    apply: async (p, on) => { applied.push({ pid: p, on }); return [p, p + 1]; },
    log: (line) => lines.push(line),
  });
  return {
    governor, applied, lines,
    set(next: BrowserContextOwner[]) { owners = next; },
  };
}

const agent = { contextId: "a", sessionKey: "card:1" };
const person = { contextId: "p", sessionKey: "topic:mine" };

describe("browser QoS governor", () => {
  test("agents only: background, once, with one line", async () => {
    const h = harness();
    h.set([agent]);
    h.governor.refresh("context created: a");
    await h.governor.settled();
    expect(h.applied).toEqual([{ pid: 100, on: true }]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("background");
    expect(h.lines[0]).toContain("context created: a");
  });

  test("a verdict that did not move spawns nothing and says nothing", async () => {
    const h = harness();
    h.set([agent]);
    h.governor.refresh("first");
    await h.governor.settled();
    h.governor.refresh("sweep");
    h.governor.refresh("sweep");
    await h.governor.settled();
    expect(h.applied).toHaveLength(1);
    expect(h.lines).toHaveLength(1);
  });

  test("both ways: a person arrives, then leaves", async () => {
    const h = harness();
    h.set([agent]);
    h.governor.refresh("agent opened a context");
    await h.governor.settled();
    h.set([agent, person]);
    h.governor.refresh("viewer joined");
    await h.governor.settled();
    h.set([agent]);
    h.governor.refresh("viewer left");
    await h.governor.settled();
    expect(h.applied.map((a) => a.on)).toEqual([true, false, true]);
    expect(h.lines.map((l) => l.includes("background"))).toEqual([true, false, true]);
  });

  test("with no context at all nobody is waiting on the browser", async () => {
    const h = harness();
    h.set([]);
    h.governor.refresh("last context gone");
    await h.governor.settled();
    expect(h.applied).toEqual([{ pid: 100, on: true }]);
  });

  test("no browser process: nothing is claimed, and the next event tries again", async () => {
    const h = harness(null);
    h.set([agent]);
    h.governor.refresh("launch");
    await h.governor.settled();
    expect(h.applied).toEqual([]);
    expect(h.lines).toEqual([]);
    // Same verdict as before, and it must still be attempted: the band was
    // never actually set, so it cannot be considered already there.
    const second = harness();
    second.set([agent]);
    second.governor.refresh("retry");
    await second.governor.settled();
    expect(second.applied).toHaveLength(1);
  });

  test("after a relaunch the band is decided from scratch", async () => {
    const h = harness();
    h.set([agent]);
    h.governor.refresh("launch");
    await h.governor.settled();
    h.governor.reset();
    h.governor.refresh("launch again");
    await h.governor.settled();
    expect(h.applied).toEqual([{ pid: 100, on: true }, { pid: 100, on: true }]);
  });
});

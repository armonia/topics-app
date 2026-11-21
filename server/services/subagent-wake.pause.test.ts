/**
 * Door B3b of the project pause: the result of a child wakes no parent turn
 * while the parent's project is paused. The card is written as a row at once
 * (only the TURN waits, like under a provider hold) and the turn goes on "Continua".
 * @covers USAGE-29
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { SubAgentResult } from "../lib/subagent-result";
import { createSubagentWake } from "./subagent-wake";
import { heldCount, resetHeldForTests } from "./turn-gate";
import { PAUSED_PROJECT_ID, pauseFixtureProject, pausedProjectDb, resumeFixtureProject } from "../../tests/helpers/paused-project";
import { projectIsPaused } from "./project-pause";

const PARENT = "topic:parent";
const result = (id: string): SubAgentResult => ({
  agentId: id, name: "scout", turn: 1, status: "completed", partial: false, text: "Report",
  model: "claude-sonnet-5-5", agentType: "scout", durationMs: 1000, cwd: "/p", branch: null,
});

let db: ReturnType<typeof pausedProjectDb>;
let posted: number;
let rows: string[];
let settled: string[];

function harness() {
  return createSubagentWake({
    debounceMs: 10, pollMs: 5, endGraceMs: 20,
    isBusy: () => false,
    canWake: () => "wake",
    pausedProject: () => (projectIsPaused(db, PAUSED_PROJECT_ID) ? PAUSED_PROJECT_ID : null),
    route: async () => { posted++; return new Response("data: [DONE]\n\n"); },
  });
}

const ask = (wake: ReturnType<typeof harness>, id: string) => wake.request({
  parentSessionKey: PARENT, result: result(id),
  writeRow: () => rows.push(id), settle: () => settled.push(id),
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  resetHeldForTests();
  db = pausedProjectDb();
  posted = 0;
  rows = [];
  settled = [];
});

describe("sub-agent result wake vs a paused project", () => {
  test("paused: zero parent turns, the card is a row, the wake is parked", async () => {
    pauseFixtureProject(db);
    const wake = harness();
    ask(wake, "c1");
    await wake.idle();
    expect(posted).toBe(0);
    expect(rows).toEqual(["c1"]);
    expect(settled).toEqual([]);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
  });

  test("after Continua the parent is woken once with every result that waited", async () => {
    pauseFixtureProject(db);
    const wake = harness();
    ask(wake, "c1");
    await wake.idle();
    ask(wake, "c2");
    await wake.idle();
    // One slot per parent chat: two results, one parked thunk, nothing lost.
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
    resumeFixtureProject(db);
    await until(() => settled.length === 2);
    await wake.idle();
    expect(posted).toBe(1);
    expect(settled.sort()).toEqual(["c1", "c2"]);
    // The row written during the pause is not written a second time.
    expect(rows.sort()).toEqual(["c1", "c2"]);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(0);
  });

  test("a project that was never paused wakes the parent as before", async () => {
    const wake = harness();
    ask(wake, "c1");
    await wake.idle();
    expect(posted).toBe(1);
    expect(settled).toEqual(["c1"]);
  });
});

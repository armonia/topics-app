/**
 * Door B3c of the project pause: a card outcome wakes no turn of the opener
 * chat while its project is paused; the outcome is parked and goes on "Continua".
 * @covers USAGE-29
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createCardOutcomeWake, type CardFrame } from "./card-outcome-wake";
import { heldCount, resetHeldForTests } from "./turn-gate";
import { PAUSED_PROJECT_ID, PAUSED_TOPIC_ID, pauseFixtureProject, pausedProjectDb, resumeFixtureProject } from "../../tests/helpers/paused-project";
import { projectIsPaused } from "./project-pause";

const SK = `topic:${PAUSED_TOPIC_ID}`;
const frame: CardFrame = { id: "card-1", text: "do the thing", status: "review", openerTopicId: PAUSED_TOPIC_ID, updatedAt: new Date().toISOString() };

let db: ReturnType<typeof pausedProjectDb>;
let posted: number;

function harness() {
  return createCardOutcomeWake({
    debounceMs: 10, pollMs: 5,
    isBusy: () => false,
    sessionKeyOfTopic: () => SK,
    canWake: () => "wake",
    pausedProject: () => (projectIsPaused(db, PAUSED_PROJECT_ID) ? PAUSED_PROJECT_ID : null),
    route: async () => { posted++; return new Response("ok"); },
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  resetHeldForTests();
  db = pausedProjectDb();
  posted = 0;
});

describe("card outcome wake vs a paused project", () => {
  test("paused: zero turns, the outcome is parked", async () => {
    pauseFixtureProject(db);
    const wake = harness();
    wake.observe(frame);
    await wake.idle();
    expect(posted).toBe(0);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
  });

  test("after Continua the parked outcome wakes the chat, once", async () => {
    pauseFixtureProject(db);
    const wake = harness();
    wake.observe(frame);
    await wake.idle();
    resumeFixtureProject(db);
    await until(() => posted > 0);
    await wake.idle();
    expect(posted).toBe(1);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(0);
  });

  test("a project that was never paused wakes as before", async () => {
    const wake = harness();
    wake.observe(frame);
    await wake.idle();
    expect(posted).toBe(1);
  });
});

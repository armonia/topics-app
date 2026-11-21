/**
 * Door B1 of the project pause: a paused project gets no goal judge and no
 * nudge. Nothing is parked: the next turn end re-evaluates, so the goal picks
 * up by itself after "Continua".
 * @covers USAGE-29
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createGoalContinuation, type TurnEndInfo } from "./goal-continuation";
import { setGoal } from "./goals";
import { PAUSED_TOPIC_ID, pauseFixtureProject, pausedProjectDb, resumeFixtureProject } from "../../tests/helpers/paused-project";
import { resetHeldForTests } from "./turn-gate";

const MIG = join(import.meta.dir, "..", "db", "migrations");

let db: Database;
let judged: number;
let nudges: string[];

function loop() {
  return createGoalContinuation({
    db,
    judge: async () => { judged++; return "continue"; },
    resend: async ({ text }) => { nudges.push(text); },
    announce: () => {},
    broadcast: () => {},
  });
}

const turn: TurnEndInfo = {
  sessionKey: `topic:${PAUSED_TOPIC_ID}`, topicId: PAUSED_TOPIC_ID, dispatched: false, end: "end_turn",
  discarded: false, pendingAsk: false, usedTools: true, lastAssistantText: "done a step",
};

beforeEach(() => {
  resetHeldForTests();
  db = pausedProjectDb();
  for (const f of ["064-topic-goals.sql", "20260903232650-goal-continuazione.sql"]) db.run(readFileSync(join(MIG, f), "utf-8"));
  setGoal(db, { topicId: PAUSED_TOPIC_ID, content: "finish the thing" });
  judged = 0;
  nudges = [];
});

describe("goal nudge and judge vs a paused project", () => {
  test("paused: zero judge calls and zero nudges", async () => {
    pauseFixtureProject(db);
    expect(await loop()(turn)).toBe("skipped");
    expect(judged).toBe(0);
    expect(nudges).toHaveLength(0);
  });

  test("after Continua the next turn end judges and nudges again", async () => {
    pauseFixtureProject(db);
    const onTurnEnd = loop();
    await onTurnEnd(turn);
    resumeFixtureProject(db);
    expect(await onTurnEnd(turn)).toBe("continued");
    expect(judged).toBe(1);
    expect(nudges).toHaveLength(1);
  });

  test("a project that was never paused is judged as before", async () => {
    expect(await loop()(turn)).toBe("continued");
    expect(judged).toBe(1);
  });
});

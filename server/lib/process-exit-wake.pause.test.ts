/**
 * Door B3a of the project pause: the wake of a finished `run_command` starts no
 * turn while the project of the topic is paused. It is parked (one slot per
 * command) and goes out on "Continua".
 * @covers USAGE-29
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { processExitWakesIdle, requestProcessExitWake, startProcessExitWakes } from "./process-exit-wake";
import { heldCount, resetHeldForTests } from "../services/turn-gate";
import {
  PAUSED_PROJECT_ID, PAUSED_TOPIC_ID, pauseFixtureProject, pausedProjectDb, resumeFixtureProject,
} from "../../tests/helpers/paused-project";

const SK = `topic:${PAUSED_TOPIC_ID}`;
const REQUEST = { processId: "p-1", topicId: PAUSED_TOPIC_ID, label: "make", exitCode: 0, durationMs: 1000, lines: ["ok"] };

let db: Database;
let sent: Array<Record<string, unknown>>;
let settled: number;

function start(): void {
  startProcessExitWakes({
    db,
    getTopicById: () => ({ sessionKey: SK }),
    ownedByRunningTask: () => false,
    isBusy: () => false,
    pollMs: 5,
    route: async (req) => {
      const body = await req.json() as { processExit: { processId: string } };
      sent.push(body);
      db.run("INSERT INTO messages VALUES (?, ?, 'user', 'x', ?, NULL, ?)", [
        `w-${sent.length}`, SK, JSON.stringify([{ kind: "process-exit", processId: body.processExit.processId, exitCode: 0, label: "x" }]), new Date().toISOString(),
      ]);
      return new Response("data: [DONE]\n\n", { status: 200 });
    },
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  resetHeldForTests();
  db = pausedProjectDb();
  db.run("CREATE TABLE messages (id TEXT, session_key TEXT, role TEXT, content TEXT, blocks TEXT, parent_id TEXT, timestamp TEXT)");
  sent = [];
  settled = 0;
  start();
});

const ask = () => requestProcessExitWake({ ...REQUEST, settle: () => { settled++; } });

describe("command-exit wake vs a paused project", () => {
  test("paused: zero turns started, the wake is parked and still owed", async () => {
    pauseFixtureProject(db);
    ask();
    await processExitWakesIdle();
    expect(sent).toHaveLength(0);
    expect(settled).toBe(0);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
  });

  test("the same command asked again while paused is parked once", async () => {
    pauseFixtureProject(db);
    ask();
    await processExitWakesIdle();
    ask();
    await processExitWakesIdle();
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
  });

  test("after Continua the parked wake goes out, once, and settles", async () => {
    pauseFixtureProject(db);
    ask();
    await processExitWakesIdle();
    resumeFixtureProject(db);
    await until(() => settled > 0);
    await processExitWakesIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionKey: SK, processExit: { processId: "p-1" } });
    expect(settled).toBe(1);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(0);
  });

  test("a project that was never paused is woken as before", async () => {
    ask();
    await processExitWakesIdle();
    expect(sent).toHaveLength(1);
  });
});

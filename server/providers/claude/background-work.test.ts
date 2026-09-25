/**
 * What the CLI says about the work a closed turn left running, folded into one
 * answer: is it still alive? Driven by the recorded session in
 * `background-work.fixture.ts` (CLI 2.1.282, 25/09).
 * @covers MONITOR-02
 */
import { describe, expect, test } from "bun:test";
import { BACKGROUND_WORK_CAP_MS, isBackgroundWorkAlive, noteBackgroundLine, type BackgroundWork } from "./background-work";
import { readBackgroundTasks } from "./events";
import { recordedBackgroundSession } from "./background-work.fixture";

/** Fold events [0, end) with a fake clock that ticks one second per line. */
function foldUntil(events: Array<Record<string, unknown>>, end: number): { work: BackgroundWork | undefined; now: number } {
  let work: BackgroundWork | undefined;
  let now = 1_000_000;
  for (let i = 0; i < end; i++) { now += 1_000; work = noteBackgroundLine(work, events[i], now); }
  return { work, now };
}

describe("background work, from the recorded CLI session", () => {
  const events = recordedBackgroundSession();
  const firstResult = events.findIndex((e) => e.type === "result");
  const lastEmptySnapshot = events.findLastIndex((e) => readBackgroundTasks(e)?.length === 0);

  test("the turn ends with the agent, the Bash and the Monitor still running", () => {
    const { work, now } = foldUntil(events, firstResult + 1);
    expect([...work!.tasks.values()].map((t) => t.type).sort()).toEqual(["local_agent", "local_bash", "local_bash"]);
    expect(isBackgroundWorkAlive(work, now)).toBe(true);
  });

  test("it stays alive through every wake, and ends only on the empty snapshot", () => {
    for (let end = firstResult + 1; end <= lastEmptySnapshot; end++) {
      const { work, now } = foldUntil(events, end);
      expect(isBackgroundWorkAlive(work, now)).toBe(true);
    }
    const { work, now } = foldUntil(events, lastEmptySnapshot + 1);
    expect(isBackgroundWorkAlive(work, now)).toBe(false);
  });

  test("thirty minutes without a word about it, the work is presumed lost", () => {
    const { work } = foldUntil(events, firstResult + 1);
    const heard = work!.lastSignalAt;
    expect(isBackgroundWorkAlive(work, heard + BACKGROUND_WORK_CAP_MS - 1)).toBe(true);
    expect(isBackgroundWorkAlive(work, heard + BACKGROUND_WORK_CAP_MS)).toBe(false);
  });

  test("the agent's own lines are news: they move the thirty minutes", () => {
    const { work, now } = foldUntil(events, firstResult + 1);
    const agentLine = events.slice(firstResult + 1).find((e) => typeof e.parent_tool_use_id === "string")!;
    const later = now + BACKGROUND_WORK_CAP_MS - 1_000;
    const refreshed = noteBackgroundLine(work, agentLine, later);
    expect(isBackgroundWorkAlive(refreshed, later + BACKGROUND_WORK_CAP_MS - 1)).toBe(true);
  });

  test("a line of the model is not news about the background", () => {
    const { work, now } = foldUntil(events, firstResult + 1);
    const modelLine = { type: "assistant", message: { content: [{ type: "text", text: "Tick-1 fired." }] } };
    expect(noteBackgroundLine(work, modelLine, now + 5_000)).toBe(work);
  });
});

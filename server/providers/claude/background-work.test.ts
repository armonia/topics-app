/**
 * What the CLI says about the work a closed turn left running, folded into one
 * answer: is it still alive? Driven by the recorded session in
 * `background-work.fixture.ts` (CLI 2.1.282, 25/09), plus single lines copied
 * from the verifiers' recordings of the same CLI where the fixture has none.
 * @covers MONITOR-02
 */
import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_WORK_CAP_MS,
  WAKE_QUEUED_MS,
  datedByLastWrite,
  isBackgroundWorkAlive,
  isWakeQueued,
  newBackgroundWork,
  noteBackgroundLine,
  type BackgroundWork,
} from "./background-work";
import { readBackgroundTasks } from "./events";
import { recordedBackgroundSession } from "./background-work.fixture";

const events = recordedBackgroundSession();
const firstResult = events.findIndex((e) => e.type === "result");

/** Fold events [0, end) with a clock that ticks one second per line; after the first turn nobody is driving. */
function foldUntil(end: number): { work: BackgroundWork; now: number } {
  const work = newBackgroundWork();
  let now = 1_000_000;
  for (let i = 0; i < end; i++) { now += 1_000; noteBackgroundLine(work, events[i], now, { unattended: i > firstResult }); }
  return { work, now };
}

const snapshot = (tasks: Array<Record<string, unknown>>) => ({ type: "system", subtype: "background_tasks_changed", tasks });
const started = (task_id: string, tool_use_id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "system", subtype: "task_started", task_id, tool_use_id, is_backgrounded: true, task_type: "local_bash", ...extra });
const notification = (task_id: string) => ({ type: "system", subtype: "task_notification", task_id, status: "completed" });

describe("background work, from the recorded CLI session", () => {
  const lastEmptySnapshot = events.findLastIndex((e) => readBackgroundTasks(e)?.length === 0);

  test("the turn ends with the agent, the Bash and the Monitor still running", () => {
    const { work, now } = foldUntil(firstResult + 1);
    expect([...work.tasks.values()].map((t) => t.type).sort()).toEqual(["local_agent", "local_bash", "local_bash"]);
    expect(isBackgroundWorkAlive(work, now)).toBe(true);
  });

  test("it stays alive through every wake; after the empty snapshot only the queued wake keeps the session, until it starts", () => {
    for (let end = firstResult + 1; end <= lastEmptySnapshot; end++) {
      const { work, now } = foldUntil(end);
      expect(isBackgroundWorkAlive(work, now)).toBe(true);
    }
    // The agent's report follows the empty snapshot: the CLI is about to answer it.
    const lastInit = events.findLastIndex((e) => e.type === "system" && e.subtype === "init");
    const before = foldUntil(lastInit);
    expect(before.work.tasks.size).toBe(0);
    expect(isWakeQueued(before.work, before.now)).toBe(true);
    // The wake started: nothing left to wait for.
    const after = foldUntil(lastInit + 1);
    expect(isBackgroundWorkAlive(after.work, after.now)).toBe(false);
  });

  test("two hours without a word about it, the work is presumed lost", () => {
    const { work } = foldUntil(firstResult + 1);
    const heard = work.lastSignalAt;
    expect(isBackgroundWorkAlive(work, heard + BACKGROUND_WORK_CAP_MS - 1)).toBe(true);
    expect(isBackgroundWorkAlive(work, heard + BACKGROUND_WORK_CAP_MS)).toBe(false);
  });

  test("the agent's own lines are news: they move the two hours", () => {
    const { work, now } = foldUntil(firstResult + 1);
    const agentLine = events.slice(firstResult + 1).find((e) => typeof e.parent_tool_use_id === "string")!;
    const later = now + BACKGROUND_WORK_CAP_MS - 1_000;
    noteBackgroundLine(work, agentLine, later, { unattended: true });
    expect(isBackgroundWorkAlive(work, later + BACKGROUND_WORK_CAP_MS - 1)).toBe(true);
  });

  test("a Monitor's event is news: its wake carries no task line, only the model", () => {
    const { work } = foldUntil(firstResult + 1);
    const tick = events.findIndex((e) => e.type === "assistant" && JSON.stringify(e.message).includes("Tick-2 fired."));
    const init = events.slice(0, tick).findLastIndex((e) => e.type === "system" && e.subtype === "init");
    const at = work.lastSignalAt + BACKGROUND_WORK_CAP_MS - 5;
    noteBackgroundLine(work, events[init], at, { unattended: true });
    expect(work.lastSignalAt).toBe(at);
  });

  test("a turn somebody sent is not news about the background", () => {
    const { work } = foldUntil(firstResult + 1);
    const before = work.lastSignalAt;
    noteBackgroundLine(work, { type: "system", subtype: "init" }, before + 5_000, { unattended: false });
    noteBackgroundLine(work, { type: "assistant", message: { content: [{ type: "text", text: "Tick-1 fired." }] } }, before + 6_000, { unattended: false });
    expect(work.lastSignalAt).toBe(before);
  });
});

describe("background work, lines the fixture lacks (verifiers' recordings, CLI 2.1.282)", () => {
  test("an ambient task is not work: the CLI's schema says hosts should leave it out", () => {
    const work = newBackgroundWork();
    noteBackgroundLine(work, snapshot([{ task_id: "d1", task_type: "dream", description: "dream", ambient: true }]), 10, { unattended: true });
    expect(work.tasks.size).toBe(0);
    expect(isBackgroundWorkAlive(work, 11)).toBe(false);
    noteBackgroundLine(work, snapshot([
      { task_id: "d1", task_type: "dream", description: "dream", ambient: true },
      { task_id: "b1", task_type: "local_bash", description: "suite" },
    ]), 12, { unattended: true });
    expect([...work.tasks.keys()]).toEqual(["b1"]);
  });

  test("a heartbeat is news only for a listed task: a foreground Bash's heartbeat is not", () => {
    const work = newBackgroundWork();
    noteBackgroundLine(work, snapshot([{ task_id: "b1", task_type: "local_bash", description: "suite" }]), 10, { unattended: true });
    noteBackgroundLine(work, started("b1", "toolu_bg"), 11, { unattended: true });
    // `during-user.ndjson`: a foreground Bash of the main thread, with its own task_started.
    noteBackgroundLine(work, started("fg", "toolu_fg", { is_backgrounded: false }), 12, { unattended: false });
    const beat = (parent: string) => ({ type: "tool_progress", tool_use_id: `${parent}-heartbeat-0`, tool_name: "Bash", parent_tool_use_id: parent, elapsed_time_seconds: 30, heartbeat: true });
    noteBackgroundLine(work, beat("toolu_fg"), 500, { unattended: false });
    expect(work.lastSignalAt).toBe(11);
    noteBackgroundLine(work, beat("toolu_bg"), 600, { unattended: true });
    expect(work.lastSignalAt).toBe(600);
  });

  test("only the model's own background task queues a wake: not a foreground Bash, not a subagent's task", () => {
    const work = newBackgroundWork();
    noteBackgroundLine(work, snapshot([{ task_id: "b1", task_type: "local_bash", description: "suite" }, { task_id: "s1", task_type: "local_bash", description: "the agent's wait" }]), 10, { unattended: true });
    noteBackgroundLine(work, started("b1", "toolu_b1"), 10, { unattended: true });
    noteBackgroundLine(work, started("s1", "toolu_s1", { owned_by_subagent: true }), 10, { unattended: true });
    noteBackgroundLine(work, started("fg", "toolu_fg", { is_backgrounded: false }), 11, { unattended: false });
    noteBackgroundLine(work, notification("fg"), 20, { unattended: false });
    noteBackgroundLine(work, notification("s1"), 21, { unattended: true });
    expect(isWakeQueued(work, 22)).toBe(false);
    noteBackgroundLine(work, snapshot([]), 30, { unattended: true });
    noteBackgroundLine(work, notification("b1"), 30, { unattended: true });
    expect(isWakeQueued(work, 31)).toBe(true);
    expect(isWakeQueued(work, 30 + WAKE_QUEUED_MS)).toBe(false);
    noteBackgroundLine(work, { type: "system", subtype: "init" }, 32, { unattended: true });
    expect(isWakeQueued(work, 33)).toBe(false);
  });

  test("a snapshot that changes only an ambient entry is not news for the tasks listed next to it", () => {
    const work = newBackgroundWork();
    noteBackgroundLine(work, snapshot([{ task_id: "b1", task_type: "local_bash", description: "suite" }]), 10, { unattended: true });
    noteBackgroundLine(work, snapshot([
      { task_id: "b1", task_type: "local_bash", description: "suite" },
      { task_id: "d1", task_type: "dream", description: "dream", ambient: true },
    ]), 5_000, { unattended: true });
    expect(work.lastSignalAt).toBe(10);
    noteBackgroundLine(work, snapshot([{ task_id: "b1", task_type: "local_bash", description: "suite" }, { task_id: "b2", task_type: "local_bash", description: "build" }]), 6_000, { unattended: true });
    expect(work.lastSignalAt).toBe(6_000);
  });

  test("a replay is dated by the child's last write, the queued wake too", () => {
    const work = newBackgroundWork();
    noteBackgroundLine(work, snapshot([{ task_id: "b1", task_type: "local_bash", description: "suite" }]), 5_000_000, { unattended: true });
    noteBackgroundLine(work, started("b1", "toolu_b1"), 5_000_000, { unattended: true });
    noteBackgroundLine(work, snapshot([]), 5_000_000, { unattended: true });
    noteBackgroundLine(work, notification("b1"), 5_000_000, { unattended: true });
    datedByLastWrite(work, 1_000);
    expect(work.lastSignalAt).toBe(1_000);
    expect(isWakeQueued(work, 5_000_001)).toBe(false);
  });
});

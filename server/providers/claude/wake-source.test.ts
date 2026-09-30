/**
 * A MONITOR'S END IS THAT MONITOR'S, AND ITS LAST EVENT IS SHOWN.
 *
 * The CLI closes a Monitor with one notification whose summary is not
 * `Monitor event: "<description>"` but one of four endings (CLI 2.1.286, the
 * function that words a task's end): `Monitor "<description>" stream ended`,
 * `... script failed (exit N)`, `... stopped`, `... ended without producing
 * output`. The last event the Monitor printed travels in that same
 * notification. Recorded with the real CLI 2.1.285 (a Monitor running
 * `sleep 6; echo EVT-ONE; sleep 6; echo EVT-TWO`), the transcript line reads
 * `<summary>Monitor "probe-mon" stream ended</summary>\n<event>EVT-TWO</event>`.
 * In a real chat 7 Monitor notifications of 43 had this shape.
 *
 * Read as a generic task, such a wake showed "a background task reported:
 * Monitor "probe-mon" stream ended" and dropped EVT-TWO, the result the person
 * was waiting for.
 * @covers MONITOR-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { claudeTranscriptPath } from "../../lib/claude-transcript-path";
import { newBackgroundWork, noteBackgroundLine } from "./background-work";
import { resolveWakeSource } from "./wake-source";

// The transcript is looked up under the real home: bun caches `homedir()` at
// its first call, so moving HOME in a test does not move it. A cwd no one uses
// keeps these files apart, and its folder goes when the file is done.
const CWD = `/wake-source-test/${process.pid}-${Date.now()}`;
const SESSION = "00000000-0000-4000-8000-0000000000c1";
afterAll(() => {
  rmSync(dirname(claudeTranscriptPath(CWD, SESSION)), { recursive: true, force: true });
});

let n = 0;
/** One wake: the CLI's transcript holds `content` as the user line that opened the turn. */
function wakeOn(content: string) {
  const session = `${SESSION.slice(0, -2)}${String(++n).padStart(2, "0")}`;
  const path = claudeTranscriptPath(CWD, session);
  mkdirSync(dirname(path), { recursive: true });
  const now = Date.now();
  appendFileSync(path, JSON.stringify({ type: "user", timestamp: new Date(now).toISOString(), sessionId: session, cwd: CWD, message: { role: "user", content } }) + "\n");
  const work = newBackgroundWork();
  work.cliCwd = CWD;
  work.cliSessionId = session;
  work.turnEndedAt = now - 5_000;
  return resolveWakeSource(work);
}

const note = (summary: string, event?: string) =>
  `<task-notification>\n<task-id>bprobe01</task-id>\n<summary>${summary}</summary>\n${event !== undefined ? `<event>${event}</event>\n` : ""}</task-notification>`;

describe("the wake that answers a Monitor's end", () => {
  test("the recorded line: that Monitor, how it ended, and its last event", () => {
    expect(wakeOn(note('Monitor "probe-mon" stream ended', "EVT-TWO"))).toEqual([
      { source: "monitor", label: "probe-mon", end: "stream ended", text: "EVT-TWO" },
    ]);
  });

  test("each of the CLI's four endings is that Monitor's, exit code kept", () => {
    const cases: Array<[string, string]> = [
      ['Monitor "deploy log" script failed (exit 2)', "script failed (exit 2)"],
      ['Monitor "deploy log" stopped', "stopped"],
      ['Monitor "deploy log" ended without producing output', "ended without producing output"],
      ['Monitor "deploy log" ended without producing output (exit 0)', "ended without producing output (exit 0)"],
    ];
    for (const [summary, end] of cases) {
      expect(wakeOn(note(summary))).toEqual([{ source: "monitor", label: "deploy log", end }]);
    }
  });

  test("a description with quotes in it is kept whole", () => {
    expect(wakeOn(note('Monitor "tail "prod" log" stream ended', "done"))).toEqual([
      { source: "monitor", label: 'tail "prod" log', end: "stream ended", text: "done" },
    ]);
  });

  test("an event and a task's report read as before", () => {
    expect(wakeOn(note('Monitor event: "batch 4 results"', "[new] v133 ok"))).toEqual([
      { source: "monitor", label: "batch 4 results", text: "[new] v133 ok" },
    ]);
    expect(wakeOn(note('Agent "Verify v131" finished'))).toEqual([{ source: "task", label: 'Agent "Verify v131" finished' }]);
    expect(wakeOn(note('Background command "build" completed (exit code 0)'))).toEqual([
      { source: "task", label: 'Background command "build" completed (exit code 0)' },
    ]);
  });
});

describe("with no transcript line, the stdout report of a Monitor's end", () => {
  test("names that Monitor and how it ended, never an event", () => {
    const work = newBackgroundWork();
    const opts = { unattended: false };
    const t = 1_000_000;
    noteBackgroundLine(work, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_p", name: "Monitor", input: { description: "probe-mon" } }] } }, t, opts);
    noteBackgroundLine(work, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bprobe01", task_type: "local_bash", description: "probe-mon" }] }, t, opts);
    noteBackgroundLine(work, { type: "system", subtype: "task_started", task_id: "bprobe01", tool_use_id: "toolu_p", description: "probe-mon", task_type: "local_bash" }, t, opts);
    noteBackgroundLine(work, { type: "system", subtype: "background_tasks_changed", tasks: [] }, t + 10, opts);
    noteBackgroundLine(work, { type: "system", subtype: "task_notification", task_id: "bprobe01", tool_use_id: "toolu_p", status: "completed", summary: 'Monitor "probe-mon" stream ended' }, t + 10, opts);
    work.turnEndedAt = t - 5_000;
    expect(resolveWakeSource(work)).toEqual([{ source: "monitor", label: "probe-mon", end: "stream ended" }]);
  });
});

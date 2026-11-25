/**
 * The third origin of a process row, `job` (R11): a scheduled command is kept
 * in `recentScripts` until the engine has taken its end, its end is replayed to
 * a listener that arrives after it, and the chat's live strip never shows it.
 *
 * @covers SCHED-04
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "topics-job-origin-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { liveCommandsOf, setJobCommandEndListener, settleJobRun } = await import("./processes-commands");
const { trimRecent } = await import("./processes-output");
const { MAX_RECENT, recentScripts, runningScripts } = await import("./processes-state");
type Row = import("./processes-state").ScriptProcess;

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(STATE, { recursive: true, force: true });
});

function jobRow(id: string, status: Row["status"] = "done"): Row {
  return {
    processId: id, scriptName: id, command: "x", projectPath: "/p", status, pid: null, startedAt: new Date().toISOString(),
    output: [], outputBytes: 0, proc: null, source: "command", exitCode: status === "done" ? 0 : undefined,
    cmd: { sessionKey: "job:j", topicId: "topic-1", wake: false, origin: "job", job: { jobId: "j", runId: `run-${id}` } },
  };
}

describe("origin job", () => {
  test("rows the engine has not taken yet survive trimRecent; once taken they are pruned like the rest", () => {
    recentScripts.length = 0;
    for (let i = 0; i < MAX_RECENT + 5; i++) recentScripts.push(jobRow(`r${i}`));
    trimRecent();
    expect(recentScripts).toHaveLength(MAX_RECENT + 5);
    for (const row of recentScripts) row.jobSettled = true;
    trimRecent();
    expect(recentScripts).toHaveLength(MAX_RECENT);
  });

  test("an end that came before the listener is replayed once, and each end after it is delivered once", () => {
    recentScripts.length = 0;
    recentScripts.push(jobRow("early"));
    const seen: string[] = [];
    setJobCommandEndListener((end) => seen.push(end.runId));
    expect(seen).toEqual(["run-early"]);
    const late = jobRow("late");
    recentScripts.push(late);
    settleJobRun(late);
    settleJobRun(late);
    setJobCommandEndListener((end) => seen.push(end.runId));
    expect(seen).toEqual(["run-early", "run-late"]);
    setJobCommandEndListener(null);
  });

  test("the chat's live strip never shows a scheduled command, even one tied to its topic", () => {
    runningScripts.clear();
    const running = jobRow("live", "running");
    runningScripts.set("live", running);
    expect(liveCommandsOf("topic-1")).toEqual([]);
    runningScripts.clear();
  });
});

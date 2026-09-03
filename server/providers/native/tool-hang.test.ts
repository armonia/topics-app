/**
 * A COMMAND THAT EXITED MUST ANSWER, EVEN IF SOMEBODY HOLDS ITS PIPE OPEN.
 *
 * On 2026-09-02 two chats (`topic:6b9605e5`, `topic:ada7e7db`) sat on
 * `bash:running` for hours. The command had the shape
 * `cd x && nohup <daemon> > /tmp/log 2>&1 &` followed by a probing `curl`: the
 * redirection applies to the daemon, not to the subshell bash forks to push it
 * into the background, and that subshell (pid 30236, reparented to init) kept
 * the server's stdout and stderr open for three and a half hours. `runCommand`
 * waited for `close`, which only arrives once every pipe is closed: the tool's
 * promise never resolved, the agent loop stayed inside its await, and the three
 * guards above it — `isTurnProcessAlive`, `toolRunning`, the restart cap — read
 * that wait as work in progress. Two chats stuck loading, and the automatic
 * restart held back by them.
 *
 * @covers RT-01
 */
import { describe, expect, test } from "bun:test";
import { executeTool } from "./tools";

describe("runCommand answers when the command exits", () => {
  test("a background child that inherits the pipe does not hold the answer", async () => {
    const startedAt = Date.now();
    // `sleep 20 &` inherits our stdout and never closes it: bash exits at once,
    // `close` would arrive twenty seconds later. Before the fix this await ran
    // out; now the answer comes with the exit of the process we spawned.
    const out = await executeTool(
      "bash",
      { command: "sleep 20 & echo via" },
      { workspace: process.cwd() },
    );
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(out.content).toContain("via");
    expect(out.isError).toBeUndefined();
  });

  test("the timeout answers even when no event ever arrives", async () => {
    const startedAt = Date.now();
    const out = await executeTool(
      "bash",
      { command: "sleep 30" },
      { workspace: process.cwd(), bashTimeoutMs: 300 },
    );
    // The ceiling is 300ms plus the grace given to the kill: far below the 30s
    // of the command, which is the point.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(out.content).toContain("ucciso dopo 300ms");
  });

  test("ordinary output still comes back whole", async () => {
    const out = await executeTool(
      "bash",
      { command: "for i in 1 2 3; do echo line$i; done" },
      { workspace: process.cwd() },
    );
    expect(out.content).toContain("line1");
    expect(out.content).toContain("line3");
  });
});

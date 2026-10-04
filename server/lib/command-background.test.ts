/**
 * The registry's rows read as one chat's background line (BGVIS-07): only that
 * chat's running commands, and a name that cannot break the wake's text.
 * @covers BGVIS-07
 */
import { describe, expect, test } from "bun:test";
import { commandLabel, commandWorkOver, observeCommandChanged, pushBackgroundChanged } from "./command-background";

const row = (processId: string, sessionKey: string, status = "running") => ({
  processId, scriptName: `job ${processId}`, startedAt: "2026-10-01T00:40:00.000Z", status, cmd: { sessionKey, wake: true },
});

describe("command-background", () => {
  test("a chat's line lists its own running commands, never another chat's", () => {
    const work = commandWorkOver(() => [row("p1", "topic:a"), row("p2", "topic:b"), row("p3", "topic:a", "exited")]);
    expect(work.tasks("topic:a").map((t) => t.processId)).toEqual(["p1"]);
    expect(work.tasks("topic:b").map((t) => t.processId)).toEqual(["p2"]);
    expect(work.sessions().sort()).toEqual(["topic:a", "topic:b"]);
  });

  test("a command of a chat that starts or ends tells the attention state, a terminal's does not", () => {
    const told: string[] = [];
    const frames: unknown[] = [];
    observeCommandChanged((sk) => { told.push(sk); });
    try {
      pushBackgroundChanged({ broadcastToAll: (f: unknown) => { frames.push(f); } } as never, { topicId: "t1", sessionKey: "topic:t1" });
      pushBackgroundChanged({ broadcastToAll: (f: unknown) => { frames.push(f); } } as never, { topicId: null, sessionKey: "term:x" });
    } finally {
      observeCommandChanged(() => {});
    }
    expect(told).toEqual(["topic:t1"]);
    expect(frames).toHaveLength(1);
  });

  test("a backtick in the description the agent gave does not reach the name", () => {
    expect(commandLabel("sleep 1", "wait for `jobs`")).toBe("wait for 'jobs'");
  });
});

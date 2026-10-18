/**
 * A pane resumes the conversation its CLI is on now, not the one it was spawned
 * with: a `/clear` moves Claude Code to a new session id.
 * @covers TERM-05
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { liveClaudeSessionId, panesToFollow } from "./claude-live-session";

const dir = mkdtempSync(join(tmpdir(), "claude-live-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("liveClaudeSessionId", () => {
  test("reads the session id the CLI wrote for its pid", () => {
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "after-clear", status: "busy" }));
    expect(liveClaudeSessionId(4242, dir)).toBe("after-clear");
  });

  test("no file, a torn write or no id: nothing to follow", () => {
    expect(liveClaudeSessionId(4343, dir)).toBeNull();
    writeFileSync(join(dir, "4444.json"), '{"pid":4444,"sessi');
    expect(liveClaudeSessionId(4444, dir)).toBeNull();
    writeFileSync(join(dir, "4545.json"), JSON.stringify({ pid: 4545, sessionId: "" }));
    expect(liveClaudeSessionId(4545, dir)).toBeNull();
  });
});

describe("panesToFollow", () => {
  const live = (pid: number) => ({ 1: "new", 2: "same", 3: "new", 4: "new", 5: "new" } as Record<number, string>)[pid] ?? null;

  test("a cleared Claude pane moves to the id its CLI is on", () => {
    const cleared = { id: "a", type: "claude-code", ptyPid: 1, claudeSessionId: "old" };
    const team = { id: "t", type: "claude-code-team", ptyPid: 5, claudeSessionId: "old" };
    expect(panesToFollow([cleared, team], live)).toEqual([
      { pane: cleared, sessionId: "new" },
      { pane: team, sessionId: "new" },
    ]);
  });

  test("leaves alone a pane already on it, a CLI that says nothing, other kinds, sub-agents and panes without a pid", () => {
    const panes = [
      { type: "claude-code", ptyPid: 2, claudeSessionId: "same" },
      { type: "claude-code", ptyPid: 9, claudeSessionId: "old" },
      { type: "shell", ptyPid: 3, claudeSessionId: "old" },
      { type: "codex", ptyPid: 3, claudeSessionId: "old" },
      { type: "claude-code", ptyPid: 4, claudeSessionId: "old", parentSessionKey: "topic:parent" },
      { type: "claude-code", claudeSessionId: "old" },
    ];
    expect(panesToFollow(panes, live)).toEqual([]);
  });
});

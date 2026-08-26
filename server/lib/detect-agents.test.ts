/**
 * @covers RUNTIME-08
 *
 * Detecting which agent CLIs are installed is the answer to a question nothing
 * used to ask. Without it a missing agent produced a tab that opened and stayed
 * empty: on macOS the shell at least printed "command not found", on Windows not
 * even that, because the process never started (reported 2026-08-26).
 */
import { test, expect } from "bun:test";
import { existsSync } from "fs";
import { detectAgents } from "./detect-agents";

test("every agent reports a coherent state", () => {
  const agents = detectAgents();
  expect(agents.length).toBeGreaterThan(0);

  for (const a of agents) {
    // `installed` must be DERIVED from the path, never asserted on its own:
    // a true with no path is the shape that sends the UI to spawn something
    // that is not there.
    expect(a.installed).toBe(a.path !== null);
    // A resolved path must be a real file. A stale cache or a candidate list
    // pointing at a directory would otherwise be announced as "installed".
    if (a.path) expect(existsSync(a.path)).toBe(true);
    // Whoever is missing an agent must be told how to get it: an empty string
    // here is a dead end in the first-run screen.
    expect(a.install.length).toBeGreaterThan(0);
    expect(a.url.startsWith("https://")).toBe(true);
    expect(a.name.length).toBeGreaterThan(0);
  }
});

test("the ids match the session types the server can actually spawn", () => {
  // The id is what the client posts as `type` to /api/terminal/sessions. An id
  // that does not exist there produces a plain shell instead of the agent, in
  // silence — the server falls back to `shell` for anything unknown.
  const spawnable = new Set(["claude-code", "codex", "opencode", "gemini"]);
  for (const a of detectAgents()) expect(spawnable.has(a.id)).toBe(true);
});

test("Claude Code is listed first", () => {
  // It is the default agent: on a first-run screen the order is the
  // recommendation, and the recommended one goes at the top.
  expect(detectAgents()[0].id).toBe("claude-code");
});

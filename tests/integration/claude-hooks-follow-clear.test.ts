/**
 * A `/clear` in a Claude pane moves the CLI to a new session id, and the first
 * hook from that id is the pane's news of it. Through the hook route, on the
 * real terminal row: the resume id a park would use follows the CLI.
 * @covers TERM-05
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { createClaudeSessionTracker } from "../../server/lib/claude-session-tracker";
import { _setClaudeSessionsDirForTests } from "../../server/lib/claude-live-session";
import { _terminalSessionsForTests, parkIdleClaudeSessions, type TerminalSession } from "../../server/routes/terminal";
import { getDatabase } from "../../server/db";

const ROOT = testTmpDir("claude-hooks-follow-clear");
const CLI_SESSIONS = join(ROOT, "cli-sessions");
// The router writes its hook token and script under TOPICS_HOME: left to the
// default that is the file every live session of the production server runs.
let previousTopicsHome: string | undefined;
beforeAll(() => {
  setupTestDataDir(join(ROOT, "data"));
  previousTopicsHome = process.env.TOPICS_HOME;
  process.env.TOPICS_HOME = join(ROOT, "topics-home");
  mkdirSync(CLI_SESSIONS, { recursive: true });
  _setClaudeSessionsDirForTests(CLI_SESSIONS);
});
afterAll(async () => {
  _terminalSessionsForTests().delete("pane-cleared");
  _terminalSessionsForTests().delete("pane-quiet");
  _setClaudeSessionsDirForTests(null);
  if (previousTopicsHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = previousTopicsHome;
  await cleanupTestDataDir(ROOT);
});

test("the first hook after a /clear moves the pane's resume id to the new conversation", async () => {
  const ctx = await createTestAppContext();
  const db = getDatabase();
  const createdAt = new Date().toISOString();
  db.run(
    "INSERT INTO terminal_sessions (id, name, cwd, type, created_at, claude_session_id, status) VALUES (?, ?, ?, 'claude-code', ?, ?, 'active')",
    ["pane-cleared", "Clap", ROOT, createdAt, "before-clear"],
  );
  const pane: TerminalSession = {
    id: "pane-cleared", name: "Clap", createdAt, cwd: ROOT, command: "claude",
    cols: 80, rows: 24, type: "claude-code", skipPermissions: true, nameSource: "default",
    claudeSessionId: "before-clear", ptyPid: 4242,
  };
  _terminalSessionsForTests().set(pane.id, pane);
  // What Claude Code writes for its process once `/clear` has moved it.
  writeFileSync(join(CLI_SESSIONS, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "after-clear", status: "idle" }));

  const tracker = createClaudeSessionTracker({ db, broadcast: () => {}, coalesceWindowMs: 20, dedupWindowMs: 100, rateLimitPerSec: 50 });
  const { createClaudeHooksRouter, getOrCreateHookToken } = await import("../../server/routes/claude-hooks");
  const router = createClaudeHooksRouter(ctx, tracker);
  // The token the router checks: cached for the process, so not always on disk under this TOPICS_HOME.
  const token = getOrCreateHookToken();
  const url = new URL("http://127.0.0.1:3333/api/claude-hooks/SessionStart");
  const res = await router(
    new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1:3333", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id: "after-clear", source: "clear", cwd: ROOT }),
    }),
    url, url.pathname, "POST",
  );

  expect(res?.status).toBe(200);
  expect(pane.claudeSessionId).toBe("after-clear");
  expect(db.query("SELECT claude_session_id FROM terminal_sessions WHERE id = ?").get("pane-cleared"))
    .toEqual({ claude_session_id: "after-clear" });
});

test("a park looks first: the id it would resume from is the one the CLI is on", async () => {
  await createTestAppContext();
  const db = getDatabase();
  const createdAt = new Date().toISOString();
  db.run(
    "INSERT INTO terminal_sessions (id, name, cwd, type, created_at, claude_session_id, status) VALUES (?, ?, ?, 'claude-code', ?, ?, 'active')",
    ["pane-quiet", "Quiet", ROOT, createdAt, "before-clear-2"],
  );
  const pane: TerminalSession = {
    id: "pane-quiet", name: "Quiet", createdAt, cwd: ROOT, command: "claude",
    cols: 80, rows: 24, type: "claude-code", skipPermissions: true, nameSource: "default",
    claudeSessionId: "before-clear-2", ptyPid: 4343,
  };
  _terminalSessionsForTests().set(pane.id, pane);
  // Cleared and left alone, with no hook since: only the park is left to notice.
  writeFileSync(join(CLI_SESSIONS, "4343.json"), JSON.stringify({ pid: 4343, sessionId: "after-clear-2", status: "idle" }));

  // No activity was ever measured here, so the park itself is refused and nothing is killed.
  parkIdleClaudeSessions(60_000);

  expect(pane.claudeSessionId).toBe("after-clear-2");
  expect(db.query("SELECT claude_session_id FROM terminal_sessions WHERE id = ?").get("pane-quiet"))
    .toEqual({ claude_session_id: "after-clear-2" });
});

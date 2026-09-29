/**
 * THE SPAWN OF A FORKED CLAUDE CODE CHAT, against a real database.
 *
 * The route wrote the branch's session (`branch_ref`) and its fork. What is
 * proven here is what the spawn makes of it: the first start forks the parent
 * at the point and carries no recap; once the branch has a transcript it is an
 * ordinary resume, and once its first start said `system/init` it is one from
 * any cwd; a session forgotten by `/clear`, a worktree reap or a recovery
 * never forks again; and a refused fork start is a recovery that restarts
 * fresh with the recap, not a crash.
 *
 * The transcript of the branch is written where the CLI would write it, under
 * `~/.claude/projects/<the workspace, encoded>` (the house method of
 * `claude-transcript-path.test.ts`): the workspace is a fresh temp dir, so the
 * folder name is unique, and it is removed after each test.
 *
 * @covers CHAT-FORK-02
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { ClaudeCodeProvider, planClaudeSessionStart } from "./claude-code";
import { buildClaudeArgs } from "./claude/args";
import { insertChatFork } from "../lib/chat-fork-store";
import { claudeTranscriptCandidates } from "../lib/claude-transcript-path";
import { createWorktreeStore } from "../services/worktree-store";
import { SidechainTracker } from "./claude/sidechain-tracker";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const NOW = "2026-09-28T00:00:00.000Z";
const SK = "topic:forkspwn";
const PARENT = "parent-session-0000";
const POINT = "point-uuid-0001";
const BRANCH = "branch-session-0001";
let tempRoot: string;
let workspace: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  try { closeDatabase(); } catch { /* no database open yet */ }
  tempRoot = mkdtempSync(join(tmpdir(), "topics-fork-spawn-"));
  workspace = mkdtempSync(join(tmpdir(), "topics-fork-ws-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(tempRoot, "data");
  initDatabase(REPO_ROOT, tempRoot);
  seedBranch();
});

afterEach(() => {
  try { closeDatabase(); } catch { /* cleanup */ }
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  for (const file of claudeTranscriptCandidates(workspace, BRANCH)) rmSync(dirname(file), { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** What the route leaves behind: topic, copied history, fork row, the branch's session. */
function seedBranch(): void {
  const db = getDatabase();
  db.prepare("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES ('forkspwn', 'Branch', 'branch', ?, ?, ?)").run(SK, NOW, NOW);
  const row = db.prepare("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index, partial) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)");
  row.run("c-u0", SK, "user", "remember the word LIVE-ONE", NOW, 0, null);
  row.run("c-a0", SK, "assistant", "LIVE-ONE", NOW, 1, "c-u0");
  insertChatFork(db, { sessionKey: SK, parentTopicId: "parent", parentName: "Parent", forkPointMessageId: "c-a0", runtime: "claude-cli", parentRef: PARENT, parentAt: POINT, branchRef: BRANCH, createdAt: NOW });
  db.prepare("INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(SK, BRANCH, NOW, NOW);
}

/** The branch's first user message of this turn, as the chat route appends it before the spawn. */
function appendPrompt(): void {
  getDatabase().prepare("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index, partial) VALUES ('c-u1', ?, 'user', 'and now?', ?, 2, 'c-a0', 0, 0)").run(SK, NOW);
}

function argvOf(plan: ReturnType<typeof planClaudeSessionStart>): string[] {
  return buildClaudeArgs({
    permissionMode: "acceptEdits", model: "haiku", mcpConfigPath: "/tmp/mcp.json", mcpStrict: true,
    permissionPromptTool: "t", appendSystemPrompt: "p",
    claudeSessionId: plan.claudeSessionId, isNewSession: plan.isNewSession, forkFrom: plan.forkFrom,
  });
}

/** The live process of a forking start, as far as the stream handler reads it (`claude-code-context-size.test.ts`). */
function forkingProcess(plan: ReturnType<typeof planClaudeSessionStart>) {
  return {
    sessionKey: SK, consumedOffset: 0, stderrBuf: "", recovering: false, pendingReject: null, pendingResolve: null,
    spawnMeta: { claudeSessionId: plan.claudeSessionId, isNewSession: plan.isNewSession, forkFrom: plan.forkFrom },
    createdAt: Date.now(), lastActivity: Date.now(), lastEventAt: Date.now(), alive: true, fullText: "",
    activeToolCalls: new Set(), subAgentEmit: new Map(), pendingInputs: new Map(), sidechain: new SidechainTracker(),
    needsHistoryReplay: false,
    streamHandler: { onTextDelta() {}, onToolStart() {}, onToolResult() {}, onDone() {}, onError() {} },
  };
}

function expectFreshWithoutFork(plan: ReturnType<typeof planClaudeSessionStart>): string[] {
  expect(plan.claudeSessionId).not.toBe(BRANCH);
  expect(plan.isNewSession).toBe(true);
  expect(plan.forkFrom).toBeNull();
  const args = argvOf(plan);
  expect(args.slice(-2)).toEqual(["--session-id", plan.claudeSessionId]);
  expect(args).not.toContain("--fork-session");
  expect(args).not.toContain(PARENT);
  return args;
}

describe("a forked chat's spawn", () => {
  test("the first start forks the parent at the point, onto the minted uuid, without the recap", () => {
    appendPrompt();
    const plan = planClaudeSessionStart(SK, workspace);
    expect(plan).toEqual({ claudeSessionId: BRANCH, isNewSession: false, forkFrom: { sessionId: PARENT, atUuid: POINT }, needsHistoryReplay: false });
    expect(argvOf(plan).slice(-7)).toEqual(["--resume", PARENT, "--resume-session-at", POINT, "--fork-session", "--session-id", BRANCH]);
  });

  test("with the branch's transcript on disk it is an ordinary chat: --resume <branch>", () => {
    const file = claudeTranscriptCandidates(workspace, BRANCH)[0];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    const plan = planClaudeSessionStart(SK, workspace);
    expect(plan.forkFrom).toBeNull();
    const args = argvOf(plan);
    expect(args.slice(-2)).toEqual(["--resume", BRANCH]);
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("--resume-session-at");
  });

  test("the first start's system/init consumes the fork: a branch moved to another project resumes its own session", () => {
    appendPrompt();
    const plan = planClaudeSessionStart(SK, workspace);
    expect(plan.forkFrom).not.toBeNull();
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const pp = forkingProcess(plan);
    (provider as unknown as { handleStreamEvent(pp: unknown, e: unknown): void })
      .handleStreamEvent(pp, { type: "system", subtype: "init", session_id: BRANCH });
    // `/project open`, `open_project`, autoBind or a PATCH of projectPath: the
    // next spawn runs in a cwd where the branch's transcript is not. The CLI
    // finds a session by id from any cwd; forked again, the model lost the
    // branch's turns (measured on CLI 2.1.284, round 2 of the verifiers).
    const moved = mkdtempSync(join(tmpdir(), "topics-fork-moved-"));
    try {
      const next = planClaudeSessionStart(SK, moved);
      expect(next).toEqual({ claudeSessionId: BRANCH, isNewSession: false, forkFrom: null, needsHistoryReplay: false });
      expect(argvOf(next).slice(-2)).toEqual(["--resume", BRANCH]);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  test("/clear on the branch: a new uuid, --session-id, and neither the parent nor a recap", async () => {
    await new ClaudeCodeProvider({ type: "claude-code" }).resetSession(SK);
    // The route empties the chat before it resets the provider (routes/topics.ts, `clear`).
    getDatabase().prepare("DELETE FROM messages WHERE session_key = ?").run(SK);
    getDatabase().prepare("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, branch_index, partial) VALUES ('n0', ?, 'user', 'fresh start', ?, 0, 0, 0)").run(SK, NOW);
    const plan = planClaudeSessionStart(SK, workspace);
    expectFreshWithoutFork(plan);
    expect(plan.needsHistoryReplay).toBe(false);
  });

  test("a worktree reap forgets the session: fresh, with the recap of the copy and the branch's turns", () => {
    const db = getDatabase();
    db.prepare("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('pr', 'p', 'p', ?, ?, ?)").run(workspace, NOW, NOW);
    db.prepare("INSERT INTO worktrees (id, project_id, name, mode, abs_path, status, created_at, updated_at) VALUES ('wt', 'pr', 'w', 'branch', ?, 'ready', ?, ?)").run(join(workspace, "wt"), NOW, NOW);
    db.prepare("UPDATE topics SET worktree_id = 'wt' WHERE session_key = ?").run(SK);
    createWorktreeStore(db).delete("wt");
    appendPrompt();
    const plan = planClaudeSessionStart(SK, workspace);
    expectFreshWithoutFork(plan);
    expect(plan.needsHistoryReplay).toBe(true);
  });

  for (const refusal of [
    "No conversation found with session ID: parent-session-0000",
    "No message found with message.uuid of: point-uuid-0001",
    "error: unknown option '--resume-session-at'",
    "error: unknown option '--fork-session'",
  ]) {
    test(`a refused fork start («${refusal}») is a recovery: next spawn --session-id with the recap, no fork`, () => {
      appendPrompt();
      const plan = planClaudeSessionStart(SK, workspace);
      expect(plan.forkFrom).not.toBeNull();
      const pp = {
        sessionKey: SK, stderrBuf: "", recovering: false, pendingReject: null,
        spawnMeta: { claudeSessionId: plan.claudeSessionId, isNewSession: plan.isNewSession, forkFrom: plan.forkFrom },
      };
      const provider = new ClaudeCodeProvider({ type: "claude-code" });
      (provider as unknown as { handleStderrData(pp: unknown, sk: string, d: Buffer): void }).handleStderrData(pp, SK, Buffer.from(refusal));
      expect(pp.recovering).toBe(true);
      const next = planClaudeSessionStart(SK, workspace);
      expectFreshWithoutFork(next);
      expect(next.needsHistoryReplay).toBe(true);
    });
  }

  test("the fork's refusals are read as such only on a forking start", () => {
    // A resume that is not a fork and meets the same words is not a lost session.
    const pp = {
      sessionKey: SK, stderrBuf: "", recovering: false, pendingReject: null,
      spawnMeta: { claudeSessionId: BRANCH, isNewSession: false, forkFrom: null },
    };
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    (provider as unknown as { handleStderrData(pp: unknown, sk: string, d: Buffer): void }).handleStderrData(pp, SK, Buffer.from("No message found with message.uuid of: x"));
    expect(pp.recovering).toBe(false);
  });
});

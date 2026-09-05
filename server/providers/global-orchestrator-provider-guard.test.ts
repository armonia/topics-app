/**
 * A damaged registered coordinator must not become an ordinary provider
 * session merely because a caller bypasses the HTTP chat front door.
 *
 * These tests deliberately call providers directly.  The normal `/api/chat`
 * path is already guarded; this proves the final spawn boundary cannot create
 * a generic bridge/config/workspace for the same raw registry identity.
 * @covers GLOBAL-ORCHESTRATOR-PROVIDER-01
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { ClaudeCodeProvider } from "./claude-code";
import { CodexProvider } from "./codex";
import type { StreamHandler } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SESSION_KEY = "topic:raw-global-coordinator";
let tempRoot: string;

function seedRawCoordinator(): void {
  const now = "2026-09-04T00:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO topics (id, name, slug, session_key, project_path, provider, mcp_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "raw-global-coordinator",
    "Raw coordinator",
    "raw-coordinator",
    SESSION_KEY,
    "/must-not-be-used-as-a-workspace",
    "codex",
    "bridge-only",
    now,
    now,
  );
  db.prepare(
    `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
     VALUES ('global', 'raw-global-coordinator', ?, ?)`,
  ).run(now, now);
}

function recorder(): { handler: StreamHandler; errors: string[] } {
  const errors: string[] = [];
  return {
    handler: {
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onDone: () => {},
      onError: (error) => { errors.push(error); },
    },
    errors,
  };
}

beforeEach(() => {
  try { closeDatabase(); } catch { /* isolated test worker may have none */ }
  tempRoot = mkdtempSync(join(tmpdir(), "topics-provider-global-guard-"));
  initDatabase(REPO_ROOT, tempRoot);
  seedRawCoordinator();
});

afterEach(() => {
  try { closeDatabase(); } catch { /* cleanup */ }
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* scratch */ }
});

describe("provider-level global coordinator integrity guard", () => {
  test("Codex refuses a raw ineligible coordinator before resolving or spawning its generic CLI", async () => {
    const provider = new CodexProvider({ type: "codex", defaultWorkspace: "/must-not-use" });
    const { handler, errors } = recorder();

    const result = await provider.sendChat(SESSION_KEY, "do not launch", handler);

    expect(result).toEqual({ runId: undefined });
    expect(errors).toEqual(["Global coordinator integrity is invalid; reopen it from the Kanban."]);
    expect((provider as unknown as { activeChildren: Map<string, unknown> }).activeChildren.size).toBe(0);
  });

  test("Claude Code refuses an ineligible raw coordinator before creating a persistent generic process", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: "/must-not-use" });
    const { handler, errors } = recorder();
    let invoked = false;
    (provider as unknown as { sendChatInternal: () => Promise<{ runId?: string }> }).sendChatInternal = async () => {
      invoked = true;
      return { runId: "must-not-run" };
    };

    const result = await provider.sendChat(SESSION_KEY, "do not launch", handler);

    expect(result).toEqual({ runId: undefined });
    expect(errors).toEqual(["Global coordinator is Codex-only; reopen it from the Kanban."]);
    expect(invoked).toBe(false);
    expect((provider as unknown as { processes: Map<string, unknown> }).processes.size).toBe(0);
  });

  test("Claude Code also refuses a healthy raw coordinator: registry role is Codex-only", async () => {
    // The default fixture is invalid only because it has a project binding.
    // Remove that binding so the registry row is otherwise eligible; provider
    // selection must still not be delegated to Claude Code.
    getDatabase().run("UPDATE topics SET project_path = NULL WHERE session_key = ?", [SESSION_KEY]);
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const { handler, errors } = recorder();
    let invoked = false;
    (provider as unknown as { sendChatInternal: () => Promise<{ runId?: string }> }).sendChatInternal = async () => {
      invoked = true;
      return { runId: "must-not-run" };
    };

    const result = await provider.sendChat(SESSION_KEY, "do not launch", handler);

    expect(result).toEqual({ runId: undefined });
    expect(errors).toEqual(["Global coordinator is Codex-only; reopen it from the Kanban."]);
    expect(invoked).toBe(false);
  });
});

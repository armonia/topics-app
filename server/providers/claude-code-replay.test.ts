/**
 * Tests for the claude-code DB-replay resilience layer.
 *
 * Covers the recovery path that fires when `--resume` would have failed:
 * fresh CLI session + DB carrying prior turns ⇒ next user message is
 * prepended with a markdown recap so the model sees the conversation thread
 * even though the CLI's on-disk session file is gone.
 *
 * The three internal helpers are tested through their exported surface:
 *   - hasPriorMessagesInDB  → "should we replay at all?"
 *   - loadActiveBranchForReplay → "what does the recap include?"
 *   - renderReplayPrologue → "what does the prologue look like?"
  * @covers CCLI-06
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  hasPriorMessagesInDB,
  loadActiveBranchForReplay,
  renderReplayPrologue,
  type ReplayTurn,
} from "./claude-code";
import { initDatabase, closeDatabase, getDatabase } from "../db";

let tempDir: string;
let originalDataDir: string | undefined;
const REPO_ROOT = join(import.meta.dir, "..", "..");

beforeAll(() => {
  // Spin up an isolated DB rooted in a tempdir; runMigrations expects to find
  // server/db/migrations/*.sql relative to baseDir, so we point baseDir at
  // the real repo root after seeding the temp DATA_DIR.
  tempDir = mkdtempSync(join(tmpdir(), "claude-code-replay-test-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(tempDir, "data");
  initDatabase(REPO_ROOT);
});

afterAll(() => {
  closeDatabase();
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe state between tests so each one starts from a clean session.
  const db = getDatabase();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM active_branches");
});

function insertMsg(
  sessionKey: string,
  role: "user" | "assistant",
  content: string,
  opts: { id?: string; parentId?: string | null; branchIndex?: number; partial?: boolean; sortOrder?: number } = {},
): string {
  const db = getDatabase();
  const id = opts.id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO messages
     (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index, partial)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionKey,
    role,
    content,
    new Date().toISOString(),
    opts.sortOrder ?? 0,
    opts.parentId ?? null,
    opts.branchIndex ?? 0,
    opts.partial ? 1 : 0,
  );
  return id;
}

describe("hasPriorMessagesInDB", () => {
  test("returns false when no messages exist", () => {
    expect(hasPriorMessagesInDB("missing-session")).toBe(false);
  });

  test("returns false when only the brand-new user turn is present", () => {
    insertMsg("topic-1", "user", "first ever message");
    expect(hasPriorMessagesInDB("topic-1")).toBe(false);
  });

  test("returns true once at least 2 non-partial turns exist", () => {
    const u1 = insertMsg("topic-2", "user", "hello");
    insertMsg("topic-2", "assistant", "hi", { parentId: u1, sortOrder: 1 });
    expect(hasPriorMessagesInDB("topic-2")).toBe(true);
  });

  test("ignores partial (in-flight) assistant turns", () => {
    insertMsg("topic-3", "user", "hello");
    insertMsg("topic-3", "assistant", "", { partial: true, sortOrder: 1 });
    // Only the user turn counts → not enough to trigger replay.
    expect(hasPriorMessagesInDB("topic-3")).toBe(false);
  });
});

describe("loadActiveBranchForReplay", () => {
  test("returns empty array when no messages exist", () => {
    expect(loadActiveBranchForReplay("ghost-session")).toEqual([]);
  });

  test("walks the active branch in order", () => {
    const u1 = insertMsg("topic-A", "user", "message one");
    const a1 = insertMsg("topic-A", "assistant", "reply one", { parentId: u1, sortOrder: 1 });
    const u2 = insertMsg("topic-A", "user", "message two", { parentId: a1, sortOrder: 2 });
    insertMsg("topic-A", "assistant", "reply two — current turn", { parentId: u2, sortOrder: 3 });
    // The last entry is the just-appended turn that the caller will send fresh,
    // so loadActiveBranchForReplay drops it.
    expect(loadActiveBranchForReplay("topic-A")).toEqual([
      { role: "user", content: "message one" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "message two" },
    ]);
  });

  test("respects active_branches when siblings exist", () => {
    const root = insertMsg("topic-B", "user", "root prompt");
    insertMsg("topic-B", "assistant", "branch-0 reply", {
      parentId: root,
      branchIndex: 0,
      sortOrder: 1,
    });
    insertMsg("topic-B", "assistant", "branch-1 reply", {
      parentId: root,
      branchIndex: 1,
      sortOrder: 2,
    });
    // Mark branch 1 as the active fork
    getDatabase()
      .prepare(
        `INSERT INTO active_branches (parent_id, session_key, active_branch_index)
         VALUES (?, ?, ?)`,
      )
      .run(root, "topic-B", 1);

    // Add a final user turn under the active branch — to be excluded.
    const branch1Id = (getDatabase()
      .prepare(
        "SELECT id FROM messages WHERE parent_id = ? AND branch_index = ?",
      )
      .get(root, 1) as { id: string }).id;
    insertMsg("topic-B", "user", "follow-up under branch 1", {
      parentId: branch1Id,
      sortOrder: 3,
    });

    expect(loadActiveBranchForReplay("topic-B")).toEqual([
      { role: "user", content: "root prompt" },
      { role: "assistant", content: "branch-1 reply" },
    ]);
  });

  test("strips browser/topic markers and skips OpenClaw context envelopes", () => {
    const u = insertMsg("topic-C", "user", "{{TOPIC_NEW:Greeting}} ciao");
    const a1 = insertMsg(
      "topic-C",
      "assistant",
      "[Chat messages since your last reply: ...routing chunk...]",
      { parentId: u, sortOrder: 1 },
    );
    const a2 = insertMsg("topic-C", "assistant", "look at {{BROWSER:url}} ok", {
      parentId: a1,
      sortOrder: 2,
    });
    insertMsg("topic-C", "user", "current question", { parentId: a2, sortOrder: 3 });
    expect(loadActiveBranchForReplay("topic-C").map((t) => t.content)).toEqual([
      "ciao",
      "look at  ok",
    ]);
  });

  test("skips partial assistant turns", () => {
    const u = insertMsg("topic-D", "user", "first");
    const a = insertMsg("topic-D", "assistant", "ack", { parentId: u, sortOrder: 1 });
    insertMsg("topic-D", "assistant", "still streaming…", {
      parentId: a,
      sortOrder: 2,
      partial: true,
    });
    insertMsg("topic-D", "user", "current turn", { parentId: a, sortOrder: 3, branchIndex: 1 });
    // The "still streaming" partial is filtered; current turn is the excluded last entry.
    expect(loadActiveBranchForReplay("topic-D").map((t) => t.content)).toEqual([
      "first",
      "ack",
    ]);
  });
});

describe("renderReplayPrologue", () => {
  test("formats turns under <conversation_recap>", () => {
    const turns: ReplayTurn[] = [
      { role: "user", content: "ciao" },
      { role: "assistant", content: "hi!" },
    ];
    const out = renderReplayPrologue(turns);
    expect(out).toContain("[The CLI session was reset");
    expect(out).toContain("<conversation_recap>");
    expect(out).toContain("**User:**");
    expect(out).toContain("ciao");
    expect(out).toContain("**Assistant:**");
    expect(out).toContain("hi!");
    expect(out).toContain("</conversation_recap>");
  });

  test("truncates over the cap and notes the omission", () => {
    const turns: ReplayTurn[] = Array.from({ length: 25 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}`,
    }));
    const out = renderReplayPrologue(turns);
    expect(out).toContain("Earlier 5 turns omitted");
    expect(out).not.toContain("turn 0"); // dropped
    expect(out).toContain("turn 24"); // kept (most recent)
  });

  test("does not truncate when under cap", () => {
    const turns: ReplayTurn[] = [
      { role: "user", content: "only" },
      { role: "assistant", content: "one" },
    ];
    const out = renderReplayPrologue(turns);
    expect(out).not.toContain("turns omitted");
  });
});

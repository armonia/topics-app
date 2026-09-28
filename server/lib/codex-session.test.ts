/**
 * @covers CODEXSESS-01, CHAT-CHANGES-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverCodexSessionId, codexRolloutExists, readSubagentFileChanges } from "./codex-session";

// Build a fake ~/.codex/sessions tree and drive discovery against it via the
// `root` override (no real codex / no env needed).
let root: string;

function meta(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-06-24T00:00:00.000Z", type: "session_meta", payload }) + "\n" +
    JSON.stringify({ type: "event", payload: { kind: "noise" } }) + "\n";
}

/** Write a rollout file under YYYY/MM/DD and stamp its mtime (ms since epoch). */
function writeRollout(dateDir: string, uuid: string, payload: Record<string, unknown>, mtimeMs: number): string {
  const dir = join(root, ...dateDir.split("/"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${dateDir.replace(/\//g, "-")}T12-00-00-${uuid}.jsonl`);
  writeFileSync(file, meta({ id: uuid, cwd: "/x", originator: "codex-tui", ...payload }));
  const sec = mtimeMs / 1000;
  utimesSync(file, sec, sec);
  return file;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
});
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("discoverCodexSessionId", () => {
  test("returns null when the sessions root does not exist", () => {
    expect(discoverCodexSessionId({ cwd: "/p", sinceMs: 0, root: join(root, "nope") })).toBeNull();
  });

  test("matches a fresh codex-tui rollout by cwd, returning its UUID", () => {
    const spawn = 1_000_000;
    writeRollout("2026/06/24", "uuid-match", { cwd: "/proj/a" }, spawn + 500);
    expect(discoverCodexSessionId({ cwd: "/proj/a", sinceMs: spawn, root })).toBe("uuid-match");
  });

  test("ignores rollouts in a different cwd", () => {
    const spawn = 2_000_000;
    writeRollout("2026/06/24", "uuid-other-cwd", { cwd: "/proj/elsewhere" }, spawn + 500);
    expect(discoverCodexSessionId({ cwd: "/proj/none", sinceMs: spawn, root })).toBeNull();
  });

  test("ignores rollouts written before the spawn time (beyond skew)", () => {
    const spawn = 3_000_000;
    // 10s before spawn — older than the default 5s skew tolerance.
    writeRollout("2026/06/24", "uuid-stale", { cwd: "/proj/b" }, spawn - 10_000);
    expect(discoverCodexSessionId({ cwd: "/proj/b", sinceMs: spawn, root })).toBeNull();
  });

  test("tolerates small negative clock skew (file stamped just before spawn)", () => {
    const spawn = 3_500_000;
    writeRollout("2026/06/24", "uuid-skew", { cwd: "/proj/skew" }, spawn - 2_000);
    expect(discoverCodexSessionId({ cwd: "/proj/skew", sinceMs: spawn, root })).toBe("uuid-skew");
  });

  test("skips subagent rollouts (thread_source / source.subagent)", () => {
    const spawn = 4_000_000;
    writeRollout("2026/06/24", "uuid-sub1", { cwd: "/proj/c", thread_source: "subagent" }, spawn + 100);
    writeRollout("2026/06/24", "uuid-sub2", { cwd: "/proj/c", source: { subagent: { other: "guardian" } } }, spawn + 200);
    expect(discoverCodexSessionId({ cwd: "/proj/c", sinceMs: spawn, root })).toBeNull();
  });

  test("skips non-codex-tui originators (e.g. exec)", () => {
    const spawn = 5_000_000;
    writeRollout("2026/06/24", "uuid-exec", { cwd: "/proj/d", originator: "codex-exec" }, spawn + 100);
    expect(discoverCodexSessionId({ cwd: "/proj/d", sinceMs: spawn, root })).toBeNull();
  });

  test("picks the NEWEST matching rollout when several qualify", () => {
    const spawn = 6_000_000;
    writeRollout("2026/06/24", "uuid-old", { cwd: "/proj/e" }, spawn + 100);
    writeRollout("2026/06/24", "uuid-new", { cwd: "/proj/e" }, spawn + 9_000);
    expect(discoverCodexSessionId({ cwd: "/proj/e", sinceMs: spawn, root })).toBe("uuid-new");
  });
});

describe("codexRolloutExists", () => {
  test("true when a rollout file with the id suffix exists", () => {
    writeRollout("2026/06/20", "uuid-exists", { cwd: "/proj/f" }, 7_000_000);
    expect(codexRolloutExists("uuid-exists", root)).toBe(true);
  });

  test("false for an unknown id and for an empty id", () => {
    expect(codexRolloutExists("uuid-ghost", root)).toBe(false);
    expect(codexRolloutExists("", root)).toBe(false);
  });
});

describe("readSubagentFileChanges", () => {
  // Shapes taken from real codex-cli 0.153.4 rollouts of task 05807e8e: the
  // primary exec thread 01a09570-bba3 and its sub-agent 01a09572-3ca3 (paths
  // shortened, diffs cut). The depth-2 thread's id is made up.
  const SESSION = "01a09570-bba3-7c53-9417-b2ff4923c341";
  const CHILD = "01a09572-3ca3-7d33-99aa-c837c22ad3b7";
  const GRANDCHILD = "01a09574-0000-7000-8000-000000000002";
  const PREVIOUS_CHILD = "01a0956f-0000-7000-8000-000000000003";
  const OTHER_SESSION = "01a09570-df4f-77c2-8945-5f7fc9680e70";
  const OTHER_CHILD = "01a09571-d20b-7142-a950-d1e388401034";
  const TURN_START = Date.parse("2026-09-12T11:49:00.000Z");

  function sessionMeta(id: string, parent: string | null, depth = 1): Record<string, unknown> {
    const session = id === OTHER_CHILD ? OTHER_SESSION : SESSION;
    return {
      timestamp: "2026-09-12T11:48:06.000Z", ordinal: 0, type: "session_meta",
      payload: {
        session_id: session, id, cwd: "/wt/subtle-heath", originator: "codex_exec", cli_version: "0.153.4",
        ...(parent ? {
          parent_thread_id: parent,
          source: { subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: "/root/implement_selector", agent_nickname: "Bohr", agent_role: null } } },
          thread_source: "subagent",
        } : { source: "exec", thread_source: "user" }),
      },
    };
  }

  function fileChange(thread: string, itemId: string, at: string, changes: Record<string, unknown>, status = "completed"): Record<string, unknown> {
    const ms = Date.parse(at);
    return {
      timestamp: at, ordinal: 97, type: "event_msg",
      payload: {
        type: "item_completed", thread_id: thread, turn_id: "01a09572-3d14-7891-8c83-448ab3a81f04",
        item: { type: "FileChange", id: itemId, changes, status, stdout: "Success. Updated the following files:\n", stderr: "" },
        started_at_ms: ms - 100, completed_at_ms: ms,
      },
    };
  }

  const update = (diff: string) => ({ type: "update", unified_diff: diff, move_path: null });

  function writeLines(tree: string, name: string, lines: Record<string, unknown>[], mtimeMs: number): void {
    const dir = join(tree, "2026", "09", "12");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  function seedTree(): string {
    const tree = join(root, "subagent-tree");
    const afterTurn = TURN_START + 10 * 60_000;
    writeLines(tree, `rollout-2026-09-12T13-46-10-${SESSION}.jsonl`, [
      sessionMeta(SESSION, null),
      // Already streamed by `codex exec --json`: not read back.
      fileChange(SESSION, "exec-primary", "2026-09-12T11:50:00.000Z", { "/wt/primary.ts": update("@@ -1 +1 @@") }),
    ], afterTurn);
    writeLines(tree, `rollout-2026-09-12T13-40-00-${PREVIOUS_CHILD}.jsonl`, [
      sessionMeta(PREVIOUS_CHILD, SESSION),
      fileChange(PREVIOUS_CHILD, "exec-previous-file", "2026-09-12T11:41:00.000Z", { "/wt/previous-file.ts": update("@@ -1 +1 @@") }),
    ], TURN_START - 60_000);
    writeLines(tree, `rollout-2026-09-12T13-48-06-${CHILD}.jsonl`, [
      sessionMeta(CHILD, SESSION),
      // A patch of the previous turn: this sub-agent outlived it.
      fileChange(CHILD, "exec-previous-turn", "2026-09-12T11:48:30.000Z", { "/wt/previous-turn.ts": update("@@ -1 +1 @@") }),
      fileChange(CHILD, "exec-495f6867-eb76-44af-8018-84a57378f0a2", "2026-09-12T11:49:51.139Z", {
        "/wt/openspec/changes/general-auto-model-ui/specs/multi-provider/spec.md": update("@@ -17 +17,64 @@"),
        "/wt/openspec/changes/general-auto-model-ui/proposal.md": update("@@ -2,5 +2,13 @@"),
      }),
      fileChange(CHILD, "exec-declined", "2026-09-12T11:52:00.000Z", { "/wt/declined.ts": update("@@ -1 +1 @@") }, "failed"),
      fileChange(CHILD, "exec-8ba93ec5-2557-4068-8a9e-8dd71c0373eb", "2026-09-12T11:55:00.797Z", {
        "/wt/client/src/components/Chat/ProviderModelPicker.tsx": { type: "delete", content: "import { useEffect, useMemo" },
      }),
    ], afterTurn);
    writeLines(tree, `rollout-2026-09-12T13-56-00-${GRANDCHILD}.jsonl`, [
      sessionMeta(GRANDCHILD, CHILD, 2),
      fileChange(GRANDCHILD, "exec-grandchild", "2026-09-12T11:57:00.000Z", {
        "/wt/client/src/components/Chat/ModelSelector.tsx": { type: "add", content: "export function ModelSelector" },
      }),
    ], afterTurn);
    writeLines(tree, `rollout-2026-09-12T13-47-39-${OTHER_CHILD}.jsonl`, [
      sessionMeta(OTHER_CHILD, OTHER_SESSION),
      fileChange(OTHER_CHILD, "exec-other", "2026-09-12T11:50:00.000Z", { "/wt/other-session.md": update("@@ -1 +1 @@") }),
    ], afterTurn);
    return tree;
  }

  test("returns every applied patch of the session's sub-agents at any depth since the turn started", () => {
    const tree = seedTree();
    expect(readSubagentFileChanges({ sessionId: SESSION, sinceMs: TURN_START, root: tree })).toEqual([
      { id: `${CHILD}:exec-495f6867-eb76-44af-8018-84a57378f0a2:0`, path: "/wt/openspec/changes/general-auto-model-ui/specs/multi-provider/spec.md", kind: "update" },
      { id: `${CHILD}:exec-495f6867-eb76-44af-8018-84a57378f0a2:1`, path: "/wt/openspec/changes/general-auto-model-ui/proposal.md", kind: "update" },
      { id: `${CHILD}:exec-8ba93ec5-2557-4068-8a9e-8dd71c0373eb:0`, path: "/wt/client/src/components/Chat/ProviderModelPicker.tsx", kind: "delete" },
      { id: `${GRANDCHILD}:exec-grandchild:0`, path: "/wt/client/src/components/Chat/ModelSelector.tsx", kind: "add" },
    ]);
  });

  test("returns nothing when the sessions root does not exist", () => {
    expect(readSubagentFileChanges({ sessionId: SESSION, sinceMs: TURN_START, root: join(root, "nope") })).toEqual([]);
  });
});

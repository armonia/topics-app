/**
 * The aggregator of what a conversation touched, and only that: no git, no DB.
 *
 * The three properties that decide whether the panel tells the truth:
 *  - a turn is a MESSAGE, not a tool call, so four edits in one answer are
 *    one turn on one row (otherwise the panel counts keystrokes);
 *  - only writes count: a `read` or a `grep` on a file is not a change, and
 *    listing them would say the agent modified everything it looked at;
 *  - a failed tool call wrote nothing, so it must not appear at all.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateTouchedFiles, computeTopicChanges, refineKind } from "./topic-changes";
import type { ToolCall } from "../../shared/types";

function call(name: string, detail: ToolCall["detail"], extra: Partial<ToolCall> = {}): ToolCall {
  return { id: `${name}-${Math.random()}`, name, args: {}, detail, ...extra };
}

describe("aggregateTouchedFiles", () => {
  test("one write, one row, born as created", () => {
    const files = aggregateTouchedFiles([
      { timestamp: "2026-01-01T10:00:00.000Z", toolCalls: [call("Write", { type: "write", filePath: "src/a.ts" })] },
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", kind: "created", turns: 1, lastAt: "2026-01-01T10:00:00.000Z" },
    ]);
  });

  test("write then edit on the same file: still created, two turns, last timestamp wins", () => {
    const files = aggregateTouchedFiles([
      { timestamp: "2026-01-01T10:00:00.000Z", toolCalls: [call("Write", { type: "write", filePath: "src/a.ts" })] },
      { timestamp: "2026-01-01T11:00:00.000Z", toolCalls: [call("Edit", { type: "edit", filePath: "src/a.ts" })] },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "src/a.ts", kind: "created", turns: 2, lastAt: "2026-01-01T11:00:00.000Z" });
  });

  test("three edits inside ONE answer count as one turn", () => {
    const files = aggregateTouchedFiles([
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [
          call("Edit", { type: "edit", filePath: "src/a.ts" }),
          call("Edit", { type: "edit", filePath: "src/a.ts" }),
          call("Edit", { type: "edit", filePath: "src/a.ts" }),
        ],
      },
    ]);
    expect(files[0]).toMatchObject({ turns: 1, kind: "modified" });
  });

  test("reads, searches and shells are not changes", () => {
    const files = aggregateTouchedFiles([
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [
          call("Read", { type: "read", filePath: "src/a.ts" }),
          call("Grep", { type: "search", query: "foo" }),
          call("Bash", { type: "shell", command: "ls" }),
        ],
      },
    ]);
    expect(files).toEqual([]);
  });

  test("a tool call that failed wrote nothing", () => {
    const files = aggregateTouchedFiles([
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [call("Write", { type: "write", filePath: "src/a.ts" }, { error: "permission denied" })],
      },
    ]);
    expect(files).toEqual([]);
  });

  test("older rows carry no typed detail: the raw arguments still name the file", () => {
    const files = aggregateTouchedFiles([
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [{ id: "x", name: "Edit", args: { file_path: "src/legacy.ts" } }],
      },
    ]);
    expect(files[0]).toMatchObject({ path: "src/legacy.ts", kind: "modified", turns: 1 });
  });

  test("a native `edit_file` stored as detail `unknown` still names its file (861 rows since 10/09)", () => {
    // The shape the prod DB holds: the provider boundary did not recognise the
    // name at write time and saved the raw args under `unknown`. Returning null
    // there dropped 13 of 64 files from one topic's strip.
    const unknown = (name: string, args: Record<string, unknown>): ToolCall =>
      ({ id: `${name}-${Math.random()}`, name, args, detail: { type: "unknown", raw: { args } } });
    const files = aggregateTouchedFiles([
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [
          unknown("edit_file", { path: "/repo/src/edited.ts", old: "a", new: "b" }),
          unknown("write_file", { path: "/repo/src/written.ts", content: "x" }),
          unknown("create_file", { path: "/repo/src/created.ts", content: "x" }),
          unknown("str_replace", { path: "/repo/src/replaced.ts", old: "a", new: "b" }),
          unknown("MultiEdit", { file_path: "/repo/src/multi.ts", edits: [{ old_string: "a", new_string: "b" }] }),
          // Not a write, whatever the detail says: it must stay out.
          unknown("read_file", { path: "/repo/src/read.ts" }),
          unknown("some_mcp_tool", { path: "/repo/src/mcp.ts" }),
        ],
      },
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.kind]));
    expect(byPath).toEqual({
      "/repo/src/edited.ts": "modified",
      "/repo/src/written.ts": "created",
      "/repo/src/created.ts": "created",
      "/repo/src/replaced.ts": "modified",
      "/repo/src/multi.ts": "modified",
    });
  });

  test("a row with no detail at all falls back by name too, native names included", () => {
    const files = aggregateTouchedFiles([
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [
          { id: "a", name: "edit_file", args: { path: "src/native.ts", old: "a", new: "b" } },
          { id: "b", name: "write_file", args: { path: "src/new.ts", content: "x" } },
        ],
      },
    ]);
    expect(Object.fromEntries(files.map((f) => [f.path, f.kind]))).toEqual({
      "src/native.ts": "modified",
      "src/new.ts": "created",
    });
  });

  test("newest first", () => {
    const files = aggregateTouchedFiles([
      { timestamp: "2026-01-01T10:00:00.000Z", toolCalls: [call("Write", { type: "write", filePath: "old.ts" })] },
      { timestamp: "2026-01-01T12:00:00.000Z", toolCalls: [call("Write", { type: "write", filePath: "new.ts" })] },
    ]);
    expect(files.map((f) => f.path)).toEqual(["new.ts", "old.ts"]);
  });
});

describe("refineKind", () => {
  test("git has the last word on what survived", () => {
    expect(refineKind("modified", "??")).toBe("created");
    expect(refineKind("modified", "A ")).toBe("created");
    expect(refineKind("created", " D")).toBe("deleted");
    expect(refineKind("created", " M")).toBe("modified");
  });

  test("a file git does not mention keeps what the tool calls said", () => {
    expect(refineKind("created", null)).toBe("created");
    expect(refineKind("modified", null)).toBe("modified");
  });
});

describe("computeTopicChanges behind a symlink", () => {
  test("a repository reached through a link is still inside the repository", async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), "topic-changes-"));
    const repo = join(base, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "base.ts"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(repo, "base.ts"), "one\ntwo\nthree\n");
    // The topic's cwd goes through the link, git answers with the real path:
    // this is `/tmp` against `/private/tmp` on macOS, and a mounted home
    // elsewhere.
    const linked = join(base, "link");
    symlinkSync(repo, linked);

    const changes = await computeTopicChanges(linked, [
      {
        timestamp: "2026-01-01T10:00:00.000Z",
        toolCalls: [call("Edit", { type: "edit", filePath: join(linked, "base.ts") })],
      },
    ]);

    rmSync(base, { recursive: true, force: true });
    expect(changes.files.map((f) => f.path)).toEqual(["base.ts"]);
    expect(changes.files[0]?.added).toBe(1);
    expect(changes.files[0]?.kind).toBe("modified");
  });
});

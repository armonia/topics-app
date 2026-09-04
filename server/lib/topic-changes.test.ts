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
import { aggregateTouchedFiles, refineKind } from "./topic-changes";
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

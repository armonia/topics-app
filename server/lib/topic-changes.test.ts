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
 * @covers CHAT-CHANGES-01, CHGSET-02
 */
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { aggregateTouchedFiles, computeTopicChanges, pathInTree, rangeFiles, refineKind, resolveTopicChangeTarget, type TopicRangeAnchors } from "./topic-changes";
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

describe("rangeFiles", () => {
  const stat = [
    { path: "a.ts", additions: 1, deletions: 0, status: "M" },
    { path: "src/a.ts", additions: 2, deletions: 1, status: "A" },
    { path: "logo.png", additions: -1, deletions: -1, status: "A" },
    { path: "gone.ts", additions: 0, deletions: 4, status: "D" },
  ];

  test("a pruned worktree known by its name: the path after that gone folder, in full", () => {
    const at = "2026-01-01T12:00:00.000Z";
    // A draft never committed: `src/tmp/a.ts` is not the range's `a.ts`.
    const draft = { path: "/gone/worktrees/p/wt/src/tmp/a.ts", kind: "created" as const, turns: 1, lastAt: at };
    // Another gone folder whose file is named like a range row.
    const scratch = { path: "/gone/scratch/a.ts", kind: "created" as const, turns: 1, lastAt: at };
    const { files, rest } = rangeFiles(stat, [
      { path: "/gone/worktrees/p/wt/src/a.ts", kind: "created", turns: 2, lastAt: "2026-01-01T11:00:00.000Z" },
      { path: "/gone/worktrees/p/wt/a.ts", kind: "modified", turns: 1, lastAt: "2026-01-01T10:00:00.000Z" },
      draft,
      scratch,
    ], { name: "wt" });
    expect(files).toEqual([
      { path: "src/a.ts", kind: "created", turns: 2, lastAt: "2026-01-01T11:00:00.000Z", added: 2, removed: 1, inRange: true },
      { path: "a.ts", kind: "modified", turns: 1, lastAt: "2026-01-01T10:00:00.000Z", added: 1, removed: 0, inRange: true },
      { path: "logo.png", kind: "created", turns: 0, lastAt: "", added: 0, removed: 0, binary: true, inRange: true },
      { path: "gone.ts", kind: "deleted", turns: 0, lastAt: "", added: 0, removed: 4, inRange: true },
    ]);
    // Not in the range is not "wrote nothing": the caller still lists it.
    expect(rest).toEqual([draft, scratch]);
  });

  test("a path under a tree still on disk is read in that tree: another checkout or repo keeps its own row", () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), "range-files-"));
    const root = join(base, "wt");
    const shared = join(base, "checkout");
    const agents = join(base, "agents");
    for (const dir of [join(root, "src"), join(shared, "src"), agents]) mkdirSync(dir, { recursive: true });
    const at = "2026-01-01T10:00:00.000Z";
    const inTree = { path: join(root, "src/a.ts"), kind: "created" as const, turns: 1, lastAt: at };
    // The known failure: the agent wrote the shared checkout, not its worktree.
    const wrongTree = { path: join(shared, "src/a.ts"), kind: "modified" as const, turns: 2, lastAt: at };
    // Another repository whose file has the same name as one of the range.
    const otherRepo = { path: join(agents, "a.ts"), kind: "modified" as const, turns: 1, lastAt: at };
    // Inside the range's tree, a path is read exactly: `src/tmp/a.ts` is not `a.ts`.
    const deletedDir = { path: join(root, "src/tmp/a.ts"), kind: "created" as const, turns: 1, lastAt: at };

    const { files, rest } = rangeFiles(stat, [inTree, wrongTree, otherRepo, deletedDir], { path: root });
    rmSync(base, { recursive: true, force: true });

    expect(files.find((f) => f.path === "src/a.ts")).toMatchObject({ turns: 1, inRange: true });
    expect(files.find((f) => f.path === "a.ts")).toMatchObject({ turns: 0, inRange: true });
    expect(rest).toEqual([wrongTree, otherRepo, deletedDir]);
  });
});

describe("rangeFiles on relative paths and other spellings", () => {
  const stat = [{ path: "src/a.ts", additions: 2, deletions: 0, status: "A" }];
  const at = "2026-01-01T12:00:00.000Z";

  test("a relative path is the task's tree's own, even once only its name is left", () => {
    // The native provider's write_file takes a path relative to the
    // workspace, which on a task is its worktree.
    const relativeWrite = { path: "src/a.ts", kind: "created" as const, turns: 1, lastAt: at };
    const outsideTree = { path: "../other/a.ts", kind: "created" as const, turns: 1, lastAt: at };
    for (const tree of [{ name: "wt" }, { path: "/gone/worktrees/p/wt" }]) {
      const { files, rest } = rangeFiles(stat, [relativeWrite, outsideTree], tree);
      expect(files).toEqual([{ path: "src/a.ts", kind: "created", turns: 1, lastAt: at, added: 2, removed: 0, inRange: true }]);
      expect(rest).toEqual([outsideTree]);
    }
  });
});

describe("pathInTree", () => {
  test("answers in git's spelling on Windows too: forward slashes, or the range's row gets a twin", () => {
    expect(pathInTree("C:\\wt", "C:\\wt\\src\\a.ts", win32)).toBe("src/a.ts");
    expect(pathInTree("C:\\wt", "C:\\other\\a.ts", win32)).toBeNull();
    // Another drive: `relative` gives back the absolute path, which is not "under" the tree.
    expect(pathInTree("C:\\wt", "D:\\wt\\a.ts", win32)).toBeNull();
    expect(pathInTree("C:\\wt", "C:\\wt", win32)).toBeNull();
  });

  test("a name that only starts with two dots is inside", () => {
    expect(pathInTree("/wt", "/wt/..env")).toBe("..env");
    expect(pathInTree("/wt", "/wt/src/a.ts")).toBe("src/a.ts");
    expect(pathInTree("/wt", "/other/a.ts")).toBeNull();
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

/**
 * The target both changes routes read: decided ONCE, so the list and the
 * changeset can never describe two different diffs.
 */
describe("resolveTopicChangeTarget", () => {
  /** A throwaway repository with one committed file, or none when `commit` is false. */
  function repo(commit = true): { dir: string; git: (...args: string[]) => string; done: () => void } {
    const base = mkdtempSync(join(realpathSync(tmpdir()), "topic-target-"));
    const dir = join(base, "repo");
    mkdirSync(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    if (commit) {
      writeFileSync(join(dir, "base.ts"), "one\n");
      git("add", "-A");
      git("commit", "-qm", "base");
    }
    return { dir, git, done: () => rmSync(base, { recursive: true, force: true }) };
  }
  const wrote = (...paths: string[]) => [{ timestamp: "2026-01-01T10:00:00.000Z", toolCalls: paths.map((p) => call("Write", { type: "write", filePath: p })) }];

  test("a topic without a task reads HEAD against the working tree, limited to its repo-relative paths", async () => {
    const r = repo();
    try {
      const target = await resolveTopicChangeTarget(r.dir, wrote(join(r.dir, "src/a.ts"), "/somewhere/else.md"));
      expect(target).toEqual({ kind: "head", cwd: r.dir, range: "HEAD", live: true, paths: ["src/a.ts"], hasHead: true });
      const changes = await computeTopicChanges(r.dir, wrote(join(r.dir, "src/a.ts")));
      expect(changes.revs).toEqual({ base: r.git("rev-parse", "HEAD"), head: null });
    } finally {
      r.done();
    }
  });

  test("a card's topic reads the task's range, whole: no path filter", async () => {
    const r = repo();
    try {
      const wt = join(r.dir, "..", "wt");
      r.git("worktree", "add", "-q", "-b", "topics/card", wt);
      writeFileSync(join(wt, "shell.txt"), "x\n");
      r.git("-C", wt, "add", "-A");
      r.git("-C", wt, "commit", "-qm", "card work");
      const anchors: TopicRangeAnchors = {
        task: { id: "t1", deliveryBranch: null, deliveryCommit: null, deliveryFiles: null, attemptBranch: null },
        worktree: { absPath: realpathSync(wt), mode: "branch", branchName: "topics/card" },
        repoPath: r.dir,
      };
      const target = await resolveTopicChangeTarget(r.dir, wrote(join(wt, "other.ts")), anchors);
      expect(target?.kind).toBe("range");
      expect(target && "paths" in target).toBe(false);
      expect(target?.cwd).toBe(realpathSync(wt));
    } finally {
      r.done();
    }
  });

  test("outside a repository, or with nothing written, there is no target and no revisions", async () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), "topic-target-plain-"));
    try {
      expect(await resolveTopicChangeTarget(outside, wrote(join(outside, "x.md")))).toBeNull();
      expect(await resolveTopicChangeTarget(outside, [])).toBeNull();
      expect((await computeTopicChanges(outside, wrote(join(outside, "x.md")))).revs).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a repository with no commit has no HEAD: no revisions, and its untracked files are still the changes", async () => {
    const r = repo(false);
    try {
      writeFileSync(join(r.dir, "first.ts"), "a\nb\n");
      const target = await resolveTopicChangeTarget(r.dir, wrote(join(r.dir, "first.ts")));
      expect(target).toMatchObject({ kind: "head", paths: ["first.ts"], hasHead: false });
      const changes = await computeTopicChanges(r.dir, wrote(join(r.dir, "first.ts")));
      expect(changes.revs).toBeNull();
      expect(changes.files).toEqual([expect.objectContaining({ path: "first.ts", kind: "created", added: 2 })]);
    } finally {
      r.done();
    }
  });
});

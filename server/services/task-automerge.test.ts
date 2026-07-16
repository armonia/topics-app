import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, type GitRunResult, type TaskMergeTarget } from "./task-automerge";

const TARGET: TaskMergeTarget = { repoPath: "/repo", branch: "topics/lyrical-cobra", defaultBranch: "main" };

/** Build a fake git runner from per-subcommand canned responses; records calls. */
function fakeGit(responses: Record<string, Partial<GitRunResult>>) {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
    calls.push(args);
    // Key on the first two tokens (e.g. "merge --abort" vs "merge --no-ff").
    const key = args.slice(0, 2).join(" ");
    const r = responses[key] ?? responses[args[0]] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

const CLEAN_PRECONDITIONS = {
  "symbolic-ref --short": { stdout: "main\n" },
  "status --porcelain": { stdout: "" },
  "rev-list --count": { stdout: "3\n" },
};

describe("task-automerge", () => {
  test("clean merge → 'merged', invoked with --no-ff", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "Titolo task");
    expect(res.status).toBe("merged");
    if (res.status === "merged") { expect(res.commit).toBe("abc1234"); expect(res.branch).toBe(TARGET.branch); }
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--no-ff"))).toBe(true);
  });

  test("merge conflict → 'conflict' and 'merge --abort' is called", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 1, stderr: "CONFLICT" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("conflict");
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--abort"))).toBe(true);
  });

  test("dirty working tree → 'skipped', never merges", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: " M src/foo.ts\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    expect(git.calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("checkout not on main → 'skipped'", async () => {
    const git = fakeGit({ "symbolic-ref --short": { stdout: "feature/x\n" } });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.reason).toContain("feature/x");
  });

  test("no commits ahead of main → 'nothing'", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { stdout: "0\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("nothing");
    expect(git.calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("branch missing (rev-list fails) → 'skipped'", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "unknown revision" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
  });

  test("no worktree/branch (resolve → null) → 'skipped'", async () => {
    const git = fakeGit({});
    const am = createTaskAutoMerge({ resolveTaskMerge: () => null, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    expect(git.calls.length).toBe(0);
  });

  test("serializes per repo path (no overlapping git ops on the same repo)", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (args.slice(0, 2).join(" ") === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (args.slice(0, 2).join(" ") === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (args.slice(0, 2).join(" ") === "rev-list --count") return { code: 0, stdout: "0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    await Promise.all([am.tryMerge("a", "x"), am.tryMerge("b", "y"), am.tryMerge("c", "z")]);
    expect(maxActive).toBe(1);
  });
});

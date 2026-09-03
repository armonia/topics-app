/**
 * The git status in five spawns, from one function.
 *
 * The defect, measured in code: `GET /api/git/status` and the git watcher each
 * spawned EIGHT git processes per call on a normal branch, from two copies of
 * the same procedure. The number is pinned here by counting `Bun.spawn` while
 * the status is computed on a real repo, and the readings the old procedure
 * produced (branch, ahead/behind, dirty files, detached label, not-a-repo)
 * are pinned next to it so the collapse cannot change an answer.
 *
 * @covers GIT-STATUS-SPAWNS-01
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeGitStatus, parseBranchHeader, splitBranchHeader } from "./git-status";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv({ GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" }),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/** How many processes a call spawns, whatever they are. */
async function countSpawns<T>(fn: () => Promise<T>): Promise<{ result: T; spawns: number }> {
  const original = Bun.spawn;
  let spawns = 0;
  (Bun as unknown as { spawn: unknown }).spawn = ((...args: unknown[]) => {
    spawns += 1;
    return (original as unknown as (...a: unknown[]) => unknown)(...args);
  }) as typeof Bun.spawn;
  try {
    return { result: await fn(), spawns };
  } finally {
    (Bun as unknown as { spawn: unknown }).spawn = original;
  }
}

describe("the `## ` header of `status --branch`", () => {
  test("every shape git prints", () => {
    expect(parseBranchHeader("## main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(parseBranchHeader("## main...origin/main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(parseBranchHeader("## main...origin/main [ahead 3]")).toEqual({ branch: "main", ahead: 3, behind: 0 });
    expect(parseBranchHeader("## main...origin/main [behind 2]")).toEqual({ branch: "main", ahead: 0, behind: 2 });
    expect(parseBranchHeader("## main...origin/main [ahead 1, behind 2]")).toEqual({ branch: "main", ahead: 1, behind: 2 });
    expect(parseBranchHeader("## main...origin/main [gone]")).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(parseBranchHeader("## HEAD (no branch)")).toEqual({ branch: null, ahead: 0, behind: 0 });
    expect(parseBranchHeader("## No commits yet on main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(parseBranchHeader("## Initial commit on trunk")).toEqual({ branch: "trunk", ahead: 0, behind: 0 });
    // A branch with a slash and a dot survives.
    expect(parseBranchHeader("## jarvis/fix.perf...origin/jarvis/fix.perf [ahead 1]").branch).toBe("jarvis/fix.perf");
  });

  test("the header is split off; the entries keep their raw XY codes", () => {
    const { header, entries } = splitBranchHeader("## main...o/main [ahead 1]\0 M a.txt\0?? b\0");
    expect(header).toBe("## main...o/main [ahead 1]");
    expect(entries).toBe(" M a.txt\0?? b\0");
    expect(splitBranchHeader(" M a.txt\0")).toEqual({ header: null, entries: " M a.txt\0" });
    expect(splitBranchHeader("## main")).toEqual({ header: "## main", entries: "" });
  });
});

describe("computeGitStatus on a real repo", () => {
  let root: string;
  let origin: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gitstatus-"));
    origin = join(root, "origin.git");
    repo = join(root, "repo");
    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, repo);
    writeFileSync(join(repo, "README.md"), "start\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "first");
    git(repo, "push", "-u", "origin", "main");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a normal branch: five spawns, and the same readings as before", async () => {
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    writeFileSync(join(repo, "README.md"), "start\nmore\n");
    git(repo, "commit", "-am", "second");

    const { result, spawns } = await countSpawns(() => computeGitStatus(repo));
    expect(spawns, "rev-parse, status --branch, log -1, numstat x2").toBe(5);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("main");
    expect(result!.ahead).toBe(1);
    expect(result!.behind).toBe(0);
    expect(result!.lastCommit.message).toBe("second");
    expect(result!.lastCommit.hash).toHaveLength(40);
    expect(result!.files).toEqual([{ path: "dirty.txt", status: "??" }]);
    expect(result!.folderUntracked).toBe(false);
    expect(result!.repoName).toBe("");
  });

  test("a detached HEAD is labelled by its short hash", async () => {
    git(repo, "checkout", "--detach");
    const status = (await computeGitStatus(repo))!;
    expect(status.branch).toMatch(/^[0-9a-f]{7,}$/);
    expect(status.lastCommit.hash.startsWith(status.branch)).toBe(true);
  });

  test("an unborn branch still has a name", async () => {
    const fresh = join(root, "fresh");
    git(root, "init", "-b", "trunk", fresh);
    const status = (await computeGitStatus(fresh))!;
    expect(status.branch).toBe("trunk");
    expect(status.lastCommit.hash).toBe("");
  });

  test("a subfolder is scoped, and named after the repo that hosts it", async () => {
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    writeFileSync(join(sub, "inside.txt"), "y\n");
    writeFileSync(join(repo, "outside.txt"), "z\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "tree");
    writeFileSync(join(sub, "inside.txt"), "changed\n");
    writeFileSync(join(repo, "outside.txt"), "changed\n");
    const status = (await computeGitStatus(sub))!;
    expect(status.files.map((f) => f.path)).toEqual(["inside.txt"]);
    expect(status.repoName).toBe("repo");
  });

  test("not a repo is null, in one spawn", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const { result, spawns } = await countSpawns(() => computeGitStatus(plain));
    expect(result).toBeNull();
    expect(spawns).toBe(1);
  });
});

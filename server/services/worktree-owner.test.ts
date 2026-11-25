/**
 * The owner marker and the lock Topics puts on its worktrees, on real git.
 *
 * @covers WORKTREE-STD-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit } from "./own-commits";
import {
  OWNER_MARKER_FILE, listRepoWorktrees, lockOwned, lockedByTopics, parseWorktreeList, readOwnerMarker,
  unlockOwned, worktreeAdminDir, writeOwnerMarker,
} from "./worktree-owner";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

describe("parseWorktreeList", () => {
  test("reads branch, detached, locked with a reason and prunable records", () => {
    const text =
      "worktree /r\0HEAD aaa\0branch refs/heads/main\0\0" +
      "worktree /w/one\0HEAD bbb\0branch refs/heads/topics/one\0locked topics:one\0\0" +
      "worktree /w/two\0HEAD ccc\0detached\0locked\0prunable gitdir file points to non-existent location\0\0";
    const list = parseWorktreeList(text);
    expect(list.map((w) => w.path)).toEqual(["/r", "/w/one", "/w/two"]);
    expect(list[1]).toMatchObject({ branch: "topics/one", locked: true, lockReason: "topics:one", detached: false });
    expect(list[2]).toMatchObject({ detached: true, branch: null, locked: true, lockReason: null, prunable: true });
    expect(lockedByTopics(list[1]!)).toBe(true);
    expect(lockedByTopics(list[2]!)).toBe(false);
  });

  test("an empty answer is an empty list", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("marker and lock on a real repository", () => {
  let root: string;
  let repo: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-owner-"));
    repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function mount(name: string): string {
    const abs = join(root, "wts", name);
    mkdirSync(join(root, "wts"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", `topics/${name}`, abs, "main").code).toBe(0);
    return abs;
  }

  test("the marker is written in the admin folder of the worktree, never in git config", () => {
    const abs = mount("marked");
    const admin = worktreeAdminDir(abs)!;
    expect(admin).toContain(join(".git", "worktrees"));
    expect(writeOwnerMarker(abs, { worktreeId: "w1", projectId: "p1", createdAt: "2026-11-24T00:00:00Z" })).toBe(true);
    expect(existsSync(join(admin, OWNER_MARKER_FILE))).toBe(true);
    expect(readOwnerMarker(abs)).toEqual({ worktreeId: "w1", projectId: "p1", createdAt: "2026-11-24T00:00:00Z" });
    // Nothing leaked into the config shared by every worktree of the repository.
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("w1");
  });

  test("the main checkout and a plain folder have no admin folder", () => {
    expect(worktreeAdminDir(repo)).toBeNull();
    expect(worktreeAdminDir(join(root, "nowhere"))).toBeNull();
    expect(readOwnerMarker(repo)).toBeNull();
  });

  test("lock then unlock: Topics' own lock is lifted, and git refuses to remove while it holds", async () => {
    const abs = mount("locked");
    expect(await lockOwned(defaultRunGit, repo, abs, "locked")).toBe(true);
    const listed = (await listRepoWorktrees(defaultRunGit, repo))!.find((w) => w.path.endsWith("/locked"))!;
    expect(listed.locked).toBe(true);
    expect(listed.lockReason).toBe("topics:locked");
    // A plain `git worktree remove --force` is refused while the lock holds.
    expect(git(repo, "worktree", "remove", "--force", abs).code).not.toBe(0);
    expect(await unlockOwned(defaultRunGit, repo, abs)).toBe(true);
    expect(git(repo, "worktree", "remove", "--force", abs).code).toBe(0);
    expect(existsSync(abs)).toBe(false);
  });

  test("taking the lock twice is not an error", async () => {
    const abs = mount("twice");
    expect(await lockOwned(defaultRunGit, repo, abs, "twice")).toBe(true);
    expect(await lockOwned(defaultRunGit, repo, abs, "twice")).toBe(true);
  });

  test("a lock with another reason is never lifted", async () => {
    const abs = mount("foreign-lock");
    expect(git(repo, "worktree", "lock", "--reason", "somebody else's", abs).code).toBe(0);
    expect(await unlockOwned(defaultRunGit, repo, abs)).toBe(false);
    const listed = (await listRepoWorktrees(defaultRunGit, repo))!.find((w) => w.path.endsWith("/foreign-lock"))!;
    expect(listed.locked).toBe(true);
  });

  test("unlocking a worktree that is not locked, or not listed, is a no-op that answers yes", async () => {
    const abs = mount("plain");
    expect(await unlockOwned(defaultRunGit, repo, abs)).toBe(true);
    expect(await unlockOwned(defaultRunGit, repo, join(root, "never-existed"))).toBe(true);
  });

  test("a worktree whose folder is gone can still be unlocked and then pruned", async () => {
    const abs = mount("vanished");
    await lockOwned(defaultRunGit, repo, abs, "vanished");
    rmSync(abs, { recursive: true, force: true });
    // Locked: prune leaves it listed.
    git(repo, "worktree", "prune");
    expect((await listRepoWorktrees(defaultRunGit, repo))!.some((w) => w.path.endsWith("/vanished"))).toBe(true);
    expect(await unlockOwned(defaultRunGit, repo, abs)).toBe(true);
    git(repo, "worktree", "prune");
    expect((await listRepoWorktrees(defaultRunGit, repo))!.some((w) => w.path.endsWith("/vanished"))).toBe(false);
  });
});

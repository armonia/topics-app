/**
 * The owner marker and the lock Topics puts on its worktrees, on real git; and,
 * since the cross-node addendum, the v2 marker, the `claude-code:` lock rule and
 * the two archive namespaces.
 *
 * @covers WORKTREE-STD-03
 * @covers WORKTREE-STD-09
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit, type GitRunner } from "./own-commits";
import {
  OWNER_MARKER_FILE, claudeCodeLockVerdict, listRepoWorktrees, lockLiftRule, lockOwned, lockedByTopics, parseOwnerMarker,
  parseWorktreeList, readOwnerMarker, unlockOwned, worktreeAdminDir, writeOwnerMarker,
  type ClaudeCodeLockFacts, type ListedWorktree,
} from "./worktree-owner";
import { alreadyArchived } from "./worktree-archive";
import { classifyRootEntry, type RootFacts } from "./worktree-root-gc";
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

describe("marker v2 (WORKTREE-STD-09)", () => {
  test("a v1 marker still reads, with no creator; a v2 marker carries creator, session and machine", () => {
    expect(parseOwnerMarker({ worktreeId: "w", projectId: "p", createdAt: "c" })).toEqual({ worktreeId: "w", projectId: "p", createdAt: "c" });
    expect(parseOwnerMarker({ worktreeId: "w", projectId: "p", createdAt: "c", creator: "claude-code", session: { id: "s", transcript: "/t.jsonl" }, machine: "m", extra: 1 }))
      .toEqual({ worktreeId: "w", projectId: "p", createdAt: "c", creator: "claude-code", session: { id: "s", transcript: "/t.jsonl" }, machine: "m" });
  });

  test("an unknown creator reads as adopted; missing ids are no marker", () => {
    expect(parseOwnerMarker({ worktreeId: "w", projectId: "p", creator: "someone" })?.creator).toBe("adopted");
    expect(parseOwnerMarker({ projectId: "p" })).toBeNull();
  });
});

describe("the claude-code: lock rule (WORKTREE-STD-09)", () => {
  const DAY = 24 * 3600_000;
  const ok: ClaudeCodeLockFacts = {
    lockReason: "claude-code:s1",
    marker: { worktreeId: "w", projectId: "p", createdAt: "x", creator: "claude-code", session: { id: "s1", transcript: "/t" } },
    transcriptIdleMs: 8 * DAY, dirty: false, mergedOrPushed: true, ageMs: 2 * DAY, abandonMs: 7 * DAY,
  };

  test("lifted only when every fact holds", () => {
    expect(claudeCodeLockVerdict(ok).lift).toBe(true);
  });

  test.each([
    ["another session", { lockReason: "claude-code:s2" }],
    ["a marker by another creator", { marker: { ...ok.marker!, creator: "codex" as const } }],
    ["no marker", { marker: null }],
    ["a transcript still moving", { transcriptIdleMs: 2 * DAY }],
    ["a transcript nobody can read", { transcriptIdleMs: null }],
    ["a dirty tree", { dirty: true }],
    ["commits on no remote", { mergedOrPushed: false }],
    ["younger than a day", { ageMs: DAY - 1 }],
    ["no age", { ageMs: null }],
    ["a prefix nobody registered", { lockReason: "codex:s1" }],
  ] as const)("kept with %s", (_label, over) => {
    expect(claudeCodeLockVerdict({ ...ok, ...over } as ClaudeCodeLockFacts).lift).toBe(false);
  });
});

describe("the lock rule reads the files first and asks git last (WORKTREE-STD-09)", () => {
  const DAY = 24 * 3600_000;
  let dir: string;
  beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-lockrule-fake-"))); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A folder whose `.git` file points at an admin folder holding a claude-code marker: no repository, no git process. */
  function markedFolder(name: string, session: string, transcriptAgeDays: number): string {
    const abs = join(dir, name);
    const admin = join(dir, "admin", name);
    mkdirSync(abs, { recursive: true });
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(abs, ".git"), `gitdir: ${admin}\n`);
    const transcript = join(dir, `${session}.jsonl`);
    writeFileSync(transcript, "{}\n");
    const t = (Date.now() - transcriptAgeDays * DAY) / 1000;
    utimesSync(transcript, t, t);
    writeFileSync(join(admin, OWNER_MARKER_FILE), JSON.stringify({
      worktreeId: name, projectId: "p", createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
      creator: "claude-code", session: { id: session, transcript },
    }));
    return abs;
  }
  /** A git that answers «clean, nothing ahead» and records every call. */
  function recordingGit(): { calls: string[][]; git: GitRunner } {
    const calls: string[][] = [];
    return { calls, git: async (_cwd, args) => { calls.push(args); return { code: 0, stdout: args.includes("rev-list") ? "0\n" : "", stderr: "" }; } };
  }
  const locked = (path: string, lockReason: string): ListedWorktree =>
    ({ path, head: null, branch: null, detached: false, bare: false, locked: true, lockReason, prunable: false });

  test("a lock with a foreign prefix is refused without a single git call", async () => {
    const { calls, git } = recordingGit();
    const abs = markedFolder("foreign", "s-foreign", 30);
    expect(await lockLiftRule(git, () => 7)(locked(abs, "someone-else:abc"))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a claude-code lock whose marker names another session, or whose transcript still moves, makes no git call", async () => {
    const { calls, git } = recordingGit();
    expect(await lockLiftRule(git, () => 7)(locked(markedFolder("other", "s-other", 30), "claude-code:s-not-this-one"))).toBe(false);
    expect(await lockLiftRule(git, () => 7)(locked(markedFolder("moving", "s-moving", 0), "claude-code:s-moving"))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("when the files allow a lift, git status runs without taking the optional index lock", async () => {
    const { calls, git } = recordingGit();
    expect(await lockLiftRule(git, () => 7)(locked(markedFolder("over", "s-over", 30), "claude-code:s-over"))).toBe(true);
    expect(calls).toEqual([["--no-optional-locks", "status", "--porcelain"], ["rev-list", "--count", "HEAD", "--not", "--remotes"]]);
  });
});

describe("the lock rule and the archives on real git (WORKTREE-STD-09)", () => {
  let base: string;
  let repo: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "wt-lockrule-")));
    git(base, "init", "-q", "--bare", "-b", "main", "remote.git");
    git(base, "init", "-q", "-b", "main", "repo");
    repo = join(base, "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    git(repo, "remote", "add", "origin", join(base, "remote.git"));
    git(repo, "push", "-q", "origin", "main");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  function hooked(name: string, session: string, transcriptAgeDays: number, ageDays: number): string {
    const abs = join(base, "wts", name);
    expect(git(repo, "worktree", "add", "-q", "-b", `worktree-${name}`, abs, "main").code).toBe(0);
    const transcript = join(base, `${session}.jsonl`);
    writeFileSync(transcript, "{}\n");
    const t = (Date.now() - transcriptAgeDays * 24 * 3600_000) / 1000;
    utimesSync(transcript, t, t);
    writeOwnerMarker(abs, {
      worktreeId: name, projectId: "p", createdAt: new Date(Date.now() - ageDays * 24 * 3600_000).toISOString(),
      creator: "claude-code", session: { id: session, transcript },
    });
    expect(git(repo, "worktree", "lock", "--reason", `claude-code:${session}`, abs).code).toBe(0);
    return abs;
  }

  test("a claude-code lock whose session is over is lifted; one still moving is not", async () => {
    const rule = lockLiftRule(defaultRunGit, () => 7);
    const over = hooked("over", "s-over", 10, 3);
    const live = hooked("live", "s-live", 0, 3);
    expect(await unlockOwned(defaultRunGit, repo, live, rule)).toBe(false);
    expect(await unlockOwned(defaultRunGit, repo, over, rule)).toBe(true);
    const listed = await listRepoWorktrees(defaultRunGit, repo);
    expect(listed!.find((w) => w.path.endsWith("/over"))!.locked).toBe(false);
    expect(listed!.find((w) => w.path.endsWith("/live"))!.locked).toBe(true);
  });

  test("a lock with a prefix nobody registered is never lifted, even under the rule", async () => {
    const abs = join(base, "wts", "codex-one");
    expect(git(repo, "worktree", "add", "-q", "-b", "codex-one", abs, "main").code).toBe(0);
    expect(git(repo, "worktree", "lock", "--reason", "codex:abc", abs).code).toBe(0);
    expect(await unlockOwned(defaultRunGit, repo, abs, lockLiftRule(defaultRunGit, () => 0))).toBe(false);
    expect((await listRepoWorktrees(defaultRunGit, repo))!.find((w) => w.path.endsWith("/codex-one"))!.locked).toBe(true);
  });

  test("both archive namespaces count as archived: the GC's refs and the hook's tags", async () => {
    git(repo, "checkout", "-q", "-b", "side");
    git(repo, "commit", "-q", "--allow-empty", "-m", "one");
    const a = git(repo, "rev-parse", "HEAD").out;
    git(repo, "commit", "-q", "--allow-empty", "-m", "two");
    const b = git(repo, "rev-parse", "HEAD").out;
    git(repo, "commit", "-q", "--allow-empty", "-m", "three");
    const c = git(repo, "rev-parse", "HEAD").out;
    git(repo, "checkout", "-q", "main");
    expect(await alreadyArchived(repo, a, defaultRunGit)).toBe(false);
    git(repo, "update-ref", "refs/topics/archive/task-1", a);
    git(repo, "tag", "archive/wt-hooked", b);
    expect(await alreadyArchived(repo, a, defaultRunGit)).toBe(true);
    expect(await alreadyArchived(repo, b, defaultRunGit)).toBe(true);
    expect(await alreadyArchived(repo, c, defaultRunGit)).toBe(false);
    // A tag outside the convention is not an archive.
    git(repo, "tag", "release-1", c);
    expect(await alreadyArchived(repo, c, defaultRunGit)).toBe(false);
  });
});

describe("an orphan with a v2 marker is registered at once (WORKTREE-STD-09)", () => {
  const orphan: RootFacts = {
    hasRow: false, folderPresent: true, inRoot: true, hasDotGit: true, inGitList: true,
    isSymlink: false, liveInside: false, ageMs: 60_000, projectKnown: true, owned: true,
  };
  test("young with Topics' marker waits a day; young and marked by a creator registers now", () => {
    expect(classifyRootEntry(orphan).action).toBe("wait");
    // No marker of any kind: somebody's checkout, only listed (WORKTREE-STD-15).
    expect(classifyRootEntry({ ...orphan, owned: false }).action).toBe("inventory");
    expect(classifyRootEntry({ ...orphan, creatorMarked: true }).action).toBe("register");
    // A marker never claims a folder for an unknown repository.
    expect(classifyRootEntry({ ...orphan, creatorMarked: true, projectKnown: false }).action).toBe("inventory");
  });
});

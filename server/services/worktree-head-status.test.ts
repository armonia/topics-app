/**
 * Is a `reuse` or `detached` checkout already on main? Whoever could not look
 * keeps: a git that fails, times out or does not recognise the folder as a
 * repository (a worktree whose registration was lost) answers `unmerged`; only an
 * unborn HEAD, where git answered and there is no commit, reads as `merged`.
 *
 * @covers WORKTREE-STD-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headStatusOfCheckout } from "./worktree-head-status";
import { defaultRunGit, type GitRunner } from "./own-commits";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const row = (absPath: string) => ({ absPath, branchName: null, mode: "detached" as const });

describe("headStatusOfCheckout with a fake git", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "head-status-fake-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const answering = (code: number, stdout = "", stderr = ""): GitRunner => async () => ({ code, stdout, stderr });

  test("124 (timeout) is unmerged: nobody looked", async () => {
    expect(await headStatusOfCheckout(row(dir), "/repo", answering(124))).toBe("unmerged");
  });

  test("128 (not a git repository: the registration was lost) is unmerged", async () => {
    expect(await headStatusOfCheckout(row(dir), "/repo", answering(128, "", "fatal: not a git repository: /r/.git/worktrees/x"))).toBe("unmerged");
  });

  test("a git that cannot even be spawned is unmerged", async () => {
    const broken: GitRunner = async () => { throw new Error("spawn git ENOENT"); };
    expect(await headStatusOfCheckout(row(dir), "/repo", broken)).toBe("unmerged");
  });

  test("1 with nothing printed is an unborn HEAD: no commit to lose", async () => {
    expect(await headStatusOfCheckout(row(dir), "/repo", answering(1))).toBe("merged");
  });

  test("0 with a sha goes on to ask main; a main that cannot answer keeps", async () => {
    const git: GitRunner = async (_cwd, args) => args[0] === "rev-parse" && args.includes("HEAD^{commit}")
      ? { code: 0, stdout: "a".repeat(40) + "\n", stderr: "" }
      : { code: 124, stdout: "", stderr: "" };
    expect(await headStatusOfCheckout(row(dir), "/repo", git)).toBe("unmerged");
  });

  test("a folder that is gone, or no repository, can only drop the row", async () => {
    expect(await headStatusOfCheckout(row(join(dir, "gone")), "/repo", answering(124))).toBe("merged");
    expect(await headStatusOfCheckout(row(dir), null, answering(124))).toBe("merged");
  });
});

describe("headStatusOfCheckout on real git", () => {
  let base: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
  };
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "head-status-real-"));
    repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("a detached HEAD with a commit not on main is unmerged; one level with main is merged", async () => {
    const level = join(base, "level");
    expect(git(repo, "worktree", "add", "-q", "--detach", level, "main").code).toBe(0);
    expect(await headStatusOfCheckout(row(level), repo, defaultRunGit)).toBe("merged");

    const ahead = join(base, "ahead");
    expect(git(repo, "worktree", "add", "-q", "--detach", ahead, "main").code).toBe(0);
    writeFileSync(join(ahead, "only-here.txt"), "work\n");
    git(ahead, "add", "-A");
    expect(git(ahead, "commit", "-q", "-m", "only on this HEAD").code).toBe(0);
    expect(await headStatusOfCheckout(row(ahead), repo, defaultRunGit)).toBe("unmerged");
  });

  test("a reuse row is judged by its stored branch only while HEAD is on it: detached with a commit of its own, it is unmerged", async () => {
    git(repo, "branch", "-q", "feat", "main");
    const wt = join(base, "adopted");
    expect(git(repo, "worktree", "add", "-q", wt, "feat").code).toBe(0);
    const reuse = { absPath: wt, branchName: "feat", mode: "reuse" as const };
    expect(await headStatusOfCheckout(reuse, repo, defaultRunGit)).toBe("merged");
    git(wt, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "work.txt"), "the only copy\n");
    git(wt, "add", "-A");
    expect(git(wt, "commit", "-q", "-m", "unique work").code).toBe(0);
    expect(await headStatusOfCheckout(reuse, repo, defaultRunGit)).toBe("unmerged");
  });

  test("a worktree whose admin folder is gone is unmerged, with its files where they were", async () => {
    const lost = join(base, "lost");
    expect(git(repo, "worktree", "add", "-q", "--detach", lost, "main").code).toBe(0);
    writeFileSync(join(lost, "uncommitted.txt"), "x");
    rmSync(join(repo, ".git", "worktrees", "lost"), { recursive: true, force: true });
    expect(await headStatusOfCheckout(row(lost), repo, defaultRunGit)).toBe("unmerged");
  });
});

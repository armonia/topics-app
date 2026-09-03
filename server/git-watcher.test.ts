/**
 * The git watcher on a WORKTREE (WORKTREE-05).
 *
 * The requirement is written in `openspec/specs/worktrees/spec.md`, the code
 * that satisfies it names it in its own header, and until this file nothing
 * exercised it: `git-watcher.ts` had zero tests. That combination is the worst
 * one — a requirement everybody believes is covered because the source quotes
 * its id.
 *
 * WHAT CAN BREAK QUIETLY HERE, and how each break would look to the person
 * using the app:
 *
 *  1. A linked worktree's `.git` is a FILE, not a directory: it holds a
 *     `gitdir:` pointer into the parent's `.git/worktrees/<name>/`, and that
 *     is where the worktree's own `HEAD` and `index` live. If the resolution
 *     stopped at "is `.git` a directory?", `watchGitDir` would return without
 *     registering anything and the panel of every agent working in a worktree
 *     would simply never update — no error, no log, just a stale panel.
 *  2. If it resolved to the PARENT's `.git` instead, the watcher would fire on
 *     the wrong repository's activity: the worktree's own `git add` would go
 *     unnoticed while somebody else's commit on main would refresh your panel.
 *  3. `worktreeId` is carried in a module-level Map keyed by path. The
 *     requirement's second scenario says a plain project path must broadcast
 *     an envelope with NO `worktreeId` field — not `undefined`, absent — so
 *     that consumers written before worktrees existed keep working unchanged.
 *     A leaked or stale id sends cache invalidation to the wrong scope.
 *
 * This runs against real git, in a real temp repo, because the promise is not
 * a string: it is that a change made inside a worktree directory reaches the
 * broadcast. A fake `watch()` would have passed for the version that resolves
 * to the parent.
 *
 * @covers WORKTREE-05
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { refreshGitStatus, watchGitDir, unwatchGitDir } from "./git-watcher";
import type { AppContext } from "./types";
import { gitEnv } from "../tests/setup/bun-test-preload";
import { invalidateGitCache, readGitStatusCache } from "./lib/git-status-cache";

/** `git` with the machine's own config (hooks, signing) kept out — see the preload. */
function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv({ GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" }),
  });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

type Envelope = { type: string; projectPath: string; status: { branch: string; ahead: number; behind: number; files: { path: string; status: string }[] }; worktreeId?: string };

/** Wait for a condition instead of a fixed sleep: the debounce is 500 ms, load is not. */
async function until(cond: () => boolean, budgetMs = 6000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

describe("WORKTREE-05 — the watcher speaks for the worktree, not for its parent", () => {
  let root: string;
  let origin: string;
  let repo: string;
  let tree: string;
  let sent: Envelope[];
  let ctx: AppContext;
  /** Every path handed to `watchGitDir`, so `afterEach` can free the real fs watchers. */
  let watched: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gitwatch-"));
    origin = join(root, "origin.git");
    repo = join(root, "repo");
    tree = join(root, "tree");
    sent = [];
    watched = [];
    ctx = { broadcastToAll: (m: unknown) => void sent.push(m as Envelope) } as unknown as AppContext;

    expect(Bun.spawnSync(["git", "init", "--bare", "-b", "main", origin], { env: gitEnv(), stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "clone", origin, repo], { env: gitEnv(), stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "start\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "first");
    git(repo, "push", "-u", "origin", "main");
    // The worktree lives on its OWN branch. Same-branch would make every
    // assertion below pass even if the watcher read the parent's HEAD.
    expect(git(repo, "worktree", "add", "-b", "feature", tree, "main").code).toBe(0);
  });

  afterEach(() => {
    for (const p of watched) unwatchGitDir(p);
    rmSync(root, { recursive: true, force: true });
  });

  function watch(path: string, id?: string) {
    watched.push(path);
    watchGitDir(path, ctx, id);
  }

  test("the shape the whole requirement rests on: a worktree's `.git` is a FILE pointing elsewhere", () => {
    // Pinned, not assumed. Everything below is about following this pointer;
    // if git ever stopped writing it this way the tests would go green while
    // the feature broke, so the shape itself is an assertion.
    const dotGit = join(tree, ".git");
    expect(statSync(dotGit).isFile(), "a linked worktree keeps a .git FILE, not a directory").toBe(true);
    const target = readFileSync(dotGit, "utf-8").trim().replace(/^gitdir:\s*/, "");
    expect(target).toContain(join(".git", "worktrees"));
    expect(existsSync(join(target, "HEAD")), "the worktree's own HEAD lives in that directory").toBe(true);
  });

  test("a worktree broadcast carries its id, its branch and its own dirty files", async () => {
    watch(tree, "w-nightly");
    // Both trees dirty, with DIFFERENT filenames: if the status were computed
    // for the parent, the file list would name the wrong one.
    writeFileSync(join(repo, "only-in-parent.txt"), "x\n");
    writeFileSync(join(tree, "only-in-worktree.txt"), "y\n");

    await refreshGitStatus(tree, ctx);

    const env = sent.at(-1)!;
    expect(env.type).toBe("git:status");
    expect(env.worktreeId).toBe("w-nightly");
    expect(env.status.branch, "the worktree is on `feature`; the parent is on `main`").toBe("feature");
    const paths = env.status.files.map((f) => f.path);
    expect(paths).toContain("only-in-worktree.txt");
    expect(paths, "the parent's dirt is not this worktree's business").not.toContain("only-in-parent.txt");
  });

  test("ahead/behind are counted against the worktree's own upstream", async () => {
    git(tree, "push", "-u", "origin", "feature");
    writeFileSync(join(tree, "a.txt"), "a\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-m", "one ahead");

    watch(tree, "w-1");
    await refreshGitStatus(tree, ctx);

    const { ahead, behind } = sent.at(-1)!.status;
    expect(ahead, "one commit made here and not pushed").toBe(1);
    expect(behind).toBe(0);
  });

  test("after a push the route's cache is warm, with the route's own fields", async () => {
    // The poll that follows a push used to be a cache MISS: the watcher only
    // emptied the slot, so the client re-asked git for the state the push had
    // just computed. Now the push fills it, in the route's shape.
    invalidateGitCache(tree);
    expect(readGitStatusCache(tree)).toBeNull();
    watch(tree, "w-cache");
    writeFileSync(join(tree, "dirty.txt"), "x\n");
    await refreshGitStatus(tree, ctx);

    const cached = readGitStatusCache(tree);
    expect(cached, "the push warms the route's cache").not.toBeNull();
    expect(cached!.branch).toBe("feature");
    expect(cached!.files.map((f) => f.path)).toContain("dirty.txt");
    expect(cached!.repoName, "the route's field, present so the cached answer equals a computed one").toBe("");
    expect(cached!.folderUntracked).toBe(false);
    expect(cached).toEqual(sent.at(-1)!.status as unknown as typeof cached);
  });

  test("a plain project path has NO `worktreeId` KEY — absent, not undefined", async () => {
    watch(repo);
    await refreshGitStatus(repo, ctx);

    const env = sent.at(-1)!;
    expect(env.status.branch).toBe("main");
    // `in`, not `=== undefined`: the requirement is that consumers written
    // before worktrees existed see the exact same envelope they always saw,
    // and a key present with an undefined value survives JSON.stringify as a
    // missing key but shows up in `Object.keys` on the server side.
    expect("worktreeId" in env, "the pre-worktree envelope has no such field").toBe(false);
  });

  test("two worktrees of the same repo do not share a slot", async () => {
    const other = join(root, "other");
    expect(git(repo, "worktree", "add", "-b", "second", other, "main").code).toBe(0);
    watch(tree, "w-first");
    watch(other, "w-second");

    await refreshGitStatus(tree, ctx);
    await refreshGitStatus(other, ctx);

    expect(sent.at(-2)!.worktreeId).toBe("w-first");
    expect(sent.at(-1)!.worktreeId).toBe("w-second");
    expect(sent.at(-1)!.status.branch).toBe("second");
  });

  test("unwatching forgets the id, so a reused path cannot inherit a dead scope", async () => {
    watch(tree, "w-gone");
    await refreshGitStatus(tree, ctx);
    expect(sent.at(-1)!.worktreeId).toBe("w-gone");

    unwatchGitDir(tree);
    await refreshGitStatus(tree, ctx);

    // The failure this pins: the id map is module-level and outlives the
    // watcher. A worktree collected by the GC and a new one later mounted at
    // the same path would broadcast under the dead one's id, and the client
    // would invalidate a cache scope that no longer exists.
    expect("worktreeId" in sent.at(-1)!, "the id must die with the watcher").toBe(false);
  });

  test("a git operation INSIDE the worktree actually reaches the broadcast", async () => {
    // The end-to-end half, and the only one that can tell a correct
    // `resolveGitDir` from one that stopped at the parent: `git add` writes
    // the worktree's own `index`, inside `.git/worktrees/<name>/`. Watching
    // the parent's `.git` would see nothing here.
    watch(tree, "w-live");
    sent.length = 0;

    writeFileSync(join(tree, "live.txt"), "written by an agent\n");
    git(tree, "add", "-A");

    const arrived = await until(() => sent.some((e) => e.type === "git:status"));
    expect(arrived, "nothing was broadcast: the watcher is not on the worktree's git dir").toBe(true);
    const env = sent.find((e) => e.type === "git:status")!;
    expect(env.projectPath).toBe(tree);
    expect(env.worktreeId).toBe("w-live");
  });
});

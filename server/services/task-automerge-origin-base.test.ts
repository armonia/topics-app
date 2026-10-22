/**
 * @covers LAND-04
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTaskAutoMerge, type GitRunResult } from "./task-automerge";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/**
 * THE LAND STARTS FROM `origin/main`, NOT FROM THE LOCAL `main`.
 *
 * On 21/10 the local `main` was 646 commits behind and 6 ahead of `origin/main`:
 * the land compared a card's branch (born from a stale base) with a main nobody
 * updated, and `land-drags-foreign-commits` fired on healthy cards. Now the land
 * does a bounded fetch of `origin/main`, compares the branch with that, and
 * brings `origin/main` into the landing checkout before merging. It never
 * pushes: Publish stays a human gesture.
 */

const TARGET = { repoPath: "/repo", branch: "topics/lyrical-cobra", defaultBranch: "main" };

/** Fake runner: records the calls; `over` answers by the prefix of the first two tokens. */
function fakeGit(over: Record<string, Partial<GitRunResult>> = {}) {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
    calls.push(args);
    const r = over[args.slice(0, 2).join(" ")] ?? over[args[0]!] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

const ON_MAIN = {
  "symbolic-ref --short": { stdout: "main\n" },
  "rev-list --count": { stdout: "3\n" },
  "rev-parse --short": { stdout: "abc1234\n" },
};

const index = (calls: string[][], pred: (c: string[]) => boolean) => calls.findIndex(pred);

describe("land: la base è origin/main", () => {
  test("fetch limitato PRIMA di ogni confronto, e il ramo si confronta con origin/main", async () => {
    const git = fakeGit(ON_MAIN);
    const res = await createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run }).tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    expect(git.calls[0]).toEqual(["fetch", "--no-tags", "origin", "main"]);
    const count = git.calls.find((c) => c[0] === "rev-list" && c[1] === "--count");
    expect(count![2]).toBe("origin/main..topics/lyrical-cobra");
  });

  test("origin/main entra nel checkout di land PRIMA del merge del ramo, e il land non pusha", async () => {
    const git = fakeGit(ON_MAIN);
    await createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run }).tryMerge("t1", "x");
    const sync = index(git.calls, (c) => c[0] === "merge" && c.includes("origin/main"));
    const land = index(git.calls, (c) => c[0] === "merge" && c.includes("--no-ff"));
    expect(sync).toBeGreaterThan(-1);
    expect(sync).toBeLessThan(land);
    expect(git.calls.some((c) => c[0] === "push")).toBe(false);
  });

  test("checkout su un ramo di sviluppo: origin/main entra nel worktree usa-e-getta, dopo la sua creazione", async () => {
    const git = fakeGit({ ...ON_MAIN, "symbolic-ref --short": { stdout: "feature/x\n" } });
    const res = await createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run }).tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    const add = index(git.calls, (c) => c[0] === "worktree" && c[1] === "add");
    const sync = index(git.calls, (c) => c[0] === "merge" && c.includes("origin/main"));
    expect(add).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(add);
  });

  test("fetch fallito: si atterra comunque sulla copia locale di origin/main", async () => {
    const git = fakeGit({ ...ON_MAIN, fetch: { code: 128, stderr: "fatal: unable to access" } });
    const res = await createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run }).tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    const count = git.calls.find((c) => c[0] === "rev-list" && c[1] === "--count");
    expect(count![2]).toBe("origin/main..topics/lyrical-cobra");
  });

  test("senza origin/main (repo senza remote) il land resta sul main locale e non cerca di fonderlo", async () => {
    const git = fakeGit({ ...ON_MAIN, fetch: { code: 128 }, "rev-parse --verify": { code: 1 } });
    const res = await createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run }).tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    const count = git.calls.find((c) => c[0] === "rev-list" && c[1] === "--count");
    expect(count![2]).toBe("main..topics/lyrical-cobra");
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("origin/main"))).toBe(false);
  });

  test("origin/main non si fonde col main locale: skipped base-diverged, merge --abort, il ramo non si tocca", async () => {
    const git = fakeGit({ ...ON_MAIN, "merge --no-edit": { code: 1, stderr: "CONFLICT" } });
    const res = await createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run }).tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.code).toBe("base-diverged");
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--abort"))).toBe(true);
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--no-ff"))).toBe(false);
  });
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return r.stdout.toString().trim();
}

function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), msg);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

function setupIdentity(repo: string): void {
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
}

/** On real git: the 21/10 case, a stale local main while origin/main has moved ahead. */
describe("land su git vero: main locale stantio", () => {
  let root: string;
  let clone: string;
  let bare: string;
  let originTip: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "land-origin-base-"));
    const seed = join(root, "seed");
    bare = join(root, "origin.git");
    clone = join(root, "clone");
    const other = join(root, "other");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", seed], { env: gitEnv() });
    setupIdentity(seed);
    commit(seed, "base.txt", "base");
    Bun.spawnSync(["git", "clone", "-q", "--bare", seed, bare], { env: gitEnv() });
    Bun.spawnSync(["git", "clone", "-q", bare, clone], { env: gitEnv() });
    setupIdentity(clone);
    // The shared checkout is on a dev branch, so the land goes through the throwaway worktree.
    git(clone, "checkout", "-q", "-b", "sviluppo");

    // Another clone publishes two commits: the clone's local `main` does not have them.
    Bun.spawnSync(["git", "clone", "-q", bare, other], { env: gitEnv() });
    setupIdentity(other);
    commit(other, "uno.txt", "uno");
    originTip = commit(other, "due.txt", "due");
    git(other, "push", "-q", "origin", "main");

    // The card is born from origin/main (after a fetch), as the dispatch does now.
    git(clone, "fetch", "-q", "--no-tags", "origin", "main");
    git(clone, "branch", "topics/card", "origin/main");
    git(clone, "worktree", "add", "-q", join(root, "wt"), "topics/card");
    setupIdentity(join(root, "wt"));
    commit(join(root, "wt"), "card.txt", "lavoro della card");
  }, 30_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("il merge atterra sopra origin/main: introduce solo il lavoro della card, e non pusha", async () => {
    expect(git(clone, "rev-parse", "main")).not.toBe(originTip);
    const res = await createTaskAutoMerge({
      resolveTaskMerge: () => ({ repoPath: clone, branch: "topics/card", defaultBranch: "main" }),
    }).tryMerge("t1", "lavoro della card");
    expect(res.status).toBe("merged");
    if (res.status === "merged") {
      // The merge's first parent is origin/main: what the land introduces is the card's file,
      // not the two already published commits the branch carries from its birth.
      expect(git(clone, "diff", "--name-only", "main^1", "main")).toBe("card.txt");
      expect(res.touchedClient || res.touchedServer || res.touchedNative).toBe(false);
    }
    expect(Bun.spawnSync(["git", "-C", clone, "merge-base", "--is-ancestor", originTip, "main"], { env: gitEnv() }).exitCode).toBe(0);
    // The land does not publish: origin is exactly as it was.
    expect(git(bare, "rev-parse", "main")).toBe(originTip);
  });
});

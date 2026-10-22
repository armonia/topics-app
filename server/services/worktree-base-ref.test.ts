/**
 * @covers WORKTREE-08
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolveWorktreeBaseRef } from "./worktree-base-ref";
import type { GitRunResult } from "./own-commits";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return r.stdout.toString().trim();
}

function initRepo(path: string, branch: string): void {
  Bun.spawnSync(["git", "init", "-q", "-b", branch, path], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  git(path, "config", "user.email", "t@t");
  git(path, "config", "user.name", "t");
}

function commit(path: string, file: string, msg: string): void {
  writeFileSync(join(path, file), msg);
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", msg);
}

/**
 * REAL repos, because the question under test is the one git answers: the remote
 * ref exists and the fetch moves it forward. A fake runner would only prove the
 * code reads a `code`, not that it asks the right thing.
 *
 *   clone      checkout with a real `origin`, a STALE local `main` and another
 *              branch checked out (the shared checkout), while `origin/main` has
 *              moved ahead through a second clone: the 21/10 defect
 *   noOrigin   a single `sviluppo` branch, no remote
 */
describe("worktree-base-ref: su git vero", () => {
  let root: string;
  let clone: string;
  let originTip: string;
  let noOrigin: string;

  // Wide timeout: about twenty synchronous `git` calls run here, and bun's 5s
  // default covers them only on an idle machine (same reason as own-commits).
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-base-ref-"));
    const bare = join(root, "origin.git");
    const seed = join(root, "seed");
    clone = join(root, "clone");
    const other = join(root, "other");

    initRepo(seed, "main");
    commit(seed, "a.txt", "base");
    Bun.spawnSync(["git", "clone", "-q", "--bare", seed, bare], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    Bun.spawnSync(["git", "clone", "-q", bare, clone], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    git(clone, "config", "user.email", "t@t");
    git(clone, "config", "user.name", "t");
    // The shared checkout is NOT on main, it is on another session's branch.
    git(clone, "checkout", "-q", "-b", "altra-sessione");
    commit(clone, "b.txt", "lavoro altrui");

    // A second clone publishes to origin/main: the clone above does not know.
    Bun.spawnSync(["git", "clone", "-q", bare, other], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    git(other, "config", "user.email", "t@t");
    git(other, "config", "user.name", "t");
    commit(other, "c.txt", "pubblicato altrove");
    git(other, "push", "-q", "origin", "main");
    originTip = git(other, "rev-parse", "HEAD");

    noOrigin = join(root, "senza-origin");
    initRepo(noOrigin, "sviluppo");
    commit(noOrigin, "a.txt", "base");
  }, 30_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("la base è origin/main, aggiornato dal fetch, non il main locale fermo", async () => {
    expect(git(clone, "rev-parse", "main")).not.toBe(originTip);
    const r = await resolveWorktreeBaseRef(clone);
    expect(r.baseRef).toBe("origin/main");
    expect(r.fallback).toBe(false);
    expect(r.reason).toBe("");
    // The fetch really moved the ref forward, an old copy was not read.
    expect(git(clone, "rev-parse", r.baseRef)).toBe(originTip);
  });

  test("repo senza origin → HEAD, e il ripiego è dichiarato", async () => {
    const r = await resolveWorktreeBaseRef(noOrigin);
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
    expect(r.reason).toContain("origin/main");
  });

  test("un main LOCALE non basta più: la base è la ref remota, non refs/heads/main", async () => {
    // A local `main` exists, `origin/main` does not: it used to be the right base, now it is the defect.
    git(noOrigin, "branch", "main");
    const r = await resolveWorktreeBaseRef(noOrigin);
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
  });

  test("il ramo d'integrazione è un parametro: mainRef diverso → il suo remoto", async () => {
    git(clone, "push", "-q", "origin", "main:trunk");
    const r = await resolveWorktreeBaseRef(clone, { mainRef: "trunk" });
    expect(r.baseRef).toBe("origin/trunk");
    expect(r.fallback).toBe(false);
  });
});

/** The fetch, seen from a fake runner: what is asked and what happens when it fails. */
describe("worktree-base-ref: il fetch", () => {
  function runner(fetchCode: number, haveRemoteRef: boolean) {
    const calls: string[][] = [];
    const runGit = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
      calls.push(args);
      if (args[0] === "fetch") return { code: fetchCode, stdout: "", stderr: fetchCode ? "fatal: unable to access\n" : "" };
      return { code: haveRemoteRef ? 0 : 1, stdout: "", stderr: "" };
    };
    return { runGit, calls };
  }

  test("un fetch limitato (--no-tags, solo quel ref) PRIMA di risolvere", async () => {
    const { runGit, calls } = runner(0, true);
    const r = await resolveWorktreeBaseRef("/repo", { runGit });
    expect(calls[0]).toEqual(["fetch", "--no-tags", "origin", "main"]);
    expect(calls[1]![0]).toBe("rev-parse");
    expect(r).toEqual({ baseRef: "origin/main", fallback: false, reason: "" });
  });

  test("fetch fallito con la copia locale di origin/main → si parte da quella, e lo dice", async () => {
    const { runGit } = runner(1, true);
    const r = await resolveWorktreeBaseRef("/repo", { runGit });
    expect(r.baseRef).toBe("origin/main");
    expect(r.fallback).toBe(false);
    expect(r.reason).toContain("fetch");
  });

  test("fetch fallito e nessuna copia di origin/main → HEAD, dichiarato", async () => {
    const { runGit } = runner(1, false);
    const r = await resolveWorktreeBaseRef("/repo", { runGit });
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
    expect(r.reason).toContain("fetch");
  });

  test("progetto senza path di repo → HEAD, senza chiamare git", async () => {
    const { runGit, calls } = runner(0, true);
    const r = await resolveWorktreeBaseRef(undefined, { runGit });
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
    expect(calls).toEqual([]);
  });
});

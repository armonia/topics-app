/**
 * A CARD BORN AFTER A LAND THAT WAS NEVER PUBLISHED.
 *
 * The land writes to the LOCAL main and never pushes (Publish is a human
 * gesture). So the minute card A lands, the local main carries work
 * `origin/main` does not have. If card B is then born from `origin/main` it
 * cannot see A: its land collides with A, and the repair everyone suggests —
 * rebase onto the trunk — does nothing, because B is already based on it. The
 * card bounces between review and land forever.
 *
 * Real git here, not a fake runner: what is being proven is what `git` answers
 * about two refs that have genuinely diverged, which is exactly the thing a
 * stubbed `rev-list` cannot get wrong.
 *
 * @covers LAND-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { resolveWorktreeBaseRef } from "./worktree-base-ref";
import { gitEnv } from "../../tests/setup/bun-test-preload";

let root: string;
let work: string;

/**
 * Real git, with an identity of its own AND the preload's isolated environment:
 * without `gitEnv()` the machine's `core.hooksPath` fires on every commit this
 * test makes (`tests/unit/git-env-nei-test.test.ts` tells the story).
 */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args],
    { cwd, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} → ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "topics-trunk-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  work = join(root, "work");
  git(root, "clone", origin, work);
  commit(work, "README.md", "uno\n", "base");
  git(work, "push", "origin", "main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("la base di una card nasce dove il land fonde", () => {
  test("main locale allineato a origin: si nasce da origin/main", async () => {
    const base = await resolveWorktreeBaseRef(work);
    expect(base).toMatchObject({ baseRef: "origin/main", fallback: false });
  });

  test("dopo un land non pubblicato si nasce dal main LOCALE, e la card seguente vede il land", async () => {
    // Card A: works on a branch of its own and lands on the local main. No push.
    git(work, "checkout", "-b", "topics/card-a");
    const shaA = commit(work, "contested.txt", "A\n", "card A");
    git(work, "checkout", "main");
    git(work, "merge", "--no-ff", "--no-edit", "topics/card-a");

    // `origin/main` has not moved: the local main is ahead.
    expect(git(work, "rev-list", "--count", "origin/main..main")).not.toBe("0");

    const base = await resolveWorktreeBaseRef(work);
    expect(base.baseRef).toBe("main");
    expect(base.fallback).toBe(false);
    expect(base.reason).toContain("land non pubblicati");

    // This is what breaks the loop: card B is born WITH A's work inside it.
    git(work, "worktree", "add", "-b", "topics/card-b", join(root, "wt-b"), base.baseRef);
    const wtB = join(root, "wt-b");
    expect(git(wtB, "merge-base", "--is-ancestor", shaA, "HEAD") === "").toBe(true);

    // B touches the same file as A and its land does NOT conflict.
    commit(wtB, "contested.txt", "A\nB\n", "card B");
    git(work, "merge", "--no-ff", "--no-edit", "topics/card-b");
    expect(git(work, "rev-list", "--count", "main..topics/card-b")).toBe("0");
  });

  test("nata da origin/main, la stessa card B avrebbe fatto conflitto", () => {
    // The counterfactual, on the same repo: this is why the base cannot be
    // `origin/main` while the local main is ahead.
    git(work, "worktree", "add", "-b", "topics/card-c", join(root, "wt-c"), "origin/main");
    const wtC = join(root, "wt-c");
    commit(wtC, "contested.txt", "C\n", "card C da origin/main");
    const land = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com",
      "merge", "--no-ff", "--no-edit", "topics/card-c"], { cwd: work, encoding: "utf8", env: gitEnv() });
    expect(land.status).not.toBe(0);
    expect(`${land.stdout}${land.stderr}`).toContain("CONFLICT");
    spawnSync("git", ["merge", "--abort"], { cwd: work, env: gitEnv() });
  });
});

/**
 * The gate that counts the leftovers, tested on what it actually reports.
 *
 * @covers RUNTIME-22
 *
 * `collect` is the whole gate: it reads the repo and returns one entry per kind
 * of leftover. Each case below builds a throwaway repo, plants exactly one
 * leftover and checks the gate sees it, so what is asserted is "it goes red
 * when something is there" and not merely "it runs".
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "./check-repo-pulito";

/**
 * A THROWAWAY REPO, because the interesting assertion is "it goes red when
 * something is there", and that cannot be made on this checkout: a test that
 * dirties the repo it runs in is a test that loses somebody's work.
 *
 * Each case builds a fresh repo, plants exactly one leftover and runs the gate
 * inside it. `collect` shells out to git in the current directory, so the
 * cases chdir in and back out.
 */
async function throwawayRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "clean-"));
  await $`git init -q -b main`.cwd(dir).quiet();
  await $`git config user.email t@t.t`.cwd(dir).quiet();
  await $`git config user.name t`.cwd(dir).quiet();
  await Bun.write(join(dir, "a.txt"), "uno\n");
  await $`git add -A`.cwd(dir).quiet();
  await $`git commit -qm base`.cwd(dir).quiet();
  return dir;
}

/** Runs the gate with `dir` as the working directory, then restores it. */
async function inside<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

describe("check-repo-pulito: vede cio' che deve vedere", () => {
  test("a clean repo produces no findings at all", async () => {
    const dir = await throwawayRepo();
    const found = await inside(dir, collect);
    expect(found).toEqual([]);
  });

  test("goes red on a stray branch, and names it", async () => {
    const dir = await throwawayRepo();
    await $`git branch avanzo`.cwd(dir).quiet();
    const found = await inside(dir, collect);
    const branches = found.find((r) => r.what.includes("ramo"));
    expect(branches).toBeDefined();
    expect(branches!.lines).toContain("avanzo");
    expect(branches!.lines).not.toContain("main");
  });

  test("goes red on a stash, the leftover that hides from git status", async () => {
    // THE CASE THAT SLIPPED THROUGH on 19/09: nine stashes from August, in a
    // repo that `git status` called clean and that had been declared finished
    // three times.
    const dir = await throwawayRepo();
    await Bun.write(join(dir, "a.txt"), "due\n");
    await $`git stash push -q -m residuo`.cwd(dir).quiet();
    const status = (await $`git status --porcelain`.cwd(dir).quiet().text()).trim();
    expect(status).toBe(""); // invisible to git status: that is the whole point
    const found = await inside(dir, collect);
    expect(found.find((r) => r.what.includes("stash"))).toBeDefined();
  });

  test("goes red on uncommitted files", async () => {
    const dir = await throwawayRepo();
    await Bun.write(join(dir, "b.txt"), "non committato\n");
    const found = await inside(dir, collect);
    expect(found.find((r) => r.what.includes("non committati"))).toBeDefined();
  });

  test("counts an extra worktree but never the main checkout", async () => {
    // The trap: `git worktree list` ALWAYS prints the main checkout, so a
    // naive count reports one too many on a clean repo and the gate becomes
    // noise people learn to skip.
    const dir = await throwawayRepo();
    const clean = await inside(dir, collect);
    expect(clean.find((r) => r.what.includes("worktree"))).toBeUndefined();

    await $`git worktree add -q ${join(dir, "wt")} -b altro`.cwd(dir).quiet();
    const found = await inside(dir, collect);
    const wt = found.find((r) => r.what.includes("worktree"));
    expect(wt).toBeDefined();
    expect(wt!.lines.length).toBe(1);
  });
});

describe("check-repo-pulito: come lo riporta", () => {
  test("every finding carries what, which ones, and how to remove it", async () => {
    const dir = await throwawayRepo();
    await $`git branch avanzo`.cwd(dir).quiet();
    await Bun.write(join(dir, "b.txt"), "x\n");
    const found = await inside(dir, collect);
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.what.length).toBeGreaterThan(0);
      // A finding without a remedy is the "open the run and look" failure all
      // over again: it hands the reader an investigation instead of an action.
      expect(r.remedy.length).toBeGreaterThan(0);
      expect(Array.isArray(r.lines)).toBe(true);
    }
  });

  test("the remedy archives, it never just deletes", async () => {
    const dir = await throwawayRepo();
    await $`git branch avanzo`.cwd(dir).quiet();
    const found = await inside(dir, collect);
    const branches = found.find((r) => r.what.includes("ramo"));
    // `git branch -D` on its own would lose the work: the advice must lead
    // with the tag that keeps it reachable.
    expect(branches!.remedy).toContain("git tag archive/");
  });

  test("says nothing about pull requests", async () => {
    // Deliberate: a PR awaiting review is work in flight, not a leftover.
    // A gate nudging toward merging it would push the wrong way.
    const dir = await throwawayRepo();
    await $`git branch avanzo`.cwd(dir).quiet();
    const found = await inside(dir, collect);
    for (const r of found) {
      expect(r.what.toLowerCase()).not.toContain("pull request");
    }
  });
});

describe("check-repo-pulito: fantasma contro worktree vere", () => {
  test("tells a GHOST worktree from a real one", async () => {
    // The free half of the problem. A worktree whose folder is gone still sits
    // in git's registration: no disk, no work, and `git worktree prune` clears
    // it with no decision to make. Reported together with the real ones it
    // would hide a free fix behind one that needs thought - on 20/09 six of
    // eight worktrees on this box were ghosts, five of them in one repo.
    const dir = await throwawayRepo();
    const wt = join(dir, "wt");
    await $`git worktree add -q ${wt} -b altro`.cwd(dir).quiet();
    await $`rm -rf ${wt}`.quiet(); // the folder goes, the registration stays

    const found = await inside(dir, collect);
    const ghost = found.find((r) => r.what.includes("FANTASMA"));
    expect(ghost).toBeDefined();
    expect(ghost!.remedy).toContain("git worktree prune");
    // And it must NOT also show up among the real ones.
    expect(found.find((r) => r.what.includes("oltre il checkout"))).toBeUndefined();
  });

  test("a real worktree says ARCHIVE before remove", async () => {
    // Measured reason: of the 16 removed on 20/09, ten carried commits that
    // were NOT in main (up to six each). "The agent finished" is not "the work
    // landed", so the advice cannot lead with a removal.
    const dir = await throwawayRepo();
    await $`git worktree add -q ${join(dir, "viva")} -b viva`.cwd(dir).quiet();
    const found = await inside(dir, collect);
    const real = found.find((r) => r.what.includes("oltre il checkout"));
    expect(real).toBeDefined();
    expect(real!.remedy).toContain("git tag archive/wt-");
    expect(real!.remedy).toContain("main..HEAD");
  });
});

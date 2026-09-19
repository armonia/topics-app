/**
 * The gate that counts the leftovers, tested on what it actually reported.
 *
 * `raccogli` is the whole gate: it reads the repo and returns one entry per
 * kind of leftover. The tests below run it against THIS repo, so they assert
 * the shape of what it finds rather than a fixture that could drift away from
 * git's real output.
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raccogli } from "./check-repo-pulito";

/**
 * A THROWAWAY REPO, because the interesting assertion is "it goes red when
 * something is there", and that cannot be made on this checkout: a test that
 * dirties the repo it runs in is a test that loses somebody's work.
 *
 * Each case builds a fresh repo, plants exactly one leftover and runs the gate
 * inside it. `raccogli` shells out to git in the current directory, so the
 * cases chdir in and back out.
 */
async function repoFinto(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pulito-"));
  await $`git init -q -b main`.cwd(dir).quiet();
  await $`git config user.email t@t.t`.cwd(dir).quiet();
  await $`git config user.name t`.cwd(dir).quiet();
  await Bun.write(join(dir, "a.txt"), "uno\n");
  await $`git add -A`.cwd(dir).quiet();
  await $`git commit -qm base`.cwd(dir).quiet();
  return dir;
}

/** Runs the gate with `dir` as the working directory, then restores it. */
async function dentro<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prima = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prima);
  }
}

describe("check-repo-pulito: vede cio' che deve vedere", () => {
  test("a clean repo produces no findings at all", async () => {
    const dir = await repoFinto();
    const trovati = await dentro(dir, raccogli);
    expect(trovati).toEqual([]);
  });

  test("goes red on a stray branch, and names it", async () => {
    const dir = await repoFinto();
    await $`git branch avanzo`.cwd(dir).quiet();
    const trovati = await dentro(dir, raccogli);
    const rami = trovati.find((r) => r.cosa.includes("ramo"));
    expect(rami).toBeDefined();
    expect(rami!.righe).toContain("avanzo");
    expect(rami!.righe).not.toContain("main");
  });

  test("goes red on a stash, the leftover that hides from git status", async () => {
    // THE CASE THAT SLIPPED THROUGH on 19/09: nine stashes from August, in a
    // repo that `git status` called clean and that had been declared finished
    // three times.
    const dir = await repoFinto();
    await Bun.write(join(dir, "a.txt"), "due\n");
    await $`git stash push -q -m residuo`.cwd(dir).quiet();
    const stato = (await $`git status --porcelain`.cwd(dir).quiet().text()).trim();
    expect(stato).toBe(""); // invisible to git status: that is the whole point
    const trovati = await dentro(dir, raccogli);
    expect(trovati.find((r) => r.cosa.includes("stash"))).toBeDefined();
  });

  test("goes red on uncommitted files", async () => {
    const dir = await repoFinto();
    await Bun.write(join(dir, "b.txt"), "non committato\n");
    const trovati = await dentro(dir, raccogli);
    expect(trovati.find((r) => r.cosa.includes("non committati"))).toBeDefined();
  });

  test("counts an extra worktree but never the main checkout", async () => {
    // The trap: `git worktree list` ALWAYS prints the main checkout, so a
    // naive count reports one too many on a clean repo and the gate becomes
    // noise people learn to skip.
    const dir = await repoFinto();
    const pulito = await dentro(dir, raccogli);
    expect(pulito.find((r) => r.cosa.includes("worktree"))).toBeUndefined();

    await $`git worktree add -q ${join(dir, "wt")} -b altro`.cwd(dir).quiet();
    const trovati = await dentro(dir, raccogli);
    const wt = trovati.find((r) => r.cosa.includes("worktree"));
    expect(wt).toBeDefined();
    expect(wt!.righe.length).toBe(1);
  });
});

describe("check-repo-pulito: come lo riporta", () => {
  test("every finding carries what, which ones, and how to remove it", async () => {
    const dir = await repoFinto();
    await $`git branch avanzo`.cwd(dir).quiet();
    await Bun.write(join(dir, "b.txt"), "x\n");
    const trovati = await dentro(dir, raccogli);
    expect(trovati.length).toBeGreaterThan(0);
    for (const r of trovati) {
      expect(r.cosa.length).toBeGreaterThan(0);
      // A finding without a remedy is the "open the run and look" failure all
      // over again: it hands the reader an investigation instead of an action.
      expect(r.rimedio.length).toBeGreaterThan(0);
      expect(Array.isArray(r.righe)).toBe(true);
    }
  });

  test("the remedy archives, it never just deletes", async () => {
    const dir = await repoFinto();
    await $`git branch avanzo`.cwd(dir).quiet();
    const trovati = await dentro(dir, raccogli);
    const rami = trovati.find((r) => r.cosa.includes("ramo"));
    // `git branch -D` on its own would lose the work: the advice must lead
    // with the tag that keeps it reachable.
    expect(rami!.rimedio).toContain("git tag archive/");
  });

  test("says nothing about pull requests", async () => {
    // Deliberate: a PR awaiting review is work in flight, not a leftover.
    // A gate nudging toward merging it would push the wrong way.
    const dir = await repoFinto();
    await $`git branch avanzo`.cwd(dir).quiet();
    const trovati = await dentro(dir, raccogli);
    for (const r of trovati) {
      expect(r.cosa.toLowerCase()).not.toContain("pull request");
    }
  });
});

/**
 * The half land of 17/11, replayed on a real git repo.
 *
 * Card 76d3e2ff ran several node rounds. Each round left a local branch
 * pointing into the card's own history, so the land saw the fix commit as
 * "foreign" (reachable from another branch), cherry-picked only the rest, and
 * closed the card as landed without the fix. The land now refuses a branch
 * whose foreign commits are not on main, naming them, and merges the branch
 * whole once those branches are known to be the card's own.
 *
 * @covers LAND-04
 */
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskAutoMerge, type AutoMergeDeps } from "./task-automerge";
import { slackMs } from "../../tests/helpers/time-slack";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BRANCH = "topics/card";
const ROUND = "topics/round-1";
const WITH_REAL_GIT = slackMs(30_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function commit(cwd: string, path: string, body: string, message: string): string {
  const abs = join(cwd, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** The incident's shape: fix A and B on the card, an earlier round's branch on A, main merged in, then C. */
function incidentRepo(): { repo: string; fixSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "land-partial-"));
  created.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "README.md", "root\n", "root");

  git(repo, "switch", "-q", "-c", BRANCH);
  const fixSha = commit(repo, "src/fix.ts", "export const fixed = true;\n", "A: the fix");
  commit(repo, "src/other.ts", "export const other = 1;\n", "B: other change");
  // The previous node round of the same card, left behind as a local branch.
  git(repo, "branch", ROUND, fixSha);

  git(repo, "switch", "-q", "main");
  commit(repo, "main.txt", "main moved\n", "main: unrelated");
  git(repo, "switch", "-q", BRANCH);
  git(repo, "merge", "-q", "--no-ff", "-m", "Merge main into card", "main");
  commit(repo, "tests/spec.ts", "test('fix', () => {});\n", "C: the spec");

  git(repo, "switch", "-q", "main");
  return { repo, fixSha };
}

function landOn(repoPath: string, extra: Partial<AutoMergeDeps> = {}) {
  return createTaskAutoMerge({
    resolveTaskMerge: () => ({ repoPath, branch: BRANCH, defaultBranch: "main" }),
    ...extra,
  });
}

describe("a card branch held in part by its own earlier round", () => {
  test("unknown round branch: refused naming the fix, main untouched; known as own: merged whole", async () => {
    const { repo, fixSha } = incidentRepo();
    const mainBefore = git(repo, "rev-parse", "main");

    const refused = await landOn(repo).tryMerge("t-card", "Card with node rounds");
    if (refused.status !== "skipped") throw new Error(`expected skipped, got ${refused.status}`);
    expect(refused.code).toBe("foreign-commits");
    expect(refused.reason).toContain(git(repo, "rev-parse", "--short", fixSha));
    expect(refused.reason).toContain("A: the fix");
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(repo, "status", "--porcelain")).toBe("");

    const landed = await landOn(repo, { ownBranches: () => [ROUND] }).tryMerge("t-card", "Card with node rounds");
    expect(landed.status).toBe("merged");
    expect(git(repo, "rev-parse", "main")).not.toBe(mainBefore);
    // Every file of the card is on main, the fix included.
    expect(git(repo, "diff", "main", BRANCH, "--", "src/fix.ts", "src/other.ts", "tests/spec.ts")).toBe("");
  }, WITH_REAL_GIT);
});

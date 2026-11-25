/**
 * @covers WORKTREE-STD-02
 *
 * The throwaway checkouts live in `{worktree root}/_scratch/<kind>/<id>`, and the
 * boot sweep removes what a previous process left there, from the disk and from
 * `git worktree list`, on a real repository.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscardGit } from "../lib/worktree-discard";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { slackMs } from "../../tests/helpers/time-slack";
import { legacyNodeCheckRoot, scratchDir, scratchId, sweepScratch } from "./worktree-scratch";

const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}
const realGit: DiscardGit = async (cwd, args) => {
  try { git(cwd, ...args); return { code: 0 }; } catch { return { code: 1 }; }
};

function repoWithRoot(): { repo: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), "wt-scratch-"));
  created.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "root");
  return { repo, root: join(dir, "worktrees") };
}

describe("scratchDir", () => {
  test("is {root}/_scratch/{kind}", () => {
    expect(scratchDir("land", "/r")).toBe(join("/r", "_scratch", "land"));
    expect(scratchDir("realign", "/r")).toBe(join("/r", "_scratch", "realign"));
    expect(scratchDir("integrazione", "/r")).toBe(join("/r", "_scratch", "integrazione"));
    expect(scratchDir("node-checks", "/r")).toBe(join("/r", "_scratch", "node-checks"));
  });

  test("follows the live worktree root by default, never the temp area", () => {
    const dir = scratchDir("land");
    expect(dir.endsWith(join("_scratch", "land"))).toBe(true);
    expect(dir.startsWith(join(tmpdir(), "topics-land"))).toBe(false);
  });

  test("an id is stable for the same parts and differs for others", () => {
    expect(scratchId("/repo", "b")).toBe(scratchId("/repo", "b"));
    expect(scratchId("/repo", "b")).not.toBe(scratchId("/repo", "c"));
    expect(scratchId("/repo")).toHaveLength(16);
  });
});

describe("sweepScratch", () => {
  test("removes a checkout a previous process left, and its registration", async () => {
    const { repo, root } = repoWithRoot();
    const leftover = join(scratchDir("land", root), scratchId(repo));
    git(repo, "worktree", "add", "-q", leftover, "main", "--detach");
    expect(git(repo, "worktree", "list")).toContain(leftover);

    const gone = await sweepScratch(realGit, root);

    expect(gone).toEqual([leftover]);
    expect(existsSync(leftover)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("_scratch");
  }, slackMs(30_000));

  test("touches only the three kinds without a lease, and never a project folder", async () => {
    const { repo, root } = repoWithRoot();
    const project = join(root, "some-project", "wt-1");
    git(repo, "worktree", "add", "-q", project, "-b", "topics/x");
    const nodeCheck = join(scratchDir("node-checks", root), "abcd1234");
    git(repo, "worktree", "add", "-q", nodeCheck, "--detach", "main");

    expect(await sweepScratch(realGit, root)).toEqual([]);

    expect(existsSync(project)).toBe(true);
    expect(existsSync(nodeCheck)).toBe(true);
  }, slackMs(30_000));

  test("a missing _scratch folder is no work, not an error", async () => {
    const { root } = repoWithRoot();
    expect(await sweepScratch(realGit, root)).toEqual([]);
  });
});

describe("legacyNodeCheckRoot", () => {
  test("production keeps the old $TMPDIR folder, another home gets a suffix", () => {
    const prodHome = "/h/.topics";
    expect(legacyNodeCheckRoot(prodHome, "/t", prodHome)).toBe(join("/t", "topics-node-checks"));
    expect(legacyNodeCheckRoot("/e2e/home", "/t", prodHome)).not.toBe(join("/t", "topics-node-checks"));
  });
});

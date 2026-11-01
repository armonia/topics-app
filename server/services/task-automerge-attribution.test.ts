/**
 * @covers LAND-13
 */
import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, landFallout } from "./task-automerge";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const TIMEOUT = 120_000;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, msg: string, author?: string): void {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", ...(author ? ["--author", author] : []), "-m", msg);
}

/** A repo on main with one feature branch whose single commit is `msg` by `author`. */
function repoWithBranch(msg: string, author?: string): string {
  const repo = mkdtempSync(join(tmpdir(), "land-attribution-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "owner@example.test");
  git(repo, "config", "user.name", "owner");
  commit(repo, "base.txt", "base");
  git(repo, "checkout", "-q", "-b", "topics/feature");
  commit(repo, "work.txt", msg, author);
  git(repo, "checkout", "-q", "main");
  return repo;
}

const land = (repo: string) =>
  createTaskAutoMerge({
    resolveTaskMerge: () => ({ repoPath: repo, branch: "topics/feature", defaultBranch: "main" }),
  });

describe("land attribution gate", () => {
  test("a branch with a Co-Authored-By assistant line is refused, and main is untouched", async () => {
    const repo = repoWithBranch("add work\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>");
    try {
      const before = git(repo, "rev-parse", "main");
      const res = await land(repo).tryMerge("t-1", "Feature");
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("attribution");
      expect(res.reason).toContain("Co-Authored-By");
      expect(git(repo, "rev-parse", "main")).toBe(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("a branch authored by someone other than the repo identity is refused", async () => {
    const repo = repoWithBranch("add work", "Claude <claude@example.test>");
    try {
      const res = await land(repo).tryMerge("t-2", "Feature");
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("attribution");
      expect(res.reason).toContain("autore");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("a clean branch lands", async () => {
    const repo = repoWithBranch("add work");
    try {
      const res = await land(repo).tryMerge("t-3", "Feature");
      expect(res.status).toBe("merged");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("the refusal sends the card back to the agent, never closes it", () => {
    expect(landFallout("attribution").status).toBe("in_progress");
  });
});

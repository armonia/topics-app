import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, landFallout } from "./task-automerge";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/** The land gate on commit attribution, on a real repo (card a54f26b1). */

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function repoWithBranch(branch: string, message: string, author?: string): string {
  const repo = mkdtempSync(join(tmpdir(), "land-attribution-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "owner@example.test");
  git(repo, "config", "user.name", "owner");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "switch", "-q", "-c", branch);
  writeFileSync(join(repo, "work.txt"), "work\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message, ...(author ? ["--author", author] : []));
  git(repo, "switch", "-q", "main");
  return repo;
}

const land = (repo: string, branch: string) =>
  createTaskAutoMerge({
    resolveTaskMerge: () => ({ repoPath: repo, branch, defaultBranch: "main" }),
  }).tryMerge("t1", "card", { branch, commit: git(repo, "rev-parse", branch) });

describe("land refuses Claude attribution", () => {
  test("a branch with the Co-Authored-By Claude line is refused, and the card says why", async () => {
    const repo = repoWithBranch("topics/dirty", "work\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>");
    try {
      const res = await land(repo, "topics/dirty");
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("attribution");
      expect(res.reason).toContain("Co-Authored-By");
      expect(landFallout(res.code).resume).toBeDefined();
      expect(git(repo, "rev-parse", "--verify", "main:work.txt")).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a branch authored by someone other than the repo identity is refused", async () => {
    const repo = repoWithBranch("topics/foreign", "work", "Claude <noreply@anthropic.com>");
    try {
      const res = await land(repo, "topics/foreign");
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("attribution");
      expect(res.reason).toContain("autore diverso");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a clean branch lands", async () => {
    const repo = repoWithBranch("topics/clean", "work");
    try {
      const res = await land(repo, "topics/clean");
      expect(res.status).toBe("merged");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * `foreignNotOnMain` resets its own checkout after every pick (its docblock
 * says so). Before this fix it ran directly on the LIVE main checkout
 * whenever the card branch was mixed by ancestry (`onlyOwn`), so the probe's
 * `reset --hard HEAD` wiped any uncommitted edit sitting there — including one
 * belonging to another session, never touched by the merge itself at all.
 * Real git.
 *
 * @covers LAND-04
 */
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskAutoMerge } from "./task-automerge";
import { slackMs } from "../../tests/helpers/time-slack";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BRANCH = "topics/card";
const OTHER = "other";
const WITH_REAL_GIT = slackMs(30_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function commit(cwd: string, path: string, body: string, message: string): void {
  writeFileSync(join(cwd, path), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

/**
 * `card` is built on top of `OTHER`, whose commit is genuinely not on
 * `main`: `others.length > 0` and `mine < total`, so `onlyOwn` is set and
 * the land asks `foreignNotOnMain`, which finds the foreign commit missing
 * and refuses the land (`foreign-commits`) — the probe's cherry-pick loop
 * runs and does not byPatch-skip, so its `reset --hard HEAD` is exercised.
 */
function mixedByAncestryRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "land-foreign-probe-"));
  created.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "README.md", "root\n", "root");
  commit(repo, "notes.txt", "notes v1\n", "notes v1");

  git(repo, "switch", "-q", "-c", OTHER);
  commit(repo, "shared.txt", "shared content\n", "X: shared content, genuinely foreign");

  git(repo, "switch", "-q", "-c", BRANCH, OTHER);
  commit(repo, "notes.txt", "notes v2 by the card\n", "Y: card work");

  git(repo, "switch", "-q", "main");
  return repo;
}

function landOn(repoPath: string) {
  return createTaskAutoMerge({ resolveTaskMerge: () => ({ repoPath, branch: BRANCH, defaultBranch: "main" }) });
}

describe("foreignNotOnMain never resets the live checkout", () => {
  test("unrelated modified file, untouched by the merge → the probe runs, and the file keeps its edit byte for byte", async () => {
    const repo = mixedByAncestryRepo();
    const mainBefore = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "README.md"), "another session's edit\n");

    // The genuinely foreign commit is not on main, so the land refuses it
    // (`foreign-commits`) — but only after the probe's cherry-pick loop ran
    // on an isolated worktree. With the old guard the probe ran directly on
    // this checkout, and its `reset --hard HEAD` wiped the edit below (red).
    const res = await landOn(repo).tryMerge("t-card", "Card mixed by ancestry");

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.code).toBe("foreign-commits");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("another session's edit\n");
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
  }, WITH_REAL_GIT);

  test("the modified file overlaps the merge → skipped naming it, nothing touched", async () => {
    const repo = mixedByAncestryRepo();
    const mainBefore = git(repo, "rev-parse", "main");
    // `notes.txt` is the card's OWN change, so it stays a real content
    // difference even after main's own commits get folded into the card
    // branch by the automatic realign.
    writeFileSync(join(repo, "notes.txt"), "racing edit\n");

    const res = await landOn(repo).tryMerge("t-card", "Card mixed by ancestry");

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.code).toBe("dirty-checkout");
      expect(res.reason).toContain("notes.txt");
    }
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("racing edit\n");
  }, WITH_REAL_GIT);

  test("a staged change → skipped, nothing touched", async () => {
    const repo = mixedByAncestryRepo();
    const mainBefore = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "README.md"), "staged edit\n");
    git(repo, "add", "README.md");

    const res = await landOn(repo).tryMerge("t-card", "Card mixed by ancestry");

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.code).toBe("dirty-checkout");
      expect(res.reason).toContain("README.md");
    }
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
  }, WITH_REAL_GIT);
});

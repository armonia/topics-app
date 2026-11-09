/**
 * The files an automatic land would bring to main, on a real repository.
 *
 * `listOwnCommits` drops the commit the pruning writes to save a dirty worktree
 * (`RESIDUE_SUBJECT`), but the merge brings it: the paths that decide "a person
 * must look" have to come from what the merge brings, not from the own-commit
 * count.  @covers LAND-05
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landingFiles } from "./landing-files";
import { needsAPerson } from "./auto-land";
import { RESIDUE_SUBJECT } from "./worktree-residue";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { slackMs } from "../../tests/helpers/time-slack";

const created: string[] = [];
afterEach(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });
const WITH_REAL_GIT = slackMs(30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}
function commit(cwd: string, path: string, body: string, message: string): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "branch-files-"));
  created.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "radice.txt", "r\n", "radice");
  return dir;
}

describe("landingFiles", () => {
  test("a commit gives the paths of THAT commit: what the branch gained afterwards is not in them", async () => {
    const dir = repo();
    git(dir, "switch", "-q", "-c", "topics/x");
    commit(dir, "server/lib/a.ts", "a\n", "ramo: a");
    const offered = git(dir, "rev-parse", "HEAD").trim();
    commit(dir, "server/routes/auth.ts", "x\n", "ramo: dopo");
    git(dir, "switch", "-q", "main");

    expect(await landingFiles(dir, offered)).toEqual(["server/lib/a.ts"]);
    expect((await landingFiles(dir, "topics/x"))?.sort()).toEqual(["server/lib/a.ts", "server/routes/auth.ts"]);
  }, WITH_REAL_GIT);

  test("an abbreviated commit works as the full one; a commit the repo does not have is unknown", async () => {
    const dir = repo();
    git(dir, "switch", "-q", "-c", "topics/x");
    commit(dir, "server/lib/a.ts", "a\n", "ramo: a");
    const full = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "switch", "-q", "main");

    expect(await landingFiles(dir, full.slice(0, 9))).toEqual(["server/lib/a.ts"]);
    expect(await landingFiles(dir, "0000000000000000000000000000000000000001")).toBeNull();
    expect(await landingFiles(dir, "")).toBeNull();
  }, WITH_REAL_GIT);

  test("a pruning-residue commit still shows its files: the merge carries them", async () => {
    const dir = repo();
    git(dir, "switch", "-q", "-c", "topics/x");
    commit(dir, "server/lib/a.ts", "a\n", "ramo: a");
    commit(dir, "server/routes/auth.ts", "x\n", RESIDUE_SUBJECT);
    git(dir, "switch", "-q", "main");

    const files = await landingFiles(dir, "topics/x");

    expect(files?.sort()).toEqual(["server/lib/a.ts", "server/routes/auth.ts"]);
    expect(needsAPerson(files!)).toEqual(["server/routes/auth.ts"]);
  }, WITH_REAL_GIT);

  test("a rename does not hide the path it came from or the one it went to", async () => {
    const dir = repo();
    commit(dir, "server/routes/auth.ts", "x\n", "base");
    git(dir, "switch", "-q", "-c", "topics/x");
    mkdirSync(join(dir, "server/lib"), { recursive: true });
    git(dir, "mv", "server/routes/auth.ts", "server/lib/ok.ts");
    git(dir, "commit", "-q", "-m", "rinomina");
    git(dir, "switch", "-q", "main");

    expect((await landingFiles(dir, "topics/x"))?.sort()).toEqual(["server/lib/ok.ts", "server/routes/auth.ts"]);
  }, WITH_REAL_GIT);

  test("a branch or a repo git cannot read is unknown, never empty", async () => {
    const dir = repo();
    expect(await landingFiles(dir, "topics/non-esiste")).toBeNull();
    expect(await landingFiles(join(dir, "nowhere"), "topics/x")).toBeNull();
  }, WITH_REAL_GIT);
});

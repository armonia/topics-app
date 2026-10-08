/**
 * Claude Code's memory folder for a turn's cwd, without a `git` per turn.
 *
 * `claudeMemoryDir` runs on every assembly of a topic's context, and asked
 * `git rev-parse` through `spawnSync` each time: the server's one loop stopped
 * for as long as git lived, on every turn (T16). The answer is now remembered
 * per folder and asked again in the background; a folder that becomes a repo,
 * or a worktree that is removed, shows within the expiry.
 *
 * Whether git was asked is read from the answer: the folder changes on disk
 * between two reads, and only a read that asked git sees the change. (A wrapper
 * first on PATH would count the calls, but under Bun 1.3.8 `spawnSync` does not
 * see a PATH changed by the process.)
 * @covers LOOP-SPAWN-01
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeMemoryDir, forgetGitRootsForTests, GIT_ROOT_TTL_MS, refreshGitRoots } from "./native-parity";

let scratch: string;
let home: string;

const encode = (p: string) => p.replace(/[/.]/g, "-");
const memoryOf = (root: string) => join(home, ".claude", "projects", encode(root), "memory");
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
/** A `proj/sub` folder in no repo: `proj` becomes one later. */
function plainFolder(): { dir: string; cwd: string } {
  const dir = join(mkdtempSync(join(scratch, "plain-")), "proj");
  const cwd = join(dir, "sub");
  mkdirSync(cwd, { recursive: true });
  return { dir, cwd };
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-memory-dir-")));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("claudeMemoryDir, remembered per folder", () => {
  beforeEach(() => {
    forgetGitRootsForTests();
    home = mkdtempSync(join(scratch, "home-"));
  });

  afterEach(() => {
    setSystemTime();
    forgetGitRootsForTests();
  });

  test("a folder read again within the expiry does not ask git again", () => {
    const { dir, cwd } = plainFolder();
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
    git("init", "-q", dir);
    // git would now answer `dir`: the memo answered.
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
  });

  test("a folder that becomes a repo shows after the background pass", async () => {
    const { dir, cwd } = plainFolder();
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
    git("init", "-q", dir);
    await refreshGitRoots();
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(dir));
  });

  test("a removed worktree shows after the background pass", async () => {
    const repo = mkdtempSync(join(scratch, "repo-"));
    git("init", "-q", repo);
    git("-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    const wt = join(scratch, `wt-${Date.now()}`);
    git("-C", repo, "worktree", "add", "-q", wt);
    expect(claudeMemoryDir(wt, home)).toBe(memoryOf(repo));
    git("-C", repo, "worktree", "remove", wt);
    await refreshGitRoots();
    expect(claudeMemoryDir(wt, home)).toBe(memoryOf(wt));
  });

  test("past the expiry, with no background pass, the turn asks git again", () => {
    const { dir, cwd } = plainFolder();
    const now = Date.now();
    setSystemTime(new Date(now));
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
    git("init", "-q", dir);
    setSystemTime(new Date(now + GIT_ROOT_TTL_MS - 1));
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
    setSystemTime(new Date(now + GIT_ROOT_TTL_MS));
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(dir));
  });
});

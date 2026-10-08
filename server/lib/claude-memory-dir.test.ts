/**
 * Claude Code's memory folder for a turn's cwd, without a `git` per turn.
 *
 * `claudeMemoryDir` runs on every assembly of a topic's context, and asked
 * `git rev-parse` through `spawnSync` each time: the server's one loop stopped
 * for as long as git lived, on every turn (T16). The answer is now remembered
 * per folder and asked again in the background; a folder that becomes a repo,
 * or a worktree that is removed, shows within the expiry.
 *
 * `git` is wrapped by a script first on PATH that counts its calls.
 * @covers LOOP-SPAWN-01
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, setSystemTime } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeMemoryDir, forgetGitRootsForTests, GIT_ROOT_TTL_MS, GIT_ROOT_IDLE_MS, refreshGitRoots } from "./native-parity";

const PATH_BEFORE = process.env.PATH;
const REAL_GIT = Bun.which("git")!;
let scratch: string;
let callsLog: string;
let home: string;

const encode = (p: string) => p.replace(/[/.]/g, "-");
const memoryOf = (root: string) => join(home, ".claude", "projects", encode(root), "memory");
const gitCalls = () => { try { return readFileSync(callsLog, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const git = (...args: string[]) => {
  const r = spawnSync(REAL_GIT, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-memory-dir-")));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  callsLog = join(scratch, "git-calls.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> "${callsLog}"\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${PATH_BEFORE}`;
});

afterAll(() => {
  process.env.PATH = PATH_BEFORE;
  rmSync(scratch, { recursive: true, force: true });
});

describe("claudeMemoryDir, remembered per folder", () => {
  beforeEach(() => {
    forgetGitRootsForTests();
    home = mkdtempSync(join(scratch, "home-"));
    rmSync(callsLog, { force: true });
  });

  afterEach(() => {
    setSystemTime();
    forgetGitRootsForTests();
  });

  test("a folder read again within the expiry does not ask git again", () => {
    const repo = mkdtempSync(join(scratch, "repo-"));
    git("init", "-q", repo);
    mkdirSync(join(repo, "sub"));
    expect(claudeMemoryDir(join(repo, "sub"), home)).toBe(memoryOf(repo));
    expect(gitCalls()).toBe(1);
    expect(claudeMemoryDir(join(repo, "sub"), home)).toBe(memoryOf(repo));
    expect(claudeMemoryDir(join(repo, "sub"), home)).toBe(memoryOf(repo));
    expect(gitCalls()).toBe(1);
  });

  test("a folder that becomes a repo shows after the background pass", async () => {
    const parent = mkdtempSync(join(scratch, "plain-"));
    const dir = join(parent, "proj");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const cwd = join(dir, "sub");
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
    const parent = mkdtempSync(join(scratch, "plain-"));
    const dir = join(parent, "proj");
    const cwd = join(dir, "sub");
    mkdirSync(cwd, { recursive: true });
    const now = Date.now();
    setSystemTime(new Date(now));
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
    git("init", "-q", dir);
    setSystemTime(new Date(now + GIT_ROOT_TTL_MS - 1));
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(cwd));
    setSystemTime(new Date(now + GIT_ROOT_TTL_MS));
    expect(claudeMemoryDir(cwd, home)).toBe(memoryOf(dir));
    expect(gitCalls()).toBe(2);
  });

  test("the background pass forgets a folder nobody read for a while", async () => {
    const dir = mkdtempSync(join(scratch, "plain-"));
    const now = Date.now();
    setSystemTime(new Date(now));
    claudeMemoryDir(dir, home);
    setSystemTime(new Date(now + GIT_ROOT_IDLE_MS + 1));
    rmSync(callsLog, { force: true });
    await refreshGitRoots();
    expect(gitCalls()).toBe(0);
  });
});

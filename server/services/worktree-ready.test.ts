import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assignWorktreePorts, copyWorktreeIncludes, runWorktreeCommand } from "./worktree-ready";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/**
 * Included files, setup outcome and ports of a new worktree.
 *
 * @covers WORKTREE-15
 */

const roots: string[] = [];
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "worktree-ready-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

describe("worktree readiness", () => {
  test("copies selected ignored files, skips tracked files and keeps symlinks out", async () => {
    const root = tempDir();
    const project = join(root, "project");
    const target = join(root, "target");
    mkdirSync(project);
    mkdirSync(target);
    git(root, "init", "--quiet", project);
    git(project, "config", "user.email", "test@example.invalid");
    git(project, "config", "user.name", "Test");
    writeFileSync(join(project, ".gitignore"), ".env*\n");
    writeFileSync(join(project, ".worktreeinclude"), ".env*\n");
    writeFileSync(join(project, ".env"), "KEY=local\n");
    writeFileSync(join(project, ".env.tracked"), "tracked\n");
    writeFileSync(join(project, "tracked.txt"), "tracked\n");
    const outside = join(root, "outside.env");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(project, ".env-link"));
    git(project, "add", ".gitignore", ".worktreeinclude", "tracked.txt");
    git(project, "add", "-f", ".env.tracked");
    git(project, "commit", "--quiet", "-m", "base");

    const result = await copyWorktreeIncludes(project, target);
    expect(result.copied).toContain(".env");
    expect(existsSync(join(target, ".env"))).toBe(true);
    expect(existsSync(join(target, "tracked.txt"))).toBe(false);
    expect(existsSync(join(target, ".env.tracked"))).toBe(false);
    expect(existsSync(join(target, ".env-link"))).toBe(false);
    expect(result.skipped).toContain(".env-link: symlink fuori dalla radice");
  });

  test("rejects parent traversal patterns without copying anything", async () => {
    const root = tempDir();
    const project = join(root, "project");
    const target = join(root, "target");
    mkdirSync(project);
    mkdirSync(target);
    writeFileSync(join(project, ".worktreeinclude"), "../outside.env\n");
    writeFileSync(join(root, "outside.env"), "secret\n");
    expect((await copyWorktreeIncludes(project, target)).copied).toEqual([]);
    expect(existsSync(join(target, "outside.env"))).toBe(false);
  });

  test("assigns repeatable distinct ports to two worktrees", () => {
    const paths = ["/tmp/project/first", "/tmp/project/second"];
    const first = assignWorktreePorts(paths);
    const restarted = assignWorktreePorts([...paths]);
    expect(first.get(paths[0])).toBe(restarted.get(paths[0]));
    expect(first.get(paths[1])).toBe(restarted.get(paths[1]));
    expect(first.get(paths[0])).not.toBe(first.get(paths[1]));
  });

  test("a newcomer whose hash collides never moves the port of an older worktree", () => {
    // Two paths with the same natural port, the newcomer sorting before the older one: ordering
    // by path would hand the newcomer the port the older worktree's server already holds.
    const byPort = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let index = 0; !pair && index < 20_000; index++) {
      const path = `/tmp/project/wt-${index}`;
      const port = assignWorktreePorts([path]).get(path)!;
      const other = byPort.get(port);
      if (other) pair = path < other ? [other, path] : [path, other];
      else byPort.set(port, path);
    }
    expect(pair).not.toBeNull();
    const [older, newcomer] = pair!;
    const before = assignWorktreePorts([older]).get(older);
    const after = assignWorktreePorts([older, newcomer]);
    expect(after.get(older)).toBe(before);
    expect(after.get(newcomer)).not.toBe(before);
  });

  test("reports failed and timed out setup with the last output lines", async () => {
    const cwd = tempDir();
    const failed = await runWorktreeCommand(cwd, {
      command: "/bin/sh", args: ["-c", "printf 'start\\nlast-line\\n'; exit 7"],
    }, 23456);
    expect(failed).toMatchObject({ status: "failed", exitCode: 7 });
    expect(failed.output).toContain("last-line");

    const timedOut = await runWorktreeCommand(cwd, {
      command: "/bin/sh", args: ["-c", "printf 'setup-started\\n'; exec /bin/sleep 5"], timeoutMs: 50,
    }, 23456);
    expect(timedOut.status).toBe("timed-out");
    expect(timedOut.output).toContain("setup-started");

    const port = await runWorktreeCommand(cwd, {
      command: "/bin/sh", args: ["-c", "printf '%s' \"$TOPICS_PORT\""],
    }, 23457);
    expect(port.output.join(" ")).toBe("23457");
  });
});

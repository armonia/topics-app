/**
 * The inspector behind the scheduled review (`scheduled-review.ts`): one
 * throwaway checkout of the delivered commit, main merged in memory with
 * `git merge-tree`, and the test files the delivery touched, each run alone.
 * The checkout lives in the scratch folder of the node checks and is removed
 * before the answer, whatever it is.
 */
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runBounded, SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";
import type { InspectionReport, TestFailure } from "./scheduled-review";
import { ensureScratchDir } from "./worktree-scratch";

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
/** E2E specs need a browser, which a scheduled pass never launches. */
const E2E_FOLDER = /(^|\/)e2e\//;
const TEST_RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_TEST_FILES = 12;

/** Names of the failed tests in a `bun test` log: its `(fail) name` lines. */
export function failedTestNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

/** The conflicting files `git merge-tree --write-tree --name-only` lists after the tree line. */
export function conflictedFiles(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const blank = lines.indexOf("");
  return (blank < 0 ? [] : lines.slice(1, blank)).filter(Boolean);
}

export async function inspectDelivery(repoPath: string, taskId: string, commit: string, files: readonly string[]): Promise<InspectionReport> {
  const git = (cwd: string, args: string[], timeoutMs: number = SPAWN_TIMEOUT.query) => runGit(cwd, args, { timeoutMs });
  // A fetch that fails inspects against the main this machine has: stale, never wrong.
  await git(repoPath, ["fetch", "--quiet", "origin", "main"], SPAWN_TIMEOUT.write);
  const merge = await git(repoPath, ["merge-tree", "--write-tree", "--name-only", "origin/main", commit]);
  if (merge.code === 1) return { kind: "conflict", files: conflictedFiles(merge.stdout) };
  if (merge.code !== 0) return { kind: "unmeasured", why: `merge-tree: ${merge.stderr.trim().slice(0, 200)}` };

  const tests = files.filter((f) => TEST_FILE.test(f) && !E2E_FOLDER.test(f)).slice(0, MAX_TEST_FILES);
  if (tests.length === 0) return { kind: "green", tested: [] };

  const dir = join(ensureScratchDir("node-checks"), `review-${taskId.slice(0, 8)}`);
  try {
    const add = await git(repoPath, ["worktree", "add", "--detach", dir, commit], SPAWN_TIMEOUT.long);
    if (add.code !== 0) return { kind: "unmeasured", why: `worktree add: ${add.stderr.trim().slice(0, 200)}` };
    // The checkout has no installed packages of its own: the repository's are reused.
    const modules = join(repoPath, "node_modules");
    if (existsSync(modules) && !existsSync(join(dir, "node_modules"))) symlinkSync(modules, join(dir, "node_modules"), "junction");
    const failures: TestFailure[] = [];
    for (const file of tests) {
      if (!existsSync(join(dir, file))) continue; // deleted by the delivery
      const run = await runBounded(["bun", "test", file], { cwd: dir, stderr: "pipe", timeoutMs: TEST_RUN_TIMEOUT_MS });
      if (run.spawnFailed) return { kind: "unmeasured", why: `bun test: ${run.spawnError ?? "did not start"}` };
      if (run.timedOut) return { kind: "unmeasured", why: `bun test ${file}: timeout` };
      if (run.exitCode !== 0) {
        const names = failedTestNames(`${run.stdout}\n${run.stderr}`);
        if (names.length === 0) failures.push({ file });
        else for (const test of names.slice(0, 3)) failures.push({ file, test });
      }
    }
    return failures.length > 0 ? { kind: "red", failures } : { kind: "green", tested: tests };
  } finally {
    await git(repoPath, ["worktree", "remove", "--force", dir], SPAWN_TIMEOUT.long);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the scratch sweep takes it */ }
  }
}

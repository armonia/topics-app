/** @covers D3D-01 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { loadNativeModule, type NativeGitStatus, type NativeModule } from "./native-addon";
import { serverSpawnCounts } from "./spawn-metrics";
import { computeGitStatus, parseBranchHeader, splitBranchHeader } from "./git-status";
import { parsePorcelainZ } from "./git-porcelain";
import { nativeGitStatusEnabled, nativeGitStatusSnapshot, setNativeGitStatusTestOverrides } from "./native-git-status";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv() });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function makeRepo(root: string, scenario: "clean" | "subfolder" | "detached"): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture Author");
  git(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "README.md"), "fixture\n");
  if (scenario === "subfolder") {
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "packages", "app", "tracked.txt"), "before\n");
  }
  git(root, "add", "-A");
  Bun.spawnSync(["git", "-C", root, "commit", "-qm", "fixture"], {
    env: { ...gitEnv(), GIT_AUTHOR_DATE: "@946684800 +0000", GIT_COMMITTER_DATE: "@946684800 +0000" },
  });
  if (scenario === "subfolder") writeFileSync(join(root, "packages", "app", "tracked.txt"), "after\n");
  if (scenario === "detached") git(root, "checkout", "-q", "--detach", "HEAD");
  return scenario === "subfolder" ? join(root, "packages", "app") : root;
}

function nativeFixture(): NativeModule {
  return {
    nativeVersion: () => "test",
    gitHeadCommitId: () => null,
    async gitStatus(repoPath): Promise<NativeGitStatus | null> {
      const root = git(repoPath, "rev-parse", "--show-toplevel").trim();
      const statusText = git(root, "status", "--porcelain", "-z", "--branch");
      const { header, entries } = splitBranchHeader(statusText);
      const branchInfo = header ? parseBranchHeader(header) : { branch: null, ahead: 0, behind: 0 };
      const log = git(root, "log", "-1", "--format=%h%x09%H%x09%s%x09%an%x09%at").trim().split("\t");
      return {
        root,
        branch: branchInfo.branch,
        ahead: branchInfo.ahead,
        behind: branchInfo.behind,
        entries: parsePorcelainZ(entries),
        lastCommit: { short: log[0], hash: log[1], subject: log[2], author: log[3], time: Number(log[4]) },
      };
    },
  };
}

function gitSpawnTotal(): number {
  return Object.values(serverSpawnCounts().counts.gitStatus).reduce((sum, count) => sum + count, 0);
}

test("computeGitStatus uses native status for three repository shapes and retains Git fallback", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "git-status-native-"));
  try {
    for (const scenario of ["clean", "subfolder", "detached"] as const) {
      const resolvedDir = makeRepo(join(scratch, scenario), scenario);
      setNativeGitStatusTestOverrides({ enabled: false });
      let before = gitSpawnTotal();
      const expected = await computeGitStatus(resolvedDir, { cause: "cacheMiss" });
      expect(gitSpawnTotal() - before).toBe(5);

      setNativeGitStatusTestOverrides({ enabled: true, module: nativeFixture() });
      before = gitSpawnTotal();
      const actual = await computeGitStatus(resolvedDir, { cause: "cacheMiss" });
      expect(actual).toEqual(expected);
      expect(gitSpawnTotal() - before).toBe(2);
      expect(nativeGitStatusSnapshot()).toMatchObject({ loaded: true, enabled: true, calls: 1, fallbacks: 0 });
    }

    const failurePath = makeRepo(join(scratch, "rejected"), "clean");
    const rejecting: NativeModule = {
      nativeVersion: () => "test",
      gitHeadCommitId: () => null,
      gitStatus: async () => { throw new Error("fixture rejection"); },
    };
    setNativeGitStatusTestOverrides({ enabled: true, module: rejecting });
    let before = gitSpawnTotal();
    const rejected = await computeGitStatus(failurePath, { cause: "cacheMiss" });
    expect(rejected).not.toBeNull();
    expect(gitSpawnTotal() - before).toBe(5);
    expect(nativeGitStatusSnapshot()).toMatchObject({ calls: 1, fallbacks: 1, lastError: "fixture rejection" });

    const missingPath = makeRepo(join(scratch, "missing"), "clean");
    setNativeGitStatusTestOverrides({ enabled: true, module: null });
    before = gitSpawnTotal();
    expect(await computeGitStatus(missingPath, { cause: "cacheMiss" })).not.toBeNull();
    expect(gitSpawnTotal() - before).toBe(5);
    expect(nativeGitStatusSnapshot()).toMatchObject({ loaded: false, calls: 0, fallbacks: 1 });

    const disabledPath = makeRepo(join(scratch, "disabled"), "clean");
    setNativeGitStatusTestOverrides({ enabled: false, module: nativeFixture() });
    before = gitSpawnTotal();
    const disabled = await computeGitStatus(disabledPath, { cause: "cacheMiss" });
    expect(disabled).not.toBeNull();
    expect(gitSpawnTotal() - before).toBe(5);
    expect(nativeGitStatusSnapshot()).toMatchObject({ enabled: false, calls: 0, fallbacks: 0 });
  } finally {
    setNativeGitStatusTestOverrides(null);
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Skipped, and said so, where the addon is not built: the CI job that builds it
// (`tauri` in ci.yml) runs this file next to native/parity.test.ts.
const nativeModuleBuilt = Bun.file(join(import.meta.dir, "../../native/topics_native.node")).size > 0;
test.skipIf(!nativeModuleBuilt)("the built addon returns the same status as git for the three repository shapes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "git-status-native-real-"));
  try {
    const native = loadNativeModule();
    expect(native?.gitStatus).toBeFunction();
    for (const shape of ["clean", "subfolder", "detached"] as const) {
      const path = makeRepo(join(scratch, shape), shape);
      setNativeGitStatusTestOverrides({ enabled: false });
      const expected = await computeGitStatus(path, { cause: "cacheMiss" });
      setNativeGitStatusTestOverrides({ enabled: true, module: native });
      expect(await computeGitStatus(path, { cause: "cacheMiss" })).toEqual(expected);
    }
  } finally {
    setNativeGitStatusTestOverrides(null);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the native Git switch reads the server-synced settings row and defaults on", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)");
    expect(nativeGitStatusEnabled(db)).toBe(true);
    db.query("INSERT INTO ui_state (key, value) VALUES ('settings', ?)").run(JSON.stringify({ nativeGitStatusEnabled: false }));
    expect(nativeGitStatusEnabled(db)).toBe(false);
    db.query("UPDATE ui_state SET value = ? WHERE key = 'settings'").run("not-json");
    expect(nativeGitStatusEnabled(db)).toBe(true);
  } finally {
    db.close();
  }
});

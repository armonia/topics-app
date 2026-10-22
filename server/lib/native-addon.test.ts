import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { loadNativeModuleAt } from "./native-addon";

/** @covers D3B-01 */
test("native addon is optional when its file is missing", () => {
  expect(loadNativeModuleAt(resolve(import.meta.dir, "../../native/missing-addon.node"))).toBeNull();
});

/** @covers D3B-01 */
test("native addon resolves HEAD and git status when a build is present", async () => {
  const modulePath = resolve(import.meta.dir, "../../native/topics_native.node");
  if (!Bun.file(modulePath).size) {
    console.log("SKIP native addon integration: build-native-addon.sh has not run");
    return;
  }

  const nativeModule = loadNativeModuleAt(modulePath);
  expect(nativeModule).not.toBeNull();
  expect(nativeModule?.nativeVersion()).toBe("0.1.0");
  expect(typeof nativeModule?.gitStatus).toBe("function");
  const scratch = mkdtempSync(resolve(tmpdir(), "native-addon-test-"));
  const notRepo = resolve(scratch, "not-repo");
  try {
    const linkedRepo = resolve(scratch, "repo");
    const linkedWorktree = resolve(scratch, "linked-worktree");
    mkdirSync(linkedRepo);
    expect(Bun.spawnSync(["git", "init", "-q", linkedRepo], { env: gitEnv() }).exitCode).toBe(0);
    writeFileSync(resolve(linkedRepo, "README.md"), "fixture\n");
    expect(Bun.spawnSync(["git", "-C", linkedRepo, "add", "README.md"], { env: gitEnv() }).exitCode).toBe(0);
    expect(Bun.spawnSync([
      "git", "-C", linkedRepo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-qm", "fixture",
    ], { env: gitEnv() }).exitCode).toBe(0);
    const expected = Bun.spawnSync(["git", "-C", linkedRepo, "rev-parse", "HEAD"], { env: gitEnv() }).stdout.toString().trim();
    expect(nativeModule?.gitHeadCommitId(linkedRepo)).toBe(expected);
    const status = await nativeModule?.gitStatus?.(linkedRepo);
    const expectedRoot = Bun.spawnSync(["git", "-C", linkedRepo, "rev-parse", "--show-toplevel"], { env: gitEnv() }).stdout.toString().trim();
    expect(status?.root).toBe(expectedRoot);
    expect(status?.entries).toEqual([]);
    const worktree = Bun.spawnSync(["git", "-C", linkedRepo, "worktree", "add", "--detach", linkedWorktree, "HEAD"], { env: gitEnv() });
    expect(worktree.exitCode).toBe(0);
    expect(nativeModule?.gitHeadCommitId(linkedWorktree)).toBe(expected);
    mkdirSync(notRepo);
    expect(nativeModule?.gitHeadCommitId(notRepo)).toBeNull();
    expect(await nativeModule?.gitStatus?.(notRepo)).toBeNull();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * @covers KANBAN-15
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { isMacOnlyDiff } from "./review-checks";

describe("isMacOnlyDiff: which diffs the CI's verdict cannot cover", () => {
  let cwd = "";

  function git(...args: string[]): void {
    Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
  }

  function repoWithDiff(files: readonly string[]): void {
    cwd = mkdtempSync(join(tmpdir(), "mac-only-diff-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(cwd, "base.txt"), "base");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    for (const f of files) {
      const abs = join(cwd, f);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "change");
    }
    git("add", "-A");
    git("commit", "-q", "-m", "feature");
  }

  afterEach(() => { if (cwd) rmSync(cwd, { recursive: true, force: true }); });

  test("every changed path is macOS-only: true", () => {
    repoWithDiff(["desktop-tauri/src-tauri/main.rs"]);
    expect(isMacOnlyDiff(cwd)).toBe(true);
  });

  test("the diff touches ordinary server code: false", () => {
    repoWithDiff(["server/routes/tasks.ts"]);
    expect(isMacOnlyDiff(cwd)).toBe(false);
  });

  test("a mix of macOS-only and ordinary paths: false, the CI does cover part of it", () => {
    repoWithDiff(["desktop-tauri/src-tauri/main.rs", "server/routes/tasks.ts"]);
    expect(isMacOnlyDiff(cwd)).toBe(false);
  });

  test("an empty diff: false, nothing to go on means an ordinary diff may apply the swap fallback", () => {
    repoWithDiff([]);
    expect(isMacOnlyDiff(cwd)).toBe(false);
  });
});

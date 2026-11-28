/**
 * The install in a fresh worktree has a ceiling: a hung one must not hold the repo's land chain.
 * @covers LAND-13
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installWorktreeDeps } from "./worktree-install-deps";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

test("an install that cannot finish within the ceiling is killed and reported as timed out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-deps-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  const res = await installWorktreeDeps(dir, 1);
  expect(res.timedOut).toBe(true);
  expect(res.ok).toBe(0);
});

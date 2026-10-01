/** @covers GATE-09 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LINT_TARGET_PATHS, lintCachePath } from "./lint";

test("lint cache is separate by checkout and target, and changes with dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-cache-test-"));
  try {
    const roots = [join(dir, "first"), join(dir, "second")];
    for (const root of roots) {
      mkdirSync(join(root, "client"), { recursive: true });
      for (const file of ["bun.lock", "client/bun.lock"]) {
        writeFileSync(join(root, file), "original");
      }
    }
    const first = lintCachePath(roots[0]!, "client");
    expect(first).toBe(lintCachePath(roots[0]!, "client"));
    expect(first).not.toBe(lintCachePath(roots[1]!, "client"));
    expect(first).not.toBe(lintCachePath(roots[0]!, "relay"));
    expect(first).toContain(".cache/checks/");
    for (const file of ["bun.lock", "client/bun.lock"]) {
      writeFileSync(join(roots[0]!, file), "updated");
      expect(first).not.toBe(lintCachePath(roots[0]!, "client"));
      writeFileSync(join(roots[0]!, file), "original");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the root lint gate runs the server target over server/, shared/ and server.ts", () => {
  // A merge that drops one link of this chain leaves CI green and the server
  // unlinted, with nothing to show for it.
  const scripts = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).scripts as Record<string, string>;
  expect(scripts.lint).toContain("bun run lint:server");
  expect(scripts["lint:server"]).toBe("bun run scripts/lint.ts server");
  expect(LINT_TARGET_PATHS.server).toEqual(["server", "shared", "server.ts"]);
});

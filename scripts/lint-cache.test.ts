/** @covers GATE-09 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintCachePath } from "./lint";

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

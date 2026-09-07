/**
 * The land runs the REPO's package manager, not the one Topics is built with.
 *
 * `bun run build:client` and `bun run <script>` were hardcoded: an installed
 * Topics.app landing a card on a machine without `bun` on PATH failed inside
 * `Bun.spawn` and the card read "build failed" with no hint that the tool was
 * missing. Now the argv comes from the repo's lockfile, and a missing manager
 * is a failed `GitRunResult` whose stderr names it, on the channel the land
 * already reports.
 *
 * Read from the source, like the worktree deps gate: the spawn sits inside a
 * private function with a five-minute kill switch, and exercising it for real
 * would build the client.
 *
 * @covers LAND-10
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dir, "task-automerge.ts"), "utf8");

function body(name: string): string {
  const i = SRC.indexOf(`function ${name}(`);
  expect(i, `${name} was renamed: update this test`).toBeGreaterThan(0);
  const end = SRC.indexOf("\n}\n", i);
  expect(end).toBeGreaterThan(i);
  return SRC.slice(i, end);
}

describe("the land spawns the repo's package manager", () => {
  test("no `bun` literal reaches a spawn", () => {
    expect(SRC).not.toContain('Bun.spawn(["bun"');
    expect(SRC).not.toContain('"bun", "run"');
  });

  test("the build goes through the same runner as the baseline scripts", () => {
    expect(body("defaultRunBuild")).toContain('runRepoScript(cwd, ["build:client"])');
  });

  test("the runner resolves the argv from the repo and keeps the kill switch", () => {
    const b = body("runRepoScript");
    expect(b).toContain("Bun.spawn(runScriptArgv(cwd, args)");
    expect(b).toContain("BUILD_TIMEOUT_MS");
    expect(b).toContain("proc.kill()");
  });

  test("a missing manager is a failed result whose stderr names it, before any spawn", () => {
    const b = body("runRepoScript");
    const check = b.indexOf("missingPackageManager(cwd)");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(b.indexOf("Bun.spawn("));
    expect(b).toContain("return { code: 1, stdout: \"\", stderr: missing }");
  });
});

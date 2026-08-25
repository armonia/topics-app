/**
 * Phase H · CLI smoke test — argv parsing, --help, missing-state behaviour.
 *
 * The full CLI run requires a live daemon; this test exercises the
 * command surface against a synthesised state file and a missing one.
  * @covers CLI-01
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { testTmpDir } from "./helpers";

const TEST_HOME = testTmpDir("phase-h-cli");
const CLI = join(import.meta.dir, "..", "..", "cli", "topics.ts");

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bun", ["run", CLI, ...args], {
    env: {
      ...process.env,
      TOPICS_HOME: TEST_HOME,
      ...extraEnv,
    },
    encoding: "utf-8",
    timeout: 5000,
  });
}

beforeEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
});
afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("Phase H · topics CLI", () => {

  test("--help prints usage", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: topics");
    expect(result.stdout).toContain("open [path]");
    expect(result.stdout).toContain("daemon status");
    expect(result.stdout).toContain("kill");
  });

  test("unknown command exits 2", () => {
    const result = runCli(["frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  test("auth status reports 'daemon not running' when state file is missing", () => {
    const result = runCli(["auth", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("daemon not running");
  });

  test("daemon status falls back to SIGTERM hint when state file is missing", () => {
    const result = runCli(["daemon", "stop"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to stop");
  });

  test("kill alias invokes daemon stop semantics", () => {
    const result = runCli(["kill"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to stop");
  });

  test("auth status with stale state file (no live daemon) → unreachable", () => {
    fs.writeFileSync(
      join(TEST_HOME, "daemon-state.json"),
      JSON.stringify({
        pid: 999_999,           // virtually-guaranteed dead
        port: 65_500,           // unlikely-bound port
        token: "a".repeat(64),
        startedAt: new Date().toISOString(),
      }),
    );
    const result = runCli(["auth", "status"]);
    expect(result.status).toBe(0);
    // Either "state file present but daemon unreachable" or
    // "state file present but unreachable (...)" — both branches are correct.
    expect(result.stdout).toMatch(/unreachable/);
  });

  test("open with non-existent path fails with helpful error", () => {
    const result = runCli(["open", "/non/existent/path"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("path does not exist");
  });

  test("auth login with TOPICS_DASHBOARD_URL prints the open command target", () => {
    const result = runCli(["auth", "login"], {
      TOPICS_DASHBOARD_URL: "http://example.test",
      TOPICS_NO_OPEN: "1", // don't spawn a real browser tab during tests
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("http://example.test");
  });

  test("auth logout removes ~/.topics/cli.json (idempotent)", () => {
    fs.writeFileSync(join(TEST_HOME, "cli.json"), "{}");
    const result = runCli(["auth", "logout"]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(join(TEST_HOME, "cli.json"))).toBe(false);
    // Second run is a no-op.
    const second = runCli(["auth", "logout"]);
    expect(second.status).toBe(0);
  });
});

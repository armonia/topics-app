/**
 * The end-of-run check for ai-bridge daemons, proven on the real runner.
 *
 * @covers GATE-01
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_HELD_ENV } from "./gate-slot.ts";
import { TEST_RUN_ENV, aiBridgesOfRun, newTestRunId, stopOwnAiBridges } from "./stray-ai-bridges.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = "./scripts/stray-ai-bridges.leaves-daemon.fixture.ts";

function runSuite(extraEnv: Record<string, string>) {
  const run = spawnSync(process.execPath, ["scripts/test-unit-serial.ts", FIXTURE], {
    cwd: ROOT,
    encoding: "utf8",
    // Already inside this run's slot: the inner `bun test` must not queue for another.
    env: { ...process.env, [GATE_HELD_ENV]: "stray-ai-bridges.test", ...extraEnv },
  });
  return { code: run.status, stderr: run.stderr };
}

describe("the check at the end of a unit run", () => {
  test("a run whose test leaves a daemon alive is red and names it, even with every test green", () => {
    const { code, stderr } = runSuite({});
    expect(stderr).toContain("1 ai-bridge daemon(s) started by this run are still alive");
    expect(stderr).toMatch(/pid \d+ {2}socket \S*stray-fixture-\S*ai-bridge\.sock/);
    expect(code).toBe(1);
  }, 60_000);

  test("the same run is green when the test stops its daemon", () => {
    const { code, stderr } = runSuite({ STRAY_FIXTURE_STOP: "1" });
    expect(stderr).not.toContain("still alive");
    expect(code).toBe(0);
  }, 60_000);
});

describe("which daemons belong to a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "stray-owner-"));
  const socket = join(dir, "ai-bridge.sock");
  const runId = newTestRunId();
  let pid = 0;
  afterAll(() => { if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } });

  test("only the daemons carrying the run's own marker, never another run's or production's", async () => {
    const daemon = spawn(
      process.execPath,
      [join(ROOT, "server", "ai-bridge.mjs"), "--socket", socket, "--store-dir", join(dir, "store")],
      { detached: true, stdio: "ignore", env: { ...process.env, [TEST_RUN_ENV]: runId } },
    );
    daemon.unref();
    pid = daemon.pid ?? 0;
    for (let i = 0; i < 200 && !existsSync(socket); i++) await Bun.sleep(50);

    expect(aiBridgesOfRun(runId)).toEqual([{ pid, socket }]);
    // A prefix of the id is another run, not this one.
    expect(aiBridgesOfRun(runId.slice(0, -1))).toEqual([]);
    expect(aiBridgesOfRun(newTestRunId())).toEqual([]);
    // No id at all matches nothing, rather than every daemon on the machine.
    expect(aiBridgesOfRun("")).toEqual([]);
  }, 30_000);
});

describe("a test stops only the daemons it started", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const daemonScript = join(ROOT, "server", "ai-bridge.mjs");

  test("a daemon whose stale --parent-pid now names this process is left alone", async () => {
    // Production's daemon carries the pid of the server that spawned it, dead
    // since a restart (53082 carries 62481 on 25/09), and macOS hands pids out
    // again: the day a `bun test` gets that pid, its afterAll must not end
    // production. The decoy is started by a shell that exits, so, like
    // production, its parent is launchd and only its argv names us.
    const dir = mkdtempSync(join(tmpdir(), "stray-decoy-"));
    const env: Record<string, string | undefined> = { ...process.env };
    delete env[TEST_RUN_ENV];
    spawnSync("/bin/sh", ["-c", `nohup '${process.execPath}' '${daemonScript}' --socket '${dir}/d.sock' --store-dir '${dir}/store' --parent-pid ${process.pid} >/dev/null 2>&1 &`], { env });
    for (let i = 0; i < 100 && !existsSync(join(dir, "d.sock")); i++) await Bun.sleep(100);
    const row = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
      .split("\n").find((l) => l.includes(`--socket ${dir}/d.sock`));
    const [pid, ppid] = (row ?? "").trim().split(/\s+/).map(Number);
    try {
      expect(ppid, "the decoy must not be our child, or it proves nothing").not.toBe(process.pid);
      await stopOwnAiBridges();
      expect(alive(pid!)).toBe(true);
    } finally {
      try { process.kill(pid!, "SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a daemon this process did start is still stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stray-own-"));
    const daemon = Bun.spawn([process.execPath, daemonScript, "--socket", join(dir, "o.sock"), "--store-dir", join(dir, "store"), "--parent-pid", String(process.pid)],
      { stdout: "ignore", stderr: "ignore" });
    try {
      for (let i = 0; i < 100 && !existsSync(join(dir, "o.sock")); i++) await Bun.sleep(100);
      await stopOwnAiBridges();
      expect(alive(daemon.pid)).toBe(false);
    } finally {
      try { daemon.kill("SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

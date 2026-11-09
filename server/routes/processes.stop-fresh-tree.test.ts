/**
 * Stop on a process Topics did not spawn (an agent's background shell, a
 * detected dev server) must reach a child born a moment ago.
 *
 * The process table is cached for 2 s for the detector. The Stop path read
 * that cache, so a worker forked inside the window (a server stopped while it
 * is still bringing up its workers) got no signal and kept its port. Real
 * processes: an "agent CLI" with a background shell under it; the shell forks
 * its child only after the cache has been filled.
 * @covers BGSHELL-02
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const STATE = mkdtempSync(join(tmpdir(), "topics-stop-fresh-state-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { createProcessesRouter, getScriptsSnapshot, listBackgroundShells, registerBackgroundShell, startProcessDetection, stopProcessDetectionForTests } = await import("./processes");
const { setSessionCliPid } = await import("../providers/session-pids");
const { getDescendantPids, killProcessTree } = await import("../lib/process-tree");

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "topics-stop-fresh-")));
const spawned: number[] = [];
// Paths handed to bash use forward slashes: backslashes are escapes there, so a
// Windows path made the wait loop spin forever on a file that never appears.
const bashPath = (p: string) => p.replaceAll("\\", "/");

afterAll(async () => {
  // The loop this file started is module state: left running, it closed the
  // ownerless background shells of the files after it (processes.shell-file).
  stopProcessDetectionForTests();
  // Kill whole trees: the outer bash dying alone leaves its children running on
  // Windows. There the MSYS pids of `ps` do not match Windows pids, so the tree
  // goes through taskkill, which follows the real parentage.
  for (const pid of spawned) {
    try {
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      else await killProcessTree(pid, 0);
    } catch { /* gone */ }
  }
  for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(STATE, { recursive: true, force: true });
  rmSync(DIR, { recursive: true, force: true });
});

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(25);
}

// On Windows the MSYS bash pids are not the ones the process scan sees, so the
// shell is never detected there; afterAll still reaps the tree if it runs.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("Stop on an agent's background shell", () => {
  test("signals a child forked after the process table was cached", async () => {
    const go = bashPath(join(DIR, "go"));
    const childPidFile = bashPath(join(DIR, "child.pid"));
    // The shell waits for the go-ahead, then forks its long-lived child.
    const command = `while [ ! -f ${go} ]; do sleep 0.05; done; sleep 297 & echo $! > ${childPidFile}; wait`;
    const cli = Bun.spawn(["bash", "-c", `bash -c '${command}' & wait`], { stdout: "ignore", stderr: "ignore" });
    spawned.push(cli.pid);

    const sessionKey = "stop-fresh-session";
    setSessionCliPid(sessionKey, cli.pid);
    registerBackgroundShell({ sessionKey, topicId: null, shellId: "bfresh01", command, cwd: DIR, ownerPid: cli.pid });
    startProcessDetection({ broadcastToAll: () => {} } as never, () => []);
    const shell = () => listBackgroundShells().find((s) => s.sessionKey === sessionKey);
    await until(() => Boolean(shell()?.pid));
    expect(shell()?.pid).toBeTruthy();

    // The cache is filled NOW, before the child exists; Stop lands well inside
    // its 2-second life.
    await getDescendantPids(cli.pid, { fresh: true });
    writeFileSync(go, "");
    await until(() => existsSync(childPidFile) && readFileSync(childPidFile, "utf-8").trim() !== "");
    const child = Number(readFileSync(childPidFile, "utf-8").trim());
    spawned.push(child);
    expect(isAlive(child)).toBe(true);

    const router = createProcessesRouter({
      db: { query: () => ({ get: () => null }) },
      json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
      broadcastToAll: () => {},
      getTopicBySessionKey: () => null,
      resolveTopicCwd: () => DIR,
    } as never);
    const processId = getScriptsSnapshot().find((r) => r.shellId === "bfresh01")!.processId as string;
    const url = new URL(`http://x/api/scripts/${processId}/stop`);
    const resp = (await router(new Request(url, { method: "POST" }), url, url.pathname, "POST"))!;
    expect(resp.status).toBe(200);

    await until(() => !isAlive(child), 2_000);
    expect(isAlive(child)).toBe(false);
  }, 20_000);
});

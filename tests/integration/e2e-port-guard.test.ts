/**
 * THE E2E SETUP KILLS ONLY TEST SERVERS, AND NEVER ON THE LIVE SERVER'S PORT
 * (card feb80e11).
 *
 * 25/09: `E2E_PORT=${PORT:-13450}` in a session Topics launched (PORT=3333 in
 * its environment) made tests/e2e/global-setup.ts kill every listener on 3333,
 * the production server. The real setup runs here in a child process:
 *
 *   - a listener that is not a test server, on a free port: it stays alive and
 *     the setup exits non-zero with its name;
 *   - E2E_PORT on the live server's port (a fake `~/.topics/daemon-state.json`
 *     under a fake HOME) or on 3333: refused before anything is looked up;
 *   - a PID saved earlier (the server global-setup spawned, the bench bridge's
 *     pidfile) that now belongs to another process: the real teardown leaves it
 *     alive, and still kills the test server's group and the bench bridge;
 *   - a run the lock turned away: its exit leaves the other run's server alive.
 *
 * Nothing real can be touched even by a setup without the guard: `fetch` is
 * refused, and `bash` (which would start a test server), `lsof`, `ps` and
 * `pgrep` are spies on PATH where the port is a production one. The spies'
 * log is also the proof that nothing was looked up before the refusal.
 *
 * @covers E2E-LOCK-01
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lockPathForPort } from "../e2e/helpers/run-lock";

const SETUP = join(import.meta.dir, "..", "e2e", "global-setup.ts");
const TEARDOWN = join(import.meta.dir, "..", "e2e", "global-teardown.ts");
const root = mkdtempSync(join(tmpdir(), "e2e-port-guard-"));
const spawned: Array<{ kill: () => void }> = [];
afterAll(() => {
  for (const p of spawned) { try { p.kill(); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true });
});

/** A fake HOME whose daemon-state says the live server is on `port`. */
function fakeHome(name: string, port: number): string {
  const home = join(root, name);
  mkdirSync(join(home, ".topics"), { recursive: true });
  writeFileSync(join(home, ".topics", "daemon-state.json"), JSON.stringify({ pid: 1, port, startedAt: 0, token: "x" }));
  return home;
}

/** Spies that log their call and do nothing (`bash` fails, so no test server starts). */
function recorders(name: string, commands: string[]): { dir: string; log: string } {
  const dir = join(root, `${name}-bin`);
  const log = join(root, `${name}.log`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  for (const c of commands) {
    const file = join(dir, c);
    writeFileSync(file, `#!/bin/sh\necho "${c} $*" >> "${log}"\n${c === "bash" ? "exit 1" : "exit 0"}\n`);
    chmodSync(file, 0o755);
  }
  return { dir, log };
}

/** The real global-setup, in a child, with `fetch` refused. Killed after `ms` if it hangs. */
async function runSetup(port: number, home: string, spy: { dir: string; log: string }, ms = 30_000) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ["PORT", "DATA_DIR", "E2E_PORT", "OPENCLAW_DIR", "TOPICS_E2E_BUNDLE_DIR"]) delete env[k];
  Object.assign(env, {
    E2E_PORT: String(port), HOME: home, TOPICS_E2E_BUNDLE_DIR: root, PATH: `${spy.dir}:${process.env.PATH}`,
  });
  const script = `globalThis.fetch = async (u) => { require("fs").appendFileSync(${JSON.stringify(spy.log)}, "fetch " + u + "\\n"); throw new Error("no network in this test"); };
    const { default: setup } = await import(${JSON.stringify(SETUP)});
    await setup();`;
  const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  spawned.push(child);
  const timer = setTimeout(() => child.kill(), ms);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { code, output: out + err, calls: readFileSync(spy.log, "utf8").trim() };
}

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("the e2e setup and the port it kills on", () => {
  test("a listener that is not a test server stays alive, and the setup exits non-zero with its name", async () => {
    const port = freePort();
    const server = join(root, "not-a-test-server.ts");
    writeFileSync(server, `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("mine") }); setInterval(() => {}, 1 << 30);`);
    const env = { ...(process.env as Record<string, string>) };
    delete env.DATA_DIR;
    const other = Bun.spawn([process.execPath, server], { env, stdout: "ignore", stderr: "ignore" });
    spawned.push(other);
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}`).then(() => true, () => false)); i++) await Bun.sleep(50);

    const r = await runSetup(port, fakeHome("home-foreign", 3333), recorders("foreign", ["bash"]));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain(`PID ${other.pid}`);
    expect(r.output).toContain("not-a-test-server.ts");
    expect(alive(other.pid)).toBe(true);
    // No test server was started in its place.
    expect(r.calls).toBe("");
    other.kill();
  }, 60_000);

  for (const [label, livePort, e2ePort] of [
    ["E2E_PORT=3333", 3333, 3333],
    ["E2E_PORT on the live server's port from daemon-state", 23999, 23999],
  ] as const) {
    test(`${label}: refused before anything is looked up or killed`, async () => {
      const home = fakeHome(`home-${e2ePort}`, livePort);
      const r = await runSetup(e2ePort, home, recorders(`prod-${e2ePort}`, ["lsof", "ps", "pgrep", "bash"]));
      expect(r.code).not.toBe(0);
      expect(r.output).toContain(`E2E_PORT=${e2ePort} refused`);
      expect(r.output).toContain("Nothing was killed");
      if (e2ePort !== 3333) expect(r.output).toContain(join(home, ".topics", "daemon-state.json"));
      // No port looked up (lsof, pgrep), no server started (bash), no request. The
      // exit handler's `ps` looks for this process's own Chromiums, not the port.
      expect(r.calls.split("\n").filter((c) => c && !c.startsWith("ps "))).toEqual([]);
    }, 60_000);
  }
});

/** A process that records its own exit: a killed child stays a zombie, alive to `kill -0`, until reaped. */
function watched(cmd: string, args: string[]) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  const w = { pid: child.pid!, exited: false, gone: new Promise<void>((r) => child.on("exit", () => { w.exited = true; r(); })) };
  spawned.push({ kill: () => { try { process.kill(-w.pid, "SIGKILL"); } catch { /* gone */ } } });
  return w;
}

/** The real global-teardown, in a child, with the server PID global-setup saved and the bench bridge's pidfile. */
async function runTeardown(port: number, serverPid: number, bridgePid: number) {
  writeFileSync(`/tmp/topics-pty-bridge-e2e-${port}.pid`, String(bridgePid));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ["PORT", "DATA_DIR", "E2E_PORT"]) delete env[k];
  Object.assign(env, { E2E_PORT: String(port), HOME: fakeHome(`home-teardown-${port}`, 3333), __TEST_SERVER_PID: String(serverPid) });
  const script = `const { default: teardown } = await import(${JSON.stringify(TEARDOWN)}); await teardown();`;
  // cwd outside the repo: the teardown's screenshot review looks for its script there.
  const child = Bun.spawn([process.execPath, "-e", script], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return out + err;
}

/** Waits until `probe` answers true, for at most `ms`. */
async function until(probe: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await probe()) return true;
  return probe();
}

describe.skipIf(process.platform === "win32")("the kills by PID, and the exit of a run the lock turned away", () => {
  test("a saved PID that now belongs to another process is left alive, the server's and the bridge's", async () => {
    const port = freePort();
    // What a recycled PID looks like: a job leader and a stray process, neither a test server.
    const server = watched("sleep", ["600"]);
    const bridge = watched("perl", ["-e", "sleep 600"]);
    // And a shell loop that names the bench socket without being its bridge.
    const waiter = watched("sh", ["-c", `until [ -S /tmp/topics-pty-bridge-e2e-${port}.sock ]; do sleep 1; done`]);
    const output = await runTeardown(port, server.pid, bridge.pid);
    await Bun.sleep(500);
    expect({ server: server.exited, bridge: bridge.exited, waiter: waiter.exited, output })
      .toEqual({ server: false, bridge: false, waiter: false, output: expect.any(String) });
    expect(output).toContain(`PID ${server.pid}`);
  }, 60_000);

  test("the saved test server, its whole group, and the bench's bridge are still killed", async () => {
    const port = freePort();
    const childPidFile = join(root, `server-child-${port}`);
    // The tag the real server carries after the launcher's `exec`, and a child in its process group.
    const server = watched("bash", ["-c", `sleep 600 & echo $! > ${childPidFile}; wait`, "server.ts", "--started-by=start-test-server"]);
    const bridge = watched("bash", ["-c", "sleep 600; :", "pty-bridge", "--socket", `/tmp/topics-pty-bridge-e2e-${port}.sock`]);
    expect(await until(() => existsSync(childPidFile) && readFileSync(childPidFile, "utf8").trim() !== "")).toBe(true);
    const child = Number(readFileSync(childPidFile, "utf8"));
    await runTeardown(port, server.pid, bridge.pid);
    const timeout = Bun.sleep(5_000).then(() => "timeout");
    expect(await Promise.race([Promise.all([server.gone, bridge.gone]).then(() => "killed"), timeout])).toBe("killed");
    expect(await until(() => !alive(child))).toBe(true);
  }, 60_000);

  test("a run the lock turned away leaves the other run's server alive when it exits", async () => {
    const port = freePort();
    const file = join(root, `other-run-server-${port}.ts`);
    writeFileSync(file, `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("other run") }); setInterval(() => {}, 1 << 30);`);
    // The other run: its test server, tagged like the real one, and its runner holding the lock.
    const other = watched(process.execPath, [file, "--started-by=start-test-server"]);
    const runner = watched("sleep", ["600"]);
    expect(await until(() => fetch(`http://127.0.0.1:${port}`).then(() => true, () => false))).toBe(true);
    const lock = lockPathForPort(port);
    writeFileSync(lock, JSON.stringify({ pid: runner.pid, startedAt: new Date().toISOString(), cwd: "/another/checkout", port }));
    try {
      const r = await runSetup(port, fakeHome(`home-lock-${port}`, 3333), recorders(`lock-${port}`, ["bash"]));
      await Bun.sleep(500);
      expect(r.code).not.toBe(0);
      expect(r.output).toContain(`PID ${runner.pid}`);
      expect(other.exited).toBe(false);
    } finally {
      rmSync(lock, { force: true });
    }
  }, 60_000);
});

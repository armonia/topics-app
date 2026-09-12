/**
 * Exercises the real watcher and its supervisor with a fake fswatch binary.
 * The observed server process is deliberately independent: killing either
 * watch layer must not interrupt the service it is observing.
 *
 * @covers RUNTIME-21
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const START_PROD = join(REPO_ROOT, "scripts", "start-prod.sh");
const WATCHER = join(REPO_ROOT, "scripts", "server-watch.sh");
const SUPERVISOR = join(REPO_ROOT, "scripts", "server-watch-supervisor.sh");
const PROCESS_LOCK = join(REPO_ROOT, "scripts", "server-watch-lock.sh");

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, message: string | (() => string), timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error(typeof message === "function" ? message() : message);
}

function readPid(path: string): number {
  return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
}

function lastPid(path: string): number {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  return Number.parseInt(lines.at(-1) ?? "0", 10);
}

function makeFixture(): {
  root: string;
  binDir: string;
  serverPidfile: string;
  watcherPidfile: string;
  supervisorPidfile: string;
  eventFile: string;
  watchProcessIds: string;
  curlCalls: string;
} {
  const root = mkdtempSync(join(tmpdir(), "topics-watch-supervisor-"));
  roots.push(root);
  const scriptsDir = join(root, "scripts");
  const serverDir = join(root, "server");
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  mkdirSync(scriptsDir);
  mkdirSync(serverDir);
  mkdirSync(dataDir);
  mkdirSync(binDir);

  copyFileSync(WATCHER, join(scriptsDir, "server-watch.sh"));
  copyFileSync(SUPERVISOR, join(scriptsDir, "server-watch-supervisor.sh"));
  copyFileSync(PROCESS_LOCK, join(scriptsDir, "server-watch-lock.sh"));
  chmodSync(join(scriptsDir, "server-watch.sh"), 0o755);
  chmodSync(join(scriptsDir, "server-watch-supervisor.sh"), 0o755);
  writeFileSync(join(root, "server.ts"), "export const generation = 1;\n");
  writeFileSync(join(serverDir, "module.ts"), "export const ready = true;\n");
  writeFileSync(join(scriptsDir, "server-reload-gate.sh"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(scriptsDir, "server-reload-gate.sh"), 0o755);

  const watchProcessIds = join(root, "fswatch-pids.log");
  const eventFile = join(root, "emit-event");
  writeFileSync(
    join(binDir, "fswatch"),
    `#!/bin/bash
echo $$ >> "$FAKE_FSWATCH_PIDS"
trap '' TERM
trap 'exit 0' INT
while :; do
  if [ -f "$FAKE_EVENT_FILE" ]; then
    rm -f "$FAKE_EVENT_FILE"
    echo 1
  fi
  sleep 0.05
done
`,
  );
  chmodSync(join(binDir, "fswatch"), 0o755);

  const curlCalls = join(root, "curl-calls.log");
  writeFileSync(
    join(binDir, "curl"),
    `#!/bin/bash
echo called >> "$FAKE_CURL_CALLS"
printf '202'
`,
  );
  chmodSync(join(binDir, "curl"), 0o755);

  writeFileSync(
    join(binDir, "parent-inspector"),
    `#!/bin/bash
kill -0 "$2" 2>/dev/null
`,
  );
  chmodSync(join(binDir, "parent-inspector"), 0o755);

  writeFileSync(
    join(dataDir, "daemon-state.json"),
    JSON.stringify({ token: "a".repeat(64), port: 3333 }),
  );

  return {
    root,
    binDir,
    serverPidfile: join(root, "server.pid"),
    watcherPidfile: join(root, "watcher.pid"),
    supervisorPidfile: join(root, "supervisor.pid"),
    eventFile,
    watchProcessIds,
    curlCalls,
  };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production server watcher supervision", () => {
  it("restores watcher and fswatch while content hashing and the server stay intact", async () => {
    const fixture = makeFixture();
    const observedServer = Bun.spawn(["sleep", "30"]);
    children.push(observedServer);
    const foreignProcess = Bun.spawn(["sleep", "30"]);
    children.push(foreignProcess);
    writeFileSync(fixture.serverPidfile, `${observedServer.pid}\n`);
    writeFileSync(fixture.watcherPidfile, `${foreignProcess.pid}\n`);
    writeFileSync(fixture.supervisorPidfile, `${foreignProcess.pid}\n`);
    writeFileSync(`${fixture.watcherPidfile}.lock`, "");
    writeFileSync(`${fixture.supervisorPidfile}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(fixture.serverPidfile, old, old);

    const supervisorEnv = {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      TOPICS_HOME: join(fixture.root, "data"),
      TOPICS_SERVER_WATCH_PIDFILE: fixture.watcherPidfile,
      TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
      TOPICS_SERVER_WATCH: "1",
      TOPICS_SERVER_WATCH_BACKOFF_DELAY: "1",
      TOPICS_SERVER_WATCH_BACKOFF_MAX: "2",
      TOPICS_SERVER_WATCHER_STOP_GRACE_S: "3",
      TOPICS_FSWATCH_STOP_GRACE_S: "1",
      TOPICS_SERVER_WATCH_PARENT_INSPECTOR: join(fixture.binDir, "parent-inspector"),
      TOPICS_SERVER_WATCHDOG_INTERVAL_S: "0.05",
      FAKE_EVENT_FILE: fixture.eventFile,
      FAKE_FSWATCH_PIDS: fixture.watchProcessIds,
      FAKE_CURL_CALLS: fixture.curlCalls,
    };
    const supervisorCommand = [
      "bash",
      join(fixture.root, "scripts", "server-watch-supervisor.sh"),
      fixture.root,
      fixture.serverPidfile,
    ];
    const supervisorCandidates = Array.from({ length: 4 }, () =>
      Bun.spawn(supervisorCommand, {
        env: supervisorEnv,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    children.push(...supervisorCandidates);

    try {
      await waitUntil(
        () => existsSync(fixture.watcherPidfile) && existsSync(fixture.watchProcessIds),
        () => `initial watcher tree did not start: supervisor=${existsSync(fixture.supervisorPidfile) ? readFileSync(fixture.supervisorPidfile, "utf8").trim() : "none"} watcher=${existsSync(fixture.watcherPidfile) ? readFileSync(fixture.watcherPidfile, "utf8").trim() : "none"} fswatch=${existsSync(fixture.watchProcessIds) ? readFileSync(fixture.watchProcessIds, "utf8").trim() : "none"} exits=${supervisorCandidates.map((candidate) => candidate.exitCode).join(",")}`,
      );
      expect(alive(observedServer.pid)).toBe(true);
      expect(alive(foreignProcess.pid)).toBe(true);

      const supervisorOwner = readPid(fixture.supervisorPidfile);
      const supervisor = supervisorCandidates.find(
        (candidate) => candidate.pid === supervisorOwner,
      );
      const duplicates = supervisorCandidates.filter(
        (candidate) => candidate.pid !== supervisorOwner,
      );
      if (!supervisor || duplicates.length !== 3) {
        throw new Error("atomic supervisor lock has no unique owner");
      }
      expect(await Promise.all(duplicates.map((candidate) => candidate.exited))).toEqual([0, 0, 0]);
      expect(readPid(fixture.supervisorPidfile)).toBe(supervisor.pid);

      const firstWatcher = readPid(fixture.watcherPidfile);
      const initialWatchProcess = lastPid(fixture.watchProcessIds);
      expect(readPid(fixture.watcherPidfile)).toBe(firstWatcher);
      expect(readFileSync(fixture.watchProcessIds, "utf8").trim().split("\n")).toHaveLength(1);

      process.kill(firstWatcher, "SIGKILL");
      await waitUntil(
        () =>
          existsSync(fixture.watcherPidfile) &&
          readPid(fixture.watcherPidfile) !== firstWatcher &&
          lastPid(fixture.watchProcessIds) !== initialWatchProcess,
        "watcher was not restored",
      );
      const secondWatcher = readPid(fixture.watcherPidfile);
      expect(alive(secondWatcher)).toBe(true);
      expect(alive(observedServer.pid)).toBe(true);

      const secondWatchProcess = lastPid(fixture.watchProcessIds);
      process.kill(secondWatchProcess, "SIGKILL");
      await waitUntil(
        () => lastPid(fixture.watchProcessIds) !== secondWatchProcess,
        "fswatch and watcher were not restored",
      );
      const thirdWatcher = readPid(fixture.watcherPidfile);
      expect(thirdWatcher).not.toBe(secondWatcher);
      expect(alive(thirdWatcher)).toBe(true);
      const recordedWatchProcessIds = readFileSync(fixture.watchProcessIds, "utf8")
        .trim()
        .split("\n")
        .map((value) => Number.parseInt(value, 10));
      const currentWatchProcessId = recordedWatchProcessIds[recordedWatchProcessIds.length - 1]!;
      expect(recordedWatchProcessIds.filter(alive)).toEqual([currentWatchProcessId]);
      expect(alive(observedServer.pid)).toBe(true);

      const source = join(fixture.root, "server.ts");
      const same = new Date();
      utimesSync(source, same, same);
      writeFileSync(fixture.eventFile, "same\n");
      await Bun.sleep(400);
      expect(existsSync(fixture.curlCalls)).toBe(false);

      writeFileSync(source, "export const generation = 2;\n");
      writeFileSync(fixture.eventFile, "changed\n");
      await waitUntil(() => existsSync(fixture.curlCalls), "content change did not request a restart");
      expect(alive(observedServer.pid)).toBe(true);

      supervisor.kill("SIGTERM");
      await supervisor.exited;
      const supervisorLog = await new Response(supervisor.stdout).text();
      expect(supervisorLog).toContain("restarting in 1s");
      expect(supervisorLog).toContain("restarting in 2s");
      await waitUntil(
        () => !alive(thirdWatcher) && !alive(lastPid(fixture.watchProcessIds)),
        () => `watch processes survived supervisor cleanup: watcher=${alive(thirdWatcher)} filesystem=${alive(lastPid(fixture.watchProcessIds))}`,
      );
    } finally {
      expect(alive(observedServer.pid)).toBe(true);
      expect(alive(foreignProcess.pid)).toBe(true);
    }
  }, 20_000);

  it("starts the watcher supervisor only when the opt-in flag is exactly one", () => {
    const source = readFileSync(START_PROD, "utf8");
    const conditional = source.slice(
      source.indexOf('if [ "${TOPICS_SERVER_WATCH:-0}" = "1" ]'),
      source.indexOf("# Restart-on-CRASH loop"),
    );
    expect(conditional).toContain("server-watch-supervisor.sh");
    expect(conditional).toContain("WATCH_SUPERVISOR_PID=$!");
    expect(source.match(/server-watch-supervisor\.sh/g)).toHaveLength(2);
  });

  it("exits without creating watch processes when the opt-in flag is off", async () => {
    const fixture = makeFixture();
    const launcher = Bun.spawn(
      ["bash", join(fixture.root, "scripts", "server-watch-supervisor.sh"), fixture.root, fixture.serverPidfile],
      {
        env: {
          ...process.env,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          TOPICS_SERVER_WATCH: "0",
          TOPICS_SERVER_WATCH_PIDFILE: fixture.watcherPidfile,
          TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
          TOPICS_SERVER_WATCH_PARENT_INSPECTOR: join(fixture.binDir, "parent-inspector"),
          TOPICS_SERVER_WATCHDOG_INTERVAL_S: "0.05",
          FAKE_EVENT_FILE: fixture.eventFile,
          FAKE_FSWATCH_PIDS: fixture.watchProcessIds,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(launcher);

    expect(await launcher.exited).toBe(0);
    expect(existsSync(fixture.supervisorPidfile)).toBe(false);
    expect(existsSync(`${fixture.supervisorPidfile}.lock`)).toBe(false);
    expect(existsSync(fixture.watcherPidfile)).toBe(false);
    expect(existsSync(fixture.watchProcessIds)).toBe(false);
  });

  it("releases the kernel lease when the holder dies before writing its pidfile", async () => {
    const fixture = makeFixture();
    const acquiredMarker = join(fixture.root, "lease-acquired");
    const pausedHolder = Bun.spawn(
      ["bash", join(fixture.root, "scripts", "server-watch-supervisor.sh"), fixture.root, fixture.serverPidfile],
      {
        env: {
          ...process.env,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          TOPICS_SERVER_WATCH: "1",
          TOPICS_SERVER_WATCH_PIDFILE: fixture.watcherPidfile,
          TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
          TOPICS_SERVER_WATCH_PARENT_INSPECTOR: join(fixture.binDir, "parent-inspector"),
          TOPICS_SERVER_WATCHDOG_INTERVAL_S: "0.05",
          TOPICS_SERVER_WATCH_LOCK_PAUSE_AFTER_ACQUIRE_FILE: acquiredMarker,
          FAKE_EVENT_FILE: fixture.eventFile,
          FAKE_FSWATCH_PIDS: fixture.watchProcessIds,
          FAKE_CURL_CALLS: fixture.curlCalls,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(pausedHolder);
    await waitUntil(() => existsSync(acquiredMarker), "holder did not acquire the kernel lease");
    expect(existsSync(fixture.supervisorPidfile)).toBe(false);
    pausedHolder.kill("SIGKILL");
    await pausedHolder.exited;

    const startedAt = Date.now();
    const successor = Bun.spawn(
      ["bash", join(fixture.root, "scripts", "server-watch-supervisor.sh"), fixture.root, fixture.serverPidfile],
      {
        env: {
          ...process.env,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          TOPICS_SERVER_WATCH: "1",
          TOPICS_SERVER_WATCH_PIDFILE: fixture.watcherPidfile,
          TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
          TOPICS_SERVER_WATCH_PARENT_INSPECTOR: join(fixture.binDir, "parent-inspector"),
          FAKE_EVENT_FILE: fixture.eventFile,
          FAKE_FSWATCH_PIDS: fixture.watchProcessIds,
          FAKE_CURL_CALLS: fixture.curlCalls,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(successor);
    await waitUntil(
      () => existsSync(fixture.supervisorPidfile) && readPid(fixture.supervisorPidfile) === successor.pid,
      "successor could not acquire the released kernel lease",
      3_000,
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    successor.kill("SIGTERM");
    expect(await successor.exited).toBe(0);
  }, 6_000);

  it("keeps a detached reload helper from retaining the dead watcher's lease", async () => {
    const fixture = makeFixture();
    const gatePidPath = join(fixture.root, "gate.pid");
    const helperPidPath = join(fixture.root, "gate-helper.pid");
    writeFileSync(
      join(fixture.root, "scripts", "server-reload-gate.sh"),
      `#!/bin/bash
echo $$ > "$FAKE_GATE_PIDFILE"
sleep 30 &
echo $! > "$FAKE_GATE_HELPER_PIDFILE"
wait
`,
    );
    chmodSync(join(fixture.root, "scripts", "server-reload-gate.sh"), 0o755);

    const observedServer = Bun.spawn(["sleep", "30"]);
    children.push(observedServer);
    writeFileSync(fixture.serverPidfile, `${observedServer.pid}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(fixture.serverPidfile, old, old);

    const supervisor = Bun.spawn(
      ["bash", join(fixture.root, "scripts", "server-watch-supervisor.sh"), fixture.root, fixture.serverPidfile],
      {
        env: {
          ...process.env,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          TOPICS_HOME: join(fixture.root, "data"),
          TOPICS_SERVER_WATCH: "1",
          TOPICS_SERVER_WATCH_PIDFILE: fixture.watcherPidfile,
          TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
          TOPICS_SERVER_WATCH_BACKOFF_DELAY: "1",
          TOPICS_SERVER_WATCH_BACKOFF_MAX: "1",
          TOPICS_FSWATCH_STOP_GRACE_S: "1",
          TOPICS_SERVER_WATCH_PARENT_INSPECTOR: join(fixture.binDir, "parent-inspector"),
          TOPICS_SERVER_WATCHDOG_INTERVAL_S: "0.05",
          FAKE_EVENT_FILE: fixture.eventFile,
          FAKE_FSWATCH_PIDS: fixture.watchProcessIds,
          FAKE_CURL_CALLS: fixture.curlCalls,
          FAKE_GATE_PIDFILE: gatePidPath,
          FAKE_GATE_HELPER_PIDFILE: helperPidPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(supervisor);

    let gatePid = 0;
    let helperPid = 0;
    try {
      await waitUntil(
        () => existsSync(fixture.watcherPidfile) && existsSync(fixture.watchProcessIds),
        "watcher tree did not start",
      );
      const firstWatcher = readPid(fixture.watcherPidfile);
      writeFileSync(join(fixture.root, "server.ts"), "export const generation = 2;\n");
      writeFileSync(fixture.eventFile, "changed\n");
      await waitUntil(
        () => existsSync(gatePidPath) && existsSync(helperPidPath),
        "reload gate did not start its helper",
      );
      gatePid = readPid(gatePidPath);
      helperPid = readPid(helperPidPath);

      process.kill(firstWatcher, "SIGKILL");
      await waitUntil(
        () =>
          alive(gatePid) &&
          alive(helperPid) &&
          existsSync(fixture.watcherPidfile) &&
          readPid(fixture.watcherPidfile) !== firstWatcher,
        () =>
          `detached gate state: gate=${alive(gatePid)} helper=${alive(helperPid)} watcher=${existsSync(fixture.watcherPidfile) ? readFileSync(fixture.watcherPidfile, "utf8").trim() : "none"} first=${firstWatcher} supervisor=${supervisor.exitCode}`,
        5_000,
      );
      const successorWatcher = readPid(fixture.watcherPidfile);
      expect(alive(successorWatcher)).toBe(true);
      expect(alive(gatePid)).toBe(true);
      expect(alive(helperPid)).toBe(true);
      expect(alive(observedServer.pid)).toBe(true);
    } finally {
      if (gatePid > 0 && alive(gatePid)) process.kill(gatePid, "SIGTERM");
      if (helperPid > 0 && alive(helperPid)) process.kill(helperPid, "SIGTERM");
      supervisor.kill("SIGTERM");
      await supervisor.exited;
    }
  }, 8_000);

  it("drops inherited leases and removes the watcher tree after supervisor SIGKILL", async () => {
    const fixture = makeFixture();
    const env = {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      TOPICS_SERVER_WATCH: "1",
      TOPICS_SERVER_WATCH_PIDFILE: fixture.watcherPidfile,
      TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
      TOPICS_SERVER_WATCH_BACKOFF_DELAY: "1",
      TOPICS_SERVER_WATCH_BACKOFF_MAX: "1",
      TOPICS_FSWATCH_STOP_GRACE_S: "1",
      TOPICS_SERVER_WATCH_PARENT_INSPECTOR: join(fixture.binDir, "parent-inspector"),
      TOPICS_SERVER_WATCHDOG_INTERVAL_S: "0.05",
      FAKE_EVENT_FILE: fixture.eventFile,
      FAKE_FSWATCH_PIDS: fixture.watchProcessIds,
      FAKE_CURL_CALLS: fixture.curlCalls,
    };
    const command = [
      "bash",
      join(fixture.root, "scripts", "server-watch-supervisor.sh"),
      fixture.root,
      fixture.serverPidfile,
    ];
    const firstSupervisor = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
    children.push(firstSupervisor);
    await waitUntil(
      () => existsSync(fixture.watcherPidfile) && existsSync(fixture.watchProcessIds),
      () => `first watcher tree did not start: supervisor=${firstSupervisor.exitCode} watcher=${existsSync(fixture.watcherPidfile) ? readFileSync(fixture.watcherPidfile, "utf8").trim() : "none"} fswatch=${existsSync(fixture.watchProcessIds) ? readFileSync(fixture.watchProcessIds, "utf8").trim() : "none"}`,
    );
    const firstWatcher = readPid(fixture.watcherPidfile);
    const firstWatchProcess = lastPid(fixture.watchProcessIds);

    firstSupervisor.kill("SIGKILL");
    await firstSupervisor.exited;
    await waitUntil(
      () => !alive(firstWatcher) && !alive(firstWatchProcess),
      "orphan watcher tree survived its supervisor",
      4_000,
    );

    const successor = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
    children.push(successor);
    await waitUntil(
      () =>
        existsSync(fixture.supervisorPidfile) &&
        readPid(fixture.supervisorPidfile) === successor.pid &&
        existsSync(fixture.watcherPidfile) &&
        readPid(fixture.watcherPidfile) !== firstWatcher &&
        lastPid(fixture.watchProcessIds) !== firstWatchProcess,
      "successor watcher tree did not acquire both leases",
      5_000,
    );
    const liveWatchProcesses = readFileSync(fixture.watchProcessIds, "utf8")
      .trim()
      .split("\n")
      .map((value) => Number.parseInt(value, 10))
      .filter(alive);
    expect(liveWatchProcesses).toHaveLength(1);

    successor.kill("SIGTERM");
    expect(await successor.exited).toBe(0);
  }, 10_000);

  it("force-stops only its watcher child when that child ignores TERM", async () => {
    const fixture = makeFixture();
    const stubbornProcessFile = join(fixture.root, "stubborn.pid");
    const stubbornWatcher = join(fixture.root, "scripts", "stubborn-watcher.sh");
    writeFileSync(
      stubbornWatcher,
      `#!/bin/bash
echo $$ > "$STUBBORN_PIDFILE"
trap '' TERM
while :; do sleep 1; done
`,
    );
    chmodSync(stubbornWatcher, 0o755);

    const supervisor = Bun.spawn(
      ["bash", join(fixture.root, "scripts", "server-watch-supervisor.sh"), fixture.root, fixture.serverPidfile],
      {
        env: {
          ...process.env,
          TOPICS_SERVER_WATCH: "1",
          TOPICS_SERVER_WATCH_SCRIPT: stubbornWatcher,
          TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE: fixture.supervisorPidfile,
          TOPICS_SERVER_WATCHER_STOP_GRACE_S: "1",
          STUBBORN_PIDFILE: stubbornProcessFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(supervisor);
    await waitUntil(() => existsSync(stubbornProcessFile), "stubborn watcher did not start");
    const stubbornPid = readPid(stubbornProcessFile);

    supervisor.kill("SIGTERM");
    await waitUntil(() => supervisor.exitCode !== null, "supervisor cleanup exceeded its grace", 4_000);
    expect(await supervisor.exited).toBe(0);
    expect(alive(stubbornPid)).toBe(false);
    expect(existsSync(fixture.supervisorPidfile)).toBe(false);
  }, 6_000);
});

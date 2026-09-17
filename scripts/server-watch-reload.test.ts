/**
 * What the hot-reload watcher does to a server once it has decided to reload:
 * how it asks, how long it waits, what it refuses to cut, and which edits make
 * it ask at all.
 *
 * The night of 2026-09-14 is the measure. Server 34310 was starting under swap,
 * the first two asks timed out, the third path got its 202 and then waited a
 * flat 1560 s without reading the deferral heartbeat: SIGTERM, twelve cards cut
 * mid-turn while the server was writing "RINVIATO da 1557s". An hour earlier a
 * server stalled 87 s had taken the last-resort SIGTERM after ~140 s of short
 * asks and a SIGKILL 60 s into its shutdown. At 01:51 a server spawned eight
 * seconds before writing its state was asked to restart for code it had
 * already loaded.
 *
 * These run the REAL `server-watch.sh` against fakes: `fswatch` emits an event
 * when a trigger file appears, `curl` answers 202 or 000 as the test decides,
 * and the "server" is a shell that records the SIGTERM it receives. The
 * watcher's windows are shrunk through its own environment (the server cap, the
 * exit margin, the ask cadence), never by editing the script.
 *
 * @covers RGATE-05, RGATE-06
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { slackMs } from "../tests/helpers/time-slack";

const SCRIPTS = resolve(import.meta.dir);

interface Rig {
  root: string;
  log: () => string;
  curlCalls: () => number;
  termReceived: () => boolean;
  serverAlive: () => boolean;
  fswatchArgs: () => string[];
  /** Emit one fswatch batch. */
  event: () => void;
  /** Write a source file relative to the app dir, optionally dating it. */
  write: (rel: string, content: string, mtime?: Date) => void;
  heartbeat: (mtime: Date) => void;
  openCurl: () => void;
  dateServerBirth: (mtime: Date) => void;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, what: () => string, windowMs = 8_000): Promise<void> {
  const deadline = Date.now() + slackMs(windowMs);
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error(what());
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}`);
  chmodSync(path, 0o755);
}

/** Every file of the fake app, dated in the past, so only what a test writes is new. */
function ageTree(dir: string, mtime: Date): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) ageTree(path, mtime);
    else utimesSync(path, mtime, mtime);
  }
}

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

async function startRig(opts: {
  env?: Record<string, string>;
  /** How many curl calls answer 000 before the first 202 (two per ask: https, http). */
  curlFailFirst?: number;
}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "topics-watch-reload-"));
  const app = join(root, "app");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const dir of [app, bin, home, join(app, "scripts"), join(app, "server"), join(app, "shared")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ["server-watch.sh", "server-watch-lock.sh"]) {
    copyFileSync(join(SCRIPTS, name), join(app, "scripts", name));
  }
  chmodSync(join(app, "scripts", "server-watch.sh"), 0o755);
  script(join(app, "scripts", "server-reload-gate.sh"), "exit 0\n");
  writeFileSync(join(app, "server.ts"), 'import { used } from "./shared/used";\nexport const generation = used;\n');
  writeFileSync(join(app, "server", "module.ts"), "export const ready = true;\n");
  writeFileSync(join(app, "shared", "used.ts"), "export const used = 1;\n");
  writeFileSync(join(app, "shared", "unused.ts"), "export const unused = 1;\n");
  ageTree(app, secondsAgo(600));
  writeFileSync(join(home, "daemon-state.json"), JSON.stringify({ token: "b".repeat(64), port: 3333 }));

  const trigger = join(root, "event");
  const argsFile = join(root, "fswatch-args");
  const callsFile = join(root, "curl-calls");
  const openFile = join(root, "curl-open");
  const termFile = join(root, "server-term");
  script(join(bin, "fswatch"), `printf '%s\\n' "$@" > "${argsFile}"
while :; do
  if [ -f "${trigger}" ]; then rm -f "${trigger}"; echo 1; fi
  sleep 0.05
done
`);
  script(join(bin, "curl"), `echo call >> "${callsFile}"
n=$(( $(wc -l < "${callsFile}") ))
if [ -f "${openFile}" ] || [ "$n" -gt ${opts.curlFailFirst ?? 0} ]; then printf 202; else printf 000; fi
`);
  // The stall diagnosis probes every mount for three seconds each: on a Linux
  // runner that is minutes. It is not what these tests measure.
  script(join(bin, "mount"), "exit 0\n");
  script(join(bin, "sample"), "exit 0\n");

  const server = Bun.spawn(["bash", "-c", `trap 'echo TERM >> "${termFile}"; exit 0' TERM; while :; do sleep 0.1; done`]);
  const pidPath = join(root, "server.pid");
  writeFileSync(pidPath, `${server.pid}\n`);
  utimesSync(pidPath, secondsAgo(120), secondsAgo(120));

  const logPath = join(root, "watch.log");
  const logFd = openSync(logPath, "w");
  const watcher = Bun.spawn(["bash", join(app, "scripts", "server-watch.sh"), app, pidPath], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BUN: process.execPath,
      TOPICS_HOME: home,
      TOPICS_SERVER_WATCH_PIDFILE: join(root, "watch.pid"),
      TOPICS_SERVER_WATCHDOG_INTERVAL_S: "0.2",
      TOPICS_FSWATCH_STOP_GRACE_S: "1",
      TOPICS_QUIESCENCE_CAP_MS: "1000",
      TOPICS_SERVER_WATCH_EXIT_MARGIN_S: "1",
      TOPICS_SERVER_WATCH_ASK_EVERY_S: "1",
      ...opts.env,
    },
    stdout: logFd,
    stderr: logFd,
  });

  cleanups.push(async () => {
    watcher.kill("SIGTERM");
    await Promise.race([watcher.exited, Bun.sleep(slackMs(5_000))]);
    if (watcher.exitCode === null) watcher.kill("SIGKILL");
    server.kill("SIGKILL");
    await server.exited;
    closeSync(logFd);
    rmSync(root, { recursive: true, force: true });
  });

  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const rig: Rig = {
    root: app,
    log: () => read(logPath),
    curlCalls: () => read(callsFile).split("\n").filter(Boolean).length,
    termReceived: () => existsSync(termFile),
    serverAlive: () => isAlive(server.pid),
    fswatchArgs: () => read(argsFile).split("\n").filter(Boolean),
    event: () => writeFileSync(trigger, "1"),
    write: (rel, content, mtime) => {
      writeFileSync(join(app, rel), content);
      if (mtime) utimesSync(join(app, rel), mtime, mtime);
    },
    heartbeat: (mtime) => {
      const path = join(home, "reload-deferred");
      writeFileSync(path, String(mtime.getTime()));
      utimesSync(path, mtime, mtime);
    },
    openCurl: () => writeFileSync(openFile, "1"),
    dateServerBirth: (mtime) => utimesSync(pidPath, mtime, mtime),
  };
  await until(() => rig.fswatchArgs().length > 0, () => `watcher did not start:\n${rig.log()}`);
  return rig;
}

describe("the watcher does not cut what the server protects (RGATE-05)", () => {
  it("a 202 that only arrives on a later ask still honours the deferral, even one a long stall has aged", async () => {
    // Both quick asks fail (four calls), the third answers: the path that cut
    // twelve cards. The heartbeat is 90 s old, as after the 87 s stall of 14/09.
    const rig = await startRig({ curlFailFirst: 4, env: { TOPICS_QUIESCENCE_CAP_MS: "3000" } });
    rig.heartbeat(secondsAgo(90));
    rig.write("server.ts", 'import { used } from "./shared/used";\nexport const generation = used + 1;\n');
    rig.event();

    await until(() => rig.log().includes("aspetto che il server"), () => `the watcher never got its 202:\n${rig.log()}`);
    expect(rig.curlCalls()).toBeGreaterThan(4);
    // The window is 4 s (cap 3 s + margin 1 s): twice past it the server must
    // still be there, untouched. Not widened by the load: the wait is `sleep 2`
    // steps, timers the load does not stretch, so this is watcher time too.
    await Bun.sleep(8_000);
    expect(rig.termReceived()).toBe(false);
    expect(rig.serverAlive()).toBe(true);
    expect(rig.log()).toContain("il server RINVIA il riavvio");
  }, slackMs(30_000));

  it("a server that does not answer for many asks is asked again, not cut, and the ask that lands starts the patient wait", async () => {
    const rig = await startRig({ curlFailFirst: 1_000_000, env: { TOPICS_QUIESCENCE_CAP_MS: "60000" } });
    rig.write("server.ts", 'import { used } from "./shared/used";\nexport const generation = used + 2;\n');
    rig.event();

    await until(() => rig.curlCalls() >= 12, () => `the watcher stopped asking after ${rig.curlCalls()} calls:\n${rig.log()}`);
    expect(rig.termReceived()).toBe(false);
    rig.openCurl();
    await until(() => rig.log().includes("aspetto che il server"), () => `the late 202 did not lead to the patient wait:\n${rig.log()}`);
    expect(rig.log()).not.toContain("graceful hot-reload (SIGTERM");
    expect(rig.termReceived()).toBe(false);
    expect(rig.serverAlive()).toBe(true);
  }, slackMs(30_000));

  it("a server that never answers is cut once the whole window has passed, starting from SIGTERM", async () => {
    const rig = await startRig({ curlFailFirst: 1_000_000 });
    rig.write("server.ts", 'import { used } from "./shared/used";\nexport const generation = used + 3;\n');
    rig.event();

    await until(() => rig.termReceived(), () => `a mute server was never signalled:\n${rig.log()}`, 15_000);
    expect(rig.log()).toContain("graceful hot-reload (SIGTERM");
    expect(rig.log()).toContain("richiedo ogni 1s");
  }, slackMs(30_000));

  it("the SIGKILL leaves a stalled graceful shutdown five minutes, not one", () => {
    const source = readFileSync(join(SCRIPTS, "server-watch.sh"), "utf8");
    const window = source.match(/^SIGKILL_WINDOW_S=(\d+)$/m);
    expect(window, "SIGKILL_WINDOW_S is not declared").not.toBeNull();
    expect(Number(window![1])).toBeGreaterThanOrEqual(300);
  });
});

describe("the watcher asks only for code the server has not loaded (RGATE-06)", () => {
  it("a server spawned after the last edit is not asked to restart, one spawned before it is", async () => {
    const rig = await startRig({});
    // The 01:51 shape: the edit is older than the spawn, daemon-state.json has
    // not moved since the watcher started, so the boot guard does not fire.
    rig.dateServerBirth(secondsAgo(30));
    rig.write("server.ts", 'import { used } from "./shared/used";\nexport const generation = used + 4;\n', secondsAgo(60));
    rig.event();
    await until(
      () => rig.log().includes("nato dopo l'ultima modifica") || rig.curlCalls() > 0,
      () => `the event was never handled:\n${rig.log()}`,
    );
    expect(rig.curlCalls()).toBe(0);

    rig.write("server/module.ts", "export const ready = false;\n");
    rig.event();
    await until(() => rig.curlCalls() > 0, () => `an edit newer than the spawn did not ask a restart:\n${rig.log()}`);
  }, slackMs(30_000));

  it("a shared/ file the server imports is a server change, one it does not import is not", async () => {
    const rig = await startRig({});
    expect(rig.fswatchArgs()).toContain(join(rig.root, "shared/"));

    rig.write("shared/unused.ts", "export const unused = 2;\n");
    rig.event();
    await until(
      () => rig.log().includes("evento ignorato") || rig.curlCalls() > 0,
      () => `the event was never handled:\n${rig.log()}`,
    );
    expect(rig.curlCalls()).toBe(0);

    rig.write("shared/used.ts", "export const used = 2;\n");
    rig.event();
    await until(() => rig.curlCalls() > 0, () => `an edit to a shared file the server imports did not ask a restart:\n${rig.log()}`);
  }, slackMs(30_000));
});

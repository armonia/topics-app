/**
 * @covers BRIDGE-OWN-01
 */
import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Who owns the broker socket, and who is allowed to take it away.
//
// On 2026-08-13 this contract cost the machine twice in one hour, once even
// across a reboot: 1612 daemons on a single socket in twelve minutes, 3653
// processes, 36 GB of swap on a 32 GB box, load 644, and the server on :3333
// unreachable. The cause was one line of judgement: `probeBridge` returns
// `timeout` both when the owner is dead and when the machine is too loaded for
// it to answer within 1.5s, and `checkExistingBridge` treated the two the same.
// Every new daemon evicted the previous one; `listen()` on a just-unlinked path
// does not fail with EADDRINUSE but creates a new file, so all of them stayed
// alive and none was reachable.
//
// These tests fence that judgement. The first one is the one that matters: it
// must be seen RED against the pre-fix daemon.

const BRIDGE = join(import.meta.dir, "ai-bridge.mjs");
const PROBE_MS = 1_500; // the timeout inside probeBridge()

type Cleanup = () => void;
const cleanups: Cleanup[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-bridge-singleton-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } });
  return dir;
}

function socketPath(name: string): string {
  // Keep it short: a unix socket path over 104 bytes fails to bind (EINVAL).
  const sock = join(tmpdir(), `abs-${name}-${process.pid}.sock`);
  cleanups.push(() => {
    for (const p of [sock, `${sock}.lock`, pidPathFor(sock)]) {
      try { rmSync(p, { force: true }); } catch { /* already gone */ }
    }
  });
  return sock;
}

/** The pid file the daemon writes next to its socket. */
function pidPathFor(sock: string): string {
  return sock.replace(/\.sock$/, ".pid");
}

/**
 * An owner that ACCEPTS the connection and never answers: this is the loaded
 * machine, not a dead daemon. It runs in its own process, because the whole
 * point of the test is that this process survives.
 */
async function muteOwner(sock: string): Promise<{ pid: number; alive: () => boolean }> {
  const code = `
    const net = require("net"), fs = require("fs");
    const srv = net.createServer(() => { /* accept and stay silent */ });
    srv.listen(${JSON.stringify(sock)}, () => {
      fs.writeFileSync(${JSON.stringify(pidPathFor(sock))}, String(process.pid));
      console.log("ready");
    });
    setTimeout(() => process.exit(0), 30000);
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { try { proc.kill(9); } catch { /* already dead */ } });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(pidPathFor(sock))) {
    await Bun.sleep(50);
  }
  return {
    pid: proc.pid,
    alive: () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } },
  };
}

type Daemon = {
  proc: Bun.Subprocess;
  /** Everything the daemon has printed so far, readable while it is still alive. */
  said: () => string;
};

let daemonSeq = 0;

/**
 * THE DAEMON'S STDERR GOES TO A FILE, never to a pipe.
 *
 * Two reasons, both paid for. Reading the stream of a process that is still
 * alive blocks the reader until that process exits, so a piped stderr can only
 * be read after the fact: useless exactly when you want to know what a daemon
 * that has NOT exited is doing. And a pipe nobody reads is a second way to lose
 * the account: it is the parent's event loop that has to drain it, and under a
 * full suite that loop has other things to do.
 *
 * A file has neither problem: the daemon writes, anybody reads, at any moment.
 * It is the probe that caught the defect fixed in 553e60409, after the first
 * attempt at reading the pipes hung on a daemon that was still alive.
 */
function spawnDaemon(sock: string, store: string): Daemon {
  const errPath = join(tmpdir(), `abs-daemon-${process.pid}-${daemonSeq++}.err`);
  const fd = openSync(errPath, "w");
  const proc = Bun.spawn(
    [process.execPath, BRIDGE, "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
    { stdout: "ignore", stderr: fd },
  );
  cleanups.push(() => {
    try { proc.kill(9); } catch { /* already dead */ }
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(errPath, { force: true }); } catch { /* already gone */ }
  });
  return {
    proc,
    said: () => { try { return readFileSync(errPath, "utf8"); } catch { return ""; } },
  };
}

/**
 * Is this daemon still running? TWO answers have to agree.
 *
 * `exitCode` is the parent's bookkeeping and it is only as fresh as the
 * parent's event loop; `kill(pid, 0)` is the kernel, but it also succeeds on a
 * zombie that has exited and not been reaped yet. A process is running only if
 * both say so, which makes this reading immune to the two ways of being wrong
 * at once instead of picking one of them.
 */
function stillRunning(d: Daemon): boolean {
  if (d.proc.exitCode !== null || d.proc.signalCode !== null) return false;
  try { process.kill(d.proc.pid, 0); return true; } catch { return false; }
}

/** What a daemon decided, in its own words, shortened to the decisive bit. */
function verdictOf(d: Daemon): string {
  const line = d.said().trim().split("\n")[0] ?? "";
  if (!line) return `never spoke (exit ${d.proc.exitCode ?? "none"})`;
  if (line.includes("Listening on")) return "owner";
  if (line.includes("already taking over")) return "lost the lock";
  if (line.includes("healthy bridge already")) return "found the owner";
  if (line.includes("NOT evicting it")) return "backed off";
  return line.replace("[AI Bridge] ", "");
}

/**
 * The verdict of the race as ONE sentence: either the expected outcome, or what
 * happened instead with every daemon's own account attached.
 *
 * It is a string and not five separate assertions on purpose. When this case
 * fails it fails on a machine nobody is watching, and the only thing that
 * arrives is the diff of the comparison: it has to carry the whole story, and
 * above all it has to distinguish "the race is broken" from "the machine never
 * started these processes", which is what a count of survivors could not say.
 */
function diagnose(racers: Daemon[], answering: boolean, reachCeilingMs: number): string {
  const report = racers.map((d, i) => `#${i} ${verdictOf(d)}${stillRunning(d) ? " (alive)" : ""}`).join(", ");
  const mute = racers.filter((d) => d.said().trim().length === 0).length;
  const owners = racers.filter((d) => d.said().includes("Listening on")).length;
  const running = racers.filter(stillRunning).length;
  if (mute > 0) {
    return `${mute} of ${racers.length} daemons never reached the race within ${reachCeilingMs} ms. `
      + `That is the machine failing to start them, not the race failing: ${report}`;
  }
  if (owners !== 1) return `${owners} daemons took the same socket: ${report}`;
  if (running !== 1) return `${running} daemons still running after the race: ${report}`;
  if (!answering) return `nobody answers on the socket: ${report}`;
  return "one owner listening, four losers gone";
}

function someoneListening(sock: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((res) => {
    if (!existsSync(sock)) { res(false); return; }
    const c = net.connect(sock);
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; try { c.destroy(); } catch { /* already closed */ } res(v); };
    c.on("connect", () => finish(true));
    c.on("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

describe("ai-bridge · socket ownership", () => {
  test("a LIVE owner that is merely too slow to answer is not evicted", async () => {
    const sock = socketPath("mute");
    const store = storeDir();
    const owner = await muteOwner(sock);
    expect(owner.alive()).toBe(true);

    const newcomer = spawnDaemon(sock, store);
    const exitCode = await newcomer.proc.exited;
    const stderr = newcomer.said();

    // The newcomer backs off...
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NOT evicting it");
    // ...and above all it does not touch the incumbent. This is the assertion
    // whose absence turned a loaded machine into 1612 processes.
    expect(owner.alive()).toBe(true);
    // The pid file still names the owner: nobody stole its place.
    expect(readFileSync(pidPathFor(sock), "utf8").trim()).toBe(String(owner.pid));
  }, 20_000);

  test("a stale socket with nobody listening is taken over", async () => {
    const sock = socketPath("stale");
    const store = storeDir();
    // The file exists but is not a live socket, and the recorded pid does not
    // exist: this is the case where evicting is right, and the daemon MUST take
    // the socket rather than back off.
    writeFileSync(sock, "");
    writeFileSync(pidPathFor(sock), "999999");

    const taker = spawnDaemon(sock, store);

    // The patience is a CEILING, not a measurement: the daemon only has to take
    // the socket. At 8 s it fell over inside the whole `test:unit`, where
    // spawning a Bun process while 853 files are running takes far longer than
    // usual, and the red told the story of the machine's load instead of the
    // behaviour.
    const deadline = Date.now() + 25_000;
    let taken = false;
    while (Date.now() < deadline && !taken) {
      taken = await someoneListening(sock);
      if (!taken) await Bun.sleep(100);
    }
    expect(taken).toBe(true);
    // WAIT FOR THE PID TOO, and not only for the listening: they are two
    // events, in that order, and the test was looking between the one and the
    // other.
    //
    // In the daemon the pid is written INSIDE the `listen()` callback
    // (ai-bridge.mjs: `server.listen(...)` then `writeFileSync(pidPath)`), so
    // there is a window in which the socket already answers and the file does
    // not exist yet. `someoneListening` sees it open and the `readFileSync`
    // right after blew up with ENOENT. Measured on the whole suite: the
    // listening was there after 300ms, the pid file was not.
    //
    // It is not a defect of the daemon: it writes the pid BEFORE releasing the
    // lock, which is the order that matters for whoever contends for the
    // socket. It is the test that treated two events as one. Same patience as
    // the wait above, because the reason is the same: under load every step
    // takes longer.
    let pid: string | null = null;
    const pidDeadline = Date.now() + 25_000;
    while (Date.now() < pidDeadline && pid === null) {
      try {
        pid = readFileSync(pidPathFor(sock), "utf8").trim();
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(pid).toBe(String(taker.proc.pid));
  }, 40_000);

  test("five daemons racing for a free socket leave exactly ONE listening", async () => {
    const sock = socketPath("race");
    const store = storeDir();

    const racers = Array.from({ length: 5 }, () => spawnDaemon(sock, store));

    /* WHAT THIS CASE CLAIMS, and what it used to measure instead.
     *
     * The claim: five daemons started together on a free socket end with ONE
     * owner listening and four losers gone. Before the fix in `ai-bridge.mjs`
     * (553e60409) two of them printed "Listening" on the same path and stayed
     * alive forever.
     *
     * What it measured until now: a stopwatch. It counted, at a fixed deadline,
     * how many processes had not exited yet, so every growth of the suite moved
     * the red. Raising the deadline is not a fix and it was tried: at 42 s it
     * still failed with two survivors, because a survivor that has not even
     * REACHED the race is not slow at the race, it is late to be born.
     *
     * So the case now asks the daemons themselves, in two steps that are two
     * different questions:
     *
     *   1. did all five reach the race? Every path through `start()` prints
     *      exactly one line before it decides, so silence means the machine
     *      never got that process going. That is a fact about the load, and
     *      when it is what happened the red says so in those words instead of
     *      accusing the race.
     *
     *   2. given that they all raced, how did it end? Exactly one "Listening",
     *      four losers actually gone, and the socket answering. None of this is
     *      a duration, so no threshold has to be retuned when the suite grows:
     *      the ceilings below are only there so that a hang ends as a red
     *      instead of a hung test. */
    const REACH_CEILING_MS = 25_000;
    const reachDeadline = Date.now() + REACH_CEILING_MS;
    while (Date.now() < reachDeadline && !racers.every((d) => d.said().trim().length > 0)) {
      await Bun.sleep(100);
    }

    // The losers exit as soon as they have spoken: `process.exit(1)` is the
    // statement right after the line they printed, so what is left to wait for
    // is the teardown of a process, not a decision. The window is wide because
    // it costs nothing when things go right (the loop leaves at the first
    // reading) and it is only spent on the way to a red.
    const settleDeadline = Date.now() + PROBE_MS * 10;
    while (Date.now() < settleDeadline && racers.filter(stillRunning).length > 1) {
      await Bun.sleep(200);
    }

    const OK = "one owner listening, four losers gone";
    expect(diagnose(racers, await someoneListening(sock), REACH_CEILING_MS)).toBe(OK);
    // 45 s of ceiling against the 25 + 15 of internal waiting: the test must
    // have room to reach its own comparison, because the sentence that
    // comparison prints is the only useful thing when this case really fails.
    // A bun timeout firing first would replace it with silence.
  }, 45_000);
});

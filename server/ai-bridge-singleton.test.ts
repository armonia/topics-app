import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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

function spawnDaemon(sock: string, store: string) {
  const proc = Bun.spawn(
    [process.execPath, BRIDGE, "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
    { stdout: "pipe", stderr: "pipe" },
  );
  cleanups.push(() => { try { proc.kill(9); } catch { /* already dead */ } });
  return proc;
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

    const proc = spawnDaemon(sock, store);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

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

    const proc = spawnDaemon(sock, store);

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
    expect(pid).toBe(String(proc.pid));
  }, 40_000);

  test("five daemons racing for a free socket leave exactly ONE listening", async () => {
    const sock = socketPath("race");
    const store = storeDir();

    const racers = Array.from({ length: 5 }, () => spawnDaemon(sock, store));

    // Wait for the race to settle: the losers EXIT, which is the whole point.
    // Before the fix they all ended up listening and stayed alive forever.
    /* THE DEADLINE, and why it was not enough.
     *
     * Measured: under the whole suite this case failed at **12,198 ms** against
     * a deadline of 12,000 - a fifth of a second short. On its own it always
     * passes (three runs out of three, ~2 s). So it is not a defect of the
     * race: it is that five processes being born, probing and dying take longer
     * when the machine is already running 876 test files.
     *
     * Time is not what this case proves. The claim is "the losers EXIT, and
     * exactly one is left listening"; how long they take is a detail of the
     * environment. A deadline calibrated on an idle machine turns that claim
     * into a measurement of the machine's speed, and produces a red that
     * accuses the race while talking about the load.
     *
     * The test's ceiling (30 s) stays the real safety net: if the losers really
     * do NOT exit - the defect this case exists to catch - here we wait in vain
     * and the red arrives all the same, only later. */
    const deadline = Date.now() + PROBE_MS * 4 + 18_000;
    let alive = racers.length;
    while (Date.now() < deadline) {
      alive = racers.filter((p) => p.exitCode === null && p.signalCode === null).length;
      if (alive <= 1) break;
      await Bun.sleep(200);
    }

    expect(alive).toBe(1);
    // ── IF THIS LINE IS RED, DO NOT BLAME THE LOAD FIRST.
    //    The deadline comment above explains well why it is generous, but it
    //    also gives the impression that a red here is always slowness. On 24/08
    //    it was not: waiting BEYOND the deadline, the losers that had not
    //    exited within 24s did not exit at 30, 45 or 60 either. They stayed
    //    alive, and two of them had printed "Listening" on the same path.
    //
    //    Cause found and fixed in `ai-bridge.mjs` (553e60409): the pid was
    //    written INSIDE the `listen()` callback, so there was an instant in
    //    which the socket accepted and the pid file did not exist. Whoever
    //    probed in there read `timeout` with no owner recorded, concluded
    //    "free" and took over from a live process. Now the pid is written
    //    first, and a `timeout` counts as "somebody is listening" even with no
    //    pid.
    //
    //    Before: 2 failures out of 12. After: 30 runs out of 30 green, and
    //    rebuilding the old code brings the defect back (1 in 20). If this line
    //    comes up red again, the useful probe writes the daemons' stderr to
    //    FILES: reading the stream of a still-live process blocks the reader.
    expect(await someoneListening(sock)).toBe(true);
    // 45 s and not 30: the internal deadline reaches 24, and a ceiling that
    // fires BEFORE that wait would make it useless - the test would die of a
    // bun timeout instead of saying how many daemons stayed alive, which is the
    // only useful piece of information when this case really fails.
  }, 45_000);
});

/** Fresh module state for scheduler/probe measurements; no real process probes. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppContext } from "../../server/types";

const root = mkdtempSync(join(tmpdir(), "process-cost-fixture-"));
process.env.DATA_DIR = join(root, "data");
process.env.TOPICS_DATA_DIR = join(root, "state");
process.env.APP_DATA_DIR = join(root, "appdata");
process.env.TOPICS_HOME = join(root, "home");
const originalSpawn = Bun.spawn;
const originalTimer = globalThis.setTimeout;
const originalClearTimer = globalThis.clearTimeout;
const originalNow = Date.now;
try {
  const { startProcessDetection, getListeningPorts, getTopCpuProcesses } = await import("../../server/routes/processes");
  if (process.argv[2] === "timers") {
    let now = 0, nextId = 0, cycles = 0;
    const timers = new Map<number, { at: number; fn: () => Promise<void> }>();
    globalThis.setTimeout = ((fn: () => Promise<void>, delay: number) => {
      const timerId = ++nextId;
      timers.set(timerId, { at: now + delay, fn });
      return { unref() {}, timerId };
    }) as unknown as typeof setTimeout;
    const source = () => { cycles++; return []; };
    startProcessDetection({} as AppContext, source);
    startProcessDetection({} as AppContext, source); // Initial cycle is still in flight.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const initial = [...timers.values()].map(t => t.at).sort((a, b) => a - b);
    for (let i = 0; i < 5; i++) {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
      timers.delete(id); now = timer.at; await timer.fn();
    }
    console.log(JSON.stringify({ initial, pending: timers.size, cycles }));
  } else if (process.argv[2] === "hang") {
    let nextId = 0, calls = 0, kills = 0, stalled = true;
    const timers = new Map<number, { fn: () => void; delay: number }>();
    globalThis.setTimeout = ((fn: () => void, delay: number) => {
      const timerId = ++nextId;
      timers.set(timerId, { fn, delay });
      return { unref() {}, timerId };
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: { timerId: number }) => {
      timers.delete(handle.timerId);
    }) as unknown as typeof clearTimeout;
    Bun.spawn = ((args: string[]) => {
      calls++;
      if (stalled) {
        let controller: ReadableStreamDefaultController;
        let finish: (code: number) => void = () => {};
        return {
          stdout: new ReadableStream({ start(value) { controller = value; } }),
          exited: new Promise<number>((done) => { finish = done; }),
          kill(signal: string) {
            if (signal !== "SIGKILL") throw new Error(`Unexpected signal: ${signal}`);
            kills++; controller.close(); finish(137);
          },
        };
      }
      return { stdout: args[0]!.endsWith("lsof")
        ? "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nfixture 42 user 10u IPv4 0x1 0t0 TCP *:45678\n"
        : "PID %CPU COMMAND\n42 3.0 fixture-a\n43 2.0 fixture-b\n", exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    const wave = () => Promise.all(Array.from({ length: 8 }, () => Promise.all([getListeningPorts(), getTopCpuProcesses()])));
    const firstWave = wave();
    const deadlines = [...timers.values()];
    if (deadlines.length === 0) {
      console.log(JSON.stringify({ timeouts: 0, calls }));
    } else {
      for (const timer of deadlines) timer.fn();
      const first = await firstWave;
      stalled = false;
      const recovered = await wave();
      const warm = await wave();
      console.log(JSON.stringify({ timeouts: deadlines.length, delays: deadlines.map(timer => timer.delay),
        kills, calls, pendingTimers: timers.size, firstPorts: first[0]![0].length,
        recoveredPorts: recovered[0]![0].length, recoveredTop: recovered[0]![1].length,
        warmPorts: warm[0]![0].length }));
    }
  } else {
    let now = 1_000_000;
    Date.now = () => now;
    const calls: string[] = [];
    let fail = process.argv[2] === "recovery";
    Bun.spawn = ((args: string[]) => {
      calls.push(args[0]!);
      if (fail) throw new Error("synthetic probe failure");
      const stdout = args[0]!.endsWith("lsof")
        ? "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nfixture 42 user 10u IPv4 0x1 0t0 TCP *:45678\n"
        : "PID %CPU COMMAND\n42 3.0 fixture-a\n43 2.0 fixture-b\n44 1.0 fixture-c\n";
      return { stdout, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    const wave = () => Promise.all(Array.from({ length: 8 }, (_, i) =>
      Promise.all([getListeningPorts(), getTopCpuProcesses(i === 0 ? 1 : 6)])));
    const first = await wave();
    const coldSpawns = calls.length;
    fail = false;
    const second = await wave();
    const secondSpawns = calls.length - coldSpawns;
    now += 6_000;
    const third = await wave();
    console.log(JSON.stringify({ coldSpawns, secondSpawns, expiredSpawns: calls.length - coldSpawns - secondSpawns,
      firstPorts: first[0]![0].length, secondPorts: second[0]![0].length, finalPorts: third[0]![0].length,
      secondTopLengths: [second[0]![1].length, second[1]![1].length],
      expiredTopLengths: [third[0]![1].length, third[1]![1].length] }));
  }
} finally {
  Bun.spawn = originalSpawn;
  globalThis.setTimeout = originalTimer;
  globalThis.clearTimeout = originalClearTimer;
  Date.now = originalNow;
  rmSync(root, { recursive: true, force: true });
}

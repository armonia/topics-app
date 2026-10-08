/**
 * The liveness question without a synchronous `ps`: a zombie is still dead, a
 * round of N pids costs one listing where there is no /proc, and a listing
 * that fails reads as before (alive when `kill` reaches the pid).
 *
 * @covers LOOP-SPAWN-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createPidLiveness, isPidAlive, livePids, procStatState, watchPidExits } from "./pid-liveness";

const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
});

/**
 * A real zombie: `sh` starts `sleep 0` and execs into a `sleep` that never
 * reaps it. Returns the parent (alive) and the child (a zombie once it exits).
 */
async function zombiePair(): Promise<{ parent: number; zombie: number }> {
  const proc = Bun.spawn(["sh", "-c", "sleep 0 & echo $!; exec sleep 30"], { stdout: "pipe", stderr: "ignore" });
  spawned.push(proc.pid);
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const zombie = Number(new TextDecoder().decode(value).trim());
  // Wait until the child has exited and sits unreaped.
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    try { if (/\)\s+Z/.test(await Bun.file(`/proc/${zombie}/stat`).text())) break; } catch { break; }
    await Bun.sleep(20);
  }
  return { parent: proc.pid, zombie };
}

describe.if(process.platform === "linux")("on Linux, from /proc", () => {
  test("a zombie is dead, its parent alive, a pid that does not exist dead", async () => {
    const { parent, zombie } = await zombiePair();
    expect(isPidAlive(parent)).toBe(true);
    expect(isPidAlive(zombie)).toBe(false);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
    expect([...await livePids([parent, zombie])]).toEqual([parent]);
  });

  test("the listing path reads the same states from a real `ps`", async () => {
    const { parent, zombie } = await zombiePair();
    let listings = 0;
    const real = createPidLiveness({
      probe: (pid) => { process.kill(pid, 0); },
      psStates: async (pids) => {
        listings++;
        const proc = Bun.spawn(["ps", "-o", "pid=,stat=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
        const out = new Map<number, string>();
        for (const line of (await new Response(proc.stdout).text()).split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\S+)/);
          if (m) out.set(Number(m[1]), m[2]!);
        }
        return out;
      },
    });
    expect([...await real.livePids([parent, zombie])]).toEqual([parent]);
    expect(listings).toBe(1);
    // The zombie the round saw is remembered by the synchronous question.
    expect(real.isPidAlive(zombie)).toBe(false);
    expect(real.isPidAlive(parent)).toBe(true);
  });
});

describe("without /proc, one listing per round", () => {
  function fake(states: Map<number, string> | null, live: Set<number>) {
    const calls: number[][] = [];
    const liveness = createPidLiveness({
      probe: (pid) => { if (!live.has(pid)) throw new Error("ESRCH"); },
      psStates: async (pids) => { calls.push(pids); return states; },
    });
    return { liveness, calls };
  }

  test("twenty pids, one listing, the zombie and the missing pid left out", async () => {
    const pids = Array.from({ length: 20 }, (_, i) => 1000 + i);
    const states = new Map(pids.map((pid) => [pid, pid === 1007 ? "Z" : "S"] as [number, string]));
    const { liveness, calls } = fake(states, new Set(pids.filter((pid) => pid !== 1013)));
    const live = await liveness.livePids(pids);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(1013); // gone for `kill`, not asked to `ps`
    expect(live.has(1007)).toBe(false);
    expect(live.has(1013)).toBe(false);
    expect(live.size).toBe(18);
    expect(liveness.isPidAlive(1007)).toBe(false);
    expect(liveness.isPidAlive(1001)).toBe(true);
  });

  test("a listing that fails keeps every pid `kill` reaches alive", async () => {
    const { liveness } = fake(null, new Set([7, 8]));
    expect([...await liveness.livePids([7, 8, 9])].sort()).toEqual([7, 8]);
  });

  test("nothing reachable, no listing at all", async () => {
    const { liveness, calls } = fake(new Map(), new Set());
    expect((await liveness.livePids([5, 6])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a zombie that was reaped and whose pid came back is alive again", async () => {
    const live = new Set([42]);
    let states = new Map([[42, "Z"]]);
    const liveness = createPidLiveness({
      probe: (pid) => { if (!live.has(pid)) throw new Error("ESRCH"); },
      psStates: async () => states,
    });
    await liveness.livePids([42]);
    expect(liveness.isPidAlive(42)).toBe(false);
    live.delete(42);
    expect(liveness.isPidAlive(42)).toBe(false);
    live.add(42);
    states = new Map([[42, "S"]]);
    expect(liveness.isPidAlive(42)).toBe(true);
  });
});

test("the state letter comes after the LAST parenthesis of the command name", () => {
  expect(procStatState("123 (sleep) S 1 123 123 0")).toBe("S");
  expect(procStatState("124 (a) b) Z 1 124")).toBe("Z");
  expect(procStatState("")).toBeNull();
});

describe("watchPidExits: the rows of a round share one probe", () => {
  type Row = { id: string; pid: number | null; closed?: boolean };

  test("twenty rows, one probe per round; a gone row is reported once, a settled one never", async () => {
    const live = new Set(Array.from({ length: 20 }, (_, i) => 100 + i));
    const probes: number[][] = [];
    const gone: string[] = [];
    const add = watchPidExits<Row>({
      everyMs: 5,
      pidOf: (r) => r.pid,
      settled: (r) => !!r.closed,
      onGone: (r) => gone.push(r.id),
      probe: async (pids) => { probes.push(pids); return new Set(pids.filter((p) => live.has(p))); },
    });
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, pid: 100 + i }));
    rows.forEach(add);
    await Bun.sleep(30);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((p) => p.length === 20)).toBe(true);
    live.delete(103);
    rows[7]!.closed = true;
    live.delete(107);
    const before = probes.length;
    await Bun.sleep(30);
    expect(gone).toEqual(["r3"]);
    expect(probes.length).toBeGreaterThan(before);
    expect(probes.at(-1)).toHaveLength(18);
  });

  test("a row without a pid is gone at the first round; a probe that throws does not stop the watch", async () => {
    let fail = true;
    const gone: string[] = [];
    const add = watchPidExits<Row>({
      everyMs: 5,
      pidOf: (r) => r.pid,
      settled: () => false,
      onGone: (r) => gone.push(r.id),
      probe: async () => { if (fail) { fail = false; throw new Error("ps failed"); } return new Set(); },
    });
    add({ id: "nopid", pid: null });
    await Bun.sleep(40);
    expect(gone).toEqual(["nopid"]);
  });
});

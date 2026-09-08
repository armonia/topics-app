/**
 * Actual exported process scheduler and probes in a fresh process, with virtual
 * timers and synthetic command output. Counts work, without running ps/lsof.
 * @covers PROCESS-10
 * @covers RES-ATTR-04
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

function measure(mode: string): Record<string, number | number[]> {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../tests/fixtures/process-runtime-cost.ts"), mode], {
    env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const measured = JSON.parse(result.stdout.toString().trim());
  console.log(`RUNTIME-COST ${mode}`, measured);
  return measured;
}

describe("process runtime costs", () => {
  test("hung shared probes are killed within a bound and the next wave recovers", () => {
    const measured = measure("hang");
    expect(measured.timeouts).toBe(2);
    expect(measured.delays).toEqual([5000, 5000]);
    expect(measured.kills).toBe(2);
    expect(measured.calls).toBe(4);
    expect(measured.pendingTimers).toBe(0);
    expect(measured.firstPorts).toBe(0);
    expect(measured.recoveredPorts).toBe(1);
    expect(measured.recoveredTop).toBe(2);
    expect(measured.warmPorts).toBe(1);
  });
  test("the immediate initial cycle leaves exactly one timer chain, including a concurrent start", () => {
    const measured = measure("timers");
    expect(measured.initial).toEqual([8_000]);
    expect(measured.pending).toBe(1);
    expect(measured.cycles).toBe(6);
  });
  test("eight simultaneous status callers share cold and expired probes; warm calls do not spawn", () => {
    const measured = measure("probes");
    expect(measured.coldSpawns).toBe(2);
    expect(measured.secondSpawns).toBe(0);
    expect(measured.expiredSpawns).toBe(2);
    expect(measured.finalPorts).toBe(1);
    expect(measured.secondTopLengths).toEqual([1, 3]);
    expect(measured.expiredTopLengths).toEqual([1, 3]);
  });
  test("a failed wave does not poison the in-flight promise or prevent the next wave from recovering", () => {
    const measured = measure("recovery");
    expect(measured.coldSpawns).toBe(2);
    expect(measured.firstPorts).toBe(0);
    expect(measured.secondSpawns).toBe(2);
    expect(measured.secondPorts).toBe(1);
    expect(measured.expiredSpawns).toBe(2);
    expect(measured.secondTopLengths).toEqual([1, 3]);
  });
});

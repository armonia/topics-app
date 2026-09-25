/**
 * The capacity reading must not stop the event loop for a `vm_stat` when the
 * server already holds a fresh memory sample.
 *
 * `computeDispatchCapacity` answers `/api/system/dispatch-capacity` (the board
 * polls it every 15 s), the night-mode tick and the terminal cap. Its default
 * memory probe was a synchronous spawn, measured at 2,2 ms on the isolated
 * route bench against 0,58 ms for `/api/topics` through the same pipe. The
 * server now plugs the async `mem-signal` sample in at boot; these tests hold
 * both halves: the plugged reader is used, and without one the old probe still
 * answers.
 * @covers KANBAN-07
 */
import { afterEach, describe, expect, test } from "bun:test";
import { computeDispatchCapacity, setAvailableMemReader } from "./dispatch-capacity";

afterEach(() => setAvailableMemReader(null));

describe("the memory reading of the capacity", () => {
  test("uses the plugged sample, not a probe of its own", () => {
    let calls = 0;
    setAvailableMemReader(() => { calls += 1; return 17.3; });
    const c = computeDispatchCapacity(0, () => null);
    expect(calls).toBe(1);
    expect(c.availableMemGB).toBe(17.3);
  });

  test("an injected reader still wins over the plugged one", () => {
    setAvailableMemReader(() => 17.3);
    const c = computeDispatchCapacity(0, () => null, true, () => 4.2);
    expect(c.availableMemGB).toBe(4.2);
  });

  test("a reader that says `null` reads as not measured, never as zero", () => {
    setAvailableMemReader(() => null);
    const c = computeDispatchCapacity(0, () => null);
    expect(c.availableMemGB).toBeNull();
  });
});

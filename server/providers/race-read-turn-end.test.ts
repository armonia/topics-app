import { describe, expect, test } from "bun:test";
import { raceReadAgainstTurnEnd, type GraceTimers } from "./race-read-turn-end";

/** Manual clock: counts the timers still armed and fires them on demand. */
function fakeTimers() {
  let nextId = 1;
  const live = new Map<number, () => void>();
  const timers: GraceTimers = {
    setTimeout: (fn) => {
      const id = nextId++;
      live.set(id, fn);
      return id;
    },
    clearTimeout: (handle) => {
      live.delete(handle as number);
    },
  };
  return {
    timers,
    liveCount: () => live.size,
    /** Fires every armed timer once (a grace period elapsed). */
    elapse: () => {
      for (const [id, fn] of [...live]) {
        live.delete(id);
        fn();
      }
    },
  };
}

describe("raceReadAgainstTurnEnd", () => {
  test("leaves zero live grace timers after many reads won by the reader", async () => {
    const clock = fakeTimers();
    for (let i = 0; i < 50; i++) {
      const r = await raceReadAgainstTurnEnd(
        async () => ({ done: false, value: new Uint8Array([i]) }),
        () => false,
        20_000,
        clock.timers,
      );
      expect(r.done).toBe(false);
    }
    expect(clock.liveCount()).toBe(0);
  });

  test("a pending timer is cancelled the moment a slow read wins", async () => {
    const clock = fakeTimers();
    let release!: (v: { done: boolean; value?: Uint8Array }) => void;
    const p = raceReadAgainstTurnEnd(
      () => new Promise((res) => { release = res; }),
      () => true,
      20_000,
      clock.timers,
    );
    expect(clock.liveCount()).toBe(1);
    release({ done: false, value: new Uint8Array([1]) });
    expect((await p).done).toBe(false);
    expect(clock.liveCount()).toBe(0);
  });

  test("a chunk before the grace closes nothing, even with the end deposited", async () => {
    const clock = fakeTimers();
    const r = await raceReadAgainstTurnEnd(
      async () => ({ done: false, value: new Uint8Array([1]) }),
      () => true,
      20_000,
      clock.timers,
    );
    expect(r.done).toBe(false);
  });

  test("after a silent grace with the end deposited, the turn is over", async () => {
    const clock = fakeTimers();
    const p = raceReadAgainstTurnEnd(() => new Promise(() => {}), () => true, 20_000, clock.timers);
    clock.elapse();
    expect((await p).done).toBe(true);
    expect(clock.liveCount()).toBe(0);
  });

  test("a silent grace without the end re-arms exactly one timer, then closes when the end lands", async () => {
    const clock = fakeTimers();
    let ended = false;
    const p = raceReadAgainstTurnEnd(() => new Promise(() => {}), () => ended, 20_000, clock.timers);
    clock.elapse();
    expect(clock.liveCount()).toBe(1);
    ended = true;
    clock.elapse();
    expect((await p).done).toBe(true);
    expect(clock.liveCount()).toBe(0);
  });

  test("a rejected read also clears the timer", async () => {
    const clock = fakeTimers();
    await expect(
      raceReadAgainstTurnEnd(() => Promise.reject(new Error("boom")), () => false, 20_000, clock.timers),
    ).rejects.toThrow("boom");
    expect(clock.liveCount()).toBe(0);
  });

  test("with real timers: a won read leaves nothing that wakes later", async () => {
    let checks = 0;
    for (let i = 0; i < 20; i++) {
      await raceReadAgainstTurnEnd(
        async () => ({ done: false, value: new Uint8Array([i]) }),
        () => { checks++; return false; },
        5,
      );
    }
    await Bun.sleep(40);
    expect(checks).toBe(0);
  });
});

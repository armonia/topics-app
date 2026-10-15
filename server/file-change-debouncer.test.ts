import { describe, expect, test } from "bun:test";
import { fileChangeDebouncer, FILE_CHANGE_DEBOUNCE_MS, FILE_CHANGE_SETTLE_MS } from "./file-change-debouncer";

/** @covers FILE-02 */
interface TimerTask {
  at: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeTimers {
  now = 0;
  private tasks: TimerTask[] = [];

  setTimeout = (callback: () => void, delayMs: number): TimerTask => {
    const task = { at: this.now + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return task;
  };

  clearTimeout = (handle: unknown): void => {
    (handle as TimerTask).cancelled = true;
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cancelled = true;
      this.now = next.at;
      next.callback();
    }
    this.now = target;
  }
}

function fixture() {
  const timers = new FakeTimers();
  const refreshes: { at: number; generation: number }[] = [];
  let generation = 0;
  const debouncer = fileChangeDebouncer(
    (value) => refreshes.push({ at: timers.now, generation: value }),
    () => ++generation,
    FILE_CHANGE_SETTLE_MS,
    FILE_CHANGE_DEBOUNCE_MS,
    timers,
  );
  return { debouncer, timers, refreshes };
}

describe("file change debouncer", () => {
  test("one event refreshes after the settle window only", () => {
    const { debouncer, timers, refreshes } = fixture();
    debouncer.onChange();
    timers.advance(FILE_CHANGE_SETTLE_MS - 1);
    expect(refreshes).toEqual([]);
    timers.advance(1);
    expect(refreshes).toEqual([{ at: FILE_CHANGE_SETTLE_MS, generation: 1 }]);
    timers.advance(FILE_CHANGE_DEBOUNCE_MS);
    expect(refreshes).toHaveLength(1);
  });

  test("a burst refreshes once early and once after its final quiet window", () => {
    const { debouncer, timers, refreshes } = fixture();
    debouncer.onChange();
    for (let event = 1; event < 50; event += 1) {
      timers.advance(20);
      debouncer.onChange();
    }
    expect(timers.now).toBe(980);
    expect(refreshes).toEqual([{ at: FILE_CHANGE_SETTLE_MS, generation: 3 }]);
    timers.advance(FILE_CHANGE_DEBOUNCE_MS - 1);
    expect(refreshes).toHaveLength(1);
    timers.advance(1);
    expect(refreshes).toEqual([
      { at: FILE_CHANGE_SETTLE_MS, generation: 3 },
      { at: 980 + FILE_CHANGE_DEBOUNCE_MS, generation: 50 },
    ]);
  });

  test("an atomic save, three events a few ms apart, refreshes once", () => {
    const { debouncer, timers, refreshes } = fixture();
    debouncer.onChange();
    timers.advance(2);
    debouncer.onChange();
    timers.advance(3);
    debouncer.onChange();
    timers.advance(FILE_CHANGE_SETTLE_MS + FILE_CHANGE_DEBOUNCE_MS);
    expect(refreshes).toEqual([{ at: FILE_CHANGE_SETTLE_MS, generation: 3 }]);
  });

  test("no event produces no refresh", () => {
    const { timers, refreshes } = fixture();
    timers.advance(10_000);
    expect(refreshes).toEqual([]);
  });

  test("saves two seconds apart each get their own early refresh", () => {
    const { debouncer, timers, refreshes } = fixture();
    debouncer.onChange();
    timers.advance(2_000);
    debouncer.onChange();
    timers.advance(FILE_CHANGE_SETTLE_MS);
    expect(refreshes).toEqual([
      { at: FILE_CHANGE_SETTLE_MS, generation: 1 },
      { at: 2_000 + FILE_CHANGE_SETTLE_MS, generation: 2 },
    ]);
    timers.advance(FILE_CHANGE_DEBOUNCE_MS);
    expect(refreshes).toHaveLength(2);
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import {
  hasReceivedServerHydrate,
  markServerHydrated,
  onServerHydrated,
  __resetServerHydratedForTests,
} from "./serverHydrated";

describe("serverHydrated", () => {
  beforeEach(() => {
    __resetServerHydratedForTests();
  });

  test("hasReceivedServerHydrate is false before mark, true after", () => {
    expect(hasReceivedServerHydrate()).toBe(false);
    markServerHydrated();
    expect(hasReceivedServerHydrate()).toBe(true);
  });

  test("markServerHydrated is idempotent", () => {
    markServerHydrated();
    markServerHydrated();
    expect(hasReceivedServerHydrate()).toBe(true);
  });

  test("onServerHydrated fires once when mark is called after subscribe", () => {
    let fired = 0;
    onServerHydrated(() => { fired++; });
    expect(fired).toBe(0);
    markServerHydrated();
    expect(fired).toBe(1);
    // Idempotent mark must not re-fire the listener.
    markServerHydrated();
    expect(fired).toBe(1);
  });

  test("onServerHydrated fires asynchronously when already hydrated at subscribe time", async () => {
    markServerHydrated();
    let fired = 0;
    onServerHydrated(() => { fired++; });
    // Hot path: listener queued via queueMicrotask, NOT invoked synchronously.
    expect(fired).toBe(0);
    await Promise.resolve();
    expect(fired).toBe(1);
  });

  test("multiple listeners all fire on first mark", () => {
    const calls: string[] = [];
    onServerHydrated(() => calls.push("a"));
    onServerHydrated(() => calls.push("b"));
    onServerHydrated(() => calls.push("c"));
    markServerHydrated();
    expect(calls.sort()).toEqual(["a", "b", "c"]);
  });

  test("unsubscribe before mark prevents listener from firing", () => {
    let fired = 0;
    const unsubscribe = onServerHydrated(() => { fired++; });
    unsubscribe();
    markServerHydrated();
    expect(fired).toBe(0);
  });

  test("listener exception does not block other listeners", () => {
    let fired = 0;
    onServerHydrated(() => { throw new Error("boom"); });
    onServerHydrated(() => { fired++; });
    markServerHydrated();
    expect(fired).toBe(1);
  });

  test("listener registered during fire does not re-fire in same flush", () => {
    let nestedFired = 0;
    onServerHydrated(() => {
      // A listener registered while the flush is in progress should not be
      // invoked in this same flush — we cleared the set before iterating.
      onServerHydrated(() => { nestedFired++; });
    });
    markServerHydrated();
    expect(nestedFired).toBe(0);
  });
});

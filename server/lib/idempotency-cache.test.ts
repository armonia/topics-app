/**
 * @covers RUNTIME-02
 */
import { describe, it, expect } from "bun:test";
import { createIdempotencyCache } from "./idempotency-cache";

/** A controllable clock so TTL/expiry is deterministic (no real timers). */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("idempotency-cache", () => {
  it("returns null for an unknown key", () => {
    const c = createIdempotencyCache();
    expect(c.lookup("nope")).toBeNull();
  });

  it("remembers then returns the value within TTL", () => {
    const clk = fakeClock();
    const c = createIdempotencyCache({ ttlMs: 60_000, now: clk.now });
    c.remember("k", "session-1");
    clk.advance(59_999);
    expect(c.lookup("k")).toBe("session-1");
  });

  it("expires an entry past its TTL and evicts it on lookup", () => {
    const clk = fakeClock();
    const c = createIdempotencyCache({ ttlMs: 60_000, now: clk.now });
    c.remember("k", "session-1");
    clk.advance(60_001);
    expect(c.lookup("k")).toBeNull();
    // The expired entry was deleted by the lookup, not merely hidden.
    expect(c.size()).toBe(0);
  });

  it("treats exactly-at-TTL as still valid (expiresAt < now is strict)", () => {
    const clk = fakeClock();
    const c = createIdempotencyCache({ ttlMs: 1_000, now: clk.now });
    c.remember("k", "v");
    clk.advance(1_000); // now === expiresAt, not strictly past
    expect(c.lookup("k")).toBe("v");
  });

  it("overwrites and re-stamps the TTL on a repeated remember", () => {
    const clk = fakeClock();
    const c = createIdempotencyCache({ ttlMs: 1_000, now: clk.now });
    c.remember("k", "v1");
    clk.advance(900);
    c.remember("k", "v2"); // re-stamp at t=1900, expires at 2900
    clk.advance(900);      // t=1800 < 2900 → still valid as v2
    expect(c.lookup("k")).toBe("v2");
  });

  it("opportunistically sweeps expired entries once it grows past maxSize", () => {
    const clk = fakeClock();
    const c = createIdempotencyCache({ ttlMs: 1_000, maxSize: 4, now: clk.now });
    // Fill with entries that will expire.
    c.remember("a", "1");
    c.remember("b", "2");
    c.remember("c", "3");
    c.remember("d", "4");
    expect(c.size()).toBe(4); // not yet over maxSize, no sweep
    clk.advance(2_000);       // a..d now expired
    // This remember pushes size to 5 (> maxSize) → triggers the sweep, which
    // drops the 4 expired entries, leaving only the fresh one.
    c.remember("e", "5");
    expect(c.size()).toBe(1);
    expect(c.lookup("e")).toBe("5");
  });

  it("keeps still-valid entries during a sweep", () => {
    const clk = fakeClock();
    const c = createIdempotencyCache({ ttlMs: 10_000, maxSize: 2, now: clk.now });
    c.remember("old", "x");
    clk.advance(11_000); // "old" expired
    c.remember("fresh1", "y");
    c.remember("fresh2", "z"); // size now 3 > maxSize → sweep drops only "old"
    expect(c.lookup("old")).toBeNull();
    expect(c.lookup("fresh1")).toBe("y");
    expect(c.lookup("fresh2")).toBe("z");
  });
});

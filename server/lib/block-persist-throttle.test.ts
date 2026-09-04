/**
 * The rule the throttle applies, stated as tests: WHEN the turn is allowed to
 * rewrite its `blocks` column. What that write costs is measured elsewhere,
 * against a real database (server/turn-write-cost.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { createBlockPersistThrottle } from "./block-persist-throttle";

function spy() {
  const calls: number[] = [];
  const throttle = createBlockPersistThrottle({ write: () => calls.push(calls.length) });
  return { calls, throttle };
}

describe("block persist throttle", () => {
  test("the first write always goes through: the row must show something", () => {
    const { calls, throttle } = spy();
    throttle.persist(1_000);
    expect(calls.length).toBe(1);
    throttle.dispose();
  });

  test("a payload that has not doubled is deferred, not lost", () => {
    const { calls, throttle } = spy();
    throttle.persist(100_000);
    throttle.persist(120_000);
    throttle.persist(150_000);
    expect(calls.length).toBe(1);
    throttle.flush();
    expect(calls.length).toBe(2);
    throttle.dispose();
  });

  test("doubling earns its write immediately", () => {
    const { calls, throttle } = spy();
    throttle.persist(100_000);
    throttle.persist(200_000);
    throttle.persist(400_000);
    expect(calls.length).toBe(3);
    throttle.dispose();
  });

  test("force writes even when nothing grew: a panel on screen cannot wait", () => {
    const { calls, throttle } = spy();
    throttle.persist(100_000);
    throttle.persist(100_001);
    expect(calls.length).toBe(1);
    throttle.persist(100_002, true);
    expect(calls.length).toBe(2);
    throttle.dispose();
  });

  test("flush with nothing pending writes nothing", () => {
    const { calls, throttle } = spy();
    throttle.persist(100_000);
    throttle.flush();
    throttle.flush();
    expect(calls.length).toBe(1);
    throttle.dispose();
  });

  test("dispose drops the deferred write instead of firing it later", async () => {
    const { calls, throttle } = spy();
    throttle.persist(100_000);
    throttle.persist(110_000);
    throttle.dispose();
    await Bun.sleep(30);
    expect(calls.length).toBe(1);
  });

  test("a deferred write lands on its own when the turn goes quiet", async () => {
    const { calls, throttle } = spy();
    // Small payload: the delay floor is one second, so this is the slowest
    // case the policy allows and it still lands without anyone asking.
    throttle.persist(10);
    throttle.persist(11);
    expect(calls.length).toBe(1);
    await Bun.sleep(1_200);
    expect(calls.length).toBe(2);
    throttle.dispose();
  });
});

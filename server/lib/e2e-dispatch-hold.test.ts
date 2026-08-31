/** @covers KANBAN-07 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  DISPATCH_HOLD_MAX_MS,
  dispatchReconcileHeld,
  holdDispatchReconcile,
  releaseDispatchHold,
} from "./e2e-dispatch-hold";

describe("e2e dispatch hold", () => {
  beforeEach(() => releaseDispatchHold());

  it("is off until someone asks for it", () => {
    expect(dispatchReconcileHeld(1_000)).toBe(false);
  });

  it("holds for the window and then lets go on its own", () => {
    holdDispatchReconcile(5_000, 1_000);
    expect(dispatchReconcileHeld(5_999)).toBe(true);
    expect(dispatchReconcileHeld(6_000)).toBe(false);
  });

  it("caps a window that would park the dispatcher for good", () => {
    const until = holdDispatchReconcile(60 * 60_000, 0);
    expect(until).toBe(DISPATCH_HOLD_MAX_MS);
  });

  it("is dropped by the hermetic reset, so it cannot cross into the next file", () => {
    holdDispatchReconcile(60_000, 1_000);
    releaseDispatchHold();
    expect(dispatchReconcileHeld(2_000)).toBe(false);
  });

  it("a zero window releases instead of pinning `now`", () => {
    holdDispatchReconcile(60_000, 1_000);
    holdDispatchReconcile(0, 1_000);
    expect(dispatchReconcileHeld(1_000)).toBe(false);
  });
});

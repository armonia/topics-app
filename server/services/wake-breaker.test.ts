/**
 * A node whose wakes keep failing is not picked as a sleeping target.
 * 2026-11-10: the PC stuck at the login screen got 17 cards in half an hour.
 *
 * @covers KANBAN-76
 */
import { test, expect } from "bun:test";
import { pickOverflowMachine, type OverflowMachine } from "./dispatch-overflow";
import { createWakeBreaker, WAKE_OPEN_BASE_MS } from "./wake-breaker";

const pc: OverflowMachine = { id: "pc", name: "PC", kind: "node", online: false, wakeable: true };
const opts = { cloudCredit: false, githubOrigin: false, model: null, load: () => 0 };

test("two failed wakes in a row: the sleeping PC is no longer a target, until the window ends", () => {
  const clock = { t: 0 };
  const b = createWakeBreaker(() => clock.t);
  const pick = () => pickOverflowMachine([pc], { ...opts, wakeBlocked: (id) => b.isOpen(id) });
  expect(pick()?.id).toBe("pc");
  b.failure("pc");
  expect(pick()?.id).toBe("pc");
  b.failure("pc");
  expect(pick()).toBeNull();
  clock.t += WAKE_OPEN_BASE_MS + 1;
  expect(pick()?.id).toBe("pc");
  b.failure("pc"); // third failure: the window doubles
  clock.t += WAKE_OPEN_BASE_MS + 1;
  expect(pick()).toBeNull();
  b.success("pc");
  expect(pick()?.id).toBe("pc");
});


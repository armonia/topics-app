import { describe, test, expect } from "bun:test";
import {
  scheduleTerminalCleanup,
  cancelTerminalCleanup,
  reopenClosedTab,
  type ClosedTabRecord,
} from "./closedTabRecord";

/**
 * Tests the module-level cleanup-timer registry used to defer terminal
 * DELETE by 60s after close, so Cmd+Shift+U (undo) can reattach to the
 * same live session. See RESEARCH.md pitfall #4 — timers must live
 * outside Immer state.
 *
 * We use short real delays (50 ms) + a slightly longer wait (120 ms) to
 * avoid depending on bun's fake-timer flag. Test runtime stays well
 * under a second overall.
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("scheduleTerminalCleanup / cancelTerminalCleanup", () => {
  test("fires the callback after the given delay", async () => {
    let fired = false;
    scheduleTerminalCleanup("test-fire-1", 50, () => {
      fired = true;
    });
    expect(fired).toBe(false);
    await wait(120);
    expect(fired).toBe(true);
  });

  test("cancelTerminalCleanup before the delay prevents the callback", async () => {
    let fired = false;
    scheduleTerminalCleanup("test-cancel-1", 50, () => {
      fired = true;
    });
    cancelTerminalCleanup("test-cancel-1");
    await wait(120);
    expect(fired).toBe(false);
  });

  test("rescheduling with the same id clears the prior timer (no double-fire)", async () => {
    let count = 0;
    scheduleTerminalCleanup("test-reschedule-1", 50, () => {
      count += 1;
    });
    // Reschedule with a new callback that also bumps the counter.
    scheduleTerminalCleanup("test-reschedule-1", 50, () => {
      count += 1;
    });
    await wait(120);
    // Only the second schedule should have fired; the first was cleared.
    expect(count).toBe(1);
  });

  test("cancelTerminalCleanup on an unknown id is a no-op (doesn't throw)", () => {
    expect(() => cancelTerminalCleanup("never-scheduled")).not.toThrow();
  });
});

describe("reopenClosedTab (non-terminal path)", () => {
  const baseRecord = (pane: ClosedTabRecord["pane"]): ClosedTabRecord => ({
    id: pane.id,
    closedAt: Date.now(),
    pane,
    groupId: "group:default",
    groupIndex: 0,
    level: "app",
  });

  test("returns the captured pane verbatim for a chat record (no network round-trip)", async () => {
    const pane = { id: "chat:t1", type: "chat" as const, title: "A", topicId: "t1" };
    const result = await reopenClosedTab(baseRecord(pane));
    // Instant reopen: the pane is restored from the in-memory record as-is.
    expect(result).toBe(pane);
  });

  test("cancels a pending terminal cleanup timer for the record id", async () => {
    let fired = false;
    const pane = { id: "chat:t2", type: "chat" as const, title: "B", topicId: "t2" };
    scheduleTerminalCleanup("chat:t2", 50, () => { fired = true; });
    await reopenClosedTab(baseRecord(pane)); // cancels cleanup for record.id
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(fired).toBe(false);
  });
});

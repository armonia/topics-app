import { describe, test, expect } from "bun:test";
import {
  scheduleTerminalCleanup,
  cancelTerminalCleanup,
  reopenClosedTab,
  selectProjectBrowserReopen,
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

describe("selectProjectBrowserReopen (pinned-browser reopen routing)", () => {
  const rec = (
    over: Partial<ClosedTabRecord> & { pane: ClosedTabRecord["pane"] },
  ): ClosedTabRecord => ({
    id: over.pane.id,
    closedAt: over.closedAt ?? Date.now(),
    groupId: "group:default",
    groupIndex: 0,
    level: "app",
    ...over,
  });

  const projectBrowser = (id: string, url: string, projectPath: string, closedAt?: number) =>
    rec({
      pane: { id, type: "browser" as const, title: "Browser", url },
      level: "project",
      projectPath,
      ...(closedAt !== undefined ? { closedAt } : {}),
    });

  test("returns the project-level browser record for the matching pane (url + projectPath preserved)", () => {
    const target = projectBrowser("browser:ctx1", "https://example.com", "/tmp/proj");
    const out = selectProjectBrowserReopen([target], "browser:ctx1");
    expect(out).toBe(target);
    expect(out?.pane.url).toBe("https://example.com");
    expect(out?.projectPath).toBe("/tmp/proj");
  });

  test("returns null for a STANDALONE (level:'app') browser record → falls through to standalone open", () => {
    const appBrowser = rec({ pane: { id: "browser:ctx1", type: "browser" as const, title: "B", url: "https://x.com" } });
    expect(selectProjectBrowserReopen([appBrowser], "browser:ctx1")).toBeNull();
  });

  test("returns null when no record matches the browser pane id", () => {
    const other = projectBrowser("browser:ctxOTHER", "https://a.com", "/tmp/proj");
    expect(selectProjectBrowserReopen([other], "browser:ctx1")).toBeNull();
  });

  test("returns null for a project record missing projectPath (nothing to route into)", () => {
    const noPath = rec({
      pane: { id: "browser:ctx1", type: "browser" as const, title: "B", url: "https://x.com" },
      level: "project",
    });
    expect(selectProjectBrowserReopen([noPath], "browser:ctx1")).toBeNull();
  });

  test("ignores a non-browser project record that happens to share the id", () => {
    const chat = rec({
      pane: { id: "browser:ctx1", type: "chat" as const, title: "C", topicId: "t1" },
      level: "project",
      projectPath: "/tmp/proj",
    });
    expect(selectProjectBrowserReopen([chat], "browser:ctx1")).toBeNull();
  });

  test("returns the NEWEST matching record (closedTabs is newest-first)", () => {
    // useClosedTabs reverses the reducer stack → newest at index 0.
    const newest = projectBrowser("browser:ctx1", "https://new.com", "/tmp/projB", 2000);
    const older = projectBrowser("browser:ctx1", "https://old.com", "/tmp/projA", 1000);
    const out = selectProjectBrowserReopen([newest, older], "browser:ctx1");
    expect(out).toBe(newest);
    expect(out?.pane.url).toBe("https://new.com");
  });

  test("empty stack → null", () => {
    expect(selectProjectBrowserReopen([], "browser:ctx1")).toBeNull();
  });
});

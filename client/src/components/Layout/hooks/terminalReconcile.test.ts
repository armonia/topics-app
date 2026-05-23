/**
 * Tests for shouldKeepRestoredTerminalPane — the guard that stops a refresh /
 * hot-reload from deleting a project's restored Claude Code tabs while the
 * server session roster is momentarily empty or incomplete.
 */
import { describe, test, expect } from "bun:test";
import { shouldKeepRestoredTerminalPane } from "./terminalReconcile";

const set = (...ids: string[]) => new Set(ids);

describe("shouldKeepRestoredTerminalPane", () => {
  test("keeps a pane whose session is in the current roster", () => {
    expect(shouldKeepRestoredTerminalPane("s1", set("s1", "s2"), set("s1"))).toBe(true);
  });

  test("keeps a restored pane never seen yet (roster not caught up after reload)", () => {
    // Empty roster (server mid-restart): nothing seen → keep everything.
    expect(shouldKeepRestoredTerminalPane("s1", set(), set())).toBe(true);
  });

  test("keeps a restored pane during a PARTIAL roster (reconnect race)", () => {
    // Roster lists s2 but not yet s1; s1 has never been seen → still pending.
    expect(shouldKeepRestoredTerminalPane("s1", set("s2"), set("s2"))).toBe(true);
  });

  test("prunes a seen-then-gone session (closed in another window)", () => {
    // s1 was seen in an earlier roster, now absent from a real roster → stale.
    expect(shouldKeepRestoredTerminalPane("s1", set("s2"), set("s1", "s2"))).toBe(false);
  });

  test("the reload scenario: empty roster never prunes restored tabs", () => {
    const restored = ["t1", "t2", "t3"];
    const kept = restored.filter((id) => shouldKeepRestoredTerminalPane(id, set(), set()));
    expect(kept).toEqual(restored);
  });

  test("after the real roster lands, survivors stay and a genuinely-closed one prunes", () => {
    // First an empty roster (seen stays empty) — all kept.
    const seen = new Set<string>();
    // Then the reconciled roster arrives with t1,t2 (t3 was closed before reload
    // so it was never persisted; here we model t3 as seen-then-gone).
    for (const id of ["t1", "t2", "t3"]) seen.add(id);
    const roster = set("t1", "t2");
    expect(shouldKeepRestoredTerminalPane("t1", roster, seen)).toBe(true);
    expect(shouldKeepRestoredTerminalPane("t2", roster, seen)).toBe(true);
    expect(shouldKeepRestoredTerminalPane("t3", roster, seen)).toBe(false);
  });
});

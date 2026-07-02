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

  // ── Authoritative-roster reaping (the app-restart "sessioni morte" fix) ──────

  test("prunes a never-seen id when an authoritative (non-empty) roster omits it", () => {
    // App restart: a dead terminal id restored from a project's persisted
    // nonChatPanes. The real roster is populated (server is up) but doesn't list
    // it, and it was never seen this mount → genuine corpse, reap it.
    expect(shouldKeepRestoredTerminalPane("dead", set("s1", "s2"), set(), true)).toBe(false);
  });

  test("keeps a never-seen id when the roster is EMPTY even if flagged authoritative", () => {
    // Defensive: an empty roster can never be authoritative in practice (the
    // caller only sets the flag when size>0), but the guard must never reap on
    // an empty roster — that is the hot-reload window.
    expect(shouldKeepRestoredTerminalPane("s1", set(), set(), false)).toBe(true);
  });

  test("keeps a live id present in an authoritative roster", () => {
    expect(shouldKeepRestoredTerminalPane("s1", set("s1", "s2"), set("s1"), true)).toBe(true);
  });

  test("still keeps never-seen ids during a partial roster that is NOT authoritative", () => {
    // Server mid-restart delivered a roster the caller judged unproven → keep.
    expect(shouldKeepRestoredTerminalPane("s1", set("s2"), set("s2"), false)).toBe(true);
  });

  test("the restart scenario: one live tab survives, the dead ones are reaped", () => {
    // Persisted project tabs: t-live (still running) + two corpses from a prior
    // run. The authoritative roster lists only t-live.
    const restored = ["t-live", "t-dead1", "t-dead2"];
    const roster = set("t-live", "other-project-session");
    const seen = new Set<string>();
    for (const id of roster) seen.add(id); // roster ids are seen this pass
    const kept = restored.filter((id) =>
      shouldKeepRestoredTerminalPane(id, roster, seen, true),
    );
    expect(kept).toEqual(["t-live"]);
  });
});

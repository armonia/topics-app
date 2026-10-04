/**
 * Tests for reconcileTerminalSignals — the pure helper that re-derives the
 * busy set from the authoritative server session roster.
 *
 * This is the backbone of the "stuck in progress" fix: incremental
 * terminal:activity deltas can be lost (server hot-reload, WS reconnect,
 * dropped message), so loading state must be reconcilable from the roster.
 * The "finished" set it used to prune is the server's attention state now
 * (a closed terminal is composed `idle`, notifications-redesign).
 *
 * @covers TERM-01
 */
import { describe, test, expect } from "bun:test";
import { reconcileTerminalSignals, type TerminalRosterEntry } from "./signals";

const roster = (entries: Array<[string, boolean]>): TerminalRosterEntry[] =>
  entries.map(([id, busy]) => ({ id, busy }));

describe("reconcileTerminalSignals", () => {
  test("clears stale busy when the roster reports the session idle", () => {
    expect(reconcileTerminalSignals(new Set(["a"]), roster([["a", false]])).has("a")).toBe(false);
  });

  test("keeps busy when the roster still reports the session busy", () => {
    expect(reconcileTerminalSignals(new Set(["a"]), roster([["a", true]])).has("a")).toBe(true);
  });

  test("adds busy the delta missed but the roster knows about", () => {
    expect(reconcileTerminalSignals(new Set(), roster([["a", true]])).has("a")).toBe(true);
  });

  test("prunes busy for a session that no longer exists", () => {
    expect(reconcileTerminalSignals(new Set(["a", "gone"]), roster([["a", true]]))).toEqual(new Set(["a"]));
  });

  test("missing busy field is treated as idle", () => {
    expect(reconcileTerminalSignals(new Set(["a"]), [{ id: "a" }]).size).toBe(0);
  });

  test("returns the identical set reference on no-op (avoids re-render churn)", () => {
    const prevBusy = new Set(["a"]);
    expect(reconcileTerminalSignals(prevBusy, roster([["a", true]]))).toBe(prevBusy);
  });

  test("empty roster clears all busy", () => {
    expect(reconcileTerminalSignals(new Set(["a"]), []).size).toBe(0);
  });
});

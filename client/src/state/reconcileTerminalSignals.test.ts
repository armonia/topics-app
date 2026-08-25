/**
 * Tests for reconcileTerminalSignals — the pure helper that re-derives the
 * busy/finished sets from the authoritative server session roster.
 *
 * This is the backbone of the "stuck in progress" fix: incremental
 * terminal:activity deltas can be lost (server hot-reload, WS reconnect,
 * dropped message), so loading state must be reconcilable from the roster.
 *
 * @covers TERM-01
 */
import { describe, test, expect } from "bun:test";
import { reconcileTerminalSignals, type TerminalRosterEntry } from "./signals";

const roster = (entries: Array<[string, boolean]>): TerminalRosterEntry[] =>
  entries.map(([id, busy]) => ({ id, busy }));

describe("reconcileTerminalSignals", () => {
  test("clears stale busy when the roster reports the session idle", () => {
    const prevBusy = new Set(["a"]);
    const prevFinished = new Set<string>();
    const { busy } = reconcileTerminalSignals(prevBusy, prevFinished, roster([["a", false]]));
    expect([...busy]).toEqual([]);
  });

  test("keeps busy when the roster still reports the session busy", () => {
    const prevBusy = new Set(["a"]);
    const { busy } = reconcileTerminalSignals(prevBusy, new Set(), roster([["a", true]]));
    expect([...busy]).toEqual(["a"]);
  });

  test("adds busy the delta missed but the roster knows about", () => {
    const { busy } = reconcileTerminalSignals(new Set(), new Set(), roster([["a", true]]));
    expect([...busy]).toEqual(["a"]);
  });

  test("prunes busy for a session that no longer exists", () => {
    const prevBusy = new Set(["a", "gone"]);
    const { busy } = reconcileTerminalSignals(prevBusy, new Set(), roster([["a", true]]));
    expect([...busy].sort()).toEqual(["a"]);
  });

  test("prunes finished only when its session is gone, keeps it otherwise", () => {
    const prevFinished = new Set(["here", "gone"]);
    const { finished } = reconcileTerminalSignals(new Set(), prevFinished, roster([["here", false]]));
    expect([...finished]).toEqual(["here"]);
  });

  test("does not clear a finished badge just because busy went false", () => {
    // A completed-turn badge must survive roster broadcasts (busy:false) until
    // the user looks — only session removal drops it.
    const prevFinished = new Set(["a"]);
    const { finished } = reconcileTerminalSignals(new Set(), prevFinished, roster([["a", false]]));
    expect([...finished]).toEqual(["a"]);
  });

  test("missing busy field is treated as idle", () => {
    const prevBusy = new Set(["a"]);
    const { busy } = reconcileTerminalSignals(prevBusy, new Set(), [{ id: "a" }]);
    expect([...busy]).toEqual([]);
  });

  test("returns identical set references on no-op (avoids re-render churn)", () => {
    const prevBusy = new Set(["a"]);
    const prevFinished = new Set(["a"]);
    const out = reconcileTerminalSignals(prevBusy, prevFinished, roster([["a", true]]));
    expect(out.busy).toBe(prevBusy);
    expect(out.finished).toBe(prevFinished);
  });

  test("empty roster clears all busy and finished", () => {
    const { busy, finished } = reconcileTerminalSignals(new Set(["a"]), new Set(["b"]), []);
    expect([...busy]).toEqual([]);
    expect([...finished]).toEqual([]);
  });
});

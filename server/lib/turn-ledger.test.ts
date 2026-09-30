/**
 * The server's single answer to "is a turn open on this session?".
 *
 * The case that made it necessary: the CLI opens a turn by itself (a
 * notification, a cron fire) and Topics registers it only at the model's first
 * line. During that window `activeStreams` said "free" and a message was
 * written into the running turn. Here the CLI's own state holds the session
 * open from its `system/init` to its `result`, whatever the route knows.
 *
 * @covers CHAT-QUEUE-07
 */
import { describe, expect, test } from "bun:test";
import { createTurnLedger, type TurnState } from "./turn-ledger";

function ledger() {
  const changes: TurnState[] = [];
  const l = createTurnLedger({ boot: "b1", onChange: (s) => changes.push(s) });
  return { l, changes };
}

describe("turn ledger", () => {
  test("a spontaneous CLI turn holds the session open before any route registers it", () => {
    const { l, changes } = ledger();
    l.set("topic:a", "cli", true);
    expect(l.isOpen("topic:a")).toBe(true);
    // The route adopts it later: still the same turn, no second open.
    l.set("topic:a", "route", true);
    expect(changes.map((c) => c.open)).toEqual([true]);
    // The route closes its stream while the CLI has not printed its `result` yet.
    l.set("topic:a", "route", false);
    expect(l.isOpen("topic:a")).toBe(true);
    expect(changes).toHaveLength(1);
    l.set("topic:a", "cli", false);
    expect(l.isOpen("topic:a")).toBe(false);
    expect(changes.map((c) => c.open)).toEqual([true, false]);
  });

  test("the close names the turn that closed, and revisions only grow", () => {
    const { l, changes } = ledger();
    l.set("topic:a", "route", true);
    l.set("topic:b", "route", true);
    l.set("topic:a", "route", false);
    const [openA, , closeA] = changes;
    expect(closeA.turnId).toBe(openA.turnId);
    expect(closeA.asOf).toBeGreaterThan(openA.asOf);
    expect(changes.map((c) => c.asOf)).toEqual([1, 2, 3]);
    expect(l.stateOf("topic:a")).toMatchObject({ open: false, turnId: openA.turnId, asOf: 3, boot: "b1" });
  });

  test("setting a source twice, or clearing one never set, is not a transition", () => {
    const { l, changes } = ledger();
    l.set("topic:a", "cli", false);
    l.set("topic:a", "route", true);
    l.set("topic:a", "route", true);
    expect(changes).toHaveLength(1);
  });

  test("the snapshot lists only open sessions, as of the current revision", () => {
    const { l } = ledger();
    l.set("topic:a", "route", true);
    l.set("topic:b", "boot", true);
    l.set("topic:a", "route", false);
    const snap = l.snapshot();
    expect(snap.asOf).toBe(3);
    expect(snap.open.map((s) => s.sessionKey)).toEqual(["topic:b"]);
  });

  test("a resume sent by the boot sweep may pass the boot hold, nothing else", () => {
    const { l } = ledger();
    l.set("topic:a", "boot", true);
    expect(l.isOpen("topic:a", { ignore: ["boot"] })).toBe(false);
    l.set("topic:a", "cli", true);
    expect(l.isOpen("topic:a", { ignore: ["boot"] })).toBe(true);
  });

  test("a Stop is said with the close, whichever source closes last, and forgotten by the next turn", () => {
    const { l, changes } = ledger();
    l.set("topic:a", "route", true);
    l.set("topic:a", "cli", true);
    l.noteEnd("topic:a", { stopped: true });
    l.set("topic:a", "route", false);
    l.set("topic:a", "cli", false);
    expect(changes.at(-1)).toMatchObject({ open: false, stopped: true });
    expect(l.stateOf("topic:a").stopped).toBe(true);
    l.set("topic:a", "route", true);
    l.set("topic:a", "route", false);
    expect(changes.at(-1)!.stopped).toBeUndefined();
  });

  test("an end noted with no turn open says nothing", () => {
    const { l, changes } = ledger();
    l.noteEnd("topic:a", { stopped: true, awaitsHuman: true });
    l.set("topic:a", "route", true);
    l.set("topic:a", "route", false);
    expect(changes.at(-1)).toEqual({ sessionKey: "topic:a", boot: "b1", asOf: 2, turnId: 1, open: false });
  });

  test("a turn that ended on a question for a person is listed in the snapshot, closed", () => {
    const { l, changes } = ledger();
    l.set("topic:a", "route", true);
    l.noteEnd("topic:a", { awaitsHuman: true });
    l.set("topic:a", "route", false);
    expect(changes.at(-1)).toMatchObject({ open: false, awaitsHuman: true });
    const snap = l.snapshot();
    expect(snap.open).toEqual([]);
    expect(snap.awaiting).toEqual([{ sessionKey: "topic:a", boot: "b1", asOf: 2, turnId: 1, open: false, awaitsHuman: true }]);
  });

  test("a Stop outlives its close: a window that was away learns it from the snapshot, even after a later turn", () => {
    // The phone in the background has no socket when the close says `stopped`:
    // the reconnect's snapshot is the only word it gets.
    const { l } = ledger();
    l.set("topic:a", "route", true);
    l.noteEnd("topic:a", { stopped: true });
    l.set("topic:a", "route", false);
    expect(l.snapshot().stopped).toEqual([{ sessionKey: "topic:a", boot: "b1", asOf: 2, turnId: 1, open: false, stopped: true, lastStop: 1 }]);
    // A whole turn later, closed plainly: the Stop is still the session's latest.
    l.set("topic:a", "route", true);
    expect(l.stateOf("topic:a")).toMatchObject({ open: true, turnId: 3, lastStop: 1 });
    l.set("topic:a", "route", false);
    const snap = l.snapshot();
    expect(snap.stopped).toEqual([{ sessionKey: "topic:a", boot: "b1", asOf: 4, turnId: 3, open: false, lastStop: 1 }]);
    expect(snap.open).toEqual([]);
  });

  test("a session never seen is closed with turn 0", () => {
    const { l } = ledger();
    expect(l.stateOf("topic:z")).toEqual({ sessionKey: "topic:z", boot: "b1", asOf: 0, turnId: 0, open: false });
  });
});

/**
 * Boot decisions for native turns in the broker (lossless-restart review,
 * findings 6 and 12).
 *
 * @covers RESUME-06
 */
import { test, expect, describe } from "bun:test";
import { classifyNativeBootSessions, deadStoreIsOpenRowsTurn, pickTurnOwner } from "./boot-native-turns";

describe("pickTurnOwner: the provider whose process is alive wins", () => {
  test("both claim: a dead native store loses to the live CLI turn", () => {
    expect(pickTurnOwner([
      { name: "topics", claims: true, alive: false },
      { name: "claude-code", claims: true, alive: true },
    ])).toBe("claude-code");
  });

  test("both claim and both alive: the first asked keeps it", () => {
    expect(pickTurnOwner([
      { name: "topics", claims: true, alive: true },
      { name: "claude-code", claims: true, alive: true },
    ])).toBe("topics");
  });

  test("only a dead native store claims: it is still adopted, its ending is in the journal", () => {
    expect(pickTurnOwner([{ name: "topics", claims: true, alive: false }])).toBe("topics");
  });

  test("nobody claims: null", () => {
    expect(pickTurnOwner([{ name: "topics", claims: false, alive: false }])).toBeNull();
    expect(pickTurnOwner([])).toBeNull();
  });
});

describe("classifyNativeBootSessions", () => {
  const ROW = 1_000_000;
  const sessions = [
    { id: "native:topic:aaa", sessionKey: "topic:aaa", alive: true, endOffset: 0 },
    { id: "native:topic:bbb", sessionKey: "topic:bbb", alive: false, endOffset: 120, createdAt: ROW + 5 },
    { id: "native:topic:ccc", sessionKey: "topic:ccc", alive: false, endOffset: 0 },
    // A turn before the open row: its text would replace the row's.
    { id: "native:topic:ddd", sessionKey: "topic:ddd", alive: false, endOffset: 300, createdAt: ROW - 1_000 },
    // A journal with no open row: nobody will read it.
    { id: "native:topic:eee", sessionKey: "topic:eee", alive: false, endOffset: 80, createdAt: ROW },
  ];
  const openRows = (sk: string) => (sk === "topic:eee" ? null : ROW);

  test("detached on: alive goes on, the open row's own dead store ended while down, every other dead store is forgotten", () => {
    expect(classifyNativeBootSessions(sessions, true, openRows)).toEqual({
      alive: ["topic:aaa"],
      endedWhileDown: ["topic:bbb"],
      kill: ["native:topic:ccc", "native:topic:ddd", "native:topic:eee"],
    });
  });

  test("detached off: no row is kept for a reattach that would answer dead, and every store is forgotten", () => {
    expect(classifyNativeBootSessions(sessions, false, openRows)).toEqual({ alive: [], endedWhileDown: [], kill: sessions.map((s) => s.id) });
  });
});

describe("deadStoreIsOpenRowsTurn: the check the boot and the dispatcher's probe share", () => {
  test("a store as new as the open row is its turn; an older one, or one with no row or no journal, is not", () => {
    expect(deadStoreIsOpenRowsTurn({ endOffset: 10, createdAt: 100 }, 100)).toBe(true);
    expect(deadStoreIsOpenRowsTurn({ endOffset: 10, createdAt: 99 }, 100)).toBe(false);
    expect(deadStoreIsOpenRowsTurn({ endOffset: 10, createdAt: 100 }, null)).toBe(false);
    expect(deadStoreIsOpenRowsTurn({ endOffset: 0, createdAt: 100 }, 100)).toBe(false);
    // An older daemon gives no creation time: trusted, as before.
    expect(deadStoreIsOpenRowsTurn({ endOffset: 10 }, 100)).toBe(true);
  });
});

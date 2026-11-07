/**
 * Boot decisions for native turns in the broker (lossless-restart review,
 * findings 6 and 12).
 *
 * @covers RESUME-06
 */
import { test, expect, describe } from "bun:test";
import { classifyNativeBootSessions, pickTurnOwner } from "./boot-native-turns";

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
  const sessions = [
    { id: "native:topic:aaa", sessionKey: "topic:aaa", alive: true, endOffset: 0 },
    { id: "native:topic:bbb", sessionKey: "topic:bbb", alive: false, endOffset: 120 },
    { id: "native:topic:ccc", sessionKey: "topic:ccc", alive: false, endOffset: 0 },
  ];

  test("detached on: alive goes on, a dead store with a journal ended while down", () => {
    expect(classifyNativeBootSessions(sessions, true)).toEqual({ alive: ["topic:aaa"], endedWhileDown: ["topic:bbb"], kill: [] });
  });

  test("detached off: no row is kept for a reattach that would answer dead, a running host is ended", () => {
    expect(classifyNativeBootSessions(sessions, false)).toEqual({ alive: [], endedWhileDown: [], kill: ["native:topic:aaa"] });
  });
});

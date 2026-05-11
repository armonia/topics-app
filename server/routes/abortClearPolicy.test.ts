import { describe, expect, test } from "bun:test";
import { shouldHonorClearMessages } from "./abortClearPolicy";
import type { StoredMessage } from "../types";

function msg(role: "user" | "assistant", id: string): StoredMessage {
  return {
    id,
    role,
    content: role === "user" ? "hello" : "hi",
    timestamp: new Date().toISOString(),
  };
}

describe("shouldHonorClearMessages", () => {
  test("permits wipe on a totally empty thread", () => {
    expect(shouldHonorClearMessages([])).toEqual({
      shouldWipe: true,
      userCount: 0,
      assistantCount: 0,
    });
  });

  test("permits wipe with only the first user message (no assistant yet)", () => {
    expect(shouldHonorClearMessages([msg("user", "u1")])).toEqual({
      shouldWipe: true,
      userCount: 1,
      assistantCount: 0,
    });
  });

  test("permits wipe with the first turn already finalized (1 user + 1 assistant)", () => {
    // Boundary case: server received the partial assistant reply before the
    // stop click. Still a "throwaway first turn" — wipe is OK.
    expect(
      shouldHonorClearMessages([msg("user", "u1"), msg("assistant", "a1")]),
    ).toEqual({ shouldWipe: true, userCount: 1, assistantCount: 1 });
  });

  test("REFUSES to wipe a second user turn (regression: history wipe bug)", () => {
    // This is the exact scenario the guard was added to defend: client sends
    // clearMessages=true (because its in-memory map looked empty after a hot
    // reload), but the DB has more turns. The wipe must be denied.
    const stored = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
    ];
    expect(shouldHonorClearMessages(stored)).toEqual({
      shouldWipe: false,
      userCount: 2,
      assistantCount: 1,
    });
  });

  test("REFUSES to wipe a long thread (many turns)", () => {
    const stored: StoredMessage[] = [];
    for (let i = 0; i < 25; i++) {
      stored.push(msg("user", `u${i}`));
      stored.push(msg("assistant", `a${i}`));
    }
    const decision = shouldHonorClearMessages(stored);
    expect(decision.shouldWipe).toBe(false);
    expect(decision.userCount).toBe(25);
    expect(decision.assistantCount).toBe(25);
  });

  test("REFUSES to wipe when user has 1 but assistant has 2 (multi-branch)", () => {
    // Branching can leave more assistant rows than user rows in the active
    // thread. Either count exceeding 1 is enough to deny the wipe.
    const stored = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("assistant", "a2"),
    ];
    expect(shouldHonorClearMessages(stored)).toEqual({
      shouldWipe: false,
      userCount: 1,
      assistantCount: 2,
    });
  });
});

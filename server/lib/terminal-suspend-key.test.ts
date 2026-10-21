/**
 * @covers TERM-14
 */
import { describe, expect, test } from "bun:test";
import { withoutSuspendKey } from "./terminal-suspend-key";

describe("withoutSuspendKey", () => {
  test("a Claude Code pane never receives ctrl+z", () => {
    expect(withoutSuspendKey("claude-code", "\x1a")).toBe("");
    expect(withoutSuspendKey("claude-code-team", "\x1a")).toBe("");
  });

  test("only the key goes, what was typed around it stays", () => {
    expect(withoutSuspendKey("claude-code", "ab\x1acd\x1a")).toBe("abcd");
  });

  test("alt+ctrl+z goes whole, not as a bare ESC that would interrupt the turn", () => {
    expect(withoutSuspendKey("claude-code", "\x1b\x1a")).toBe("");
    expect(withoutSuspendKey("claude-code", "\x1b[A\x1b\x1a")).toBe("\x1b[A");
  });

  test("a shell keeps ctrl+z: there job control works", () => {
    expect(withoutSuspendKey("shell", "\x1a")).toBe("\x1a");
  });

  test("the other agents keep it: measured, they do not freeze", () => {
    for (const type of ["codex", "opencode", "kimi-code", "muse"]) {
      expect(withoutSuspendKey(type, "\x1a")).toBe("\x1a");
    }
  });

  test("an unknown session passes through untouched", () => {
    expect(withoutSuspendKey(undefined, "\x1a")).toBe("\x1a");
  });
});

/**
 * Long text through /send reaches a Claude TUI whole: one paste, Enter apart.
 * @covers TERM-SEND-01
 */
import { describe, expect, test } from "bun:test";
import { resolveTerminalSend } from "../../server/routes/terminal-bridge-send";

describe("resolveTerminalSend long text", () => {
  test("text over the threshold goes as a paste with a separate Enter", () => {
    const r = resolveTerminalSend("claude-code", `${"a".repeat(3000)}\r`);
    expect(r.pasted).toBe(true);
    expect(r.enter).toBe(true);
  });
  test("short text stays a raw write", () => {
    expect(resolveTerminalSend("claude-code", "hello\r").pasted).toBe(false);
  });
});

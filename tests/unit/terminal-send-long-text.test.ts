import { describe, expect, test } from "bun:test";
import { PASTE_MIN_BYTES, resolveTerminalSend } from "../../server/routes/terminal-bridge-send";

describe("resolveTerminalSend long text", () => {
  test("long plain text for a Claude TUI goes as a paste with a separate Enter", () => {
    const text = "a".repeat(PASTE_MIN_BYTES + 500);
    const out = resolveTerminalSend("claude-code", `${text}\r`);
    expect(out.pasted).toBe(true);
    expect(out.enter).toBe(true);
    expect(out.data).toContain(text);
    expect(out.data.endsWith("\r")).toBe(false);
  });

  test("short text stays a raw write", () => {
    const out = resolveTerminalSend("claude-code", "hello\r");
    expect(out.pasted).toBe(false);
  });
});

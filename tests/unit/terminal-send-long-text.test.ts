import { describe, expect, test } from "bun:test";
import { PASTE_MIN_BYTES, resolveTerminalSend } from "../../server/routes/terminal-bridge-send";

describe("resolveTerminalSend long text", () => {
  test("claude-code text over the threshold goes as one paste with Enter split off", () => {
    const text = "a".repeat(PASTE_MIN_BYTES + 500);
    const r = resolveTerminalSend("claude-code", text + "\r");
    expect(r.pasted).toBe(true);
    expect(r.enter).toBe(true);
    expect(r.data).toContain(text);
    expect(r.data.endsWith("\r")).toBe(false);
  });

  test("short text stays a raw write", () => {
    const r = resolveTerminalSend("claude-code", "hello\r");
    expect(r.pasted).toBe(false);
    expect(r.data).toBe("hello\r");
  });
});

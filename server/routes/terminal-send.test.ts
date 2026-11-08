/**
 * @covers TERM-14
 *
 * POST /api/terminal/sessions/:id/send must report the bytes actually
 * written: `resolveTerminalSend` is the route's decision, keyed on the
 * session type, and the bridge receives `data` (nothing when dropped).
 */
import { describe, expect, test } from "bun:test";
import { resolveTerminalSend } from "./terminal";

describe("resolveTerminalSend", () => {
  test("a suspend key typed around text is stripped, sent counts what remains", () => {
    const r = resolveTerminalSend("claude-code", "a\x1ab");
    expect(r.dropped).toBe(false);
    expect(r.data).toBe("ab");
    expect(r.sent).toBe(2);
  });

  test("a lone suspend key is dropped and the bridge receives nothing", () => {
    const r = resolveTerminalSend("claude-code", "\x1a");
    expect(r.dropped).toBe(true);
    expect(r.sent).toBe(0);
    expect(r.data).toBe("");
  });

  test("sent counts UTF-8 bytes, not JavaScript characters", () => {
    const r = resolveTerminalSend("claude-code", "é🧭");
    expect(r).toEqual({ data: "é🧭", sent: Buffer.byteLength("é🧭", "utf8"), dropped: false, pasted: false });
  });

  test("a shell keeps the full input", () => {
    const r = resolveTerminalSend("shell", "a\x1ab");
    expect(r.dropped).toBe(false);
    expect(r.data).toBe("a\x1ab");
    expect(r.sent).toBe(3);
  });

  test("long plain text for a Claude session is a bracketed paste, sent counts its own bytes", () => {
    const text = "x".repeat(1500);
    const r = resolveTerminalSend("claude-code", text);
    expect(r).toEqual({ data: `\x1b[200~${text}\x1b[201~`, sent: 1500, dropped: false, pasted: true });
  });

  test("keys, short text and other session types are never pasted", () => {
    expect(resolveTerminalSend("claude-code", "x".repeat(1500) + "\r").pasted).toBe(false);
    expect(resolveTerminalSend("claude-code", "\x1b[B").pasted).toBe(false);
    expect(resolveTerminalSend("claude-code", "x".repeat(500)).pasted).toBe(false);
    expect(resolveTerminalSend("shell", "x".repeat(1500)).pasted).toBe(false);
  });
});

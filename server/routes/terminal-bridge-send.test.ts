/**
 * @covers TERM-14
 *
 * Long text sent to a TUI session goes as one bracketed paste, CRLF included.
 */
import { describe, expect, test } from "bun:test";
import { resolveTerminalSend } from "./terminal-bridge-send";

const long = (sep: string) => Array.from({ length: 80 }, (_, i) => `line ${i} of a long brief`).join(sep);

describe("resolveTerminalSend long text", () => {
  test("CRLF text for a Claude TUI goes as one paste", () => {
    const r = resolveTerminalSend("claude-code", long("\r\n"));
    expect(r.pasted).toBe(true);
    expect(r.data.startsWith("\x1b[200~")).toBe(true);
    expect(r.data).not.toContain("\r");
  });

  test("a codex TUI gets the paste too, with its trailing Enter split off", () => {
    const r = resolveTerminalSend("codex", long("\n") + "\r");
    expect(r.pasted).toBe(true);
    expect(r.enter).toBe(true);
  });

  test("a shell keeps raw writes", () => {
    expect(resolveTerminalSend("shell", long("\n")).pasted).toBe(false);
  });
});

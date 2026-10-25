/**
 * @covers TERM-14
 *
 * Bypass resistance: the suspend filter keys on the SESSION TYPE, never on
 * which key or path delivered the byte. Every PTY write funnels through
 * `bridgeWriteForSession` (keyboard socket, /send, writeTopicsTerminal,
 * live-terminals topics send, seeded prompts): a ctrl+z rebound in
 * keybindings.json, pasted, or sent as text arrives as the same byte and
 * meets the same filter. Native children drive the chat route, not a PTY,
 * so they carry no suspend hazard.
 */
import { describe, expect, test } from "bun:test";
import { bridgeWriteForSession } from "./terminal-suspend-key";

// Ctrl+Z and ESC, built without literal control bytes in source.
const SUSPEND = String.fromCharCode(26);
const ESC = String.fromCharCode(27);

describe("every path meets the same session-typed filter", () => {
  test("claude-code: suspend bytes never reach the PTY, surrounding text survives", () => {
    expect(bridgeWriteForSession("claude-code", SUSPEND)).toBeNull();
    expect(bridgeWriteForSession("claude-code-team", SUSPEND)).toBeNull();
    expect(bridgeWriteForSession("claude-code", ESC + SUSPEND)).toBeNull();
    expect(bridgeWriteForSession("claude-code", "a" + SUSPEND + "b")).toBe("ab");
  });

  test("a rebound key is the same byte: origin never matters, session type does", () => {
    const rebound = new TextDecoder().decode(Uint8Array.of(0x1a));
    expect(bridgeWriteForSession("claude-code", rebound)).toBeNull();
    expect(bridgeWriteForSession("shell", rebound)).toBe(SUSPEND);
  });

  test("shell and unknown sessions pass everything through", () => {
    expect(bridgeWriteForSession("shell", SUSPEND)).toBe(SUSPEND);
    expect(bridgeWriteForSession("shell", "a" + SUSPEND + "b")).toBe("a" + SUSPEND + "b");
    expect(bridgeWriteForSession(undefined, SUSPEND)).toBe(SUSPEND);
  });
});

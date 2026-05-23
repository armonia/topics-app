/**
 * Tests for pty-activity — the cosmetic-repaint classifier that stops an
 * animated TUI statusline from pinning a session "busy" forever.
 */
import { describe, test, expect } from "bun:test";
import { visibleSignature, classifyFrame } from "./pty-activity";

const ESC = "\x1b";

// Two real frames captured from the pulsing "◎ /goal active (2h)" statusline.
// Identical except for the SGR 24-bit colour (the "breathing" animation).
const goalFrameA = `${ESC}[H\r${ESC}[55C${ESC}[35B${ESC}[38;2;152;159;213m◎ /goal active (2h)${ESC}[39m${ESC}[41;1H${ESC}[38;3H`;
const goalFrameB = `${ESC}[H\r${ESC}[55C${ESC}[35B${ESC}[38;2;176;184;248m◎ /goal active (2h)${ESC}[39m${ESC}[41;1H${ESC}[38;3H`;

describe("visibleSignature", () => {
  test("strips SGR colour and cursor moves, leaving visible text", () => {
    expect(visibleSignature(goalFrameA)).toBe("◎ /goal active (2h)");
  });

  test("colour-only difference produces the same signature", () => {
    expect(visibleSignature(goalFrameA)).toBe(visibleSignature(goalFrameB));
  });

  test("pure control/cursor output reduces to empty", () => {
    expect(visibleSignature(`${ESC}[H${ESC}[2K${ESC}[?25l\r`)).toBe("");
  });
});

describe("classifyFrame", () => {
  test("first statusline frame counts as activity (establishes baseline)", () => {
    const r = classifyFrame(undefined, goalFrameA);
    expect(r.cosmetic).toBe(false);
    expect(r.sig).toBe("◎ /goal active (2h)");
  });

  test("subsequent colour-pulse frames are cosmetic (the core fix)", () => {
    const r = classifyFrame("◎ /goal active (2h)", goalFrameB);
    expect(r.cosmetic).toBe(true);
  });

  test("empty visible content is cosmetic and preserves the prior signature", () => {
    const r = classifyFrame("◎ /goal active (2h)", `${ESC}[2K${ESC}[?25h\r`);
    expect(r.cosmetic).toBe(true);
    expect(r.sig).toBe("◎ /goal active (2h)");
  });

  test("changed visible text is real activity", () => {
    // A ticking elapsed counter / streamed token changes the visible text.
    const frame = `${ESC}[2K✻ Thinking… (12s)`;
    const r = classifyFrame("✻ Thinking… (11s)", frame);
    expect(r.cosmetic).toBe(false);
    expect(r.sig).toBe("✻ Thinking… (12s)");
  });

  test("streamed assistant text is real activity", () => {
    const r = classifyFrame("◎ /goal active (2h)", "Here is the answer to your question:");
    expect(r.cosmetic).toBe(false);
    expect(r.sig).toBe("Here is the answer to your question:");
  });

  test("idempotent on an exactly repeated raw frame", () => {
    const first = classifyFrame(undefined, goalFrameA);
    const second = classifyFrame(first.sig, goalFrameA);
    expect(second.cosmetic).toBe(true);
  });
});

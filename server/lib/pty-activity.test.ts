/**
 * Tests for pty-activity — the cosmetic-repaint classifier that stops an
 * animated TUI statusline from pinning a session "busy" forever.
 *
 * A frame that is only a repaint must not count as PTY activity: it is that
 * signal the tracker uses to demote a `running` session with a silent PTY.
 *
 * @covers CCS-04
 */
import { describe, test, expect } from "bun:test";
import { visibleSignature, classifyFrame, countsAsActivity, isInputEcho, INPUT_ECHO_WINDOW_MS, isResizeRepaint, RESIZE_REPAINT_WINDOW_MS } from "./pty-activity";

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

describe("isInputEcho", () => {
  test("a frame right after a keystroke is echo (the core fix)", () => {
    // User typed 5ms ago → the redrawn input line is that keystroke's echo.
    expect(isInputEcho(5)).toBe(true);
    expect(isInputEcho(0)).toBe(true);
    expect(isInputEcho(INPUT_ECHO_WINDOW_MS - 1)).toBe(true);
  });

  test("a frame long after input is real process output", () => {
    // Claude streaming a token 800ms after the last keystroke is real work.
    expect(isInputEcho(INPUT_ECHO_WINDOW_MS)).toBe(false);
    expect(isInputEcho(800)).toBe(false);
    expect(isInputEcho(5000)).toBe(false);
  });

  test("no recorded input is never echo (startup banner, idle redraw)", () => {
    // A session that has produced output but received no keystrokes — e.g. the
    // startup banner — must still be allowed to mark busy.
    expect(isInputEcho(null)).toBe(false);
  });

  test("a negative elapsed (clock skew) is not echo", () => {
    expect(isInputEcho(-1)).toBe(false);
  });

  test("honours a custom window", () => {
    expect(isInputEcho(120, 100)).toBe(false);
    expect(isInputEcho(80, 100)).toBe(true);
  });
});

describe("isResizeRepaint", () => {
  test("a frame right after a resize is a repaint (the core fix)", () => {
    // The SIGWINCH rewrap that follows a resize/tab-show must not mark busy.
    expect(isResizeRepaint(0)).toBe(true);
    expect(isResizeRepaint(5)).toBe(true);
    expect(isResizeRepaint(RESIZE_REPAINT_WINDOW_MS - 1)).toBe(true);
  });

  test("covers a wider tail than the keystroke echo window", () => {
    // A repaint can land a beat after the resize round-trips the bridge —
    // beyond the 150ms input-echo window but still well inside the resize one.
    expect(RESIZE_REPAINT_WINDOW_MS).toBeGreaterThan(INPUT_ECHO_WINDOW_MS);
    expect(isResizeRepaint(INPUT_ECHO_WINDOW_MS + 10)).toBe(true);
  });

  test("a frame long after a resize is real process output", () => {
    expect(isResizeRepaint(RESIZE_REPAINT_WINDOW_MS)).toBe(false);
    expect(isResizeRepaint(1500)).toBe(false);
    expect(isResizeRepaint(5000)).toBe(false);
  });

  test("no recorded resize is never a repaint", () => {
    expect(isResizeRepaint(null)).toBe(false);
  });

  test("a negative elapsed (clock skew) is not a repaint", () => {
    expect(isResizeRepaint(-1)).toBe(false);
  });

  test("honours a custom window", () => {
    expect(isResizeRepaint(120, 100)).toBe(false);
    expect(isResizeRepaint(80, 100)).toBe(true);
  });
});

describe("countsAsActivity", () => {
  const none = { baseline: false, cosmetic: false, inputEcho: false, resizeEcho: false };

  test("un frame senza nessuna attenuante è lavoro del processo", () => {
    expect(countsAsActivity(none)).toBe(true);
  });

  // Il caso che il riavvio del server crea da sé: `lastVisibleSig` è azzerato,
  // quindi il ridisegno di una tab riattaccata NON può risultare cosmetico e
  // passava come lavoro — da lì il `finished` fasullo (banner «Lavoro
  // completato» su una tab chiusa da giorni) e la revive fasulla dello spinner.
  test("il primo frame di una riattaccata è baseline, non lavoro", () => {
    expect(countsAsActivity({ ...none, baseline: true })).toBe(false);
  });

  test("ognuna delle altre tre attenuanti basta da sola", () => {
    expect(countsAsActivity({ ...none, cosmetic: true })).toBe(false);
    expect(countsAsActivity({ ...none, inputEcho: true })).toBe(false);
    expect(countsAsActivity({ ...none, resizeEcho: true })).toBe(false);
  });

  test("più attenuanti insieme restano un no", () => {
    expect(countsAsActivity({ baseline: true, cosmetic: true, inputEcho: true, resizeEcho: true })).toBe(false);
  });
});

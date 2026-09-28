/**
 * THREE STATES OF ONE GLYPH, and which one wins.
 *
 * The blue ring that turns says "answering, a message would queue"; the amber
 * one standing still says "your move". A chat whose closed turn left an agent
 * or a Bash running is neither: nothing answers and nothing waits for you, the
 * work runs by itself and the chat is free. It gets the third, grey and slow,
 * and on one row or one folder the precedence is waiting > working > background.
 *
 * @covers BGVIS-01
 */
import { describe, expect, test } from "bun:test";
import { loaderArcClass, loaderStateFor } from "./loaderState";
import { ON_FILL_TEXT_SOFT } from "../../lib/selectionStyles";

describe("loaderStateFor", () => {
  test("nothing open and nothing in the background draws nothing", () => {
    expect(loaderStateFor({ loading: false, waiting: false, background: false })).toBeNull();
  });

  test("background work alone is its own grey state, not a turn", () => {
    expect(loaderStateFor({ loading: false, waiting: false, background: true })).toBe("background");
  });

  test("a real turn wins over the background", () => {
    expect(loaderStateFor({ loading: true, waiting: false, background: true })).toBe("working");
  });

  test("a wait for you wins over both", () => {
    expect(loaderStateFor({ loading: true, waiting: true, background: true })).toBe("waiting");
    expect(loaderStateFor({ loading: false, waiting: true, background: true })).toBe("waiting");
  });

  test("a wait with nothing open and nothing running draws nothing, as before", () => {
    expect(loaderStateFor({ loading: false, waiting: true, background: false })).toBeNull();
  });
});

describe("loaderArcClass", () => {
  test("the grey arc is the tertiary ink, turning slowly", () => {
    const arc = loaderArcClass("background", false);
    expect(arc).toContain("animate-orbit-slow");
    expect(arc).toContain("text-app-text-tertiary");
  });

  test("on an attention fill the grey arc takes the fill's own soft ink, as the timestamp it replaces does", () => {
    // A chat whose turn closed with work left running is typically on the blue
    // 'done' fill, where the tertiary grey is about 1.3:1 and the glyph vanishes.
    const arc = loaderArcClass("background", true);
    expect(arc).toContain("animate-orbit-slow");
    expect(arc).toContain(ON_FILL_TEXT_SOFT);
    expect(arc).not.toContain("text-app-text-tertiary");
  });
});

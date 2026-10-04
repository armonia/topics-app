/**
 * TWO STATES OF ONE GLYPH, and which one wins.
 *
 * The blue ring that turns says "work in progress": a turn answering, or a job
 * a closed turn left running (one state since 2026-10-04, the grey third ring
 * is gone). The amber one standing still says "your move", and wins.
 *
 * @covers BGVIS-01
 */
import { describe, expect, test } from "bun:test";
import { loaderArcClass, loaderStateFor } from "./loaderState";
import { ON_FILL_TEXT_SOFT } from "../../lib/selectionStyles";

describe("loaderStateFor", () => {
  test("nothing in progress draws nothing", () => {
    expect(loaderStateFor({ inProgress: false, waiting: false })).toBeNull();
  });

  test("work in progress, a turn or a job left running, is the working ring", () => {
    expect(loaderStateFor({ inProgress: true, waiting: false })).toBe("working");
  });

  test("a wait for you wins", () => {
    expect(loaderStateFor({ inProgress: true, waiting: true })).toBe("waiting");
  });

  test("a wait with nothing in progress draws nothing, as before", () => {
    expect(loaderStateFor({ inProgress: false, waiting: true })).toBeNull();
  });
});

describe("loaderArcClass", () => {
  test("the working arc is the primary ink, turning", () => {
    const arc = loaderArcClass("working", false);
    expect(arc).toContain("animate-orbit-spin");
    expect(arc).toContain("text-[var(--primary)]");
  });

  test("on an attention fill the working arc takes the fill's own soft ink, as the timestamp it replaces does", () => {
    // A folder with a finished child (blue fill) and one at work: a blue arc on
    // the blue fill is about 1.3:1 and the glyph vanishes.
    const arc = loaderArcClass("working", true);
    expect(arc).toContain("animate-orbit-spin");
    expect(arc).toContain(ON_FILL_TEXT_SOFT);
    expect(arc).not.toContain("text-[var(--primary)]");
  });

  test("the wait keeps its amber on a fill", () => {
    expect(loaderArcClass("waiting", true)).toContain("text-amber-500");
  });
});

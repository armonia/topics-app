/**
 * `phraseAt` is the pure driver behind the playful "thinking" line: given the
 * turn's elapsed time it returns which phrase to show. Pinning it here keeps
 * the rotation deterministic — same elapsed always yields the same phrase, so
 * the indicator never flickers or reshuffles across React re-renders — and
 * guards the degenerate inputs (negative / NaN / Infinity) that a bad or
 * future message timestamp can produce.
  * @covers THINK-05
 */
import { describe, test, expect } from "bun:test";
import { phraseAt, PHRASES, ROTATE_MS } from "./thinkingPhrases";

describe("phraseAt", () => {
  test("starts on the first phrase and holds it for the whole first window", () => {
    expect(phraseAt(0)).toBe(PHRASES[0]);
    expect(phraseAt(1)).toBe(PHRASES[0]);
    expect(phraseAt(ROTATE_MS - 1)).toBe(PHRASES[0]);
  });

  test("advances exactly one step per ROTATE_MS window", () => {
    expect(phraseAt(ROTATE_MS)).toBe(PHRASES[1]);
    expect(phraseAt(ROTATE_MS * 2)).toBe(PHRASES[2 % PHRASES.length]);
    expect(phraseAt(ROTATE_MS * 3 - 1)).toBe(PHRASES[2 % PHRASES.length]);
  });

  test("wraps around after the last phrase", () => {
    expect(phraseAt(ROTATE_MS * PHRASES.length)).toBe(PHRASES[0]);
    expect(phraseAt(ROTATE_MS * (PHRASES.length + 1))).toBe(PHRASES[1]);
  });

  test("degrades to the first (static) phrase on invalid elapsed", () => {
    expect(phraseAt(-1)).toBe(PHRASES[0]);
    expect(phraseAt(-ROTATE_MS * 5)).toBe(PHRASES[0]);
    expect(phraseAt(NaN)).toBe(PHRASES[0]);
    expect(phraseAt(Infinity)).toBe(PHRASES[0]);
    expect(phraseAt(-Infinity)).toBe(PHRASES[0]);
  });

  test("the rotation set is non-trivial and free of blanks", () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(10);
    for (const p of PHRASES) expect(p.trim().length).toBeGreaterThan(0);
    expect(new Set(PHRASES).size).toBe(PHRASES.length); // no duplicates
  });
});

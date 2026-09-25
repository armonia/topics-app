/**
 * HOW A COMMAND LOOKS IN THE FREEZER'S LOG: one line, cut short, never broken.
 *
 * `oneLine` is a pure function, so it is tested here without the freezer's
 * world of processes (`swap-freeze.test.ts` covers the lines that use it).
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { LOG_COMMAND_MAX, oneLine } from "./swap-freeze";

describe("oneLine", () => {
  test("whitespace and newlines collapse to single spaces", () => {
    expect(oneLine("  for v in 1 2; do\n\techo $v\ndone  ")).toBe("for v in 1 2; do echo $v done");
  });

  test("a long command is cut at the limit with an ellipsis", () => {
    const cut = oneLine("x".repeat(500));
    expect(cut.length).toBe(LOG_COMMAND_MAX);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("the cut never splits a character in two", () => {
    // An emoji is two UTF-16 units: cut between them, the log would carry a
    // lone surrogate, which UTF-8 turns into U+FFFD.
    const cut = oneLine("a".repeat(LOG_COMMAND_MAX - 2) + "😀bbbb");
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cut.endsWith("…")).toBe(true);
  });
});

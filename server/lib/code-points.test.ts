/**
 * `sliceCodePoints` cuts where `Array.from(...).slice(...)` cut: the board
 * feed's preview must not move by a character for being cheaper.
 * @covers FEEDCOST-01
 */
import { describe, expect, it } from "bun:test";
import { sliceCodePoints } from "./code-points";

const reference = (s: string, max: number): string => Array.from(s).slice(0, max).join("");

// Every kind of unit the walk has to tell apart: ASCII, a basic-plane letter,
// a full surrogate pair, and the two halves of a pair on their own.
const PIECES = ["a", "Z", " ", "\n", "è", "中", "😀", "👩‍💻", "\uD83D", "\uDE00", "\uD800\uD800", "\uDC00\uD83D"];

function randomString(rand: () => number, pieces: number): string {
  let s = "";
  for (let i = 0; i < pieces; i++) s += PIECES[Math.floor(rand() * PIECES.length)]!;
  return s;
}

// A fixed-seed generator: a red here names a string that stays red.
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("sliceCodePoints", () => {
  it("cuts on code points like Array.from, pairs and lone surrogates included", () => {
    const rand = seeded(20261008);
    for (let i = 0; i < 2000; i++) {
      const s = randomString(rand, Math.floor(rand() * 40));
      for (const max of [0, 1, 2, 3, 5, 8, 13, 21, 34, 240]) {
        expect(sliceCodePoints(s, max)).toBe(reference(s, max));
      }
    }
  });

  it("keeps a pair whole at the boundary and stops before the next one", () => {
    expect(sliceCodePoints("ab😀c", 3)).toBe("ab😀");
    expect(sliceCodePoints("😀😀😀", 2)).toBe("😀😀");
    expect(sliceCodePoints("\uD83Dx", 1)).toBe("\uD83D");
  });

  it("returns nothing for a cap of zero or less, and the whole of a short string", () => {
    expect(sliceCodePoints("abc", 0)).toBe("");
    expect(sliceCodePoints("abc", -1)).toBe("");
    expect(sliceCodePoints("abc", 240)).toBe("abc");
    expect(sliceCodePoints("", 5)).toBe("");
  });
});

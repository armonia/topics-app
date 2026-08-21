/**
 * The two things `check:comment-language` can get silently wrong.
 *
 * A ratchet is only worth its baseline if the number under it means what it
 * says. Two ways it could lie without anyone noticing: the extractor could call
 * something a comment that is not one (a `//` inside a string, so an Italian
 * string would be charged to the comment budget), or the detector could call
 * English Italian (`non-empty`, which appears in this tree's comments by the
 * hundred). Both are silent: the gate stays green, the number drifts.
 */
import { describe, expect, it } from "bun:test";
import { commentLines, italianWords } from "./check-comment-language";

describe("commentLines", () => {
  it("reads line comments and block comments, with their line numbers", () => {
    const src = ["const a = 1; // first", "/* second", "   third */", "const b = 2;"].join("\n");
    expect(commentLines(src)).toEqual([
      { line: 1, text: " first" },
      { line: 2, text: " second" },
      { line: 3, text: "   third " },
    ]);
  });

  it("does NOT read a comment marker that lives inside a string", () => {
    const src = [
      `const a = "// questa non e' un commento";`,
      `const b = '/* nemmeno questa */';`,
      "const c = `una stringa modello // con lo slash`;",
    ].join("\n");
    expect(commentLines(src)).toEqual([]);
  });

  it("keeps counting lines correctly after a multi-line template literal", () => {
    const src = ["const t = `riga", "ancora", "fine`;", "// vero commento"].join("\n");
    expect(commentLines(src)).toEqual([{ line: 4, text: " vero commento" }]);
  });

  it("is not fooled by an escaped quote inside a string", () => {
    const src = [`const a = "lei ha detto \\"ciao\\"";`, "// il commento"].join("\n");
    expect(commentLines(src)).toEqual([{ line: 2, text: " il commento" }]);
  });
});

describe("italianWords", () => {
  it("flags Italian words and accents", () => {
    expect(italianWords("questa riga non va bene")).toContain("questa");
    expect(italianWords("perché sì")).toContain("<accent>");
  });

  it("says nothing about ordinary English", () => {
    expect(italianWords("the cache is invalidated on every write")).toEqual([]);
  });

  it("treats `non-` compounds as the English they are", () => {
    expect(italianWords("returns a non-empty, non-null value")).toEqual([]);
    expect(italianWords("a non-blocking read")).toEqual([]);
  });

  it("still catches the bare Italian word", () => {
    expect(italianWords("questo non funziona")).toContain("non");
  });
});

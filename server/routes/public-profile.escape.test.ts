/**
 * Every place the public profile page prints the owner's name goes through
 * escapeHtml. The name comes from `people.display_name`, free text, and the
 * page is served to anyone with the link: a quote in it closed the
 * `content="…"` attribute of the meta description, which was the one spot
 * that printed it raw.
 *
 * @covers PROFILE-05
 */
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("the public profile never interpolates the name unescaped", () => {
  const src = readFileSync(join(import.meta.dir, "public-profile.ts"), "utf8");
  const interpolations = [...src.matchAll(/\$\{([^}]*\bnome\b[^}]*)\}/g)].map((m) => m[1]);
  expect(interpolations.length).toBeGreaterThan(0);
  const raw = interpolations.filter((expr) =>
    [...expr.matchAll(/\bnome\b/g)].some((m) => {
      const before = expr.slice(0, m.index);
      // The ternary test on the variable is a presence check, not a print.
      return !/escapeHtml\($/.test(before) && !/^\s*\?/.test(expr.slice(m.index! + 4));
    }),
  );
  expect(raw).toEqual([]);
});

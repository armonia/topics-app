/**
 * The chat code blocks and the terminal must share one monospace stack.
 *
 * `--font-mono` in client/src/index.css drives chat code; TERMINAL_FONT_FAMILY
 * in client/src/lib/terminalFont.ts drives xterm. They are two copies of the
 * same string, so a drift between them (for example `--font-mono: Menlo,
 * monospace;`) would split the two surfaces without any other test noticing.
 *
 * What this checks:
 * - `--font-mono` in `:root` equals TERMINAL_FONT_FAMILY, token for token.
 * - The first family in that stack is JetBrains Mono.
 * - index.css declares an @font-face for JetBrains Mono, so the first family
 *   is actually bundled and not only named.
 *
 * Whether the font loads in a browser is covered by the e2e font spec.
 *
 * @covers TERM-FONT-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_FONT_FAMILY } from "../../client/src/lib/terminalFont";

const ROOT = join(import.meta.dir, "..", "..");
const CSS = readFileSync(join(ROOT, "client", "src", "index.css"), "utf8");

/** Reads the value of `--font-mono` from the `:root` block, or null. */
function valueFontMono(css: string): string | null {
  const root = css.match(/:root\s*\{([^}]*)\}/);
  if (!root) return null;
  const m = root[1].match(/--font-mono\s*:\s*([^;]+);/);
  return m ? m[1].trim() : null;
}

/** Normalises a CSS font stack to comparable tokens: no quotes, single spaces. */
function tokens(stack: string): string[] {
  return stack
    .replace(/["']/g, "")
    .split(",")
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter((t) => t.length > 0);
}

describe("terminal-font-stack-matches", () => {
  const fontMono = valueFontMono(CSS);

  it("--font-mono is declared in :root", () => {
    expect(fontMono).not.toBeNull();
  });

  it("--font-mono and TERMINAL_FONT_FAMILY are the same stack", () => {
    expect(tokens(fontMono ?? "")).toEqual(tokens(TERMINAL_FONT_FAMILY));
  });

  it("the first family in the stack is JetBrains Mono", () => {
    expect(tokens(TERMINAL_FONT_FAMILY)[0]).toBe("JetBrains Mono");
  });

  it("index.css declares an @font-face for JetBrains Mono", () => {
    const faces = CSS.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const jetbrains = faces.filter((f) => /font-family\s*:\s*['"]?JetBrains Mono['"]?/.test(f));
    expect(jetbrains.length).toBeGreaterThan(0);
  });
});

/**
 * The three things the Kanban topbar card actually asked for.
 *
 * WHY A TEST AND NOT A READING. The card was closed, its work landed nowhere
 * traceable (`landing_state: unverifiable`, no delivery commit), and it was
 * reopened on 2026-08-24. Reading the file today and finding the three changes
 * present answers "is it there now", not "will it stay". Two of the three are
 * REMOVALS - a border and a second button - and a removal is the single easiest
 * thing to reintroduce by accident, because nothing anywhere says it was
 * deliberate. The third criterion already had `kanbanChipMetrics.test.ts` and
 * `ProjectFilterPicker.test.ts` guarding it; these two had nothing.
 *
 * WHY SOURCE ASSERTIONS. `KanbanBoardPane` pulls the store, the pane layout,
 * the API and a dozen hooks, so it does not mount under `bun test`, and `bun`
 * does not resolve the `@/` alias those files use. It is the house method here
 * (`slashCommandRouting.test.ts`, `GlobalCapControl.test.tsx`,
 * `kanbanChipMetrics.test.ts`): when the fact under test is structural rather
 * than behavioural, read the structure.
 *
 * @covers KANBAN-12
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const PANE = readFileSync(join(DIR, "KanbanBoardPane.tsx"), "utf8");
const PICKER = readFileSync(join(DIR, "ProjectFilterPicker.tsx"), "utf8");

/**
 * The file with its comments stripped.
 *
 * Needed because two of the three criteria are REMOVALS, and a comment that
 * explains a removal necessarily names the thing removed. Searching the raw
 * source for the caret finds the note saying "a caret used to live here" and
 * mistakes it for the caret: the test would accuse the very documentation that
 * protects the criterion.
 */
function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/**
 * The app stylesheet, and the rules in it that live OUTSIDE every `@layer`.
 *
 * An unlayered declaration beats a layered one whatever the specificity, and
 * Tailwind's utilities are layered. So a global rule written at the top level of
 * `index.css` overrides what a component asks for on itself - silently, and
 * without ever showing up in a grep of the component.
 */
const CSS = readFileSync(join(DIR, "..", "..", "index.css"), "utf8");

/**
 * The unlayered rules of `index.css` that can put a SCROLLBAR on any element.
 *
 * Only two shapes qualify, and both are universal: a rule that sets
 * `scrollbar-width` on a selector containing `*`, and a rule on the bare
 * `::-webkit-scrollbar` pseudo. A rule that sets only `scrollbar-color` is NOT
 * one of them: a colour cannot paint a scrollbar that `scrollbar-width: none`
 * never creates.
 */
function unlayeredScrollbarRules(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const hits: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (depth === 0) {
        const selector = src.slice(start, i).trim();
        const close = matchingBrace(src, i);
        const body = src.slice(i + 1, close);
        // `@layer`, `@utility`, `@media`... are at-rules: what matters is the
        // plain rules, the ones that sit in no layer at all.
        if (!selector.startsWith("@")) {
          const universal = /(^|[\s,>+~])\*/.test(selector) || selector.trimStart().startsWith("::");
          const webkitBar = selector.includes("::-webkit-scrollbar");
          if (universal && (/scrollbar-width\s*:/.test(body) || webkitBar)) {
            hits.push(selector.replace(/\s+/g, " "));
          }
        }
        i = close;
        start = close + 1;
        continue;
      }
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0) start = i + 1;
    }
  }
  return hits;
}

/** The index of the `}` that closes the `{` at `open`. */
function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

/** The toolbar element itself, found by the test id the app already carries. */
function toolbarTag(): string {
  const i = PANE.indexOf('data-testid="board-toolbar"');
  expect(i, "la barra non si chiama piu' `board-toolbar`: questo test cerca un elemento che non c'e'").toBeGreaterThan(-1);
  const openAt = PANE.lastIndexOf("<div", i);
  const closeAt = PANE.indexOf(">", i);
  return PANE.slice(openAt, closeAt + 1);
}

describe("1. sotto la barra non c'e' nessuna linea", () => {
  // The strips that appear below (active filters, the error band) already carry
  // their own border: one more line here drew two of them touching.
  test("l'elemento della toolbar non dichiara un bordo inferiore", () => {
    const tag = toolbarTag();
    expect(tag, `la barra ha riguadagnato un bordo: ${tag}`).not.toContain("border-b");
    expect(tag, "un bordo scritto a mano conta quanto la classe").not.toMatch(/border(Bottom|-b-)/);
  });

  test("e nemmeno il contenitore che la avvolge", () => {
    // A border can come back in from the parent, and on screen it looks the same.
    const i = PANE.indexOf('data-testid="board-toolbar"');
    const before = PANE.slice(Math.max(0, i - 400), i);
    const parent = before.slice(before.lastIndexOf("<div"));
    expect(parent, `il contenitore della barra ha un bordo inferiore: ${parent}`).not.toContain("border-b");
  });

  // THE THIRD THING THAT DRAWS A LINE, and it is not a border: the toolbar's OWN
  // horizontal SCROLLBAR. The strip overflows by construction (measured on the
  // bundle, 2026-08-27: scrollWidth 472 against clientWidth 420), so a horizontal
  // scrollbar exists, and it lives exactly under the bar's bottom edge. That is
  // why the element declares it off.
  test("la barra dichiara di non volere nessuna barra di scorrimento", () => {
    const tag = toolbarTag();
    expect(tag, "senza `scrollbar-width:none` la riga di scorrimento torna").toContain("[scrollbar-width:none]");
    expect(tag, "e la meta' webkit serve ai motori che ignorano la proprieta' standard").toContain("[&::-webkit-scrollbar]:hidden");
  });

  test("e nessuna regola FUORI da @layer puo' rimettergliela", () => {
    // MEASURED on the live app (Playwright, global board and project board, light
    // and dark, 2026-08-27): the element declares `scrollbar-width: none` and
    // `getComputedStyle` answered `thin`. The toolbar's declaration is a Tailwind
    // utility, so it sits in `@layer utilities`; the `* { scrollbar-width: thin }`
    // of `index.css` sat OUTSIDE every layer, and an unlayered rule beats a
    // layered one whatever the specificity. On the Tauri shell that scrollbar is
    // visible for real: WebKit, once the standard property is set, ignores
    // `::-webkit-scrollbar` (the `.tauri-mac *` note in `index.css` says so
    // already) and `.tauri-mac` even gives it an always-on grey. The result is a
    // grey hairline under the bar that no `border-b` grep can find.
    const offenders = unlayeredScrollbarRules(CSS);
    expect(
      offenders,
      `queste regole di index.css stanno fuori da @layer e battono il \`scrollbar-width:none\` della barra: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  test("e il test puo' fallire", () => {
    // Non-vacuity: if `toolbarTag` returned an empty string, the two assertions
    // above would pass forever without looking at anything.
    expect(toolbarTag().length).toBeGreaterThan(30);
    expect(toolbarTag()).toContain("board-toolbar");
  });
});

describe("2. una sola porta alle impostazioni", () => {
  test("il ▾ accanto al titolo non c'e' piu' — nel CODICE, non nei commenti", () => {
    // The second entrance was not merely redundant: it held its OWN copy of the
    // auto-dispatch state, which fell behind whenever the other panel changed
    // it. Two buttons for one question, and two answers.
    //
    // The character still appears three times in the file, and that is fine:
    // those are the comments that RECORD the removal. A test that forbids them
    // erases the memory of why, which is the only real defence against putting
    // it back. So we look at the code, not the prose.
    expect(codeWithoutComments(PANE), "il carattere ▾ e' tornato in un elemento").not.toMatch(/▾/);
  });

  test("un elemento solo cambia lo stato del pannello", () => {
    // `onClose` does not count: closeAt is not a DOOR, and there is one for
    // each of the two possible panels. What is counted is what OPENS it, and
    // the gesture is a toggle, not a `set(true)`.
    const code = codeWithoutComments(PANE);
    const opens = [...code.matchAll(/setShowSettings\(\s*\(s\)\s*=>\s*!s\s*\)|setShowSettings\(true\)/g)].length;
    expect(opens, "piu' di un elemento opens le impostazioni: e' il difetto che la carta chiedeva di togliere").toBe(1);
  });

  test("l'interruttore globale vive nel pannello, non in un menu della barra", () => {
    // Removing the caret is only safe because that block already exists in the
    // gear panel, on every board. If it vanished from there, removing the caret
    // would have lost a feature rather than a duplicate.
    const sections = readFileSync(join(DIR, "BoardSettingsSections.tsx"), "utf8");
    expect(sections).toContain("GlobalCapControl");
  });
});

describe("3. i suggerimenti progetto stanno dentro il selettore", () => {
  test("c'e' UN componente, e la board lo usa", () => {
    expect(PANE).toContain("import { ProjectFilterPicker } from './ProjectFilterPicker'");
    expect(PANE).toContain("<ProjectFilterPicker");
  });

  test("il backing e' dichiarato in tutti e due i temi", () => {
    // A raised surface declared only `bg-white/N` is white on white in the light
    // theme: exactly the defect the criterion named.
    const backing = PICKER.match(/className="[^"]*absolute[^"]*"/)?.[0] ?? "";
    expect(backing, "il backing del selettore non si trova").toContain("bg-black/");
    expect(backing, "senza la meta' scura il backing sparisce in un tema").toContain("dark:bg-white/");
  });

  test("i chip hanno UNA misura sola, dichiarata una volta", () => {
    const declarations = [...PICKER.matchAll(/max-w-\[[\d.]+rem\]/g)].map((m) => m[0]);
    expect(declarations.length, "nessuna larghezza dichiarata: i chip tornano a misura variabile").toBeGreaterThan(0);
    expect(new Set(declarations).size, `misure diverse fra loro: ${[...new Set(declarations)].join(", ")}`).toBe(1);
  });
});

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

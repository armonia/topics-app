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

  test("il pannello e' un DROPDOWN ancorato al ⚙, non una banda sotto la barra", () => {
    // KANBAN-75: the settings open as a `Menu` anchored to the gear. A band
    // under the toolbar drew the very line KANBAN-12 removed and pushed the
    // columns down; a `Menu` is portalled and floats. Three things are read:
    // the same state that the ONE door toggles is what opens the Menu, the
    // Menu's anchor is the gear's ref, and the shared shell declares no border
    // (the surface is the Menu's own).
    const code = codeWithoutComments(PANE);
    const menu = code.match(/<Menu\s[^>]*open=\{showSettings\}[^>]*>/s)?.[0];
    expect(menu, "nessun <Menu open={showSettings}>: il pannello non e' un dropdown").toBeTruthy();
    expect(menu).toMatch(/anchorRef=\{settingsBtnRef\}/);
    expect(code).toMatch(/ref=\{settingsBtnRef\}/);
    // And no other surface still shows the panel as a band.
    expect(code).not.toMatch(/\{showSettings\s*&&/);
    const sections = readFileSync(join(DIR, "BoardSettingsSections.tsx"), "utf8");
    const shell = codeWithoutComments(sections).match(/SETTINGS_PANEL_SHELL\s*=\s*'([^']*)'/)?.[1] ?? "";
    expect(shell.length, "SETTINGS_PANEL_SHELL non trovata").toBeGreaterThan(10);
    expect(shell, `il guscio del pannello ha di nuovo un bordo: ${shell}`).not.toMatch(/border/);
    // A dropdown that cannot scroll is a dropdown whose bottom rows are unreachable.
    expect(shell).toContain("overflow-y-auto");
    expect(shell).toMatch(/max-h-/);
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

describe("4. la barra non porta piu' un titolo ne' un numero di spesa", () => {
  // Both were READINGS, not controls, and both said something that was already
  // said elsewhere: the label repeated the name of the tab holding the pane, the
  // chip repeated a figure the gear panel shows with its total, its unpriced
  // share and the caps that act on it. On a strip that overflows by
  // construction, a reading costs the filters their width.
  test("il titolo della board generale non e' piu' nella barra", () => {
    const code = codeWithoutComments(PANE);
    expect(code, "l'etichetta statica e' tornata in barra").not.toContain("board.toolbar.general");
  });

  test("il chip della spesa non e' piu' in barra", () => {
    const code = codeWithoutComments(PANE);
    expect(code, "il chip dei dollari e' tornato in barra").not.toContain("AgentSpendChip");
  });

  test("ma la spesa si vede ancora, nel pannello del ⚙", () => {
    // Removing the chip is only safe while the number lives somewhere reachable
    // from EVERY board, the general one included: that is this section, which
    // the global-only panel mounts too.
    const sections = readFileSync(join(DIR, "BoardSettingsSections.tsx"), "utf8");
    expect(sections).toContain("SpendCapControl");
    const globalPanel = sections.slice(sections.indexOf("export function GlobalOnlySettingsPanel"));
    expect(globalPanel, "la board generale resterebbe senza nessun posto in cui vedere la spesa").toContain("GlobalSettingsSection");
  });
});

describe("5. i filtri hanno un guscio solo", () => {
  const FIELD = readFileSync(join(DIR, "FilterTokenField.tsx"), "utf8");
  const CONSTANTS = readFileSync(join(DIR, "constants.ts"), "utf8");

  test("i DUE controlli rimasti passano entrambi da `filterFieldClass`", () => {
    // Were four: a search box and a labels chip in the pane, plus the token
    // field and the project picker in their own files. Since 29/08 the first
    // three are ONE field (`FilterTokenField`), so the pane itself owns no
    // filter shell at all - which is the strongest form of "one shell": the row
    // cannot grow a fourth variant in a file that no longer knows the class.
    expect(codeWithoutComments(PANE).match(/filterFieldClass\(/g) ?? [], "il pane non deve rifarsi un guscio suo").toHaveLength(0);
    expect(codeWithoutComments(FIELD)).toContain("filterFieldClass(");
    expect(codeWithoutComments(PICKER)).toContain("filterFieldClass(");
  });

  test("nessuno dei due si ridisegna il guscio a mano", () => {
    // The shape of a hand-rolled shell: its own height plus its own FILL, on
    // the same element. `hover:bg-*` is excluded on purpose - a hover tint on
    // the 24px reset button is not a shell, and matching it would forbid the
    // one affordance that button has.
    const handRolled = /h-6[^"`]*(?<!hover:)bg-(black|white)\//;
    expect(handRolled.test(codeWithoutComments(FIELD)), "il campo dei token si e' rifatto il fondo da solo").toBe(false);
    const filters = codeWithoutComments(PANE).slice(codeWithoutComments(PANE).indexOf("function InlineFilters"));
    expect(handRolled.test(filters), "un filtro della barra si e' rifatto il fondo da solo").toBe(false);
  });

  test("lo stato attivo e' UNA dichiarazione, e la scrive il guscio", () => {
    // "I am narrowing the board" has to look identical on the search box, on the
    // token field and on the two chips: one active branch, in one place.
    const active = [...CONSTANTS.matchAll(/bg-black\/15 text-app-text dark:bg-white\/15/g)];
    expect(active, "lo stato attivo del guscio non si trova piu'").toHaveLength(1);
  });
});

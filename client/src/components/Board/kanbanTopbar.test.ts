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
 * Il file senza i suoi commenti.
 *
 * Serve perche' due dei tre criteri sono RIMOZIONI, e i commenti che spiegano
 * una rimozione nominano per forza la cosa rimossa. Cercare `▾` nel sorgente
 * grezzo trova la nota che dice «qui viveva un ▾» e la scambia per il ▾: il
 * test accuserebbe proprio la documentazione che protegge il criterio.
 * allow-italian: descrive il difetto del test, non e' testo mostrato
 */
function codiceSenzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The toolbar element itself, found by the test id the app already carries. */
function toolbarTag(): string {
  const i = PANE.indexOf('data-testid="board-toolbar"');
  expect(i, "la barra non si chiama piu' `board-toolbar`: questo test cerca un elemento che non c'e'").toBeGreaterThan(-1);
  const apertura = PANE.lastIndexOf("<div", i);
  const chiusura = PANE.indexOf(">", i);
  return PANE.slice(apertura, chiusura + 1);
}

describe("1. sotto la barra non c'e' nessuna linea", () => {
  // Le strisce che compaiono sotto (filtri attivi, banda d'errore) portano gia'
  // il proprio bordo: una riga in piu' qui ne disegnava due attaccate.
  // allow-italian: la nota descrive cio' che si vede, non e' testo mostrato
  test("l'elemento della toolbar non dichiara un bordo inferiore", () => {
    const tag = toolbarTag();
    expect(tag, `la barra ha riguadagnato un bordo: ${tag}`).not.toContain("border-b");
    expect(tag, "un bordo scritto a mano conta quanto la classe").not.toMatch(/border(Bottom|-b-)/);
  });

  test("e nemmeno il contenitore che la avvolge", () => {
    // Il bordo puo' rientrare dal genitore e l'effetto a schermo e' identico.
    const i = PANE.indexOf('data-testid="board-toolbar"');
    const prima = PANE.slice(Math.max(0, i - 400), i);
    const genitore = prima.slice(prima.lastIndexOf("<div"));
    expect(genitore, `il contenitore della barra ha un bordo inferiore: ${genitore}`).not.toContain("border-b");
  });

  test("e il test puo' fallire", () => {
    // Non-vacuita': se `toolbarTag` restituisse stringa vuota le due
    // asserzioni sopra passerebbero per sempre senza guardare niente.
    expect(toolbarTag().length).toBeGreaterThan(30);
    expect(toolbarTag()).toContain("board-toolbar");
  });
});

describe("2. una sola porta alle impostazioni", () => {
  test("il ▾ accanto al titolo non c'e' piu' — nel CODICE, non nei commenti", () => {
    // Il secondo ingresso non era solo ridondante: teneva una copia PROPRIA
    // dello stato dell'auto-dispatch, che restava indietro quando l'altro
    // pannello lo cambiava. Due tasti per la stessa domanda, e due risposte.
    // allow-italian: il difetto storico, non testo mostrato
    //
    // Il carattere compare ancora tre volte nel file, e va bene: sono i
    // commenti che RACCONTANO la rimozione. Un test che li vieta cancella la
    // memoria del perche', che e' l'unica difesa contro il reinserimento. Si
    // guarda quindi il codice, non la prosa.
    expect(codiceSenzaCommenti(PANE), "il carattere ▾ e' tornato in un elemento").not.toMatch(/▾/);
  });

  test("un elemento solo cambia lo stato del pannello", () => {
    // `onClose` non conta: chiudere non e' una PORTA, e ce n'e' uno per
    // ciascuno dei due pannelli possibili. Quello che si conta e' chi lo
    // APRE, e il gesto e' un toggle, non un `set(true)`.
    const codice = codiceSenzaCommenti(PANE);
    const apre = [...codice.matchAll(/setShowSettings\(\s*\(s\)\s*=>\s*!s\s*\)|setShowSettings\(true\)/g)].length;
    expect(apre, "piu' di un elemento apre le impostazioni: e' il difetto che la carta chiedeva di togliere").toBe(1);
  });

  test("l'interruttore globale vive nel pannello, non in un menu della barra", () => {
    // La rimozione del ▾ e' sicura solo perche' quel blocco esiste gia' nel
    // pannello del ⚙, su ogni board. Se sparisse di li', togliendo il ▾ si
    // sarebbe persa una funzione invece di una duplicazione.
    const sezioni = readFileSync(join(DIR, "BoardSettingsSections.tsx"), "utf8");
    expect(sezioni).toContain("GlobalCapControl");
  });
});

describe("3. i suggerimenti progetto stanno dentro il selettore", () => {
  test("c'e' UN componente, e la board lo usa", () => {
    expect(PANE).toContain("import { ProjectFilterPicker } from './ProjectFilterPicker'");
    expect(PANE).toContain("<ProjectFilterPicker");
  });

  test("il fondino e' dichiarato in tutti e due i temi", () => {
    // Una superficie sollevata dichiarata solo `bg-white/N` e' bianco su bianco
    // nel tema chiaro: e' esattamente il difetto che il criterio nominava.
    // allow-italian: descrive il difetto storico, non e' testo mostrato
    const fondino = PICKER.match(/className="[^"]*absolute[^"]*"/)?.[0] ?? "";
    expect(fondino, "il fondino del selettore non si trova").toContain("bg-black/");
    expect(fondino, "senza la meta' scura il fondino sparisce in un tema").toContain("dark:bg-white/");
  });

  test("i chip hanno UNA misura sola, dichiarata una volta", () => {
    const dichiarazioni = [...PICKER.matchAll(/max-w-\[[\d.]+rem\]/g)].map((m) => m[0]);
    expect(dichiarazioni.length, "nessuna larghezza dichiarata: i chip tornano a misura variabile").toBeGreaterThan(0);
    expect(new Set(dichiarazioni).size, `misure diverse fra loro: ${[...new Set(dichiarazioni)].join(", ")}`).toBe(1);
  });
});

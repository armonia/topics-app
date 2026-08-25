/**
 * UNA VOCE DEL PIANO DEVE SELEZIONARE UN FILE SOLO.
 *
 * ── Il difetto ──────────────────────────────────────────────────────────────
 * Gli argomenti posizionali di `playwright test` sono ESPRESSIONI REGOLARI sul
 * percorso, non nomi di file. Il piano degli shard scriveva i basename nudi
 * (`board.spec.ts`) e `scripts/e2e-shards.sh` li passava cosi' com'erano: una
 * sottostringa combacia, quindi `board.spec.ts` selezionava anche
 * `dashboard.spec.ts`, `focus-bounce-board.spec.ts` e
 * `browser-mobile-keyboard.spec.ts`.
 *
 * Misurato il 2026-08-18 sull'albero (247 spec): CINQUE collisioni.
 *   board.spec.ts   -> dashboard, focus-bounce-board, browser-mobile-keyboard
 *   panels.spec.ts  -> file-explorer-panels, infra-panels
 *
 * Quando i due file finiscono in shard diversi il secondo gira DUE VOLTE. Non
 * e' solo tempo buttato: il bilanciamento per durata — l'unica ragione per cui
 * il piano esiste — misura una divisione che non e' quella eseguita.
 *
 * ── Perche' questo test regge nel tempo ─────────────────────────────────────
 * Non fissa i cinque nomi di oggi: li ricalcola dall'albero vero. Una spec
 * nuova che nasce con un nome contenuto in un'altra fa rosso QUI, prima di
 * costare una passata intera a nessuno.
  * @covers E2E-GATE-07
 */
import { describe, test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { specSelector, selectorCollisions } from "../../scripts/e2e-plan-shards";

const E2E = resolve(import.meta.dir, "..", "e2e");

function specFiles(): string[] {
  return readdirSync(E2E).filter((n) => n.endsWith(".spec.ts")).sort();
}

describe("i selettori del piano degli shard", () => {
  test("l'albero ha delle spec (guardia contro un verde a vuoto)", () => {
    // Senza, un cambio di cartella renderebbe verdi i casi sotto misurando zero
    // file: il modo piu' comune in cui un cancello smette di guardare.
    expect(specFiles().length).toBeGreaterThan(100);
  });

  test("nessuna voce del piano seleziona due file", () => {
    const collisioni = selectorCollisions(specFiles());
    expect(
      collisioni.map((c) => `${c.selector} -> ${c.matches.join(", ")}`),
      "Una voce che ne seleziona due fa girare quel file DUE VOLTE quando i due " +
        "finiscono in shard diversi, e falsifica il bilanciamento per durata.",
    ).toEqual([]);
  });

  test("ogni selettore prende esattamente il SUO file", () => {
    const files = specFiles();
    const paths = files.map((f) => `tests/e2e/${f}`);
    for (const f of files) {
      const presi = paths.filter((p) => new RegExp(specSelector(f)).test(p));
      expect(presi, `il selettore di ${f} prende ${presi.length} file`).toEqual([`tests/e2e/${f}`]);
    }
  });

  test("IL DIFETTO, riprodotto: il basename nudo ne prende piu' di uno", () => {
    // Questo caso e' la memoria del guasto. Se un domani qualcuno tornasse a
    // scrivere i nomi nudi, i due casi sopra diventerebbero rossi — e questo
    // dice perche', senza far scavare nella storia di git.
    const files = specFiles();
    const paths = files.map((f) => `tests/e2e/${f}`);
    const nudo = files.filter((f) => paths.filter((p) => new RegExp(f).test(p)).length > 1);
    expect(
      nudo.length,
      "se questo diventa 0 le collisioni sono sparite dall'albero e il caso non misura " +
        "piu' niente: allora si toglie, non si lascia verde a vuoto.",
    ).toBeGreaterThan(0);
  });
});

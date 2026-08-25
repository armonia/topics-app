/**
 * La guardia del timeout di default dei test.
 *
 * Il numero e' scritto in due posti perche' bun obbliga a due leve diverse
 * (vedi `tests/setup/bun-test-preload.ts` per la misura che lo dimostra):
 *   · `[test] preload` in bunfig.toml copre `bun test <un file>` a mano;
 *   · `--timeout` sugli script `test:*` di package.json copre la suite intera,
 *     e quindi la CI e i check pre-review.
 * Nessun import tiene insieme quei due posti. Togliere una delle due righe non
 * rompe niente a compilazione, e riapre meta' del guasto in silenzio: i file
 * che spawnano processi tornano a 5 secondi e ricominciano a tingere di rosso
 * la card di chi passava di li'. Questo file e' l'unica cosa che se ne accorge.
 *
 * Perche' NON importa il preload: importarlo lo eseguirebbe, e il marcatore che
 * stiamo verificando comparirebbe per colpa dell'import. Sarebbe verde anche
 * col preload staccato da bunfig. Quindi il nome della chiave e' ricopiato a
 * mano qui sotto, e i numeri si leggono dal sorgente invece che importarli.
  * @covers E2E-GATE-07
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "../..");
const PRELOAD_REL = "tests/setup/bun-test-preload.ts";

/** La stessa stringa di `TIMEOUT_MARKER`, ricopiata apposta. Vedi sopra. */
const MARKER = "__topicsDefaultTestTimeoutMs";

/** Il default di bun, quello che questo lavoro esiste per superare. */
const DEFAULT_DI_BUN_MS = 5_000;

const bunfig = readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8");
const sorgentePreload = readFileSync(join(REPO_ROOT, PRELOAD_REL), "utf8");
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Legge una dichiarazione dal sorgente del preload invece di importarla. */
function dalPreload(nome: string, pattern: RegExp): string {
  const m = sorgentePreload.match(pattern);
  if (!m) throw new Error(`${PRELOAD_REL}: non trovo la dichiarazione di ${nome}`);
  return m[1];
}

const costanteDichiarata = Number(
  dalPreload("DEFAULT_TEST_TIMEOUT_MS", /DEFAULT_TEST_TIMEOUT_MS\s*=\s*([0-9_]+)/).replace(/_/g, ""),
);
const variabileDichiarata = dalPreload("TIMEOUT_ENV_VAR", /TIMEOUT_ENV_VAR\s*=\s*"([^"]+)"/);

/** Gli script che lanciano davvero `bun test`, non quelli che lanciano Playwright. */
const scriptCheLancianoBunTest = Object.entries(pkg.scripts).filter(([, cmd]) =>
  /\bbun test\b/.test(cmd),
);

describe("timeout di default dei test", () => {
  it("meta' 1: bunfig cabla il preload, e il file cablato esiste", () => {
    expect(bunfig).toContain("[test]");
    expect(bunfig.slice(bunfig.indexOf("[test]"))).toContain(`preload = ["./${PRELOAD_REL}"]`);
    expect(existsSync(join(REPO_ROOT, PRELOAD_REL))).toBe(true);
  });

  it("meta' 1: il preload e' girato DAVVERO in questo processo", () => {
    const applicato = (globalThis as Record<string, unknown>)[MARKER];
    expect(
      typeof applicato === "number" ? applicato : `assente (${String(applicato)})`,
    ).toBe(costanteDichiarata);
  });

  /**
   * Il pezzo che il preload da solo NON copre. Il preload gira una volta per
   * corsa, quindi in una suite multi-file alza il timeout a un file e basta:
   * senza questo flag i 29 file che spawnano tornano a 5s sotto `test:unit`,
   * cioe' anche in CI. Il test guarda OGNI script che lancia `bun test`, non
   * i tre di oggi, cosi' un quarto script domani non puo' nascere scoperto.
   */
  it("meta' 2: ogni script che lancia `bun test` passa --timeout, e lo stesso numero", () => {
    const atteso = `--timeout \${${variabileDichiarata}:-${costanteDichiarata}}`;
    expect(scriptCheLancianoBunTest.length).toBeGreaterThan(0);
    for (const [nome, cmd] of scriptCheLancianoBunTest) {
      expect(`${nome}: ${cmd}`).toContain(atteso);
    }
  });

  it("il numero applicato supera il default di bun", () => {
    expect((globalThis as Record<string, unknown>)[MARKER] as number).toBeGreaterThan(
      DEFAULT_DI_BUN_MS,
    );
    expect(costanteDichiarata).toBeGreaterThan(DEFAULT_DI_BUN_MS);
  });

  /**
   * L'unico test della suite che dorme apposta, e non e' un'asserzione a vuoto:
   * e' la sola prova che il budget di QUESTO file supera davvero i 5 secondi,
   * qualunque delle due leve glielo abbia dato. Lanciato da solo lo prova il
   * preload, dentro `test:unit` lo prova il flag. Con una delle due staccate
   * muore «after 5000ms», che e' esattamente il rosso da cui nasce il lavoro.
   * Costa 5,1s su una suite di due minuti e mezzo.
   */
  it("un test puo' superare i 5 secondi senza chiedere un timeout suo", async () => {
    const partenza = Date.now();
    await Bun.sleep(DEFAULT_DI_BUN_MS + 100);
    expect(Date.now() - partenza).toBeGreaterThanOrEqual(DEFAULT_DI_BUN_MS);
  });
});

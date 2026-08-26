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
   * PROOF THAT THE LEVER REALLY RAISES THE TIMEOUT, not a red drawn by lot.
   *
   * This used to sleep 5.1s inline. It passed when bun happened to load THIS
   * file first — the preload runs once per run and `setDefaultTimeout` applies
   * only to the file being loaded — and died "after 5000ms" when it loaded a
   * different one. That is: `bun test tests/unit/`, the shape you type to
   * triage a red, produced one red out of 806 that named no defect and went
   * away when the file was rerun alone. A red like that teaches people to
   * ignore reds.
   *
   * The pose is no longer suffered, it is IMPOSED: a child `bun test` is run
   * over a single file, and there the preload covers it by construction. The
   * cost is the same sleep as before, paid in a separate process.
   *
   * The explicit timeout on these two cases is not an amnesty: they are child
   * processes, and their budget has nothing to do with what they measure.
   */
  const FIXTURE = "./tests/fixtures/slow-default-timeout.ts";

  /** Runs the child and returns its exit code. */
  function childRun(env: Record<string, string> = {}): number {
    const r = Bun.spawnSync(["bun", "test", FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode ?? -1;
  }

  it("un file lanciato da solo supera i 5 secondi senza chiedere un timeout suo", () => {
    expect(
      childRun(),
      `${FIXTURE} e' morto sotto il default di bun: il preload di bunfig.toml non sta alzando niente`,
    ).toBe(0);
  }, 60_000);

  it("e muore se la manopola scende sotto il sonno: la prova non e' a vuoto", () => {
    // A command-line `--timeout` is NOT enough to kill it: bun applies the
    // flag BEFORE the preloads, and the preload overwrites it. The knob, on the
    // other hand, moves the preload itself, which is the lever under test.
    expect(
      childRun({ [variabileDichiarata]: "1000" }),
      `${FIXTURE} e' sopravvissuto a un default di 1s: allora non dipende dal default, e il caso sopra non prova niente`,
    ).not.toBe(0);
  }, 60_000);
});

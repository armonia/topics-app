/**
 * The bundle gate reads its budgets off `public/`, never off the sources. So a
 * run without a rebuild measures whatever was compiled last time and says
 * nothing about the tree — while printing numbers and exiting green.
 *
 * Not hypothetical: the launchd `build:watch` job has been off since
 * 2026-08-04, so `public/` only moves when somebody types the command. On
 * 2026-08-25 the two measurements differed by 309 bytes purely because that
 * round was almost all server-side.
 *
 * This bench does NOT run the gate: that would need a whole fake build tree
 * (index.html with asset refs, a baseline file) and would measure the fixture
 * more than the rule. It verifies the two pieces the rule is made of, plus the
 * fact that the script still wires them — the second half is what keeps the
 * first from passing over a script that dropped the call.
 *
 * @covers GATE-BUNDLE-FRESH-01
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { isStale, newestMtime } from "./check-bundle-size";

const SRC = readFileSync(resolve(import.meta.dir, "check-bundle-size.ts"), "utf8");

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "topics-fresh-"));
  mkdirSync(join(root, "a", "b"), { recursive: true });
  return root;
}

/** Writes a file and pins its mtime, so the case does not depend on the clock. */
function fileAt(root: string, rel: string, epochS: number): string {
  const full = join(root, rel);
  writeFileSync(full, "x");
  utimesSync(full, epochS, epochS);
  return full;
}

describe("isStale — la decisione", () => {
  it("sorgente piu' recente del pacchetto: STANTIO", () => {
    expect(isStale(1_000, 2_000)).toBe(true);
  });

  it("pacchetto piu' recente: fresco", () => {
    expect(isStale(2_000, 1_000)).toBe(false);
  });

  it("stesso istante: fresco — una ricostruzione non deve perdere per un pareggio", () => {
    expect(isStale(1_000, 1_000)).toBe(false);
  });

  it("niente da confrontare NON e' stantio: di una build assente parla assertBuilt", () => {
    // Due voci sulla stessa cosa sono il modo in cui un cancello si contraddice.
    expect(isStale(0, 5_000)).toBe(false);
    expect(isStale(5_000, 0)).toBe(false);
  });
});

describe("newestMtime — la misura", () => {
  it("trova il file piu' recente, anche annidato, e lo NOMINA", () => {
    const root = tree();
    fileAt(root, "a/vecchio.ts", 1_000_000);
    const recente = fileAt(root, "a/b/recente.ts", 2_000_000);
    const got = newestMtime(root);
    expect(got.at).toBe(2_000_000_000);
    expect(got.file).toBe(recente);
  });

  it("salta node_modules: le dipendenze non sono i sorgenti di nessuno", () => {
    const root = tree();
    fileAt(root, "a/mio.ts", 1_000_000);
    mkdirSync(join(root, "node_modules"));
    fileAt(root, "node_modules/estraneo.js", 9_000_000);
    expect(newestMtime(root).at).toBe(1_000_000_000);
  });

  it("una cartella che non esiste da' zero, non un'eccezione", () => {
    expect(newestMtime(join(tmpdir(), "topics-fresh-che-non-esiste-mai")).at).toBe(0);
  });
});

describe("il cancello lo usa davvero", () => {
  it("assertFresh viene chiamata, e PRIMA di misurare", () => {
    // NON `indexOf("assertFresh();")`: quella stringa la trova anche dentro una
    // riga commentata, ed e' esattamente cosi' che si disarma una chiamata.
    // Si ancora a una chiamata VIVA: inizio riga, nessuno slash davanti.
    const viva = /^[ \t]*assertFresh\(\);/m.exec(SRC);
    const chiamata = viva?.index ?? -1;
    const misura = SRC.indexOf("const measured");
    expect(chiamata, "assertFresh non e' piu' chiamata (o e' commentata)").toBeGreaterThan(-1);
    expect(misura).toBeGreaterThan(-1);
    expect(chiamata).toBeLessThan(misura);
  });

  it("rifiuta col TERZO esito, non con un rosso", () => {
    // Un pacchetto stantio non e' un pacchetto fuori budget: exit 2, come
    // assertBuilt. Vedi GATE-04.
    const blocco = SRC.slice(SRC.indexOf("function assertFresh"), SRC.indexOf("function assertFresh") + 1600);
    expect(blocco).toContain("process.exit(2)");
    expect(blocco).not.toContain("process.exit(1)");
  });

  it("il messaggio nomina il comando che ricostruisce", () => {
    expect(SRC).toContain("bun run build:client");
    expect(SRC).toContain("poi rilancia");
  });
});

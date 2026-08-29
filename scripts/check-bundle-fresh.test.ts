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
import { isStale, newestMtime, splitOrphansByAge, totalAssetsRaw } from "./check-bundle-size";
import { SWEEP_MIN_AGE_MS } from "./build-client-publish";

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
    // Two voices on the same thing is how a gate contradicts itself.
    expect(isStale(0, 5_000)).toBe(false);
    expect(isStale(5_000, 0)).toBe(false);
  });
});

describe("newestMtime — la misura", () => {
  it("trova il file piu' recente, anche annidato, e lo NOMINA", () => {
    const root = tree();
    fileAt(root, "a/vecchio.ts", 1_000_000);
    const recent = fileAt(root, "a/b/recente.ts", 2_000_000);
    const got = newestMtime(root);
    expect(got.at).toBe(2_000_000_000);
    expect(got.file).toBe(recent);
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

  // GATE-BUNDLE-FRESH-01 measured this in the wild: a delivery touching only
  // client/src/lib/selectionStyles.test.ts got refused by assertFresh's
  // "bundle older than sources" message, even though Vite never imports a
  // `.test.ts` into any chunk. The two tests below are the two ways that regresses:
  // silently ignoring a real source change would be worse than the false
  // positive it replaces.
  it("un .test.ts NON conta come sorgente: non spedisce in nessun chunk", () => {
    const root = tree();
    const old = fileAt(root, "a/reale.ts", 1_000_000);
    fileAt(root, "a/b/recente.test.ts", 2_000_000);
    const got = newestMtime(root);
    expect(got.at).toBe(1_000_000_000);
    expect(got.file).toBe(old);
  });

  it("un .test.tsx dentro __tests__/ NON conta neanche lui", () => {
    const root = tree();
    const old = fileAt(root, "a/reale.tsx", 1_000_000);
    mkdirSync(join(root, "a", "__tests__"), { recursive: true });
    fileAt(root, "a/__tests__/recente.test.tsx", 2_000_000);
    const got = newestMtime(root);
    expect(got.at).toBe(1_000_000_000);
    expect(got.file).toBe(old);
  });

  it("un vero file sorgente conta ancora, e vince se e' il piu' recente", () => {
    const root = tree();
    fileAt(root, "a/vecchio.test.ts", 1_000_000);
    const real = fileAt(root, "a/b/recente.ts", 2_000_000);
    const got = newestMtime(root);
    expect(got.at).toBe(2_000_000_000);
    expect(got.file).toBe(real);
  });
});

describe("il cancello lo usa davvero", () => {
  it("assertFresh viene chiamata, e PRIMA di misurare", () => {
    // NOT `indexOf("assertFresh();")`: that string is found inside a commented
    // line too, and commenting it out is exactly how such a call gets disarmed.
    // Anchor on a LIVE call instead: start of line, no slash in front.
    const viva = /^[ \t]*assertFresh\(\);/m.exec(SRC);
    const call = viva?.index ?? -1;
    const misura = SRC.indexOf("const measured");
    expect(call, "assertFresh non e' piu' chiamata (o e' commentata)").toBeGreaterThan(-1);
    expect(misura).toBeGreaterThan(-1);
    expect(call).toBeLessThan(misura);
  });

  it("rifiuta col TERZO esito, non con un rosso", () => {
    // A stale bundle is not an over-budget bundle: exit 2, like assertBuilt.
    // See GATE-04.
    const block = SRC.slice(SRC.indexOf("function assertFresh"), SRC.indexOf("function assertFresh") + 1600);
    expect(block).toContain("process.exit(2)");
    expect(block).not.toContain("process.exit(1)");
  });

  it("il messaggio nomina il comando che ricostruisce", () => {
    expect(SRC).toContain("bun run build:client");
    expect(SRC).toContain("poi rilancia");
  });
});

/**
 * The orphan branch, both ways. Measured 2026-08-29, right after LAND-11:
 * since the publish step sweeps only what is older than `SWEEP_MIN_AGE_MS`,
 * every clean build leaves the previous entry chunk behind on purpose, so the
 * gate found an orphan every single time and `total_assets` went back to never
 * being measured. Age is the whole difference, and both directions have to
 * hold: a young leftover must not stop the measure, an old one must.
 */
describe("splitOrphansByAge - deliberato o avanzo vero", () => {
  const NOW = 1_000_000_000_000;
  const WINDOW = 30 * 60_000;

  it("piu' giovane della finestra: lo sweep lo tiene apposta, non invalida niente", () => {
    const got = splitOrphansByAge([{ name: "index-OLD.js", mtimeMs: NOW - 60_000 }], NOW, WINDOW);
    expect(got.kept).toEqual(["index-OLD.js"]);
    expect(got.stale).toEqual([]);
  });

  it("piu' vecchio della finestra: e' un avanzo vero e il cancello ha ragione a dirlo", () => {
    const got = splitOrphansByAge([{ name: "vecchio-X.js", mtimeMs: NOW - WINDOW - 1 }], NOW, WINDOW);
    expect(got.kept).toEqual([]);
    expect(got.stale).toEqual(["vecchio-X.js"]);
  });

  it("separa i due gruppi nello stesso giro, e li ordina", () => {
    const got = splitOrphansByAge(
      [
        { name: "b-recente.js", mtimeMs: NOW - 1_000 },
        { name: "z-vecchio.js", mtimeMs: NOW - WINDOW * 2 },
        { name: "a-recente.js", mtimeMs: NOW - 2_000 },
      ],
      NOW,
      WINDOW,
    );
    expect(got.kept).toEqual(["a-recente.js", "b-recente.js"]);
    expect(got.stale).toEqual(["z-vecchio.js"]);
  });

  it("nessun orfano: nessuno dei due gruppi", () => {
    const got = splitOrphansByAge([], NOW, WINDOW);
    expect(got.kept).toEqual([]);
    expect(got.stale).toEqual([]);
  });

  it("usa la STESSA finestra dello sweep, non una sua costante", () => {
    // Two numbers that must agree drift apart; this one is imported.
    const borderline = [{ name: "x.js", mtimeMs: NOW - SWEEP_MIN_AGE_MS - 1 }];
    expect(splitOrphansByAge(borderline, NOW).stale).toEqual(["x.js"]);
    expect(splitOrphansByAge([{ name: "x.js", mtimeMs: NOW }], NOW).kept).toEqual(["x.js"]);
  });
});

describe("totalAssetsRaw - il numero descrive QUESTA build", () => {
  it("somma i file della cartella", () => {
    const root = tree();
    writeFileSync(join(root, "a.js"), "12345");
    writeFileSync(join(root, "b.js"), "123");
    expect(totalAssetsRaw(new Set(), root)).toBe(8);
  });

  it("esclude gli avanzi tenuti apposta: sono della build PRIMA", () => {
    const root = tree();
    writeFileSync(join(root, "a.js"), "12345");
    writeFileSync(join(root, "index-VECCHIO.js"), "123");
    expect(totalAssetsRaw(new Set(["index-VECCHIO.js"]), root)).toBe(5);
  });
});

describe("il cancello usa davvero l'eta'", () => {
  it("il budget total_assets scatta sugli avanzi VERI, non su un orfano qualunque", () => {
    expect(SRC).toContain('if (stale.length === 0) check("total_assets.raw"');
  });

  it("il totale non conta gli avanzi tenuti apposta", () => {
    expect(SRC).toContain("totalAssetsRaw(new Set(kept))");
  });

  it("il messaggio nomina la causa vera, non il watcher spento dal 2026-08-04", () => {
    const msg = SRC.slice(SRC.indexOf("NON MISURABILE"), SRC.indexOf("Primi orfani"));
    expect(msg).toContain("SWEEP_MIN_AGE_MS");
    expect(msg).not.toContain("build:watch");
  });
});

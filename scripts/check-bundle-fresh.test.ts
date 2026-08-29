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

/**
 * @covers RELEASE-02
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { CARGO, LOCK, PKG, TAURI, VERSION_FILES, readVersions } from "./version-sources";

/**
 * UN SOLO GESTO porta i quattro numeri alla stessa versione.
 *
 * `version-lockstep.test.ts` è il cancello: dice che i quattro numeri devono
 * coincidere, e per due volte in una notte ha avuto ragione. Questo test prova
 * l'altra metà — che esiste un comando che li rimette d'accordo — e la prova nel
 * modo in cui il difetto si presentava davvero: si parte da un albero
 * DISALLINEATO, si esegue il gesto, e si guarda il predicato del cancello
 * passare da rosso a verde. Un test che partisse da un albero già allineato non
 * potrebbe fallire, e quindi non proverebbe niente.
 *
 * Gira su una COPIA usa-e-getta dei quattro file (`BUMP_ROOT`), mai sul
 * checkout: un test che bumpa il repo in cui vive lascerebbe dietro di sé
 * esattamente il file sporco che questa storia serve a evitare.
 *
 * Il metro è `readVersions`, lo STESSO che usa il cancello: se qui misurassi con
 * regex mie, proverei che il gesto soddisfa me, non lui.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts/bump-version.sh");

/** Una copia dei soli quattro file, con la stessa struttura di cartelle. */
function makeTree(): string {
  const root = mkdtempSync(resolve(tmpdir(), "bump-version-"));
  for (const rel of VERSION_FILES) {
    mkdirSync(dirname(resolve(root, rel)), { recursive: true });
    copyFileSync(resolve(REPO_ROOT, rel), resolve(root, rel));
  }
  return root;
}

/** Riscrive UNA riga di versione, come farebbe una mano distratta. */
function setVersion(root: string, rel: string, version: string): void {
  const path = resolve(root, rel);
  const before = readFileSync(path, "utf8");
  const after =
    rel === CARGO ? before.replace(/^version\s*=\s*"\d+\.\d+\.\d+"/m, `version = "${version}"`)
    : rel === LOCK ? before.replace(/^(name = "app"\nversion = ")\d+\.\d+\.\d+"/m, `$1${version}"`)
    : before.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  expect(after, `non sono riuscito a scollare ${rel}`).not.toBe(before);
  writeFileSync(path, after);
}

/** Il predicato del cancello, in una riga: i quattro numeri coincidono? */
function allineati(root: string): boolean {
  const v = Object.values(readVersions(root));
  return v.every((x) => x !== null && x === v[0]);
}

function bump(root: string, arg?: string): string {
  return execFileSync("bash", arg ? [SCRIPT, arg] : [SCRIPT], {
    env: { ...process.env, BUMP_ROOT: root },
    encoding: "utf8",
  }).trim();
}

const trees: string[] = [];
let root = "";

beforeEach(() => {
  root = makeTree();
  trees.push(root);
});

afterAll(() => {
  for (const t of trees) rmSync(t, { recursive: true, force: true });
});

describe("bun run bump — un gesto per tutti e quattro i posti", () => {
  test("l'albero scollato è ROSSO prima del gesto e VERDE dopo", () => {
    // Il difetto vero, riprodotto: tre file bumpati a mano, il lock indietro.
    setVersion(root, PKG, "9.9.9");
    setVersion(root, TAURI, "9.9.9");
    setVersion(root, CARGO, "9.9.9");
    expect(allineati(root), "l'albero di partenza doveva essere disallineato").toBe(false);

    expect(bump(root, "sync")).toBe("9.9.9");

    expect(allineati(root)).toBe(true);
    expect(readVersions(root)[LOCK]).toBe("9.9.9");
  });

  test("`sync` non inventa un numero nuovo: tiene quello di package.json", () => {
    const prima = readVersions(root)[PKG];
    // Non è un'asserzione di comodo: `null` qui vorrebbe dire che non so più
    // leggere package.json, e il resto del test misurerebbe un'altra cosa.
    if (!prima) throw new Error("package.json non dichiara una versione leggibile");
    setVersion(root, LOCK, "1.0.0");
    expect(bump(root, "sync")).toBe(prima);
    expect(readVersions(root)[PKG]).toBe(prima);
    expect(allineati(root)).toBe(true);
  });

  test("una versione esplicita finisce in tutti e quattro, anche partendo scollati", () => {
    setVersion(root, LOCK, "1.0.0");
    setVersion(root, CARGO, "2.0.0");
    expect(bump(root, "3.4.5")).toBe("3.4.5");
    for (const [file, v] of Object.entries(readVersions(root))) {
      expect(v, `${file} è rimasto indietro`).toBe("3.4.5");
    }
  });

  test("patch/minor/major incrementano package.json e trascinano gli altri tre", () => {
    setVersion(root, PKG, "2.5.7");
    setVersion(root, TAURI, "2.5.7");
    setVersion(root, CARGO, "2.5.7");
    setVersion(root, LOCK, "2.5.7");

    expect(bump(root)).toBe("2.5.8"); // patch è il default
    expect(allineati(root)).toBe(true);
    expect(bump(root, "minor")).toBe("2.6.0");
    expect(allineati(root)).toBe(true);
    expect(bump(root, "major")).toBe("3.0.0");
    expect(allineati(root)).toBe(true);
  });

  test("un argomento che non è né una parola nota né un semver esce non-zero", () => {
    // Senza questo, `bump 2.3` scriverebbe silenziosamente un patch a caso.
    expect(() => bump(root, "2.3")).toThrow();
    expect(readVersions(root)[PKG]).toBe(readVersions(root)[LOCK]);
  });
});

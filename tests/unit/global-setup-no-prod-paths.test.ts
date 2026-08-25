/**
 * Il globalSetup della suite E2E non deve toccare NIENTE fuori dalla sua
 * cartella dati.
 *
 * Perché esiste questo test: fino al 2026-08-02 `global-setup.ts` faceva
 * `rmSync(join(process.cwd(), "data", "browser-state"), {recursive:true})`
 * "belt-and-braces", per ripulire i residui delle run pre-fix. Ma il server di
 * PRODUZIONE non ha `DATA_DIR` (il suo plist esporta solo HOME e PATH, con
 * WorkingDirectory sul repo), quindi quel percorso è il suo: dentro ci stanno i
 * cookie, il localStorage, l'ultima URL di ogni pane browser e i login salvati
 * sotto `_handles/`. Ogni run della suite lanciata dal checkout li cancellava,
 * e le pane browser si risvegliavano sloggate e bianche.
 *
 * Il difetto non era visibile in nessun assert — la suite restava verde
 * mentre distruggeva dati veri — quindi la protezione non può essere un altro
 * assert di comportamento: dev'essere un divieto sul SORGENTE.
 *
 * La regola: in `global-setup.ts` ogni cancellazione distruttiva deve avere per
 * radice una directory derivata dalla configurazione di test (TEST_DATA_DIR,
 * DATA_DIR, /tmp), mai `process.cwd()` — che nell'uso reale È il repo, e quindi
 * la cartella dati di produzione.
  * @covers E2E-GATE-06
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const SETUP = path.join(import.meta.dir, "../e2e/global-setup.ts");
const src = readFileSync(SETUP, "utf-8");

/** Righe di codice, senza commenti: il divieto riguarda ciò che ESEGUE. */
const codeLines = src
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));

describe("global-setup non tocca percorsi di produzione", () => {
  test("nessuna rmSync/rmdir su un percorso costruito da process.cwd()", () => {
    // `process.cwd()` può comparire in una stringa di log o in una spawn: il
    // divieto è sulle CANCELLAZIONI. Si cercano le righe che rimuovono e si
    // controlla che non nominino cwd, né direttamente né via una variabile
    // costruita da cwd.
    const cwdDerived = new Set<string>();
    for (const l of codeLines) {
      const m = l.match(/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*[^;]*process\.cwd\(\)/);
      if (m) cwdDerived.add(m[1]);
    }
    const offenders = codeLines.filter((l) => {
      if (!/\b(rmSync|rmdirSync|unlinkSync|rm\s*\()/.test(l)) return false;
      if (l.includes("process.cwd()")) return true;
      return [...cwdDerived].some((v) => new RegExp(`\\b${v}\\b`).test(l));
    });
    expect(offenders, `cancellazioni ancorate a process.cwd():\n${offenders.join("\n")}`).toEqual([]);
  });

  test("il loop di pulizia di browser-state resta dentro la cartella dati di test", () => {
    // La forma esatta che era sbagliata: un array di directory da rimuovere in
    // cui una veniva da cwd. Si controlla che nel file non ricompaia
    // l'accoppiata cwd + "browser-state".
    const joined = codeLines.join("\n");
    const bad = /process\.cwd\(\)[^\n]*browser-state|browser-state[^\n]*process\.cwd\(\)/.test(joined);
    expect(bad, 'global-setup non deve piu\' cancellare "<cwd>/data/browser-state"').toBe(false);
  });

  test("il DB che azzera è quello di test, non data/topics.db", () => {
    // Stessa classe: il hard-wipe del DB deve stare sotto la cartella di test.
    const wipes = codeLines.filter((l) => /topics\.db/.test(l) && /\b(rmSync|unlinkSync)\b/.test(l));
    for (const l of wipes) {
      expect(l.includes("process.cwd()"), `wipe del DB ancorato a cwd: ${l}`).toBe(false);
    }
  });
});

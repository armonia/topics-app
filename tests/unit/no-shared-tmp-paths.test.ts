/**
 * Nessun test tiene la sua roba in un path FISSO sotto /tmp.
 *
 * PERCHE' ESISTE. Una costante di test che punta a un path fisso sotto /tmp
 * sembra isolata, e lo e' dagli altri programmi. Non lo e' da un'altra copia di
 * questa suite. Due run insieme aprono lo stesso file SQLite, lo stesso HOME
 * finto e lo stesso repo git, e la prima `rmSync` di un `beforeAll` porta via i
 * dati dell'altra mentre sta lavorando. Misurato prima della bonifica: 3 run
 * concorrenti, circa 65 test rossi fra `SQLITE_IOERR_VNODE` e lock contesi,
 * tutti verdi presi da soli. Il costo vero non e' il rosso: e' che il rosso e'
 * CASUALE, quindi il cancello pre-review diventa una moneta e chi lo legge
 * impara a rilanciarlo.
 *
 * La cura sta in `tests/integration/helpers` con `testTmpDir(label)`: da' una
 * cartella unica per processo sotto `/tmp/topics-test/`, corta abbastanza da
 * poterci mettere dentro anche un socket unix.
 *
 * Nessuna allowlist di file: se questo test e' rosso, e' rimasta indietro una
 * conversione. Resta una deroga per riga, `// allow-shared-tmp: <ragione>`, per
 * il caso in cui una cartella condivisa sia davvero cio' che si vuole provare.
 *
 * DOVE SI FERMA LO SCAN, E PERCHE'. Solo `tests/integration`, `tests/unit`,
 * `server` e `scripts`: sono i soli posti dove un test tocca il disco per
 * davvero (DATA_DIR, HOME finto, repo git, socket). `client/src`, `shared` e
 * `relay` sono fuori APPOSTA, non per dimenticanza: li' si provano reducer e
 * funzioni pure, e un `/tmp/proj` e' una chiave in memoria che non diventera'
 * mai una cartella. Allargare lo scan a quelle radici non trova un guasto in
 * piu': aggiunge sei deroghe su righe innocenti, e una deroga su una riga
 * innocente insegna a chi legge che la deroga e' normale. Se un giorno un test
 * di quelle cartelle iniziasse a scrivere sul disco, quella e' la riga da
 * cambiare, ma va cambiata sapendo cosa si sta comprando.
  * @covers GATE-09
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * Le radici dove un test crea cartelle vere. `tests/e2e` non c'e' perche' gira
 * sotto Playwright, fuori da `test:unit`; `client/src`, `shared` e `relay` non
 * ci sono per la ragione spiegata in testa al file.
 */
const SCAN_ROOTS = ["tests/unit", "tests/integration", "server", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

/** L'unica via d'uscita: una ragione scritta in coda alla riga. */
const ALLOW = /\/\/\s*allow-shared-tmp:\s*\S/;

/**
 * La riga deve APRIRE con una dichiarazione, dopo l'indentazione. Cercare la
 * parola chiave in mezzo alla riga era troppo largo: prendeva il parametro di
 * default di `function progetto(id, name, path = ...)` in
 * `server/services/profile-stats.test.ts`, che e' un dato scritto in una riga
 * di DB, non una cartella che qualcuno crea. Ancorando qui restano fuori da
 * soli i parametri di default, le proprieta' di oggetto e gli argomenti di
 * chiamata: sono i tre casi che il test negativo qui sotto tiene fermi.
 * `export` passa perche' `export const X` e' la stessa dichiarazione.
 */
const DECL = /^\s*(?:export\s+)?(?:const|let|var)\s/;

/**
 * L'identificatore e il letterale che gli si assegna, cercato su TUTTA la riga
 * dichiarativa: cosi' prende anche il secondo dichiaratore di una lista
 * separata da virgola (`const a = '/tmp/x', b = '/tmp/y'`, presi entrambi).
 *
 * Limite noto: guarda una riga per volta, quindi una dichiarazione spezzata su
 * due righe non la vede. Tutte e 28 quelle bonificate stavano su una riga.
 */
const ASSIGN = /([A-Za-z_$][\w$]*)\s*(?::[^=;,]*)?=\s*(["'`])(\/tmp\/[^"'`]*)\2/g;

/**
 * Righe che sono INTERAMENTE commento. Un guasto commentato non gira, e senza
 * questo filtro il check si accorgerebbe dei propri esempi qui sopra.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

interface TmpHit {
  file: string;
  line: number;
  name: string;
  path: string;
}

function scanForFixedTmpPaths(root: string, files: string[]): TmpHit[] {
  const hits: TmpHit[] = [];
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), "utf-8");
    } catch {
      continue; // cancellato mentre giravamo: non e' compito di questo check
    }
    if (!src.includes("/tmp/")) continue;
    src.split(/\r?\n/).forEach((text, idx) => {
      if (COMMENT_LINE.test(text) || ALLOW.test(text)) return;
      if (!DECL.test(text)) return;
      ASSIGN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ASSIGN.exec(text)) !== null) {
        // Un template interpolato non e' fisso: `${...}` dentro il path lo
        // rende diverso a ogni valutazione, che e' il punto di tutto questo.
        if (m[3]!.includes("${")) continue;
        hits.push({ file: rel, line: idx + 1, name: m[1]!, path: m[3]! });
      }
    });
  }
  return hits;
}

/** Ogni `*.test.ts` sotto le radici, in ordine stabile. */
function testFiles(root: string, roots: string[] = SCAN_ROOTS): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // radice assente: non e' un errore di questo check
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue; // link rotto
      }
      if (isDir) {
        if (!SKIP_DIRS.has(entry)) walk(full);
        continue;
      }
      if (entry.endsWith(".test.ts")) out.push(relative(root, full));
    }
  };
  for (const r of roots) walk(join(root, r));
  return out;
}

/** Il rimprovero: dice dove sta, perche' e' un guasto, e cosa mettere al suo posto. */
function spiega(h: TmpHit): string {
  return (
    `${h.file}:${h.line}  ${h.name} punta a "${h.path}"\n` +
    `      Un path fisso non isola da un'altra copia di questa suite: due run in parallelo\n` +
    `      condividono DB, HOME finto e socket, si cancellano i dati a vicenda, e il cancello\n` +
    `      pre-review diventa rosso a caso. Usa testTmpDir("<etichetta>") da\n` +
    `      tests/integration/helpers e rimuovi la cartella in afterAll. Se quella stringa e'\n` +
    `      un DATO e non una cartella, chiudi la riga con "// allow-shared-tmp: <ragione>".`
  );
}

/** Compone una riga di sorgente finta. Scritta cosi' e non a mano perche' una
 *  dichiarazione letterale qui dentro sarebbe materia per il check stesso. */
const riga = (kw: string, nome: string, valore: string, coda = "") =>
  `${kw} ${nome} ${"="} ${valore};${coda}`;

describe("path fissi in /tmp nei test", () => {
  it("nessun file di test ne dichiara uno", () => {
    const hits = scanForFixedTmpPaths(REPO_ROOT, testFiles(REPO_ROOT));
    // Il messaggio conta piu' dell'assert: dice dove, e dice cosa farne.
    expect(hits.map(spiega).join("\n")).toBe("");
  });

  it("guarda davvero dentro i file (le radici non sono vuote)", () => {
    // Senza questo, una radice sbagliata renderebbe il test qui sopra verde per
    // sempre: e' esattamente il modo in cui una rete smette di essere una rete.
    const files = testFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    for (const root of SCAN_ROOTS) {
      expect(files.some((f) => f.startsWith(`${root}/`))).toBe(true);
    }
    expect(files.every((f) => f.endsWith(".test.ts"))).toBe(true);
    // Le spec Playwright non sono affar suo: girano fuori da `test:unit`.
    expect(files.some((f) => f.startsWith("tests/e2e/"))).toBe(false);
    // E le radici senza filesystem restano fuori, per scelta (vedi il commento
    // in testa): se un giorno rientrassero, questa riga e' il posto dove dirlo.
    expect(files.some((f) => f.startsWith("client/src/"))).toBe(false);
  });

  it("trova i path fissi e lascia stare tutto il resto", () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-tmp-check-"));
    writeFileSync(
      join(dir, "colpevole.test.ts"),
      [
        riga("const", "TEST_DATA", '"/tmp/topics-qualcosa"'),
        riga("let", "ALTRO: string", "'/tmp/topics-altro'"),
        riga("const", "SECONDI", "'/tmp/topics-a', GEMELLO = '/tmp/topics-b'"),
        // Sotto la radice giusta ma ancora fisso: due run ci finiscono uguale.
        riga("const", "SOTTO_LA_RADICE", '"/tmp/topics-test/non-basta"'),
        // E le forme che NON sono un guasto. Le tre che seguono sono la regola
        // stessa messa per iscritto: fuori il parametro di default, fuori la
        // proprieta' di oggetto, fuori l'argomento di chiamata. Sono dati che
        // passano di mano, non cartelle che qualcuno crea.
        `function parametro(p = "/tmp/topics-default") { return p; }`,
        riga("const", "proprieta", '{ file_path: "/tmp/topics-oggetto" }'),
        riga("const", "argomento", 'carica("/tmp/topics-arg")'),
        riga("const", "scusato", '"/tmp/topics-ok"', " // allow-shared-tmp: e' un dato, non una cartella"),
        riga("const", "interpolato", "`/tmp/topics-${Date.now()}`"),
        `  // ${riga("const", "COMMENTATO", '"/tmp/topics-commentato"')}`,
      ].join("\n"),
    );

    const hits = scanForFixedTmpPaths(dir, ["colpevole.test.ts"]);

    expect(hits.map((h) => h.name)).toEqual([
      "TEST_DATA",
      "ALTRO",
      "SECONDI",
      "GEMELLO",
      "SOTTO_LA_RADICE",
    ]);
    expect(hits[0]).toMatchObject({ line: 1, path: "/tmp/topics-qualcosa" });
    // E il rimprovero nomina il file, la riga e la cura.
    expect(spiega(hits[0]!)).toContain("colpevole.test.ts:1");
    expect(spiega(hits[0]!)).toContain("testTmpDir");

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Chi lancia `git` in un test si porta l'ambiente isolato del preload.
 *
 * PERCHE' NON BASTA AVERLI CORRETTI. Il 24/08 diciassette file di test
 * costruivano un repo git vero e ci facevano 46 commit ereditando la config
 * della macchina, hook compresi. Su quella di sviluppo `core.hooksPath` punta a
 * un `prepare-commit-msg` di terze parti che a ogni commit fa due
 * `curl --max-time 2` verso `localhost:3333`: misurato, 380ms per commit contro
 * 160ms, e sotto carico i test sforavano il timeout. Il sintomo era il peggiore
 * possibile, un rosso che compariva SOLO nella suite intera e su un test diverso
 * ogni volta.
 *
 * I diciassette sono stati corretti a mano. Questa guardia esiste per il
 * diciottesimo, quello che nascera' domani: il criterio «questo file lancia
 * git?» non e' scritto da nessuna parte, e chi copia il vicino copiera' la
 * versione senza `env`. Il costo di riscoprirlo e' una giornata, perche' il
 * rosso non parla del file che l'ha causato.
 *
 * COSA PRETENDE, e perche' cosi' poco: che dove c'e' uno spawn di `git` ci sia
 * anche un `env`, non che sia `gitEnv()`. `landing-verdict.test.ts` passa
 * `process.env` con dentro `GIT_AUTHOR_DATE` per fissare le date, ed eredita
 * l'isolamento lo stesso, quindi pretendere il nome della funzione lo
 * boccerebbe per niente. La differenza che conta e' fra «passo un ambiente» e
 * «non ne passo nessuno», che e' il caso in cui `Bun.spawnSync` non eredita
 * cio' che il preload ha impostato a runtime.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "..", "..");

/** I file di test tracciati da git: quelli non tracciati non sono di nessuno. */
function testTracciati(): string[] {
  const out = execFileSync("git", ["ls-files", "*.test.ts"], {
    cwd: RADICE,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // QUESTO file resta fuori dalla scansione, e non e' una scorciatoia.
  //
  // La prova «lo scanner sa dire di NO» contiene, per forza, un esempio
  // LETTERALE della forma cattiva: `Bun.spawnSync(["git", ...], { stdout })`
  // senza `env`. E' la meta' non vacua del cancello — senza, lo scanner
  // potrebbe smettere di riconoscere la forma e il test passerebbe per sempre
  // guardando il nulla. Ma quell'esempio e' testo, non una chiamata: nessun
  // git viene lanciato, nessun hook della macchina entra in un test.
  //
  // Scansionando anche se stesso, il cancello si autodenunciava: rosso fisso,
  // colpevole `tests/unit/git-env-nei-test.test.ts (1)`, e nessun modo di
  // farlo tornare verde se non cancellando proprio la prova che lo rende
  // affilato. Un cancello che chiede di disarmarsi per diventare verde ha un
  // difetto nel perimetro, non nella regola.
  const questoFile = "tests/unit/git-env-nei-test.test.ts";
  return out.split("\n").filter(Boolean).filter((f) => f !== questoFile);
}

/**
 * Gli spawn di `git` in un file, con l'indicazione se portano un `env`.
 *
 * Si guarda la chiamata per intero fino alla parentesi che la chiude, perche'
 * `env` sta nelle opzioni e quelle possono andare a capo. Un `env` che compare
 * DOPO la fine della chiamata non e' di questa chiamata.
 */
function spawnSenzaEnv(testo: string): number {
  let quanti = 0;
  const re = /(?:Bun\.)?spawnSync?\(\s*\[\s*["']git["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(testo))) {
    // Dalla chiamata, si prende fino alla graffa di chiusura delle opzioni o
    // alla parentesi finale: e' li' che vive `env`.
    const coda = testo.slice(m.index, m.index + 600);
    const fine = coda.indexOf(");");
    const chiamata = fine === -1 ? coda : coda.slice(0, fine);
    // `env: qualcosa` oppure la forma abbreviata `{ ..., env }`, che
    // `landing-verdict.test.ts` usa per infilare GIT_AUTHOR_DATE: passa un
    // ambiente a tutti gli effetti, e bocciarla sarebbe un falso positivo.
    if (!/\benv\s*[:,}]/.test(chiamata)) quanti += 1;
  }
  return quanti;
}

describe("i test che lanciano git si portano l'ambiente isolato", () => {
  test("lo scanner vede qualcosa (guardia contro un elenco vuoto)", () => {
    // Senza questa riga il test sarebbe verde anche se `git ls-files` non
    // tornasse niente, cioe' misurando il nulla.
    const files = testTracciati();
    expect(files.length).toBeGreaterThan(100);
  });

  test("lo scanner sa dire di NO (guardia contro un controllo che non morde)", () => {
    // Il caso negativo: se `spawnSenzaEnv` non riconoscesse piu' la forma, il
    // test sotto passerebbe per sempre senza guardare niente.
    expect(spawnSenzaEnv(`Bun.spawnSync(["git", "-C", d, "log"], { stdout: "pipe" });`)).toBe(1);
    expect(spawnSenzaEnv(`Bun.spawnSync(["git", "-C", d, "log"], { stdout: "pipe", env: gitEnv() });`)).toBe(0);
    expect(spawnSenzaEnv(`Bun.spawnSync(["git", "log"], { env: process.env });`)).toBe(0);
    expect(spawnSenzaEnv(`Bun.spawnSync(["git", "log"], { stdout: "pipe", env });`)).toBe(0);
  });

  test("nessun file di test lancia git senza passare un env", () => {
    const colpevoli: string[] = [];
    for (const rel of testTracciati()) {
      let testo: string;
      try {
        testo = readFileSync(join(RADICE, rel), "utf-8");
      } catch {
        continue; // cancellato fra `ls-files` e qui: non e' un colpevole
      }
      const n = spawnSenzaEnv(testo);
      if (n > 0) colpevoli.push(`${rel} (${n})`);
    }
    // Se questo elenco non e' vuoto: aggiungi `env: gitEnv()` allo spawn, con
    // `import { gitEnv } from "<...>/tests/setup/bun-test-preload"`. Serve a
    // tenere fuori gli hook della macchina di chi esegue, che altrimenti girano
    // a ogni commit del tuo repo di prova.
    expect(colpevoli).toEqual([]);
  });
});

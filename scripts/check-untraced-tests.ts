#!/usr/bin/env bun
/**
 * R6 — UN TEST CHE NON DICHIARA COSA COPRE.
 *
 * IL BUCO CHE CHIUDE, e non è teorico: in una sola notte la stessa forma è
 * comparsa TRE volte — la status line della sidebar (8 file di test, zero
 * requisiti), la resa delle chiamate a tool, e il banco sui leak di memoria
 * (banco + cancello funzionanti, nessun requisito che li nominasse). Ogni volta:
 * funzionalità viva, coperta da test, e il documento di riferimento in silenzio.
 * Chi legge le spec crede che la feature non esista; chi guarda i test crede che
 * sia descritta; e i due non possono accorgersi l'uno dell'altro.
 *
 * PERCHÉ `check-spec-coverage` non poteva vederlo. Quel cancello verifica che
 * ogni REQUISITO abbia un test (R2) e che ogni id dichiarato esista (R1).
 * Entrambe partono dalle spec e guardano verso i test. La direzione opposta —
 * dai test verso le spec — non era controllata da niente, ed è esattamente la
 * direzione in cui si perde una funzionalità.
 *
 * PERCHÉ UN CRICCHETTO E NON UN DIVIETO. Alla prima misura, 1.043 file di test
 * su 1.166 non dichiarano niente: l'89%. Un cancello che li accusa tutti è rosso
 * dal primo giorno, e un cancello rosso di default smette di essere letto entro
 * un mese — è la stessa ragione per cui esistono le tolleranze negli altri
 * cancelli di questo repository. Quindi la linea di partenza assorbe l'esistente
 * e questo controllo risponde a UNA domanda sola, che è quella che conta:
 *
 *     un file di test NUOVO dichiara cosa copre?
 *
 * La linea di partenza scende soltanto. Un file che guadagna una dichiarazione
 * ne esce e non può rientrare.
 *
 *   bun run scripts/check-untraced-tests.ts
 *   bun run scripts/check-untraced-tests.ts --update-baseline
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts", "untraced-tests-baseline.json");

/** The two channels a test may declare a requirement through. */
const DECLARES = /@covers\s+[A-Z]|type:\s*["']spec["']/;

function testFiles(): string[] {
  // `--others --exclude-standard` include i file NON ANCORA tracciati, ed e'
  // il caso che conta: un test appena scritto e non ancora committato e'
  // esattamente quello che questo cancello esiste per prendere. Con il solo
  // `ls-files` il controllo era cieco proprio prima del commit — misurato,
  // creando un file di prova che non veniva visto.
  // allow-italian: descrive il difetto trovato, non e' testo mostrato
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return out
    .split("\n")
    .filter((f) => /\.(test|spec)\.tsx?$/.test(f))
    // Helpers and fixtures are not tests and have nothing to declare.
    .filter((f) => !/\/(helpers|fixtures|setup)\//.test(f));
}

const untraced = testFiles().filter((f) => {
  try {
    return !DECLARES.test(readFileSync(join(ROOT, f), "utf8"));
  } catch {
    return false;
  }
});

const base: string[] = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")).files ?? []) : [];
const known = new Set(base);

if (process.argv.includes("--update-baseline")) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        $schema: "untraced-tests-v1",
        _comment: [
          "File di test che non dichiarano quale requisito coprono, tollerati.",
          "SCENDE SOLTANTO: un file che guadagna un `@covers` (o l'annotazione",
          "Playwright `type: \"spec\"`) esce da qui e non puo' rientrare.",
          "Un file NUOVO senza dichiarazione e' rosso, e la cura non e' aggiungerlo",
          "a questa lista: e' scrivere il requisito che quel test prova gia'.",
        ],
        count: untraced.length,
        files: untraced.sort(),
      },
      null,
      1,
    )}\n`,
  );
  console.log(`[untraced-tests] baseline scritta: ${untraced.length} file.`);
  process.exit(0);
}

const nuovi = untraced.filter((f) => !known.has(f));
const risolti = base.filter((f) => !untraced.includes(f));

if (nuovi.length > 0) {
  console.log(`[untraced-tests] FAIL: ${nuovi.length} file di test NUOVI non dichiarano cosa coprono:\n`);
  for (const f of nuovi.slice(0, 20)) console.log(`  ${f}`);
  if (nuovi.length > 20) console.log(`  … e altri ${nuovi.length - 20}`);
  console.log(`
Un test che non nomina il requisito che prova e' copertura che le spec non
vedono. E' successo tre volte in una notte: la fascia della sidebar, la resa
dei tool e il banco sui leak erano tutti coperti e tutti invisibili.

La cura NON e' aggiungere il file alla linea di partenza. E' una riga:
  ·  test in bun:    \`@covers <ID>\` nel docblock in testa
  ·  spec Playwright: test.info().annotations.push({ type: "spec", description: "<ID>" })
Se il requisito non esiste ancora, scrivilo: il test lo prova gia'.`);
  process.exit(1);
}

if (risolti.length > 0) {
  console.log(`[untraced-tests] debito sceso di ${risolti.length}, rilancia con --update-baseline per fissarlo:`);
  for (const f of risolti.slice(0, 12)) console.log(`    ${f}`);
  process.exit(1);
}

console.log(`[untraced-tests] OK: ${untraced.length} file senza dichiarazione (linea di partenza ${base.length}), nessuno nuovo.`);

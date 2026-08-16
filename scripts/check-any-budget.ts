#!/usr/bin/env bun
/**
 * IL TETTO SUGLI `any` DEL SERVER, e perche' non basta il ratchet che c'era.
 *
 * `check:any` guarda SEI file, per nome, scelti a mano durante un refactor di
 * mesi fa (`TRACKED_FILES` in `scripts/check-any.ts`). Fa bene il suo lavoro:
 * quei sei restano a zero. Ma il repo ne ha 282 di file non-test fra `server/`,
 * `shared/` e `relay/`, e in 57 di loro ci sono **370** `any` che nessun
 * cancello guarda. Un file nuovo pieno di `any` nasce verde, e il numero puo'
 * solo salire senza che niente lo dica: il ratchet e' vero ma la sua copertura
 * e' il 2% dei file.
 *
 * PERCHE' UN TETTO E NON UN DIVIETO. Vietare `any` oggi vorrebbe dire 370
 * errori al primo giro, cioe' un cancello rosso all'arrivo, cioe' un cancello
 * spento entro la settimana — e' gia' successo in questo repo e sta scritto
 * nella baseline di `check:bloat`. Un tetto che parte da dove siamo oggi
 * fallisce solo se il numero SALE, e si abbassa da solo ogni volta che qualcuno
 * ne toglie qualcuno.
 *
 * PERCHE' DUE CANCELLI E NON UNO. Questo NON sostituisce `check:any`: quello e'
 * un divieto assoluto su file che sono gia' puliti, e un tetto globale non lo
 * rimpiazza — con 370 di budget, un file ratchettato potrebbe riprendersi dieci
 * `any` senza che il totale se ne accorga. Uno difende lo zero dove c'e', l'altro
 * impedisce al resto di crescere. Rispondono a due domande diverse.
 *
 * IL CONTEGGIO E' LO STESSO di `check:any` per costruzione — stessa regex,
 * stesso trattamento dei commenti, stesso `// allow-any:` — perche' due gate
 * che contano la stessa cosa in due modi diversi finiscono per contraddirsi, e
 * il primo che sbaglia insegna a ignorare l'altro.
 *
 * COME SI VEDE ROSSO: `bun run scripts/check-any-budget.ts --max 0`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const BUDGET_FILE = resolve(ROOT, "scripts/any-budget.json");

/** Le aree che questo tetto copre. Il client ha eslint, che li vieta gia' suo. */
const GLOBS = ["server/**/*.ts", "shared/**/*.ts", "relay/**/*.ts"];

const ANY_RE = /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/;

/** I file tracciati da git nelle aree coperte, esclusi i test. */
export function trackedFiles(root = ROOT): string[] {
  const out = spawnSync("git", ["ls-files", ...GLOBS], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files e' uscito ${out.status}`);
  return out.stdout.split("\n").map((s) => s.trim()).filter((f) => f && !f.endsWith(".test.ts"));
}

/** I block comment via, ma con le righe al loro posto (i numeri devono reggere). */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Quante righe di CODICE contengono un `any` non esentato, in questa sorgente. */
export function countAny(src: string): number {
  let n = 0;
  for (const line of stripBlockComments(src).split(/\r?\n/)) {
    const code = line.split("//")[0];
    if (!ANY_RE.test(code)) continue;
    if (line.includes("allow-any:")) continue;
    n++;
  }
  return n;
}

export interface Budget {
  max: number;
  measured: number;
  updated: string;
  why: string;
}

function readBudget(): Budget | null {
  if (!existsSync(BUDGET_FILE)) return null;
  return JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Budget;
}

export function verdict(total: number, max: number): "ok" | "over" | "shrunk" {
  if (total > max) return "over";
  if (total < max) return "shrunk";
  return "ok";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const iMax = argv.indexOf("--max");
  const override = iMax >= 0 ? Number(argv[iMax + 1]) : null;
  const update = argv.includes("--update-baseline");

  const files = trackedFiles();
  let total = 0;
  const perFile: Array<[string, number]> = [];
  for (const f of files) {
    const n = countAny(readFileSync(resolve(ROOT, f), "utf8"));
    if (n > 0) { perFile.push([f, n]); total += n; }
  }
  perFile.sort((a, b) => b[1] - a[1]);

  if (update) {
    const b: Budget = {
      max: total,
      measured: total,
      updated: new Date().toISOString().slice(0, 10),
      why:
        "Il tetto e' la misura del giorno in cui e' stato scritto: fallisce se sale, " +
        "e si riscrive quando scende. Non e' un obiettivo, e' un cricchetto.",
    };
    writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 2) + "\n");
    console.log(`[any-budget] baseline scritta: ${total} in ${perFile.length} file.`);
    process.exit(0);
  }

  const budget = readBudget();
  const max = override ?? budget?.max ?? null;
  if (max == null) {
    console.error("[any-budget] nessuna baseline: `bun run scripts/check-any-budget.ts --update-baseline`");
    process.exit(2);
  }

  const v = verdict(total, max);
  if (v === "over") {
    console.error(`[any-budget] FAIL — ${total} 'any' contro un tetto di ${max} (+${total - max}).`);
    console.error("I dieci file che ne portano di piu':");
    for (const [f, n] of perFile.slice(0, 10)) console.error(`  ${String(n).padStart(4)}  ${f}`);
    console.error(
      "\nIl tetto puo' solo SCENDERE. Se l'`any` in piu' e' inevitabile, mettigli accanto\n" +
        "'// allow-any: <ragione>' — che e' una riga che qualcuno dovra' leggere in review,\n" +
        "ed e' il punto. Alzare il numero in scripts/any-budget.json non e' una strada.",
    );
    process.exit(1);
  }
  if (v === "shrunk") {
    console.log(`[any-budget] OK — ${total} 'any', sotto il tetto di ${max}.`);
    console.log(`Ne sono spariti ${max - total}: abbassa il cricchetto con --update-baseline, nello stesso commit.`);
    process.exit(0);
  }
  console.log(`[any-budget] OK — ${total} 'any', esattamente il tetto.`);
  process.exit(0);
}

#!/usr/bin/env bun
/**
 * scripts/check-e2e-sleeps.ts — un cricchetto sui SONNI FISSI della suite E2E.
 *
 * ── Perché ──────────────────────────────────────────────────────────────────
 * `tests/e2e/CONVENTIONS.md:16` dice, da sempre, «NEVER use page.waitForTimeout(N)».
 * Misurato il 15/08/2026 la suite ne conteneva 129 su 51 spec del gate PR: circa
 * 133 secondi per passata in cui non si aspetta NIENTE, si aspetta e basta.
 *
 * Un sonno fisso rompe in due modi che si sommano:
 *   · è tempo morto moltiplicato per ogni run e per ogni shard;
 *   · è la scommessa «300ms bastano», che su una macchina carica non basta e su
 *     una scarica ne sprecava 280. Il rosso che ne nasce non nomina la causa,
 *     quindi diventa «flaky» e si impara a rilanciare.
 *
 * Riscriverli tutti in una passata non si può fare in sicurezza: ognuno nasconde
 * una condizione diversa, e trasformarne uno male vuol dire un rosso vero
 * scambiato per un test rotto. Quindi questo cancello NON li vieta: impedisce
 * che AUMENTINO. Chi ne converte uno abbassa la baseline; chi ne aggiunge uno
 * deve prima spiegare a un umano perché.
 *
 * ── Come misura ─────────────────────────────────────────────────────────────
 * Conta le CHIAMATE `waitForTimeout(` sotto `tests/e2e/`, non le righe: i
 * commenti (di riga e di blocco) e le stringhe non contano, altrimenti questa
 * stessa intestazione varrebbe una decina di sonni. Il totale in millisecondi
 * si stampa quando l'argomento è un letterale, ed è informativo — il cricchetto
 * scatta sul CONTEGGIO, che è l'unica cosa che non si può abbassare barando.
 *
 * ── Cosa fa fallire ─────────────────────────────────────────────────────────
 *   · un file che GUADAGNA una chiamata rispetto alla baseline;
 *   · un file NUOVO che ne introduce una (baseline implicita: zero).
 * Scendere non fallisce mai: stampa la riga che chiede `--update-baseline`.
 *
 * EXIT CODES
 *   0  entro la baseline
 *   1  sopra: un file cresciuto, o un file nuovo con un sonno dentro
 *   2  la misura non si è potuta prendere (baseline illeggibile, cartella assente)
 *
 * USAGE
 *   bun run check:sleeps                     cricchetto contro la baseline
 *   bun run check:sleeps --json              stesso responso, leggibile da una macchina
 *   bun run check:sleeps --update-baseline   riscrive la baseline da oggi
 *   bun run check:sleeps --max=0             modo ASSOLUTO: fallisce sopra N per file
 *   bun run check:sleeps --top=30            quante righe stampare
 *   bun run check:sleeps --root=<dir>        misura un altro checkout
 *
 * MODO ASSOLUTO. `--max=N` ignora la baseline e fallisce se un file qualsiasi
 * supera N. È anche il modo di provare il codice di uscita in entrambe le
 * direzioni senza toccare un file:
 *   bun run scripts/check-e2e-sleeps.ts --max=0        -> 1
 *   bun run scripts/check-e2e-sleeps.ts --max=999      -> 0
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");
const E2E_DIR = "tests/e2e";
const SOURCE_EXT = /\.tsx?$/;
const SKIP_DIRS = new Set(["node_modules", "test-results", "screenshots"]);

interface Options {
  root: string;
  baselinePath: string;
  max: number | null;
  json: boolean;
  updateBaseline: boolean;
  top: number;
}

interface Baseline {
  _comment: string[];
  updated: string;
  /** path (relativo alla radice del repo) -> numero di chiamate quel giorno. Solo i file che ne hanno. */
  files: Record<string, number>;
  total_calls: number;
  total_ms: number;
  /** How many of those calls carry a `DELIBERATE FIXED WAIT` reason. Informative. */
  total_declared?: number;
  /** total_calls - total_declared. This is the debt. Informative. */
  total_undeclared?: number;
}

interface FileCount {
  file: string;
  calls: number;
  /** Somma degli argomenti LETTERALI. Le chiamate con un argomento calcolato non ci entrano. */
  ms: number;
  lines: number[];
  /** Calls carrying a `DELIBERATE FIXED WAIT:` comment: there the time IS the experiment. */
  declared: number;
  /** All the others. This is the number that has to reach zero, not the total. */
  undeclared: number;
  /** Lines of the undeclared calls only. */
  undeclaredLines: number[];
}

// ---------------------------------------------------------------------------
// Lettura dell'albero
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
}

// ---------------------------------------------------------------------------
// Conteggio
// ---------------------------------------------------------------------------

/**
 * Il sorgente con commenti e stringhe SVUOTATI, lunghezza e righe intatte.
 *
 * Svuotare invece di cancellare serve a poter ancora dire a quale riga sta una
 * chiamata. E le stringhe si svuotano perché un `"waitForTimeout"` scritto
 * dentro un messaggio d'errore — questo script ne ha uno — non è un sonno: un
 * cancello che accusa la propria diagnostica non lo si tiene acceso a lungo.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (inLine) {
      if (c === "\n") inLine = false;
      else out[i] = " ";
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        inBlock = false;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        out[i] = " ";
        if (next !== undefined && next !== "\n") out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      inLine = true;
      continue;
    }
    if (c === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      inBlock = true;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out[i] = " ";
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

const SLEEP_CALL = /\bwaitForTimeout\s*\(\s*([0-9_]+)?/g;

/**
 * The pact that turns this gate from a debt archive into a RULE.
 *
 * A handful of sleeps are not debt: they are the experiment. When the assertion
 * is "for N ms nothing happened" (no re-render, no extra request, no banner)
 * the window IS the oracle, and replacing it with a condition deletes the test.
 * Those declare themselves in the comment right above the call, and this gate
 * counts them apart. Everything else is an undeclared bet on a clock.
 */
const DECLARED_MARKER = /DELIBERATE FIXED WAIT/;
/** How many lines above the call are searched for the declaration. */
const DECLARED_LOOKBACK = 8;

function countFile(root: string, absPath: string): FileCount | null {
  const src = readFileSync(absPath, "utf8");
  const rawLines = src.split("\n");
  const code = blankNonCode(src);
  const lines: number[] = [];
  const undeclaredLines: number[] = [];
  let calls = 0;
  let ms = 0;
  let declared = 0;

  SLEEP_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLEEP_CALL.exec(code)) !== null) {
    calls++;
    if (m[1]) ms += Number(m[1].replace(/_/g, ""));
    const line = code.slice(0, m.index).split("\n").length;
    lines.push(line);
    // The window includes the call's own line: the declaration may sit at the
    // end of the call instead of above it, and both spellings count.
    const from = Math.max(0, line - 1 - DECLARED_LOOKBACK);
    const window = rawLines.slice(from, line).join("\n");
    if (DECLARED_MARKER.test(window)) declared++;
    else undeclaredLines.push(line);
  }
  if (calls === 0) return null;
  return {
    file: relative(root, absPath),
    calls,
    ms,
    lines,
    declared,
    undeclared: calls - declared,
    undeclaredLines,
  };
}

function measure(root: string): FileCount[] {
  const dir = join(root, E2E_DIR);
  if (!existsSync(dir)) {
    console.error(`[check-sleeps] ${E2E_DIR} non esiste sotto ${root}`);
    process.exit(2);
  }
  const files: string[] = [];
  walk(dir, files);
  files.sort();
  return files.map((f) => countFile(root, f)).filter((c): c is FileCount => c !== null);
}

// ---------------------------------------------------------------------------
// Opzioni e baseline
// ---------------------------------------------------------------------------

function parseOptions(argv: string[]): Options {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const root = resolve(get("root") ?? DEFAULT_ROOT);
  const maxRaw = get("max");
  return {
    root,
    baselinePath: resolve(get("baseline") ?? join(root, "scripts/e2e-sleeps-baseline.json")),
    max: maxRaw === null ? null : Number(maxRaw),
    json: argv.includes("--json"),
    updateBaseline: argv.includes("--update-baseline"),
    top: Number(get("top") ?? 20),
  };
}

function readBaseline(path: string): Baseline {
  if (!existsSync(path)) {
    console.error(`[check-sleeps] baseline assente: ${path} (creala con --update-baseline)`);
    process.exit(2);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Baseline;
    if (!parsed.files || typeof parsed.files !== "object") throw new Error("manca il campo `files`");
    return parsed;
  } catch (err) {
    console.error(`[check-sleeps] baseline illeggibile: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

function writeBaseline(opts: Options, counts: FileCount[]): void {
  const files: Record<string, number> = {};
  for (const c of counts.slice().sort((a, b) => a.file.localeCompare(b.file))) files[c.file] = c.calls;
  const baseline: Baseline = {
    _comment: [
      "Sonni fissi (page.waitForTimeout) per file sotto tests/e2e, congelati al giorno indicato.",
      "Il cancello e' scripts/check-e2e-sleeps.ts: un file che ne guadagna uno, o un file nuovo che ne",
      "introduce uno, fa uscire 1. Scendere non fallisce mai: riabbassa il numero con --update-baseline.",
      "Non alzare un numero per far passare la CI. Un sonno in piu' e' una decisione, non un effetto",
      "collaterale: la convenzione sta in tests/e2e/CONVENTIONS.md.",
      "total_declared conta i sonni che portano scritto DELIBERATE FIXED WAIT: quelli in cui il tempo",
      "E' l'esperimento (si asserisce che per N ms non e' successo niente, o la cadenza e' lo strumento).",
      "Il debito e' total_undeclared, ed e' quello che deve arrivare a zero.",
    ],
    updated: new Date().toISOString().slice(0, 10),
    files,
    total_calls: counts.reduce((a, c) => a + c.calls, 0),
    total_ms: counts.reduce((a, c) => a + c.ms, 0),
    total_declared: counts.reduce((a, c) => a + c.declared, 0),
    total_undeclared: counts.reduce((a, c) => a + c.undeclared, 0),
  };
  writeFileSync(opts.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[check-sleeps] baseline riscritta: ${relative(opts.root, opts.baselinePath)} (${baseline.total_calls} chiamate, ${(baseline.total_ms / 1000).toFixed(1)}s)`);
}

// ---------------------------------------------------------------------------
// Verdetto
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  was: number;
  now: number;
  lines: number[];
}

function main(): void {
  const opts = parseOptions(process.argv.slice(2));
  const counts = measure(opts.root);
  const totalCalls = counts.reduce((a, c) => a + c.calls, 0);
  const totalMs = counts.reduce((a, c) => a + c.ms, 0);
  const totalDeclared = counts.reduce((a, c) => a + c.declared, 0);
  const totalUndeclared = totalCalls - totalDeclared;

  if (opts.updateBaseline) {
    writeBaseline(opts, counts);
    return;
  }

  const absolute = opts.max !== null;
  const baseline = absolute ? null : readBaseline(opts.baselinePath);
  const worse: Violation[] = [];
  const better: Violation[] = [];

  for (const c of counts) {
    const allowed = absolute ? opts.max! : (baseline!.files[c.file] ?? 0);
    if (c.calls > allowed) worse.push({ file: c.file, was: allowed, now: c.calls, lines: c.lines });
    else if (!absolute && c.calls < allowed) better.push({ file: c.file, was: allowed, now: c.calls, lines: c.lines });
  }
  if (!absolute) {
    const seen = new Set(counts.map((c) => c.file));
    for (const [file, was] of Object.entries(baseline!.files)) {
      if (!seen.has(file)) better.push({ file, was, now: 0, lines: [] });
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          total_calls: totalCalls,
          total_ms: totalMs,
          total_declared: totalDeclared,
          total_undeclared: totalUndeclared,
          worse,
          better,
          files: counts,
        },
        null,
        2,
      ),
    );
    process.exit(worse.length ? 1 : 0);
  }

  const top = counts.slice().sort((a, b) => b.calls - a.calls || a.file.localeCompare(b.file)).slice(0, opts.top);
  console.log(`[check-sleeps] ${totalCalls} sonni fissi in ${counts.length} file sotto ${E2E_DIR} — ${(totalMs / 1000).toFixed(1)}s per passata (argomenti letterali)`);
  console.log(`[check-sleeps] di cui ${totalDeclared} DICHIARATI (il tempo e' l'esperimento) e ${totalUndeclared} no. Il numero che deve arrivare a zero e' il secondo.`);
  console.log(`[check-sleeps] i piu' grossi (calls = dichiarati + non):`);
  for (const c of top) {
    console.log(
      `  ${String(c.calls).padStart(3)}  ${String(c.declared).padStart(3)} dich.  ${(c.ms / 1000).toFixed(1).padStart(6)}s  ${c.file}`,
    );
  }

  for (const b of better) {
    console.log(`[check-sleeps] MEGLIO: ${b.file} ${b.was} -> ${b.now}. Riabbassa la baseline con --update-baseline.`);
  }
  if (worse.length === 0) {
    console.log(absolute ? `[check-sleeps] OK: nessun file sopra ${opts.max}.` : "[check-sleeps] OK: nessun file ha guadagnato un sonno fisso.");
    process.exit(0);
  }
  console.error("");
  for (const w of worse) {
    const where = w.lines.length ? ` (righe ${w.lines.join(", ")})` : "";
    console.error(`[check-sleeps] SOPRA: ${w.file} ${w.was} -> ${w.now}${where}`);
  }
  console.error("");
  console.error("Un'attesa a tempo non aspetta niente: aspetta e basta. Sostituiscila con la condizione");
  console.error("vera (expect(locator).toBeVisible(), expect.poll(...), waitForFunction) — la convenzione");
  console.error("e' in tests/e2e/CONVENTIONS.md. Se il sonno e' davvero inevitabile, e' una decisione da");
  console.error("prendere con un umano, non da far passare alzando la baseline.");
  process.exit(1);
}

main();

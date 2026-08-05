#!/usr/bin/env bun
/**
 * scripts/check-test-skips.ts — un test che si salta da solo deve dire perché,
 * e non devono aumentare.
 *
 * ── Perché ──────────────────────────────────────────────────────────────────
 * `grid-split.spec.ts` chiudeva con «24 passed, 3 skipped». Nessuno legge quel
 * numero: tre criteri di accettazione erano fermi da mesi — uno saltava perché
 * la navigazione della sidebar non trovava più il progetto, un altro chiamava
 * "no-op" una divisione che non atterrava, il terzo era un `test.fixme()` col
 * corpo vuoto che si annotava da sé la copertura. Un test verde-vuoto è peggio
 * di un test assente: l'assenza si vede, il verde no.
 *
 * Questo check non vieta gli skip — alcuni sono onesti (un gateway che non c'è,
 * una CLI non installata, un bug di prodotto tracciato). Vieta i due modi in cui
 * smettono di essere onesti:
 *
 *   1. **Skip muto** — `test.skip()` / `test.fixme()` senza messaggio. Chi legge
 *      il report non può sapere se è l'ambiente o una regressione, quindi non
 *      guarda. Il messaggio è ciò che rende lo skip rivedibile.
 *
 *   2. **Crescita silenziosa** — il totale non può salire sopra BASELINE. Un
 *      cricchetto, come `typecheck-server.ts`: aggiungerne uno è una decisione,
 *      non un effetto collaterale. Se lo togli, ABBASSA la soglia.
 *
 * NON è coperto — e non può esserlo staticamente — lo skip la cui condizione è
 * sempre vera nell'ambiente reale. Per quello serve leggere il conteggio
 * "skipped" di una run: se un file ne ha di stabili, il posto giusto per dirlo
 * è il messaggio dello skip stesso.
 *
 * Run: `bun run scripts/check-test-skips.ts`
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from "fs";
import { join, resolve, relative } from "path";

const ROOT = "tests";
const SPEC_EXT = /\.(spec|test)\.ts$/;
const SKIP_DIRS = new Set(["node_modules", "test-results"]);

/**
 * Il numero di skip/fixme al 05/08/2026, dopo aver recuperato GRID-05, GRID-10
 * e tolto lo stub del DnD. Non alzarlo per far passare la CI: o il test si
 * ripara, o lo skip merita una discussione.
 */
const BASELINE = 14;

/** `test.skip(` e `test.fixme(` — non `test.describe.skip`, che disattiva un blocco intero. */
const SKIP_CALL = /\btest\.(skip|fixme)\s*\(/g;

interface Hit {
  file: string;
  line: number;
  kind: string;
  text: string;
  mute: boolean;
}

/** Il codice di una riga, senza il commento di fine riga. */
function codeOf(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.split("//")[0];
}

/**
 * Gli argomenti della chiamata, dal `(` alla parentesi che lo chiude. Conta le
 * parentesi invece di fermarsi alla prima: `test.skip(!(await ready()), MSG)`
 * ne contiene altre, e troncare lì direbbe "muto" a uno skip che ha il messaggio.
 */
function callArgs(code: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  return code.slice(openIdx + 1); // chiamata su più righe: si giudica sul primo pezzo
}

/**
 * Muto = niente messaggio per chi legge il report. Un letterale di stringa o
 * una costante MAIUSCOLA (`NO_CLAUDE`) contano come messaggio; una sola
 * condizione booleana no.
 */
function isMute(args: string): boolean {
  const a = args.trim();
  if (a === "") return true;
  if (/["'`]/.test(a)) return false;
  return !/\b[A-Z][A-Z0-9_]{2,}\b/.test(a);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    // `lstat`, non `stat`: sotto tests/e2e/data vive un symlink al bundle
    // congelato della run, che fra una run e l'altra punta nel vuoto. `stat` lo
    // segue e lancia ENOENT; qui i link non si seguono comunque — le spec sono
    // file veri.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, out);
    else if (SPEC_EXT.test(name)) out.push(full);
  }
}

function scan(file: string): Hit[] {
  const hits: Hit[] = [];
  readFileSync(file, "utf-8").split(/\r?\n/).forEach((line, idx) => {
    const code = codeOf(line);
    SKIP_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SKIP_CALL.exec(code)) !== null) {
      const open = code.indexOf("(", m.index);
      hits.push({
        file: relative(process.cwd(), file),
        line: idx + 1,
        kind: m[1],
        text: line.trim(),
        mute: isMute(callArgs(code, open)),
      });
    }
  });
  return hits;
}

function main(): void {
  const root = resolve(ROOT);
  if (!existsSync(root)) {
    console.error(`[check-test-skips] ${ROOT}/ non esiste`);
    process.exit(1);
  }
  const files: string[] = [];
  walk(root, files);

  const hits = files.flatMap(scan);
  const mute = hits.filter((h) => h.mute);
  let failed = false;

  if (mute.length > 0) {
    failed = true;
    console.error(`[check-test-skips] FAIL — ${mute.length} skip senza messaggio:`);
    for (const h of mute) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    console.error(
      `\nScrivi COSA manca perché il test non possa girare ` +
        `(\`test.skip(cond, "il gateway non risponde")\`).\n` +
        `Senza messaggio, chi legge "skipped" nel report non sa se è l'ambiente o una regressione.`,
    );
  }

  console.log(`\n[check-test-skips] skip/fixme totali: ${hits.length} (baseline ${BASELINE})`);
  if (hits.length > BASELINE) {
    failed = true;
    console.error(
      `\n✗ Gli skip sono saliti ${BASELINE} → ${hits.length}. Ripara il test, ` +
        `oppure alza BASELINE spiegando nel commit perché quello nuovo è onesto.`,
    );
  } else if (hits.length < BASELINE) {
    console.log(
      `✓ ${BASELINE - hits.length} sotto la soglia. Abbassa BASELINE in ` +
        `scripts/check-test-skips.ts a ${hits.length} per bloccare il guadagno.`,
    );
  }

  process.exit(failed ? 1 : 0);
}

main();

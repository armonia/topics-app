#!/usr/bin/env bun
/**
 * scripts/check-eslint-disable.ts — un `eslint-disable` senza motivo scritto
 * fallisce la build.
 *
 * ── Perché ──────────────────────────────────────────────────────────────────
 * Questo repo silenzia 133 regole, e le tiene quasi tutte oneste: accanto al
 * disable c'è scritto PERCHÉ l'eccezione è corretta. Ma la convenzione era solo
 * un'abitudine, e un `// eslint-disable-next-line react-hooks/exhaustive-deps`
 * nudo è la forma in cui una closure stantia entra in produzione senza che
 * nessuno debba difenderla in review. Il costo di scriverne il motivo è una
 * riga; il beneficio è che scriverla obbliga la domanda «perché l'omissione è
 * giusta?» ad avere una risposta.
 *
 * ── Cosa conta come motivo ──────────────────────────────────────────────────
 * Due forme, entrambe valide — quale usare dipende da quanto c'è da dire:
 *
 *   1. Inline, dopo `--` (la sintassi ufficiale di ESLint), su UNA riga:
 *        // eslint-disable-next-line react-hooks/exhaustive-deps -- `ref` è stabile
 *
 *   2. Nel commento SOPRA, quando il motivo non sta in una riga:
 *        // Position dipende dalla dimensione MISURATA del menu montato,
 *        // ignota in render: è il canonico measure-then-place.
 *        // eslint-disable-next-line react-hooks/set-state-in-effect
 *
 * Sopra, mai sotto: `-next-line` silenzia la riga SEGUENTE, quindi un commento
 * di continuazione infilato sotto la direttiva se ne prende il bersaglio e
 * lascia il codice scoperto — senza che niente cambi d'aspetto.
 *
 * In entrambi i casi servono almeno MIN_REASON_CHARS caratteri di prosa: la
 * soglia esiste perché `-- ok` e `// serve` non sono motivi, sono rumore con
 * l'aria di una giustificazione.
 *
 * Run: `bun run scripts/check-eslint-disable.ts`
 *      `bun run scripts/check-eslint-disable.ts client/src/hooks`  (scope custom)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve, relative } from "path";

/** Le radici sorgente. `tests/` resta fuori: lì un disable non spedisce nulla. */
const DEFAULT_ROOTS = ["client/src", "server", "shared", "cli", "scripts"];

const SOURCE_EXT = /\.(ts|tsx|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "assets", ".git"]);

/**
 * Sotto questa lunghezza la "motivazione" non informa nessuno. Tarata sul
 * corpus esistente: il commento più corto che dice davvero qualcosa
 * («mirror original deps», 19) sta appena sotto, e infatti è uno di quelli che
 * questo check ha fatto riscrivere.
 */
const MIN_REASON_CHARS = 20;

/** `eslint-disable-next-line`, `eslint-disable-line`, `eslint-disable` (blocco). */
const DISABLE_RE = /eslint-disable(-next-line|-line)?\b/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Il testo di un commento, spogliato dei marcatori. "" se non è un commento. */
function commentProse(rawLine: string): string {
  const line = rawLine.trim();
  // Commento JSX: `{/* … */}` — togli le graffe e ricadi nei casi sotto.
  const jsx = line.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  const body =
    jsx.startsWith("//") ? jsx.slice(2)
    : jsx.startsWith("/*") ? jsx.slice(2).replace(/\*\/$/, "")
    : jsx.startsWith("*/") ? ""
    : jsx.startsWith("*") ? jsx.slice(1)
    : "";
  return body.trim();
}

/**
 * Un disable è giustificato se ha `-- <motivo>` inline, oppure se le righe di
 * commento immediatamente sopra portano abbastanza prosa. Le righe sopra si
 * accumulano: una motivazione può essere un paragrafo, e spesso lo è.
 */
function isJustified(lines: string[], idx: number): boolean {
  // Forma 1 — `-- <motivo>`, tutto sulla riga della direttiva. NON può
  // continuare sotto, e la tentazione è forte: `eslint-disable-next-line`
  // silenzia LA RIGA SEGUENTE, quindi ogni riga di commento infilata sotto la
  // direttiva diventa il suo bersaglio e il codice resta scoperto. È un errore
  // che si fa scrivendo proprio queste motivazioni — l'ho fatto io su undici
  // siti prima che `reportUnusedDisableDirectives` lo dicesse. Se il motivo non
  // ci sta in una riga, va sopra: è la Forma 2.
  const inline = lines[idx].split(/--/).slice(1).join("--").replace(/\*\/\s*$/, "").trim();
  if (inline.length >= MIN_REASON_CHARS) return true;

  // Forma 2 — il commento SOPRA. Si accumula all'insù: una motivazione può
  // essere un paragrafo, e in questo repo spesso lo è.
  let prose = "";
  for (let i = idx - 1; i >= 0; i--) {
    const body = commentProse(lines[i]);
    // Un altro disable sopra non è la motivazione di questo.
    if (body === "" || DISABLE_RE.test(lines[i])) break;
    prose = `${body} ${prose}`;
    if (prose.trim().length >= MIN_REASON_CHARS) return true;
  }
  return false;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
}

function scan(file: string): Hit[] {
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  const hits: Hit[] = [];
  lines.forEach((line, idx) => {
    // Solo i disable VERI. ESLint attiva la direttiva quando il commento
    // COMINCIA con essa: una riga che la nomina in mezzo alla prosa (una doc,
    // questo file stesso) non silenzia niente, e segnalarla sarebbe rumore che
    // insegna a ignorare il check.
    if (!/^eslint-disable/.test(commentProse(line))) return;
    if (isJustified(lines, idx)) return;
    hits.push({ file: relative(process.cwd(), file), line: idx + 1, text: line.trim() });
  });
  return hits;
}

function main(): void {
  const argv = process.argv.slice(2);
  const roots = argv.length > 0 ? argv : DEFAULT_ROOTS;
  const files: string[] = [];
  for (const r of roots) {
    const abs = resolve(r);
    if (!existsSync(abs)) {
      console.warn(`[check-eslint-disable] assente: ${r} (saltata)`);
      continue;
    }
    if (statSync(abs).isDirectory()) walk(abs, files);
    else files.push(abs);
  }

  const hits: Hit[] = [];
  for (const f of files) hits.push(...scan(f));

  if (hits.length === 0) {
    console.log(`[check-eslint-disable] OK — ${files.length} file, ogni disable ha un motivo scritto.`);
    process.exit(0);
  }

  console.error(`[check-eslint-disable] FAIL — ${hits.length} disable senza motivo:`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
  console.error(
    `\nScrivi PERCHÉ l'eccezione è corretta: inline dopo \`--\`, o nel commento sopra.` +
      `\nAlmeno ${MIN_REASON_CHARS} caratteri — "ok" e "serve" non sono motivi.`,
  );
  process.exit(1);
}

main();

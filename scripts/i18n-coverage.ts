/**
 * Quante stringhe visibili all'utente NON passano ancora dal dizionario.
 *
 * Perché esiste: «rendiamo tutto multilingua» è un obiettivo senza traguardo
 * finché non è un numero. Qui il numero c'è, si vede scendere, e chi converte
 * una superficie sa quanto ne resta invece di andare a sentimento.
 *
 * Cosa conta come stringa visibile — e cosa NO, di proposito:
 *  - SÌ: testo dentro un elemento JSX (`<span>Chiudi</span>`), e gli attributi
 *    che l'utente legge o sente (`title`, `placeholder`, `aria-label`).
 *  - NO: `className`, `data-*`, `role`, chiavi di oggetti, import, URL, testo di
 *    una sola parola tutta minuscola o senza lettere (icone, simboli, unità).
 *
 * È volutamente APPROSSIMATO per eccesso: meglio contare qualche falso positivo
 * — che si vede subito aprendo il file — che dichiarare finita una migrazione
 * che non lo è.
 *
 *   bun run scripts/i18n-coverage.ts            # riepilogo
 *   bun run scripts/i18n-coverage.ts --files    # i 20 file peggiori
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = new URL("../client/src", import.meta.url).pathname;

/** Attributi il cui valore l'utente legge o sente. */
const HUMAN_ATTRS = ["title", "placeholder", "aria-label"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Una stringa «da tradurre» somiglia a una frase: ha una lettera maiuscola o uno spazio. */
function looksHuman(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 120) return false;
  if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;          // simboli, numeri, unità
  if (/^[a-z0-9_.-]+$/.test(t)) return false;         // chiavi, slug, classi
  if (/^https?:\/\//.test(t)) return false;
  return /[A-ZÀ-Ý]/.test(t) || /\s/.test(t);
}

export function scanFile(src: string): number {
  let n = 0;
  // Testo fra tag, senza espressioni: `>Chiudi ora<`
  for (const m of src.matchAll(/>([^<>{}\n]{3,120})</g)) {
    if (looksHuman(m[1]!)) n++;
  }
  // Attributi leggibili con valore letterale
  for (const attr of HUMAN_ATTRS) {
    const re = new RegExp(`${attr}=["']([^"']{3,120})["']`, "g");
    for (const m of src.matchAll(re)) {
      if (looksHuman(m[1]!)) n++;
    }
  }
  return n;
}

function main() {
  const files = walk(ROOT);
  const rows = files
    .map((f) => ({ file: f.slice(ROOT.length + 1), n: scanFile(readFileSync(f, "utf8")) }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const total = rows.reduce((s, r) => s + r.n, 0);

  if (process.argv.includes("--files")) {
    for (const r of rows.slice(0, 20)) console.log(String(r.n).padStart(4), r.file);
    console.log("");
  }
  console.log(`stringhe visibili ancora NON tradotte: ${total} in ${rows.length} file (su ${files.length} .tsx)`);
}

if (import.meta.main) main();

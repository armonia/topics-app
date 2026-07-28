#!/usr/bin/env bun
/**
 * scripts/check-nul-bytes.ts — nessun byte NUL nei sorgenti tracciati.
 *
 * Un `\0` finito dentro un file di testo non si vede: gli editor lo rendono
 * come niente o come uno spazio, il diff sembra pulito, il codice a volte
 * compila persino. Quello che cambia è tutto il resto.
 *
 *   - `grep -r` considera BINARIO un file che contiene un NUL e lo SALTA in
 *     silenzio: il file sparisce da ogni ricerca fatta sul repo. È già successo
 *     qui (`moondream-client`, saltato da ogni audit repo-wide finché qualcuno
 *     non l'ha aperto a mano).
 *   - dentro una stringa il NUL prende il posto di un carattere vero, di solito
 *     uno spazio, e produce un confronto che fallisce fra due valori stampati
 *     IDENTICI: `Expected: "t ieri x" / Received: "t ieri x"`. Senza un hex dump
 *     non se ne esce.
 *
 * Nessuna delle due cose si scopre leggendo il codice, quindi la si controlla
 * qui. Il costo è un `git ls-files` più una scansione: pochi decimi di secondo.
 *
 * Uso:  `bun run scripts/check-nul-bytes.ts`  — esce 1 elencando i colpevoli.
 * In automatico gira dentro `bun run test:unit` (tests/unit/no-nul-bytes.test.ts).
 */
import { execFileSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { extname, join } from "path";

/** Estensioni in cui un NUL non ha MAI senso. Il resto (png, ico, sqlite…) è binario per mestiere. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".css", ".html", ".svg",
  ".sh", ".zsh", ".bash", ".py", ".rs", ".toml", ".yml", ".yaml", ".sql", ".feature",
]);

export function isTextSource(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface NulHit {
  path: string;
  /** Offset in byte del primo NUL — è quello che si dà a un hex dump. */
  offset: number;
  count: number;
  /** Il contorno testuale, coi NUL resi visibili come `␀`. */
  context: string;
}

export function scanForNulBytes(repoRoot: string, files: string[]): NulHit[] {
  const hits: NulHit[] = [];
  for (const rel of files) {
    if (!isTextSource(rel)) continue;
    const abs = join(repoRoot, rel);
    let buf: Buffer;
    try {
      if (!statSync(abs).isFile()) continue;
      buf = readFileSync(abs);
    } catch {
      continue; // cancellato o non leggibile: non è compito di questo check
    }
    const offset = buf.indexOf(0);
    if (offset === -1) continue;
    let count = 0;
    for (const b of buf) if (b === 0) count++;
    const context = buf
      .subarray(Math.max(0, offset - 40), offset + 40)
      .toString("utf8")
      .replace(/\0/g, "␀")
      .replace(/\n/g, "⏎");
    hits.push({ path: rel, offset, count, context });
  }
  return hits;
}

export function trackedFiles(repoRoot: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const hits = scanForNulBytes(repoRoot, trackedFiles(repoRoot));
  if (hits.length === 0) {
    console.log("✓ nessun byte NUL nei sorgenti tracciati");
    process.exit(0);
  }
  console.error(`✘ ${hits.length} file con byte NUL — grep -r li salta in silenzio:\n`);
  for (const h of hits) {
    console.error(`  ${h.path}  (${h.count} NUL, primo a offset ${h.offset})`);
    console.error(`      …${h.context}…`);
  }
  console.error(
    `\nPer ripulirne uno:\n` +
      `  python3 -c "p='FILE'; b=open(p,'rb').read(); open(p,'wb').write(b.replace(b'\\x00', b' '))"\n` +
      `(verifica il contesto qui sopra: il NUL di solito ha preso il posto di uno spazio)`,
  );
  process.exit(1);
}

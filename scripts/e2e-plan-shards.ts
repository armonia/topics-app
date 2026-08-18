#!/usr/bin/env bun
/**
 * Divide i file di spec in N shard BILANCIATI PER DURATA.
 *
 * IL PROBLEMA. `--shard=i/N` di Playwright riparte i file per numero di test:
 * non conosce le durate, quindi non può sapere che un file da 22 test può
 * costare quanto quaranta file da uno. Sulla run del 30/07 gli shard uscivano
 * 193s / 326s / 186s / 209s — e il wall-clock di una suite parallela è il suo
 * shard PIÙ LENTO, quindi si aspettavano 326 secondi con tre quarti della
 * macchina fermi a guardare.
 *
 * COSA FA. Legge le durate misurate (`e2e-durations.json`, scritto da
 * `e2e-record-durations.ts`) e riempie gli N secchi col metodo LPT
 * (Longest-Processing-Time first): i file si ordinano dal più lento al più
 * veloce e ognuno va nel secchio meno carico. È l'euristica classica dello
 * scheduling multiprocessore — garantita entro 4/3 dell'ottimo, e su una coda
 * come questa (un file lungo, tanti corti) arriva a pochi secondi di scarto.
 *
 * USO
 *   bun run scripts/e2e-plan-shards.ts <N> [--out <dir>]
 *     N          numero di shard
 *     --out dir  scrive dir/shard-<i>.txt (un file di spec per riga)
 *   Stampa sempre il piano leggibile con i totali per shard.
 *
 * `--out` esiste perché elencare le spec costa: `playwright test --list` deve
 * caricare e transpilare tutti i file, una decina di secondi. Chiamare questo
 * script una volta per shard significherebbe pagarli N+1 volte — a 8 shard sono
 * più di due minuti di sola pianificazione, cioè più di quanto il bilanciamento
 * faccia risparmiare. Il piano si calcola UNA volta e si scrive su disco.
 *
 * L'elenco dei file viene da `playwright test --list`, non da un glob: così
 * rispetta `testIgnore`/`grepInvert` del config, cioè il piano di E2E_TIER=pr
 * contiene solo i file del gate PR senza duplicare qui quella logica.
 *
 * NON È UN CONTRATTO. Se le durate mancano, sono stantie o il `--list` fallisce,
 * chi chiama torna a `--shard=i/N` e la suite gira lo stesso: questo file rende
 * la corsa più corta, non più corretta. Un file mai misurato prende la MEDIANA
 * degli altri — meglio che zero, che lo farebbe ammucchiare tutto in un secchio.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { resolve } from "path";

const DURATIONS_PATH = resolve(import.meta.dir, "e2e-durations.json");
const REPO_ROOT = resolve(import.meta.dir, "..");

type PwSuite = { file?: string; suites?: PwSuite[]; specs?: Array<{ file?: string }> };

/** I file che il config di Playwright eseguirebbe ADESSO (tier compreso). */
export function listSpecFiles(): string[] {
  const raw = execFileSync("npx", ["playwright", "test", "--list", "--reporter=json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const json = JSON.parse(raw) as { suites?: PwSuite[] };
  const files = new Set<string>();
  const walk = (s: PwSuite) => {
    for (const child of s.suites ?? []) walk(child);
    for (const spec of s.specs ?? []) {
      const f = spec.file ?? s.file;
      if (f) files.add(f);
    }
  };
  for (const s of json.suites ?? []) walk(s);
  return [...files].sort();
}

export function loadDurations(): Record<string, number> {
  if (!existsSync(DURATIONS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DURATIONS_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * IL NOME DEL FILE NON E' UN PATH: PLAYWRIGHT LO LEGGE COME REGEX.
 *
 * Gli argomenti posizionali di `playwright test` sono ESPRESSIONI REGOLARI sul
 * percorso, non nomi. Il piano scriveva i basename nudi (`board.spec.ts`), e
 * `.` e' un jolly ma soprattutto una sottostringa combacia: `board.spec.ts`
 * seleziona anche `dashboard.spec.ts`, `focus-bounce-board.spec.ts` e
 * `browser-mobile-keyboard.spec.ts`.
 *
 * Sull'albero del 18/08 (247 spec) le collisioni erano CINQUE. Quando i due
 * file finiscono in shard diversi il secondo gira DUE VOLTE: tempo buttato, e
 * il bilanciamento per durata — che e' l'unica ragione per cui il piano esiste
 * — misura una divisione che non e' quella eseguita.
 *
 * L'ancora: `tests/e2e/` davanti (esclude i suffissi come `dashboard`), `\.`
 * al posto del jolly, `$` in fondo (esclude i prefissi).
 */
export function specSelector(basename: string): string {
  return `tests/e2e/${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/**
 * Due voci del piano che selezionano lo stesso file sono un errore, non un
 * dettaglio: e' la forma esatta del difetto che `specSelector` chiude, e la
 * prossima spec che nasce con un nome contenuto in un'altra deve trovare un
 * rosso invece di uno spreco muto.
 */
export function selectorCollisions(files: string[]): Array<{ selector: string; matches: string[] }> {
  const paths = files.map((f) => `tests/e2e/${f}`);
  const out: Array<{ selector: string; matches: string[] }> = [];
  for (const f of files) {
    const sel = specSelector(f);
    const re = new RegExp(sel);
    const matches = paths.filter((p) => re.test(p));
    if (matches.length > 1) out.push({ selector: sel, matches });
  }
  return out;
}

/** LPT: dal più lento al più veloce, ognuno nel secchio finora meno carico. */
export function planShards(
  files: string[],
  durations: Record<string, number>,
  shards: number,
): Array<{ files: string[]; seconds: number }> {
  const known = files.map((f) => durations[f]).filter((d): d is number => typeof d === "number" && d > 0);
  const sortedKnown = [...known].sort((a, b) => a - b);
  const median = sortedKnown.length
    ? sortedKnown[Math.floor(sortedKnown.length / 2)]
    : 1;

  const weighted = files
    .map((file) => ({ file, seconds: durations[file] ?? median }))
    .sort((a, b) => b.seconds - a.seconds);

  const buckets = Array.from({ length: shards }, () => ({ files: [] as string[], seconds: 0 }));
  for (const { file, seconds } of weighted) {
    let lightest = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].seconds < buckets[lightest].seconds) lightest = i;
    }
    buckets[lightest].files.push(file);
    buckets[lightest].seconds += seconds;
  }
  return buckets;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const shards = Number(argv[0]);

  if (!Number.isInteger(shards) || shards < 1) {
    console.error("uso: bun run scripts/e2e-plan-shards.ts <N> [--out <dir>]");
    process.exit(2);
  }
  if (outIdx >= 0 && !outDir) {
    console.error("[plan] --out richiede una directory");
    process.exit(2);
  }

  let files: string[];
  try {
    files = listSpecFiles();
  } catch (err) {
    console.error(`[plan] impossibile elencare le spec: ${(err as Error).message}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error("[plan] nessuna spec elencata.");
    process.exit(1);
  }
  // Più shard che file significherebbe secchi vuoti, e uno shard senza elenco
  // non ha modo di dire "non eseguire niente": tornerebbe alla ripartizione
  // nativa e rifarebbe 1/N di TUTTA la suite. Meglio dirlo e lasciare che chi
  // chiama usi `--shard=i/N`, che il caso lo gestisce da solo.
  if (shards > files.length) {
    console.error(`[plan] ${shards} shard per ${files.length} file: non pianificabile.`);
    process.exit(1);
  }

  const durations = loadDurations();
  const buckets = planShards(files, durations, shards);

  // La guardia PRIMA di scrivere: un piano che seleziona due volte lo stesso
  // file non e' un piano, e va detto qui — non scoperto contando i test in un
  // riepilogo.
  const collisioni = selectorCollisions(files);
  if (collisioni.length) {
    console.error("[plan] due voci selezionano lo stesso file: il piano non e' eseguibile.");
    for (const c of collisioni) console.error(`  ${c.selector}  ->  ${c.matches.join(", ")}`);
    process.exit(1);
  }

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    buckets.forEach((b, i) => {
      // SELETTORI, non nomi: vedi `specSelector`.
      writeFileSync(resolve(outDir, `shard-${i + 1}.txt`), b.files.map(specSelector).join("\n") + "\n");
    });
  }

  const measured = files.filter((f) => durations[f] !== undefined).length;
  const total = buckets.reduce((a, b) => a + b.seconds, 0);
  const slowest = Math.max(...buckets.map((b) => b.seconds));
  console.log(
    `[plan] ${files.length} file (${measured} misurati) in ${shards} shard — ` +
      `${total.toFixed(0)}s di lavoro, shard più lento ${slowest.toFixed(0)}s ` +
      `(ideale ${(total / shards).toFixed(0)}s)`,
  );
  buckets.forEach((b, i) => {
    console.log(`  shard ${i + 1}: ${b.seconds.toFixed(0).padStart(4)}s  ${b.files.length} file`);
  });
}

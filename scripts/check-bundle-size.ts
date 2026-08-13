#!/usr/bin/env bun
/**
 * Bundle-size RATCHET.
 *
 * Every other quality gate in this repo is a ratchet — server types
 * (scripts/typecheck-server.ts), `any` density (scripts/check-any.ts), idle
 * frames (tests/e2e/idle-frame-budget.spec.ts). Bundle size was the one metric
 * with no floor under it, and it drifted: the eager entry chunk grew ~3 KB raw
 * between two measurements taken the same day, with nobody noticing.
 *
 * Three budgets, because they fail in three different ways:
 *
 *   entry_eager    the chunk everybody downloads and parses before anything
 *                  renders. Regresses when a `React.lazy` import quietly
 *                  becomes a static one — the most common way to wreck TTI.
 *   critical_path  every asset `index.html` references. What the user actually
 *                  waits for on a cold load.
 *   total_assets   the whole `public/assets` tree. Catches a heavy dependency
 *                  added as a LAZY chunk: it moves neither budget above, but
 *                  you still pay for it at the first `import()`.
 *
 * The critical path is read FROM index.html, not hard-coded: the filenames are
 * content-hashed and change on every build. (There is no `public/.vite/
 * manifest.json` — `manifest` is not enabled in client/vite.config.ts — so the
 * emitted HTML is the authority.)
 *
 * Usage:  bun run check:bundle        (after `bun run build:client`)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = "public";
const ASSETS_DIR = join(PUBLIC_DIR, "assets");
const BASELINE_PATH = "scripts/bundle-baseline.json";

interface Budget { raw: number; gz: number }
interface Baseline {
  tolerance_pct: number;
  entry_eager: Budget;
  critical_path: Budget & { files: number };
  total_assets: { raw: number };
}

/** Borrowed from assert-dev-overlay-stripped.sh: refuse to certify a directory
 *  that was never built. A budget that passes on an empty `public/` is worse
 *  than no budget — it reports success for a measurement that never happened. */
function assertBuilt(): void {
  if (!existsSync(ASSETS_DIR)) {
    console.error(`✗ ${ASSETS_DIR} does not exist. Run \`bun run build:client\` first.`);
    process.exit(2);
  }
  const js = readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".js"));
  if (js.length === 0) {
    console.error(`✗ ${ASSETS_DIR} contains no .js — stale or half-written build.`);
    process.exit(2);
  }
}

/** Assets referenced directly by index.html = the cold-load critical path. */
function criticalPathFiles(): string[] {
  const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    refs.add(m[1]!.replace(/^\//, ""));
  }
  return [...refs].sort();
}

function sizes(files: string[]): Budget {
  let raw = 0;
  let gz = 0;
  for (const f of files) {
    const buf = readFileSync(join(PUBLIC_DIR, f.replace(/^public\//, "")));
    raw += buf.byteLength;
    gz += Bun.gzipSync(buf, { level: 9 }).byteLength;
  }
  return { raw, gz };
}

function totalAssetsRaw(): number {
  let raw = 0;
  for (const f of readdirSync(ASSETS_DIR)) {
    const p = join(ASSETS_DIR, f);
    if (statSync(p).isFile()) raw += statSync(p).size;
  }
  return raw;
}

/**
 * Quali file di `public/assets` NON appartengono alla build che `index.html`
 * indirizza — cioè gli avanzi di una build precedente.
 *
 * Perché serve: sulla macchina di sviluppo gira `bun run build:watch`
 * (`vite build --watch`), che NON svuota `outDir` (client/vite.config.ts:
 * `emptyOutDir: process.env.TOPICS_BUILD_WATCH !== '1'`), quindi una build a
 * mano lanciata mentre il watcher sta scrivendo lascia in giro i chunk della
 * build prima. Misurato il 2026-07-29: **248 file invece di 168**, e
 * `total_assets` a 12,6 MB contro una baseline di 7,9. Il punto non è il numero
 * sbagliato, è COSA dice il numero sbagliato: il gate annunciava "il bundle è
 * cresciuto del 58%" a chi non aveva toccato una riga di codice, e un cancello a
 * cui non si crede è peggio di nessun cancello. Meglio dire la verità — "qui ci
 * sono due build una sopra l'altra, questa misura non vuol dire niente" — e
 * continuare a far valere gli altri due budget, che sono indirizzati per hash da
 * `index.html` e quindi restano corretti anche in mezzo agli orfani.
 *
 * Come lo si riconosce: si parte dagli asset che `index.html` cita e si seguono
 * i riferimenti dentro ai file (gli `import()` pigri, i `modulepreload`, i font
 * citati dal CSS). Ciò che nessuno raggiunge è un avanzo.
 *
 * Il criterio di prima — «più di un `index-*.js` = più di una build» — era un
 * FALSO POSITIVO, e lo smentiva questo stesso file tre righe più sotto
 * (`entryEagerFile`: «Vite emits several `index-*` chunks»). Una build sola e
 * pulita di HEAD ne emette **5**: `index-*` è il nome che Rollup dà al chunk di
 * ogni modulo che si chiama `index.ts(x)`, non un marchio dell'entry. Risultato:
 * il ramo "NON MISURABILE" scattava SEMPRE, e il budget `total_assets` non è mai
 * stato verificato da quando esiste — l'unico dei tre che becca una dipendenza
 * pesante aggiunta come chunk PIGRO. Un controllo che non può fallire non è un
 * controllo (misurato il 2026-08-13, ricostruendo la baseline in una copia
 * pulita: 168 file, 0 orfani).
 */
function orphanAssets(critical: string[]): string[] {
  const all = new Set(readdirSync(ASSETS_DIR).filter((f) => statSync(join(ASSETS_DIR, f)).isFile()));
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const f of critical) {
    const name = f.replace(/^assets\//, "");
    if (all.has(name) && !reachable.has(name)) {
      reachable.add(name);
      queue.push(name);
    }
  }
  // Un nome di file emesso da Vite è sempre `<base>-<hash>.<ext>`; cercarlo come
  // testo copre sia `import("./chunk-x.js")` sia `url(/assets/font-x.woff2)`,
  // senza dover interpretare il JS minificato.
  const token = /[\w.@-]+\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|svg|jpe?g|gif|webp|avif|json|wasm|map)/g;
  while (queue.length > 0) {
    const file = queue.pop()!;
    // Solo i file di TESTO possono citarne altri: un .woff2 o un .png letto come
    // utf8 darebbe solo rumore da scandire.
    if (!/\.(?:js|mjs|css|json|map|svg)$/.test(file)) continue;
    const text = readFileSync(join(ASSETS_DIR, file), "utf8");
    for (const m of text.matchAll(token)) {
      const name = m[0];
      if (all.has(name) && !reachable.has(name)) {
        reachable.add(name);
        queue.push(name);
      }
    }
  }
  return [...all].filter((f) => !reachable.has(f)).sort();
}

/** The eager entry: the largest `assets/index-*.js` on the critical path.
 *  Vite emits several `index-*` chunks; only the ones index.html links are
 *  eager, and the entry is the big one among them. */
function entryEagerFile(critical: string[]): string | null {
  const candidates = critical.filter((f) => /\/index-[^/]+\.js$/.test(f));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    statSync(join(PUBLIC_DIR, a)).size >= statSync(join(PUBLIC_DIR, b)).size ? a : b,
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

assertBuilt();

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
const tol = 1 + baseline.tolerance_pct / 100;

const critical = criticalPathFiles();
const entry = entryEagerFile(critical);
if (!entry) {
  console.error("✗ No eager entry chunk found in index.html — did the build change shape?");
  process.exit(2);
}

const measured = {
  entry_eager: sizes([entry]),
  critical_path: { ...sizes(critical), files: critical.length },
  total_assets: { raw: totalAssetsRaw() },
};

console.log(`entry eager    ${entry}`);
console.log(`               raw ${fmt(measured.entry_eager.raw)}  gz ${fmt(measured.entry_eager.gz)}   (baseline raw ${fmt(baseline.entry_eager.raw)}  gz ${fmt(baseline.entry_eager.gz)})`);
console.log(`critical path  ${measured.critical_path.files} files  raw ${fmt(measured.critical_path.raw)}  gz ${fmt(measured.critical_path.gz)}   (baseline raw ${fmt(baseline.critical_path.raw)}  gz ${fmt(baseline.critical_path.gz)})`);
const orphans = orphanAssets(critical);
if (orphans.length > 0) {
  console.log(
    `total assets   NON MISURABILE — ${orphans.length} file di ${ASSETS_DIR} non ${orphans.length === 1 ? "è raggiungibile" : "sono raggiungibili"}\n` +
      `               da index.html: sono gli avanzi di una build precedente\n` +
      `               (è il watcher \`build:watch\` che scrive senza svuotare outDir). Gli altri\n` +
      `               due budget valgono comunque: sono indirizzati per hash da index.html.\n` +
      `               Per misurare anche questo: ferma il watcher, svuota public/assets, ribuilda.\n` +
      `               Primi orfani: ${orphans.slice(0, 3).join(", ")}${orphans.length > 3 ? ", …" : ""}`,
  );
} else {
  console.log(`total assets   raw ${fmt(measured.total_assets.raw)}   (baseline ${fmt(baseline.total_assets.raw)})`);
}

const failures: string[] = [];
const check = (label: string, got: number, base: number) => {
  if (got > Math.round(base * tol)) {
    failures.push(`${label}: ${fmt(got)} > ${fmt(Math.round(base * tol))} (baseline ${fmt(base)} +${baseline.tolerance_pct}%)`);
  }
};

check("entry_eager.raw", measured.entry_eager.raw, baseline.entry_eager.raw);
check("entry_eager.gz", measured.entry_eager.gz, baseline.entry_eager.gz);
check("critical_path.raw", measured.critical_path.raw, baseline.critical_path.raw);
check("critical_path.gz", measured.critical_path.gz, baseline.critical_path.gz);
if (orphans.length === 0) check("total_assets.raw", measured.total_assets.raw, baseline.total_assets.raw);

// Structural, not just numeric: a 7th eager asset in index.html is a real
// regression even when the bytes happen to fit — one more blocking request.
if (measured.critical_path.files > baseline.critical_path.files) {
  failures.push(
    `critical_path.files: ${measured.critical_path.files} > ${baseline.critical_path.files} — ` +
      `index.html gained an eager asset:\n    ${critical.join("\n    ")}`,
  );
}

if (failures.length > 0) {
  console.error(`\n✗ Bundle budget exceeded:\n  - ${failures.join("\n  - ")}`);
  console.error(
    `\nEither make it smaller (a static import that should be lazy is the usual cause),\n` +
      `or, if the growth is deliberate, raise the number in ${BASELINE_PATH} in the SAME commit\n` +
      `so the diff shows what it bought.`,
  );
  process.exit(1);
}

const shrunk =
  measured.entry_eager.gz < Math.round(baseline.entry_eager.gz * 0.97) ||
  measured.critical_path.gz < Math.round(baseline.critical_path.gz * 0.97);
if (shrunk) {
  console.log(
    `\n✓ More than 3% below baseline. Lower the numbers in ${BASELINE_PATH} to lock the win.`,
  );
}
console.log("\n✓ Bundle within budget.");
process.exit(0);

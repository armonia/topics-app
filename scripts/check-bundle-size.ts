#!/usr/bin/env bun
/**
 * Bundle-size RATCHET.
 *
 * @covers GATE-BUNDLE-FRESH-01
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
import { unreachableAssets } from "../server/lib/client-bundle";
import { SWEEP_MIN_AGE_MS } from "./build-client-publish";

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

/** A file (or directory) that never ships into a chunk: Vite does not import
 *  it from anywhere, so touching it cannot change a byte of `public/`. Same
 *  set the shipped-line count already carves out in the comments of
 *  `scripts/bundle-baseline.json` (`.test.ts` files, explicitly called out
 *  there as not shipping). */
function isNonShipping(name: string, isDir: boolean): boolean {
  if (isDir) return name === "__tests__";
  return /\.test\.tsx?$/.test(name) || /\.spec\.tsx?$/.test(name);
}

/** Newest mtime under a directory tree, in epoch ms. 0 when nothing is there.
 *  Skips test files and folders: they never end up in a chunk, so they must
 *  never be the reason `assertFresh` demands a rebuild. */
export function newestMtime(dir: string): { at: number; file: string } {
  let best = { at: 0, file: "" };
  const walk = (d: string): void => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      const isDir = st.isDirectory();
      if (isNonShipping(name, isDir)) continue;
      if (isDir) { walk(full); continue; }
      if (st.mtimeMs > best.at) best = { at: st.mtimeMs, file: full };
    }
  };
  walk(dir);
  return best;
}

/**
 * REFUSE TO CERTIFY A BUILD OLDER THAN ITS SOURCES.
 *
 * `assertBuilt()` above answers "is there a build?". It does not answer "is it
 * THIS build?", and the difference is the whole value of the number printed
 * below: every budget here is read off `public/`, so running this gate without
 * rebuilding measures whatever was compiled last time and says nothing about
 * the code in the working tree.
 *
 * That is not hypothetical. The launchd `build:watch` job has been off since
 * 2026-08-04 and stays off by decision (docs/build-watch-decision.md), so
 * `public/` only moves when somebody types `build:client`. On
 * 2026-08-25 the two measurements happened to differ by 309 bytes purely
 * because that round was almost all server-side; a round weighted towards the
 * client would have delivered a verdict on the wrong build. The only trace of
 * the risk was prose inside `scripts/bundle-baseline.json` — a warning you
 * read only if you open the right file, which is precisely the failure it
 * describes.
 *
 * EXIT 2, like `assertBuilt`, not 1: a stale bundle is not a bundle over
 * budget. It is "I could not measure this tree", and a gate that cannot
 * measure must never be green and must never be red.
 *
 * MTIME, not the last commit date. Uncommitted client edits are the common
 * local case and a commit-based comparison is blind to exactly those; the
 * question worth asking is whether the bundle on this disk is older than the
 * sources on this disk.
 */
export function isStale(builtAt: number, srcAt: number): boolean {
  // Nothing to compare is NOT stale: `assertBuilt` already spoke about an
  // absent build, and answering twice about the same thing in two voices is
  // how a gate starts contradicting itself.
  if (!builtAt || !srcAt) return false;
  return srcAt > builtAt;
}

function assertFresh(): void {
  const built = Math.max(newestMtime(ASSETS_DIR).at, (() => {
    try { return statSync(join(PUBLIC_DIR, "index.html")).mtimeMs; } catch { return 0; }
  })());
  const src = [newestMtime(join("client", "src")), newestMtime("shared")]
    .reduce((a, b) => (b.at > a.at ? b : a));
  if (!isStale(built, src.at)) return;

  const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  console.error(`✗ il bundle e' PIU' VECCHIO dei sorgenti: quello che segue misurerebbe un'altra build.`);
  console.error(`    build in ${PUBLIC_DIR}:  ${iso(built)}`);
  console.error(`    sorgente piu' recente:  ${iso(src.at)}  (${src.file})`);
  console.error(`    ricostruisci con \`bun run build:client\`, poi rilancia.`);
  process.exit(2);
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

/** Bytes of every file in the assets directory, minus the ones named in
 *  `exclude` - which is how the leftovers the publish step keeps ON PURPOSE
 *  stay out of a number that is supposed to describe THIS build. */
export function totalAssetsRaw(exclude: Set<string> = new Set(), dir = ASSETS_DIR): number {
  let raw = 0;
  for (const f of readdirSync(dir)) {
    if (exclude.has(f)) continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isFile()) raw += st.size;
  }
  return raw;
}

/**
 * A DELIBERATE leftover is not a broken tree: tell the two apart by AGE.
 *
 * `build-client-publish.ts` swaps `index.html` first and sweeps the assets
 * nobody references only when they are older than `SWEEP_MIN_AGE_MS` - a page
 * still open, or a second build in flight, can be asking for them. So right
 * after every clean build there is ALWAYS at least one unreachable file: the
 * entry of the build before. Treating that as "not measurable" is how
 * `total_assets` stopped being measured at all (measured 2026-08-29, right
 * after LAND-11) - the same failure `scripts/bundle-baseline.json` records
 * having already paid once, arriving through the next door.
 *
 * Younger than the sweep window: kept on purpose, excluded from the total, the
 * budget still runs. Older: the sweep had its chance and the file is still
 * there, so it is a real leftover and the measure is worth nothing.
 */
export function splitOrphansByAge(
  orphans: { name: string; mtimeMs: number }[],
  now: number,
  minAgeMs: number = SWEEP_MIN_AGE_MS,
): { kept: string[]; stale: string[] } {
  const kept: string[] = [];
  const stale: string[] = [];
  for (const o of orphans) (now - o.mtimeMs < minAgeMs ? kept : stale).push(o.name);
  return { kept: kept.sort(), stale: stale.sort() };
}

/**
 * Which files in `public/assets` do NOT belong to the build `index.html`
 * points at, i.e. the leftovers of some earlier build.
 *
 * Why it exists: two builds stacked on top of each other make `total_assets`
 * meaningless. Measured 2026-07-29, back when a watcher wrote into a non
 * emptied `outDir`: 248 files instead of 168, and `total_assets` at 12.6 MB
 * against a 7.9 baseline. The wrong number is not the point, what the wrong
 * number SAYS is: the gate announced "the bundle grew 58%" to somebody who had
 * not touched a line, and a gate nobody believes is worse than no gate. Better
 * to say the truth, "there are two builds here, this measure means nothing",
 * and keep the other two budgets standing: `index.html` addresses those by
 * hash, so they stay correct even surrounded by orphans.
 *
 * How they are recognised: start from the assets `index.html` names and follow
 * the references inside the files (lazy `import()`, `modulepreload`, fonts
 * cited by CSS). Whatever nobody reaches is a leftover.
 *
 * NOT EVERY ORPHAN IS AN ACCIDENT. Since the publish step sweeps only what is
 * older than `SWEEP_MIN_AGE_MS`, a clean build leaves the previous entry
 * behind ON PURPOSE. `splitOrphansByAge` is what tells the two apart; this
 * function only lists them.
 *
 * The older criterion, "more than one `index-*.js` means more than one build",
 * was a FALSE POSITIVE, contradicted by `entryEagerFile` three lines below
 * ("Vite emits several `index-*` chunks"): one clean build emits 5, because
 * `index-*` is the name Rollup gives the chunk of every module called
 * `index.ts(x)`, not a mark of the entry. Result: the "NON MISURABILE" branch
 * fired ALWAYS and `total_assets` was never verified, the one budget of the
 * three that catches a heavy dependency added as a LAZY chunk. A check that
 * cannot fail is not a check (measured 2026-08-13, rebuilding the baseline in
 * a clean copy: 168 files, 0 orphans).
 */
function orphanAssets(critical: string[]): string[] {
  // The walk itself lives in `server/lib/client-bundle.ts`, where the publish
  // sweep reads it too: what this gate counts and what the sweep deletes have
  // to be the same set, or one of the two is measuring a tree the other one
  // never cleans.
  return unreachableAssets(ASSETS_DIR, critical);
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

if (!import.meta.main) {
  // Imported by its bench: the pure pieces above are what gets verified, and an
  // import must not scan the tree nor call `process.exit` as a side effect.
} else {
assertBuilt();
assertFresh();

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
const tol = 1 + baseline.tolerance_pct / 100;

const critical = criticalPathFiles();
const entry = entryEagerFile(critical);
if (!entry) {
  console.error("✗ No eager entry chunk found in index.html — did the build change shape?");
  process.exit(2);
}

const orphans = orphanAssets(critical);
const { kept, stale } = splitOrphansByAge(
  orphans.map((name) => ({ name, mtimeMs: statSync(join(ASSETS_DIR, name)).mtimeMs })),
  Date.now(),
);

const measured = {
  entry_eager: sizes([entry]),
  critical_path: { ...sizes(critical), files: critical.length },
  // The leftovers the sweep is deliberately keeping belong to the PREVIOUS
  // build: counting them would inflate this build's total by an entry chunk.
  total_assets: { raw: totalAssetsRaw(new Set(kept)) },
};

console.log(`entry eager    ${entry}`);
console.log(`               raw ${fmt(measured.entry_eager.raw)}  gz ${fmt(measured.entry_eager.gz)}   (baseline raw ${fmt(baseline.entry_eager.raw)}  gz ${fmt(baseline.entry_eager.gz)})`);
console.log(`critical path  ${measured.critical_path.files} files  raw ${fmt(measured.critical_path.raw)}  gz ${fmt(measured.critical_path.gz)}   (baseline raw ${fmt(baseline.critical_path.raw)}  gz ${fmt(baseline.critical_path.gz)})`);
const sweepMin = Math.round(SWEEP_MIN_AGE_MS / 60_000);
if (stale.length > 0) {
  console.log(
    `total assets   NON MISURABILE - ${stale.length} file di ${ASSETS_DIR} che index.html non raggiunge,\n` +
      `               oltre la finestra di grazia dello sweep (SWEEP_MIN_AGE_MS = ${sweepMin} min):\n` +
      `               lo sweep avrebbe gia' dovuto spazzarli, quindi qui ci sono due build\n` +
      `               una sopra l'altra e il totale non vuol dire niente. Gli altri due budget\n` +
      `               valgono comunque: index.html li indirizza per hash.\n` +
      `               Per misurare anche questo: svuota ${ASSETS_DIR} e rilancia \`bun run build:client\`.\n` +
      `               Primi orfani: ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", ..." : ""}`,
  );
} else {
  console.log(`total assets   raw ${fmt(measured.total_assets.raw)}   (baseline ${fmt(baseline.total_assets.raw)})`);
  if (kept.length > 0) {
    console.log(
      `               esclusi ${kept.length} avanzi della build precedente, tenuti apposta\n` +
        `               dallo sweep finche' non hanno ${sweepMin} min: ${kept.slice(0, 3).join(", ")}${kept.length > 3 ? ", ..." : ""}`,
    );
  }
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
if (stale.length === 0) check("total_assets.raw", measured.total_assets.raw, baseline.total_assets.raw);

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
}

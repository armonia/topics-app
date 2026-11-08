/**
 * Publish a freshly built bundle into the directory the server is serving.
 *
 * The whole point is that there is NO INSTANT at which the served directory is
 * not a complete bundle:
 *
 *   1. the new assets are copied next to the old ones - hashed names, so
 *      nothing collides and the old `index.html` keeps working;
 *   2. `index.html` is swapped with a single rename, which is the flip;
 *   3. only then the assets nobody references any more are swept, and only if
 *      they are old enough that no other build in flight can be serving them
 *      AND no generation a window may still be running owns them (see
 *      `GENERATION_KEEP_MS`).
 *
 * Split from `build-client.ts` so the publishing rules can be tested without
 * running vite.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { missingBundleAssets, unreachableAssets } from "../server/lib/client-bundle";

/**
 * How old an unreferenced asset must be before the sweep removes it. A second
 * build in the same checkout (a land and a hand-typed one, two e2e shards)
 * publishes its own chunks a few seconds either side of this one: sweeping
 * everything "not mine" would delete the files the OTHER live index.html
 * points at. Anything older than this is from a previous session and nobody
 * is serving it.
 */
export const SWEEP_MIN_AGE_MS = 30 * 60_000;

/**
 * How long the assets of a generation survive AFTER a newer one replaced it.
 *
 * A window keeps the index.html it loaded for as long as it stays open, and a
 * desktop window stays open for days: its lazy chunks are fetched at the first
 * click, hours after the load. Measured 2026-09-29: the Topics.app window had
 * been up 10h13m while 34 client commits landed on main, every build renames
 * almost every chunk (a changed entry re-hashes all the chunks importing it),
 * and the model menu of that window asked for a chunk the 30 minute sweep had
 * already deleted: a 404, and a menu that never opened.
 *
 * Three days covers a window left open over a weekend. The clock starts when
 * the generation stops being served, not when it was published: a bundle live
 * for two quiet days was loaded by windows until the very last minute.
 */
export const GENERATION_KEEP_MS = 3 * 24 * 3_600_000;

/**
 * At most this many generations are kept, the one being served included: the
 * disk bound. Measured on public/ 2026-09-29: one generation is 12.8 MB with
 * its .br/.gz siblings, 9.2 MB (279 files) of it not shared with the next
 * build, so the worst case is 40 x 9.2 = 368 MB. The busiest day on main since
 * 2026-09-01 landed 51 client commits (2026-09-07), average 13.6/day since
 * 2026-09-15: forty generations are 19 hours at the busiest rate, which still
 * covers the measured 10 hour window twice, and three average days.
 */
export const GENERATION_KEEP_COUNT = 40;

/** Which generations were published and when, next to the bundle it describes. */
export const GENERATIONS_FILE = ".bundle-generations.json";

export interface BundleGeneration {
  /** When its index.html went live, epoch ms. */
  publishedAt: number;
  /** When another generation replaced it, epoch ms; `null` while it is served. */
  replacedAt: number | null;
  /** The assets its index.html references: what tells two generations apart. */
  refs: string[];
  /** Every file under `assets/` it is made of, precompressed siblings included. */
  assets: string[];
}

/** Every file under `dir`, as paths relative to it. */
export function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

/** Copy through a temp name + rename: a reader never sees a half file. */
function copyAtomic(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.tmp-${process.pid}`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/** The `/assets/*` an index.html on disk references. Empty when there is none. */
export function referencedAssets(indexHtml: string): Set<string> {
  const refs = new Set<string>();
  if (!existsSync(indexHtml)) return refs;
  let html: string;
  try {
    html = readFileSync(indexHtml, "utf8");
  } catch {
    return refs;
  }
  for (const m of html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)) refs.add(m[1]);
  return refs;
}

function isGeneration(g: unknown): g is BundleGeneration {
  const x = g as BundleGeneration;
  return (
    typeof x === "object" && x !== null && Number.isFinite(x.publishedAt) &&
    (x.replacedAt === null || Number.isFinite(x.replacedAt)) &&
    Array.isArray(x.refs) && x.refs.every((r) => typeof r === "string") &&
    Array.isArray(x.assets) && x.assets.every((a) => typeof a === "string")
  );
}

/** The recorded generations. Empty when there is no record, or an unreadable one. */
export function readGenerations(publicDir: string): BundleGeneration[] {
  try {
    const data = JSON.parse(readFileSync(join(publicDir, GENERATIONS_FILE), "utf8")) as { generations?: unknown };
    return Array.isArray(data.generations) ? data.generations.filter(isGeneration) : [];
  } catch {
    return [];
  }
}

function writeGenerations(publicDir: string, generations: BundleGeneration[]): void {
  const file = join(publicDir, GENERATIONS_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ generations }, null, 1)}\n`);
  renameSync(tmp, file);
}

/**
 * The generations whose assets must stay on disk at `now`: the one being
 * served, then the most recently replaced, `GENERATION_KEEP_COUNT` in all,
 * minus those replaced more than `GENERATION_KEEP_MS` ago.
 */
export function keptGenerations(generations: BundleGeneration[], now: number): BundleGeneration[] {
  const servedLast = (g: BundleGeneration): number => g.replacedAt ?? Number.POSITIVE_INFINITY;
  return [...generations]
    .sort((a, b) => servedLast(b) - servedLast(a) || b.publishedAt - a.publishedAt)
    .slice(0, GENERATION_KEEP_COUNT)
    .filter((g) => g.replacedAt === null || now - g.replacedAt < GENERATION_KEEP_MS);
}

/** Every asset a kept generation owns: what the sweep spares and the bundle gate leaves out. */
export function retainedAssets(publicDir: string, now: number): Set<string> {
  const out = new Set<string>();
  for (const g of keptGenerations(readGenerations(publicDir), now)) for (const a of g.assets) out.add(a);
  return out;
}

const refsKey = (refs: Iterable<string>): string => [...refs].sort().join("\n");

/**
 * The generation `publicDir/index.html` serves right now, read off the disk.
 * For a bundle no publish recorded: one from before the record existed, or a
 * plain `vite build` into public/ (scripts/local-shell-swap.sh does that).
 */
function servedGeneration(publicDir: string, refs: Set<string>): BundleGeneration {
  const assetsDir = join(publicDir, "assets");
  const orphans = new Set(unreachableAssets(assetsDir, refs));
  return {
    publishedAt: statSync(join(publicDir, "index.html")).mtimeMs,
    replacedAt: null,
    refs: [...refs].sort(),
    assets: existsSync(assetsDir) ? walk(assetsDir).filter((f) => !orphans.has(f)).sort() : [],
  };
}

export interface PublishResult {
  /** What is wrong with the published directory, or `null` when it is whole. */
  broken: string | null;
  /** Stale assets removed. */
  swept: number;
}

export function publishBundle(staging: string, publicDir: string, now = Date.now()): PublishResult {
  mkdirSync(publicDir, { recursive: true });
  const indexPath = join(publicDir, "index.html");
  const generations = readGenerations(publicDir);
  // The bundle about to be replaced is running in every window open right now:
  // record it before the flip if no publish did.
  const servedRefs = referencedAssets(indexPath);
  if (servedRefs.size > 0 && !generations.some((g) => refsKey(g.refs) === refsKey(servedRefs))) {
    generations.push(servedGeneration(publicDir, servedRefs));
  }

  // Everything but index.html first: the page in the browser cannot see these
  // files until an index.html points at them.
  for (const rel of walk(staging)) {
    if (rel === "index.html") continue;
    copyAtomic(join(staging, rel), join(publicDir, rel));
  }
  copyAtomic(join(staging, "index.html"), indexPath);

  // Checked on what is actually being served, not on what was built.
  const missing = missingBundleAssets(publicDir);
  if (missing.length > 0) return { broken: missing.slice(0, 5).join(", "), swept: 0 };

  const publishedRefs = referencedAssets(indexPath);
  const stagedAssets = join(staging, "assets");
  const publishedKey = refsKey(publishedRefs);
  const kept = keptGenerations(
    [
      // Whatever was served until now stops being served now. The same bundle
      // published again (a land that touched only the server rebuilds the
      // client with the same hashes) replaces nothing: it is the entry below.
      ...generations
        .filter((g) => refsKey(g.refs) !== publishedKey)
        .map((g) => (g.replacedAt === null ? { ...g, replacedAt: now } : g)),
      {
        publishedAt: now,
        replacedAt: null,
        refs: [...publishedRefs].sort(),
        assets: existsSync(stagedAssets) ? walk(stagedAssets).sort() : [],
      },
    ],
    now,
  );
  writeGenerations(publicDir, kept);
  const retained = new Set(kept.flatMap((g) => g.assets));

  // TWO EXEMPTIONS, BOTH BOUNDED. A generation still kept: a window may be
  // running it, and it leaves the record after `GENERATION_KEEP_COUNT` newer
  // ones or `GENERATION_KEEP_MS` after it stopped being served. Age: a second
  // build in flight has copied its chunks and not yet flipped its index.html,
  // so no generation names them yet.
  //
  // The bound is the point. Before 2026-08-29 the bundle the previous
  // index.html pointed at was kept whatever its age: after two builds far
  // enough apart, the entry of the one before last was unreachable, older than
  // the window, and protected anyway, `check:bundle` saw a leftover past the
  // grace window and stopped measuring `total_assets` (measured on
  // `index-DIcBEokb.js`, 93 min old, alive through two builds that swept 79
  // and 158 files). Dropping that exemption left only the 30 minute window,
  // and a window open longer than that lost its lazy chunks. The gate now
  // reads the same record (`retainedAssets`), so what is kept here is not a
  // leftover there.
  const assetsDir = join(publicDir, "assets");
  let swept = 0;
  if (existsSync(assetsDir)) {
    // Unreachable means unreachable THROUGH the whole chain, the same walk the
    // bundle gate counts orphans with: a lazy chunk nobody names in index.html
    // is still part of this build.
    for (const rel of unreachableAssets(assetsDir, referencedAssets(indexPath))) {
      if (retained.has(rel)) continue;
      const full = join(assetsDir, rel);
      try {
        if (now - statSync(full).mtimeMs < SWEEP_MIN_AGE_MS) continue;
        rmSync(full);
        swept++;
      } catch {
        // A file that vanished under us is exactly what we wanted anyway.
      }
    }
  }
  return { broken: null, swept };
}

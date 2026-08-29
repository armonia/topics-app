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
 *      they are old enough that no other build in flight can be serving them.
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
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { missingBundleAssets } from "../server/lib/client-bundle";

/**
 * How old an unreferenced asset must be before the sweep removes it. A second
 * build in the same checkout (a land and a hand-typed one, two e2e shards)
 * publishes its own chunks a few seconds either side of this one: sweeping
 * everything "not mine" would delete the files the OTHER live index.html
 * points at. Anything older than this is from a previous session and nobody
 * is serving it.
 */
export const SWEEP_MIN_AGE_MS = 30 * 60_000;

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

export interface PublishResult {
  /** What is wrong with the published directory, or `null` when it is whole. */
  broken: string | null;
  /** Stale assets removed. */
  swept: number;
}

export function publishBundle(staging: string, publicDir: string, now = Date.now()): PublishResult {
  mkdirSync(publicDir, { recursive: true });
  // Everything but index.html first: the page in the browser cannot see these
  // files until an index.html points at them.
  for (const rel of walk(staging)) {
    if (rel === "index.html") continue;
    copyAtomic(join(staging, rel), join(publicDir, rel));
  }
  const indexPath = join(publicDir, "index.html");
  const previous = referencedAssets(indexPath);
  copyAtomic(join(staging, "index.html"), indexPath);

  // Checked on what is actually being served, not on what was built.
  const missing = missingBundleAssets(publicDir);
  if (missing.length > 0) return { broken: missing.slice(0, 5).join(", "), swept: 0 };

  const kept = referencedAssets(indexPath);
  const assetsDir = join(publicDir, "assets");
  let swept = 0;
  if (existsSync(assetsDir)) {
    for (const rel of walk(assetsDir)) {
      if (kept.has(rel) || previous.has(rel)) continue;
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

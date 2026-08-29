import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Is this directory a SERVABLE client bundle? Empty answer = yes.
 *
 * One authority for the same question asked in four places: the build (before
 * it publishes what it just produced), the land (after it rebuilds the client),
 * the runtime probe (while the server is up) and the e2e bundle snapshot.
 *
 * "The referenced assets exist" is not enough: `index.html` itself can be half
 * written. Seen for real, the copy caught vite between `create` and `write` and
 * out came a ZERO byte `index.html`. An empty file references no asset, so the
 * asset check passed on nothing, the server served a blank page and every test
 * failed claiming it could not find the sidebar. So: first the file must be
 * WHOLE (closed, and carrying the client entry), then what it references must
 * be on disk.
 */
export function missingBundleAssets(dir: string): string[] {
  const entry = join(dir, "index.html");
  if (!existsSync(entry)) return ["index.html"];
  let html: string;
  try {
    html = readFileSync(entry, "utf8");
  } catch {
    return ["index.html (unreadable)"];
  }
  if (!html.trim()) return ["index.html (empty)"];
  if (!/<\/html>\s*$/.test(html)) return ["index.html (truncated)"];
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) refs.add(m[1]);
  // Without the entry module the page loads and does nothing: blank, and the
  // red blames the first component somebody happens to look at.
  if (![...refs].some((r) => /^\/assets\/.*\.js$/.test(r))) return ["index.html (no /assets/*.js entry)"];
  return [...refs].filter((ref) => !existsSync(join(dir, ref.replace(/^\//, ""))));
}

/** Every file under `dir`, as slash-separated paths relative to it. */
function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/**
 * Which assets under `assetsDir` NOTHING reaches, starting from `roots`.
 *
 * One authority for the same question asked twice, and the two answers used to
 * differ: the bundle gate called an asset an orphan only when no chain of
 * references led to it (lazy `import()`, `modulepreload`, a font cited by a
 * CSS `url()`), while the publish sweep looked at the direct references of
 * `index.html` alone. Two definitions of "orphan" means the gate can count a
 * leftover the sweep never deletes, which is how a bundle budget goes silent
 * until somebody empties `public/assets` by hand.
 *
 * A filename emitted by Vite is always `<base>-<hash>.<ext>`, so looking for
 * it as plain text covers both `import("./chunk-x.js")` and
 * `url(/assets/font-x.woff2)` without interpreting the minified JS.
 *
 * `roots` are asset names as `index.html` writes them: a leading `/assets/` or
 * `assets/` is stripped, and a bare basename resolves to whatever matches it
 * in the tree.
 */
export function unreachableAssets(assetsDir: string, roots: Iterable<string>): string[] {
  if (!existsSync(assetsDir)) return [];
  const all = filesUnder(assetsDir);
  const byBase = new Map<string, string[]>();
  for (const rel of all) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const list = byBase.get(base);
    if (list) list.push(rel);
    else byBase.set(base, [rel]);
  }
  const known = new Set(all);
  const reachable = new Set<string>();
  const queue: string[] = [];
  const reach = (name: string): void => {
    for (const rel of known.has(name) ? [name] : (byBase.get(name) ?? [])) {
      if (reachable.has(rel)) continue;
      reachable.add(rel);
      queue.push(rel);
    }
  };
  for (const root of roots) reach(root.replace(/^\/?assets\//, ""));
  const token = /[\w.@-]+\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|svg|jpe?g|gif|webp|avif|json|wasm|map)/g;
  while (queue.length > 0) {
    const file = queue.pop()!;
    // Only TEXT files can cite another one: a .woff2 or a .png read as utf8
    // would be nothing but noise to scan.
    if (!/\.(?:js|mjs|css|json|map|svg)$/.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(assetsDir, file), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(token)) reach(m[0]);
  }
  return all.filter((f) => !reachable.has(f)).sort();
}

/** One line, for a log or a comment on a card. `null` when the bundle is whole. */
export function bundleBreakageReason(dir: string): string | null {
  const missing = missingBundleAssets(dir);
  if (missing.length === 0) return null;
  const head = missing.slice(0, 5).join(", ");
  const rest = missing.length > 5 ? ` (+${missing.length - 5})` : "";
  return `${dir}: ${head}${rest}`;
}

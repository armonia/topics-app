import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** One line, for a log or a comment on a card. `null` when the bundle is whole. */
export function bundleBreakageReason(dir: string): string | null {
  const missing = missingBundleAssets(dir);
  if (missing.length === 0) return null;
  const head = missing.slice(0, 5).join(", ");
  const rest = missing.length > 5 ? ` (+${missing.length - 5})` : "";
  return `${dir}: ${head}${rest}`;
}

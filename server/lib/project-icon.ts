/**
 * Project icon (favicon / web-manifest) resolution — pure fs helpers behind
 * `GET /api/projects/icon` (server/routes/projects.ts). Given a project
 * directory, finds the image that best represents it, in priority order:
 *   1. conventional favicon/logo files (Vite/CRA public/, SvelteKit static/,
 *      Next.js app-dir, Tauri src-tauri/icons, electron-builder build/, roots)
 *   2. a web manifest's icons[] (largest declared size)
 *   3. index.html <link rel=icon> — file hrefs AND inline `data:image/*` URIs
 *      (a very common Vite pattern: an emoji/svg favicon inlined in the tag)
 *   4. fuzzy filename scan (favicon*, icon*, logo* + image ext) of the root
 *      and a few common asset dirs — catches loosely-named brand files like
 *      `logo-acme.png` that ship without any web plumbing
 * The scan runs on the repo root first, then common nested-app directories
 * (site/, client/, apps/<name>/, …) for monorepo layouts.
 *
 * SECURITY: file results only LOCATE a path; the route enforces realpath
 * containment inside the project dir before serving. Inline results carry the
 * bytes directly (size-capped, content-type allowlisted) and are served with
 * the same sandboxed-CSP headers as file icons.
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
import { isInsideDir } from "./path-containment";

export const ICON_CONTENT_TYPE: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const ALLOWED_INLINE_CT = new Set(Object.values(ICON_CONTENT_TYPE));
// Inline favicons are tag-sized by nature; anything bigger than this is not a
// favicon and gets ignored rather than buffered.
const INLINE_MAX_BYTES = 256 * 1024;

export type ResolvedProjectIcon =
  | { kind: "file"; path: string }
  | { kind: "inline"; contentType: string; bytes: Uint8Array };

// Conventional favicon/logo locations, in priority order.
const ICON_CANDIDATES = [
  "favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png", "logo.svg", "logo.png",
  "public/favicon.svg", "public/favicon.png", "public/favicon.ico", "public/icon.svg",
  "public/icon.png", "public/apple-touch-icon.png", "public/logo.svg", "public/logo.png",
  "static/favicon.svg", "static/favicon.png", "static/favicon.ico", "static/logo.png",
  "src/favicon.svg", "src/favicon.png", "src/favicon.ico", "src/assets/favicon.png", "src/assets/logo.png",
  "app/icon.svg", "app/icon.png", "app/favicon.ico", "app/apple-icon.png",
  "assets/favicon.png", "assets/icon.png", "assets/logo.png",
  "src-tauri/icons/icon.png", "build/icon.png",
];
const MANIFEST_CANDIDATES = [
  "public/manifest.json", "public/site.webmanifest", "public/manifest.webmanifest",
  "manifest.json", "site.webmanifest", "manifest.webmanifest",
];
// Monorepo / nested-app layouts: many projects keep the actual web app one
// level down (`site/public/favicon.png`, `client/index.html`, …). Each of
// these gets the SAME full scan as the root — but only when the subdirectory
// actually exists, so the extra cost for single-app repos is a handful of
// existsSync calls.
const NESTED_APP_DIRS = ["client", "site", "web", "frontend", "www", "ui", "landing"];
// Turborepo/Nx convention: apps/<name>/…. Enumerated (capped) rather than
// hardcoded since the app names are arbitrary.
const APPS_DIR_SCAN_CAP = 8;

// Fuzzy stage: directories whose entries get filename-matched, and the match
// itself. Prefix-anchored so `logo-edm.png` / `favicon-32.png` / `icon_dark.svg`
// match but `catalogo.png` or a random photo does not.
const FUZZY_DIRS = ["", "public", "assets", "static", "img", "images"];
const FUZZY_RE = /^(favicon|icon|logo)[\w.-]*\.(svg|png|ico|jpg|jpeg|webp|gif)$/i;
const FUZZY_RANK: Record<string, number> = { favicon: 0, icon: 1, logo: 2 };

function isFile(p: string): boolean {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}
function fileIcon(p: string): ResolvedProjectIcon { return { kind: "file", path: p }; }

/** Decode the handful of HTML entities that can appear inside an attribute
 *  value we lifted out of index.html. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Parse a `data:image/*` favicon URI into servable bytes, or null when it is
 *  not an allowlisted image type / too large / malformed. */
export function parseDataUriIcon(uri: string): { contentType: string; bytes: Uint8Array } | null {
  if (!/^data:/i.test(uri)) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (payload.length === 0 || payload.length > INLINE_MAX_BYTES) return null;
  const parts = header.split(";").map((p) => p.trim().toLowerCase());
  let ct = parts[0] || "";
  if (ct === "image/vnd.microsoft.icon") ct = "image/x-icon";
  if (!ALLOWED_INLINE_CT.has(ct)) return null;
  const isB64 = parts.includes("base64");
  try {
    let bytes: Uint8Array;
    if (isB64) {
      bytes = Uint8Array.from(Buffer.from(payload, "base64"));
    } else {
      // Raw payloads (typical for inline SVG) are usually only partially
      // percent-encoded; if strict decoding chokes, serve the text as-is —
      // that is exactly what the browser renders.
      let text: string;
      try { text = decodeURIComponent(payload); } catch { text = payload; }
      bytes = new TextEncoder().encode(text);
    }
    if (bytes.length === 0 || bytes.length > INLINE_MAX_BYTES) return null;
    return { contentType: ct, bytes };
  } catch { return null; }
}

/** Extract the href of the first <link rel=icon> in an HTML document.
 *  Quote-aware on purpose: an inline `data:image/svg+xml,<svg …>` href
 *  contains raw `<`/`>`/`'` characters, so naive `<link[^>]*>` tokenizing or
 *  `[^"']+` capture both truncate it. We anchor on each `<link`, require a
 *  rel=icon nearby, then capture the href value to its matching quote. */
export function extractIconHref(html: string): string | null {
  for (const m of html.matchAll(/<link\b/gi)) {
    const win = html.slice(m.index!, m.index! + 8192);
    // Both rel and href must belong to THIS tag: `[^>]{0,600}?` keeps the
    // anchor inside the attribute zone (a rel=icon appearing after a `>`
    // belongs to a later tag — e.g. a rel=stylesheet link followed by the
    // icon link — and must not be claimed by this window). The href VALUE may
    // legitimately contain `>` (inline SVG); only the text BEFORE the
    // attribute is guarded.
    if (!/^[^>]{0,600}?rel\s*=\s*["'](?:shortcut\s+)?icon["']/is.test(win)) continue;
    const hm = win.match(/^[^>]{0,600}?href\s*=\s*(?:"([^"]*)"|'([^']*)')/is);
    const href = hm?.[1] ?? hm?.[2];
    if (href) return decodeHtmlEntities(href.trim());
  }
  return null;
}

/** Prefix-ranked fuzzy filename scan of a directory's common asset spots. */
function fuzzyScanDir(dir: string): string | null {
  for (const sub of FUZZY_DIRS) {
    const d = sub ? join(dir, sub) : dir;
    if (!isDir(d)) continue;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    const ranked = entries
      .filter((n) => FUZZY_RE.test(n))
      .sort((a, b) => {
        const ra = FUZZY_RANK[a.toLowerCase().match(FUZZY_RE)![1]] ?? 9;
        const rb = FUZZY_RANK[b.toLowerCase().match(FUZZY_RE)![1]] ?? 9;
        // Category first (favicon > icon > logo), then shortest/lexicographic
        // for a deterministic pick among variants (logo.png before logo-dark.png).
        return ra - rb || a.length - b.length || a.localeCompare(b);
      });
    for (const n of ranked) {
      const p = join(d, n);
      if (isFile(p) && extname(p).toLowerCase() in ICON_CONTENT_TYPE) return p;
    }
  }
  return null;
}

/** One full icon scan of a single directory: conventional favicon/logo files,
 *  then web-manifest icons, then index.html <link rel=icon> (file or inline
 *  data URI), then the fuzzy filename scan. */
export function scanDirForIcon(dir: string): ResolvedProjectIcon | null {
  for (const rel of ICON_CANDIDATES) {
    const p = join(dir, rel);
    if (isFile(p) && extname(p).toLowerCase() in ICON_CONTENT_TYPE) return fileIcon(p);
  }
  // Web manifest: pick the icon with the largest declared size (fallback first).
  for (const rel of MANIFEST_CANDIDATES) {
    const mp = join(dir, rel);
    if (!isFile(mp)) continue;
    try {
      const m = JSON.parse(readFileSync(mp, "utf-8"));
      const icons: Array<{ src?: string; sizes?: string }> = Array.isArray(m.icons) ? m.icons : [];
      const scored = icons
        .filter((i) => typeof i.src === "string" && !/^(https?:)?\/\//.test(i.src!))
        .map((i) => ({ src: i.src!, size: parseInt((i.sizes || "0").split("x")[0], 10) || 0 }))
        .sort((a, b) => b.size - a.size);
      for (const { src } of scored) {
        if (src.startsWith("data:")) {
          const inline = parseDataUriIcon(src);
          if (inline) return { kind: "inline", ...inline };
          continue;
        }
        const cand = join(dirname(mp), src.replace(/^\//, ""));
        if (isFile(cand) && extname(cand).toLowerCase() in ICON_CONTENT_TYPE) return fileIcon(cand);
      }
    } catch { /* malformed manifest — ignore */ }
  }
  // index.html <link rel="icon"> — file href or inline data: URI.
  for (const rel of ["index.html", "public/index.html"]) {
    const hp = join(dir, rel);
    if (!isFile(hp)) continue;
    try {
      const href = extractIconHref(readFileSync(hp, "utf-8"));
      if (!href || /^(https?:)?\/\//.test(href)) continue;
      if (href.startsWith("data:")) {
        const inline = parseDataUriIcon(href);
        if (inline) return { kind: "inline", ...inline };
        continue;
      }
      const cand = join(dirname(hp), href.replace(/^\//, ""));
      if (isFile(cand) && extname(cand).toLowerCase() in ICON_CONTENT_TYPE) return fileIcon(cand);
    } catch { /* unreadable — ignore */ }
  }
  // Last resort: loosely-named brand files (logo-acme.png, favicon-32.png, …).
  const fuzzy = fuzzyScanDir(dir);
  if (fuzzy) return fileIcon(fuzzy);
  return null;
}

/** Resolve a project's icon: scan the project root, then each existing
 *  nested-app directory (site/, client/, apps/<name>/, …), or null if none.
 *  `dir` must already be a realpath'd directory. Containment of file results
 *  inside `dir` is enforced by the route (realpath check), so a symlinked
 *  nested dir can't leak files from outside the project. */
export function resolveProjectIcon(dir: string): ResolvedProjectIcon | null {
  const root = scanDirForIcon(dir);
  if (root) return root;
  for (const sub of NESTED_APP_DIRS) {
    const nested = join(dir, sub);
    if (!isDir(nested)) continue;
    const found = scanDirForIcon(nested);
    if (found) return found;
  }
  const appsDir = join(dir, "apps");
  if (isDir(appsDir)) {
    try {
      const entries = readdirSync(appsDir).sort().slice(0, APPS_DIR_SCAN_CAP);
      for (const name of entries) {
        const nested = join(appsDir, name);
        if (!isDir(nested)) continue;
        const found = scanDirForIcon(nested);
        if (found) return found;
      }
    } catch { /* unreadable — ignore */ }
  }
  return null;
}

// ── Icon identity and the folders that can change it ─────────────────────

/**
 * The identity of what `resolveProjectIcon` answered: a short hash that
 * changes whenever the served bytes can change. A file is identified by its
 * path, inode, size and change times (no read of the bytes); an inline icon by
 * its bytes.
 * `null` means «no icon», which is an answer too and is compared like one.
 *
 * It is what the route sends as ETag, what the client puts in the `<img>` URL
 * (so a changed icon is a NEW URL and the browser cannot show the old bytes),
 * and what the watcher compares to decide whether to push.
 */
export function projectIconVersion(resolved: ResolvedProjectIcon | null): string | null {
  if (!resolved) return null;
  const h = createHash("sha1");
  if (resolved.kind === "inline") {
    h.update("inline\0");
    h.update(resolved.contentType);
    h.update("\0");
    h.update(resolved.bytes);
  } else {
    try {
      // Nanoseconds, not `mtimeMs`: Bun rounds that one to the millisecond,
      // and two writes of the same size inside one millisecond (an editor's
      // save, a `cp` over the file) would keep the same identity. The inode
      // catches an atomic replace that restores an older mtime.
      const st = statSync(resolved.path, { bigint: true });
      h.update(`file\0${resolved.path}\0${st.ino}\0${st.size}\0${st.mtimeNs}\0${st.ctimeNs}`);
    } catch {
      return null;
    }
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Every directory, relative to one scan root, whose entries the resolver reads:
 * the folders of the conventional candidates, of the manifests and of
 * index.html, the fuzzy-scan folders, and every ancestor of each of them (a
 * `public/` that does not exist yet appears as an entry of the root). Derived
 * from the same lists the resolver walks, so a candidate added there is
 * watched without touching this.
 */
const SCAN_ROOT_DIRS: readonly string[] = (() => {
  const out = new Set<string>([""]);
  const addWithAncestors = (rel: string) => {
    let d = rel;
    while (d && d !== ".") { out.add(d); d = dirname(d); }
  };
  for (const rel of [...ICON_CANDIDATES, ...MANIFEST_CANDIDATES, "index.html", "public/index.html"]) {
    addWithAncestors(dirname(rel));
  }
  for (const d of FUZZY_DIRS) if (d) addWithAncestors(d);
  return [...out];
})();

/**
 * The directories to watch so that ANY change able to alter
 * `resolveProjectIcon(dir)` is seen: for the root and for each nested-app root
 * that exists, the `SCAN_ROOT_DIRS` that exist; the root itself also sees a
 * nested app or `apps/` appear; `apps/` sees a new app; and the folder of the
 * file currently served, since a manifest or an index.html may point anywhere
 * inside the project. Non-recursive on purpose: one watch per folder that
 * matters, never a walk of the whole tree (node_modules included).
 */
export function projectIconWatchDirs(dir: string, resolved: ResolvedProjectIcon | null): string[] {
  const out = new Set<string>();
  const addRoot = (root: string) => {
    for (const rel of SCAN_ROOT_DIRS) {
      const d = rel ? join(root, rel) : root;
      if (isDir(d)) out.add(d);
    }
  };
  addRoot(dir);
  for (const sub of NESTED_APP_DIRS) {
    const nested = join(dir, sub);
    if (isDir(nested)) addRoot(nested);
  }
  const appsDir = join(dir, "apps");
  if (isDir(appsDir)) {
    out.add(appsDir);
    try {
      for (const name of readdirSync(appsDir).sort().slice(0, APPS_DIR_SCAN_CAP)) {
        const nested = join(appsDir, name);
        if (isDir(nested)) addRoot(nested);
      }
    } catch { /* unreadable — ignore */ }
  }
  if (resolved?.kind === "file") {
    const d = dirname(resolved.path);
    if (d === dir || isInsideDir(d, dir)) out.add(d);
  }
  return [...out];
}

/**
 * Whether a change to an entry with this name, inside one of the watched
 * folders, can change the answer. Images, manifests and pages can; a name
 * without an extension may be a folder (a new `public/`, a new app); a missing
 * name means the platform did not say, so it counts. Everything else (source
 * files an agent is editing in `src/`, lockfiles) is skipped before the
 * debounce.
 */
export function iconRelevantEntry(name: string | null): boolean {
  if (!name) return true;
  const ext = extname(name).toLowerCase();
  if (!ext) return true;
  return ext in ICON_CONTENT_TYPE || ext === ".json" || ext === ".webmanifest" || ext === ".html";
}

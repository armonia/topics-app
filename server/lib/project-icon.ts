/**
 * Project icon (favicon / web-manifest) resolution — pure fs helpers behind
 * `GET /api/projects/icon` (server/routes/projects.ts). Given a project
 * directory, finds the image file that best represents it: conventional
 * favicon/logo files, a web manifest's icons[], or an index.html
 * <link rel=icon> — scanning the repo root first, then common nested-app
 * directories (site/, client/, apps/<name>/, …) for monorepo layouts.
 *
 * SECURITY: these helpers only LOCATE a file; the route enforces realpath
 * containment of the result inside the project dir before serving it, so a
 * symlinked nested dir or manifest href can't leak files from outside.
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";

export const ICON_CONTENT_TYPE: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Conventional favicon/logo locations, in priority order. Covers Vite/CRA
// (public/), SvelteKit/Hugo (static/), Next.js app-dir (app/icon.*), desktop
// shells (Tauri src-tauri/icons, electron-builder build/), and bare roots.
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
// level down (`site/public/favicon.png`, `client/index.html`, …) and the icon
// endpoint used to 404 on them because it only scanned the repo root. Each of
// these gets the SAME full scan (candidates → manifest → index.html) as the
// root — but only when the subdirectory actually exists, so the extra cost for
// ordinary single-app repos is a handful of existsSync calls.
const NESTED_APP_DIRS = ["client", "site", "web", "frontend", "www", "ui", "landing"];
// Turborepo/Nx convention: apps/<name>/…. Enumerated (capped) rather than
// hardcoded since the app names are arbitrary.
const APPS_DIR_SCAN_CAP = 8;

function isFile(p: string): boolean {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}

/** One full icon scan of a single directory: conventional favicon/logo files,
 *  then web-manifest icons, then index.html <link rel=icon>. */
export function scanDirForIcon(dir: string): string | null {
  for (const rel of ICON_CANDIDATES) {
    const p = join(dir, rel);
    if (isFile(p) && extname(p).toLowerCase() in ICON_CONTENT_TYPE) return p;
  }
  // Web manifest: pick the icon with the largest declared size (fallback first).
  for (const rel of MANIFEST_CANDIDATES) {
    const mp = join(dir, rel);
    if (!isFile(mp)) continue;
    try {
      const m = JSON.parse(readFileSync(mp, "utf-8"));
      const icons: Array<{ src?: string; sizes?: string }> = Array.isArray(m.icons) ? m.icons : [];
      const scored = icons
        .filter((i) => typeof i.src === "string" && !/^(https?:)?\/\//.test(i.src!) && !i.src!.startsWith("data:"))
        .map((i) => ({ src: i.src!, size: parseInt((i.sizes || "0").split("x")[0], 10) || 0 }))
        .sort((a, b) => b.size - a.size);
      for (const { src } of scored) {
        const cand = join(dirname(mp), src.replace(/^\//, ""));
        if (isFile(cand) && extname(cand).toLowerCase() in ICON_CONTENT_TYPE) return cand;
      }
    } catch { /* malformed manifest — ignore */ }
  }
  // index.html <link rel="icon">
  for (const rel of ["index.html", "public/index.html"]) {
    const hp = join(dir, rel);
    if (!isFile(hp)) continue;
    try {
      const html = readFileSync(hp, "utf-8");
      const m = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)
        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
      const href = m?.[1];
      if (href && !/^(https?:)?\/\//.test(href) && !href.startsWith("data:")) {
        const cand = join(dirname(hp), href.replace(/^\//, ""));
        if (isFile(cand) && extname(cand).toLowerCase() in ICON_CONTENT_TYPE) return cand;
      }
    } catch { /* unreadable — ignore */ }
  }
  return null;
}

/** Resolve a project's icon file (absolute path): scan the project root, then
 *  each existing nested-app directory (site/, client/, apps/<name>/, …), or
 *  null if none. `dir` must already be a realpath'd directory. */
export function resolveProjectIcon(dir: string): string | null {
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

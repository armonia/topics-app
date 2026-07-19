/**
 * Discover the user's already-installed Chrome-family extensions so the Chromium
 * sidecar (engine switch, task 54601eeb) can load them via `--load-extension`.
 *
 * Why: the sidecar backbone (browser-chromium-sidecar.ts) launches Chromium with
 * a DEDICATED `--user-data-dir`, which starts with ZERO of the user's extensions
 * — so the "toggle Chromium to use my extensions" goal isn't met by the backbone
 * alone. Chrome stores each installed extension UNPACKED under
 * `<profile>/Extensions/<id>/<version>/` (manifest.json + code), which is exactly
 * what `--load-extension` accepts. This module finds those dirs.
 *
 * Caveat (surfaced for the design decision): `--load-extension` loads the
 * extension CODE but NOT its logged-in state / storage (that lives in the user's
 * real profile). Extensions that need the user's session (e.g. an account-bound
 * one) need the real profile (`--user-data-dir=<real>`, which conflicts with a
 * running browser) or a CDP attach to the running browser — a separate decision.
 *
 * Pure filesystem reads; no launching. `listUnpackedExtensions` is unit-tested.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface InstalledExtension {
  id: string;        // 32-char Chrome extension id
  version: string;   // highest installed version dir
  path: string;      // unpacked dir for --load-extension
  name?: string;     // from manifest (best-effort; may be an i18n placeholder)
}

const EXT_ID_RX = /^[a-p]{32}$/; // Chrome extension ids are 32 chars, a–p

/** Compare two dotted version strings numerically (e.g. "1.10.0" > "1.9.0"). */
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true; // equal
}

/**
 * List the unpacked extensions under a Chrome-style `Extensions` directory.
 * For each extension id, picks the HIGHEST version subdir that contains a
 * manifest.json. Returns [] for a missing/unreadable dir (never throws).
 */
export function listUnpackedExtensions(extensionsDir: string): InstalledExtension[] {
  let ids: string[];
  try {
    if (!existsSync(extensionsDir)) return [];
    ids = readdirSync(extensionsDir);
  } catch {
    return [];
  }
  const out: InstalledExtension[] = [];
  for (const id of ids) {
    if (!EXT_ID_RX.test(id)) continue;
    const idDir = join(extensionsDir, id);
    let versions: string[];
    try {
      if (!statSync(idDir).isDirectory()) continue;
      versions = readdirSync(idDir);
    } catch {
      continue;
    }
    let best: { version: string; path: string } | null = null;
    for (const v of versions) {
      const vDir = join(idDir, v);
      const manifest = join(vDir, 'manifest.json');
      try {
        if (!statSync(vDir).isDirectory() || !existsSync(manifest)) continue;
      } catch {
        continue;
      }
      if (!best || versionGte(v, best.version)) best = { version: v, path: vDir };
    }
    if (!best) continue;
    let name: string | undefined;
    try {
      const m = JSON.parse(readFileSync(join(best.path, 'manifest.json'), 'utf-8'));
      if (typeof m?.name === 'string') name = m.name;
    } catch { /* manifest unreadable — id-only entry is fine */ }
    out.push({ id, version: best.version, path: best.path, name });
  }
  return out;
}

/**
 * Candidate `Extensions` directories for the installed Chrome-family browsers on
 * the current platform (Default profile). Best-effort; existence not guaranteed.
 * Covers Chrome, Edge, Brave, and Dia (the user's browser) on macOS, plus the
 * common Windows/Linux locations.
 */
export function chromiumExtensionDirs(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const rels: Record<string, string[]> = {
    darwin: [
      'Library/Application Support/Google/Chrome/Default/Extensions',
      'Library/Application Support/Microsoft Edge/Default/Extensions',
      'Library/Application Support/BraveSoftware/Brave-Browser/Default/Extensions',
      'Library/Application Support/Dia/Default/Extensions',
      'Library/Application Support/Dia/User Data/Default/Extensions',
    ],
    win32: [
      'AppData/Local/Google/Chrome/User Data/Default/Extensions',
      'AppData/Local/Microsoft/Edge/User Data/Default/Extensions',
      'AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Extensions',
    ],
    linux: [
      '.config/google-chrome/Default/Extensions',
      '.config/microsoft-edge/Default/Extensions',
      '.config/BraveSoftware/Brave-Browser/Default/Extensions',
    ],
  };
  return (rels[platform] ?? []).map((r) => join(home, r));
}

/** Discover all installed extensions across the platform's Chrome-family profiles. */
export function discoverInstalledExtensions(
  dirs: string[] = chromiumExtensionDirs(),
): InstalledExtension[] {
  const seen = new Set<string>();
  const out: InstalledExtension[] = [];
  for (const dir of dirs) {
    for (const ext of listUnpackedExtensions(dir)) {
      if (seen.has(ext.id)) continue; // first profile wins on id clash
      seen.add(ext.id);
      out.push(ext);
    }
  }
  return out;
}

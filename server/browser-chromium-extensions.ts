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

/**
 * THE EXTENSIONS THAT MADE THE SIDECAR UNLAUNCHABLE, remembered by id.
 *
 * WHY NOT A COUNT. The first attempt at this was a ceiling on HOW MANY, and
 * the measurement killed it. Boot time with the real launcher args, on this
 * machine on 19/09/2026:
 *
 *     1 extension    CDP ready in   8.8 s
 *     2 extensions   CDP ready in   2.9 s
 *     3 extensions   CDP ready in  51.2 s   <- and here is the whole story
 *     4 extensions, without the third one:  21.4 s
 *
 * Three is not worse than two because it is one more. It is worse because the
 * THIRD one is a password manager, and it alone costs more than everything
 * else put together. A cap on the count would drop cheap extensions to keep an
 * expensive one, purely by discovery order: arbitrary, and it would still fail
 * to boot.
 *
 * SO THE LIST IS BY ID, and each entry carries the number that put it there.
 * An id is stable across versions and machines; a name is localized
 * (`__MSG_extName__` is what four of this machine's extensions report) and a
 * path holds a version that moves.
 *
 * THIS IS NOT A BLOCKLIST OF "BAD" EXTENSIONS. It is a list of extensions that
 * cost more than the launch can afford, and it exists because the alternative
 * measured here is a sidecar that never starts. When the user gets to pick
 * their own (card 2e8bf921), this becomes a warning next to a checkbox instead
 * of a decision taken for them.
 */
export interface SlowExtension {
  id: string;
  /** What it is, for the log: the manifest name is often a localization key. */
  what: string;
  /** Measured seconds to CDP with this one in the set. */
  measuredS: number;
}

export const SLOW_EXTENSIONS: SlowExtension[] = [
  { id: "cfhdojbkjhnklbpkdaibdccddilifddb", what: "password manager", measuredS: 51.2 },
];

export interface ExtensionPick {
  /** The ones that will actually be loaded. */
  load: InstalledExtension[];
  /** Left out, with the reason: named, never dropped in silence. */
  skipped: { ext: InstalledExtension; why: string }[];
}

/**
 * AND A CEILING ON TOP, because dropping the expensive ones is not enough.
 *
 * Measured on this machine (42 installed, the password manager already out):
 *
 *     41 extensions  TIMEOUT past 30 s
 *     10 extensions  TIMEOUT past 30 s
 *      6 extensions  TIMEOUT past 30 s
 *      5 extensions  CDP ready in  7.5 s
 *      4 extensions  CDP ready in 15.0 s
 *
 * Both defences are needed and they answer different questions: the id list
 * removes the one that alone costs 51 s, the ceiling keeps the TOTAL inside a
 * launch. Neither is enough on its own — with only the list, 41 still time
 * out; with only a count, discovery order decides whether the password
 * manager is in or out.
 *
 * TWO, and the number comes from what REPEATED rather than from the best run.
 * Five booted once in 7.5 s and then timed out on the very next attempt with
 * the same set: the box moves under the bench (loadavg went 11 to 15 during
 * these runs), so a threshold read off a single good run is an anecdote. Two
 * was measured three times in a row - 4.2 s, 3.8 s, 2.8 s, at loadavg 15 - and
 * that is the only figure here that held up.
 *
 * It is deliberately mean. A sidecar that starts with two extensions is worth
 * more than one that would carry five and boots only when the machine happens
 * to be quiet, because the failure is not "slower": it is the error path that
 * kills the tree, and the user sees no browser at all.
 */
export const MAX_SIDECAR_EXTENSIONS = 2;

export function pickSidecarExtensions(
  all: InstalledExtension[],
  slow: SlowExtension[] = SLOW_EXTENSIONS,
  max: number = MAX_SIDECAR_EXTENSIONS,
): ExtensionPick {
  const bySlowId = new Map(slow.map((s) => [s.id, s]));
  const load: InstalledExtension[] = [];
  const skipped: ExtensionPick["skipped"] = [];
  const ceiling = Math.max(0, max);
  for (const ext of all) {
    const hit = bySlowId.get(ext.id);
    if (hit) {
      skipped.push({ ext, why: `${hit.what}, misurata a ${hit.measuredS}s di avvio da sola` });
      continue;
    }
    if (load.length >= ceiling) {
      skipped.push({ ext, why: `oltre il tetto di ${ceiling}: a sei l'avvio non rientra` });
      continue;
    }
    load.push(ext);
  }
  return { load, skipped };
}

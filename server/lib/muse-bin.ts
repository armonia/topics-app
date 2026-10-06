import { existsSync } from "fs";
import { join } from "path";
import { agentBinPath } from "./agent-bin-paths";

/**
 * Resolves the Muse CLI binary to an absolute path.
 *
 * Muse installs as a `muse` launcher in `~/.local/bin` (a bash script that
 * handles auto-update and login, then execs the versioned binary
 * `muse-bin-<version>` in the same directory). Resolve the LAUNCHER, never the
 * versioned binary: every update renames it, and a pinned path would keep
 * pointing at the old version.
 *
 * The server often runs under launchd with a bare PATH that lacks
 * `~/.local/bin`, so probe the known locations before giving up (same
 * problem as the empty codex terminal pane). Used both by the chat provider
 * (`providers/muse.ts`, `muse exec`) and the PTY route, so the two never
 * disagree on where muse lives.
 */
// `$HOME` does not exist on Windows — there it is `%USERPROFILE%`. Reading HOME
// alone collapsed every candidate into a relative path resolved against the
// server cwd, so on Windows the probe could only return null.
const HOME = process.env.HOME || process.env.USERPROFILE || "";

const IS_WINDOWS = process.platform === "win32";

/**
 * The names a CLI can have on this platform. On Windows an executable
 * carries an extension, and which one depends on the install method: a real
 * `.exe` for a native installer, a `.cmd` shim for an npm/bun global. The
 * bare name finds neither. See the twin note in `claude-bin.ts`.
 */
function names(base: string): string[] {
  return IS_WINDOWS ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base] : [base];
}

function candidates(base: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) for (const n of names(base)) out.push(join(dir, n));
  return out;
}

const CANDIDATES = IS_WINDOWS
  ? candidates("muse", [
      join(HOME, ".local/bin"),
      join(HOME, ".bun/bin"),
      join(process.env.APPDATA || join(HOME, "AppData/Roaming"), "npm"),
      join(HOME, "AppData/Local/Microsoft/WinGet/Links"),
      join(HOME, "AppData/Local/Programs/muse"),
    ])
  : [
      join(HOME, ".local/bin/muse"),
      join(HOME, ".bun/bin/muse"),
      "/opt/homebrew/bin/muse",
      "/usr/local/bin/muse",
      join(HOME, ".npm-global/bin/muse"),
    ];

let cached: string | null = null;

/**
 * Absolute path of the muse binary, or `null` when found nowhere
 * (not installed). The hand-picked Settings path wins, then `$MUSE_BIN`,
 * then PATH (`Bun.which`), then the known locations above. The result is
 * memoized.
 */
export function resolveMuseBin(): string | null {
  if (cached) return cached;

  // The Settings path wins over every probe: it is the only
  // answer that is not a probe. See `agent-bin-paths.ts`.
  const chosen = agentBinPath("muse");
  if (chosen) return (cached = chosen);

  const envBin = process.env.MUSE_BIN;
  if (envBin && existsSync(envBin)) return (cached = envBin);

  const inPath = Bun.which("muse");
  if (inPath) return (cached = inPath);

  for (const candidate of CANDIDATES) {
    try {
      if (existsSync(candidate)) return (cached = candidate);
    } catch {
      /* keep probing */
    }
  }
  return null;
}

/** Forgets the memoized path — for tests that mutate the environment. */
export function _resetMuseBinCache(): void {
  cached = null;
}

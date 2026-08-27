import { existsSync } from "fs";
import { join } from "path";

/**
 * Resolve the Kimi Code CLI binary by absolute path.
 *
 * Kimi Code installs via `curl https://code.kimi.com/kimi-code/install.sh | bash`,
 * which drops the binary at `~/.kimi-code/bin/kimi` and does NOT reliably land
 * on the `PATH` a launchd-spawned server (or the Tauri sidecar's bundled Node)
 * inherits — the installer edits the user's shell rc file, which a non-login,
 * non-interactive process never sources. A plain `kimi` spawn would then ENOENT
 * silently, exactly the failure `codex-bin.ts` and `claude-bin.ts` already fixed
 * for their own CLIs. Mirrors both so all three never disagree on where their
 * binary lives.
 *
 * Returns `null` when kimi isn't installed anywhere — the caller falls back to
 * the bare name, which still surfaces a plain "command not found" instead of a
 * tab that opens and stays empty.
 */
// `$HOME` does not exist on Windows — it is `%USERPROFILE%` there. Reading only
// HOME made every candidate collapse to a relative path `existsSync` resolves
// against the server's cwd, so on Windows the probe could only return null.
const HOME = process.env.HOME || process.env.USERPROFILE || "";

const IS_WINDOWS = process.platform === "win32";

/**
 * The names a CLI can have on this platform. On Windows an executable carries
 * its extension, and which one depends on how it was installed. See the twin
 * note in `claude-bin.ts` / `codex-bin.ts` — the three must never disagree.
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
  ? candidates("kimi", [
      join(HOME, ".kimi-code/bin"),
      join(HOME, ".local/bin"),
      join(HOME, ".bun/bin"),
      join(process.env.APPDATA || join(HOME, "AppData/Roaming"), "npm"),
    ])
  : [
      join(HOME, ".kimi-code/bin/kimi"), // official installer, the only known location
      "/opt/homebrew/bin/kimi",
      "/usr/local/bin/kimi",
      join(HOME, ".local/bin/kimi"),
      join(HOME, ".bun/bin/kimi"),
    ];

let cached: string | null = null;

/**
 * Absolute path to the `kimi` binary, or `null` if it can't be found anywhere
 * (not installed). Honors `$KIMI_BIN` first, then PATH (`Bun.which`), then the
 * known install locations above. Result is memoized.
 */
export function resolveKimiBin(): string | null {
  if (cached) return cached;

  const envBin = process.env.KIMI_BIN;
  if (envBin && existsSync(envBin)) return (cached = envBin);

  const inPath = Bun.which("kimi");
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

/** Reset the memoized path — for tests that mutate the environment. */
export function _resetKimiBinCache(): void {
  cached = null;
}

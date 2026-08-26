import { existsSync } from "fs";
import { join } from "path";

/**
 * Resolve the OpenAI `codex` CLI binary by absolute path.
 *
 * Codex ships two ways: the standalone `codex` on PATH (npm/brew) OR the
 * Codex.app bundle, which puts the binary at
 * `…/Codex.app/Contents/Resources/codex` and does NOT add anything to PATH.
 * The server frequently runs under launchd (the Electron LaunchAgent) with a
 * bare `PATH` that includes neither Homebrew nor the app bundle, so a plain
 * `codex` spawn ENOENTs silently — the exact failure that left the Codex
 * terminal pane blank. We probe the known locations and only fall back to the
 * bare name (which still resolves when the server was launched from a shell
 * with a full PATH, e.g. dev).
 *
 * Mirrors `server/lib/tailscale-bin.ts`. Used by BOTH the chat provider
 * (`providers/codex.ts`, `codex exec`) and the interactive PTY route
 * (`routes/terminal.ts`) so the two never disagree on where codex lives.
 */
// `$HOME` does not exist on Windows — it is `%USERPROFILE%` there. Reading only
// HOME made every candidate collapse to a relative path `existsSync` resolves
// against the server's cwd, so on Windows the probe could only return null.
const HOME = process.env.HOME || process.env.USERPROFILE || "";

const IS_WINDOWS = process.platform === "win32";

/**
 * The names a CLI can have on this platform. On Windows an executable carries its
 * extension, and which one depends on the install method: a real `.exe` for a
 * native installer, a `.cmd` shim for an npm/bun global. The bare name matches
 * neither. See the twin note in `claude-bin.ts` — the two must never disagree.
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
  ? candidates("codex", [
      join(HOME, ".local/bin"),
      join(HOME, ".bun/bin"),
      join(process.env.APPDATA || join(HOME, "AppData/Roaming"), "npm"),
      join(HOME, "AppData/Local/Microsoft/WinGet/Links"),
      join(HOME, "AppData/Local/Programs/codex"),
    ])
  : [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      join(HOME, "Applications/Codex.app/Contents/Resources/codex"),
      join(HOME, ".bun/bin/codex"),
      join(HOME, ".local/bin/codex"),
      join(HOME, ".npm-global/bin/codex"),
    ];

let cached: string | null = null;

/**
 * Absolute path to the codex binary, or `null` if it can't be found anywhere
 * (not installed). Honors `$CODEX_BIN` first, then PATH (`Bun.which`), then the
 * known install locations above. Result is memoized.
 */
export function resolveCodexBin(): string | null {
  if (cached) return cached;

  const envBin = process.env.CODEX_BIN;
  if (envBin && existsSync(envBin)) return (cached = envBin);

  const inPath = Bun.which("codex");
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
export function _resetCodexBinCache(): void {
  cached = null;
}

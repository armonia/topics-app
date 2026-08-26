import { existsSync } from "fs";
import { join } from "path";

/**
 * Resolve the Anthropic `claude` (Claude Code) CLI binary by absolute path.
 *
 * Claude Code installs several ways: the native installer → `~/.local/bin/claude`
 * (a shim into `~/.local/share/claude/versions/<v>`) or `~/.claude/local/claude`,
 * Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), or an npm/bun global. None of
 * these are on the bare `PATH` a launchd-spawned server (or the Tauri sidecar's
 * bundled Node) inherits, so a plain `claude` spawn ENOENTs and the claude-code
 * PTY exits instantly — a blank tab. Codex already had this exact problem and fix
 * (`codex-bin.ts`); this mirrors it so the two never disagree.
 *
 * Returns `null` when claude isn't installed ANYWHERE — the CLI is Anthropic's own
 * install and can't be bundled, so a virgin machine without it simply can't open a
 * claude-code tab (the caller falls back to the bare name, which still surfaces the
 * "command not found" plainly rather than pretending).
 */
// `$HOME` does not exist on Windows — it is `%USERPROFILE%` there. Reading only
// HOME made every candidate below collapse to a relative path like
// `.local/bin/claude`, which `existsSync` resolves against the server's cwd and
// never finds: on Windows the probe could only ever return null.
const HOME = process.env.HOME || process.env.USERPROFILE || "";

const IS_WINDOWS = process.platform === "win32";

/**
 * The names a CLI can have on this platform. On Windows an executable carries its
 * extension, and which one depends on how it was installed: the native installer
 * ships a real `.exe`, while an npm/bun global installs a `.cmd` shim. Probing the
 * bare name finds neither.
 *
 * Verified on Windows 11 on 2026-08-26: `claude` lives at
 * `%USERPROFILE%\.local\bin\claude.exe`.
 */
function names(base: string): string[] {
  return IS_WINDOWS ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base] : [base];
}

/** The install locations, expanded to every name this platform accepts. */
function candidates(base: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) for (const n of names(base)) out.push(join(dir, n));
  return out;
}

const CANDIDATES = IS_WINDOWS
  ? candidates("claude", [
      join(HOME, ".local/bin"),                          // native installer
      join(HOME, ".bun/bin"),                            // bun global
      join(process.env.APPDATA || join(HOME, "AppData/Roaming"), "npm"), // npm global
      join(HOME, "AppData/Local/Microsoft/WinGet/Links"),
    ])
  : [
      join(HOME, ".local/bin/claude"),        // native installer (modern default)
      join(HOME, ".claude/local/claude"),     // native installer (legacy location)
      "/opt/homebrew/bin/claude",             // Homebrew (Apple Silicon)
      "/usr/local/bin/claude",                // Homebrew (Intel) / manual
      join(HOME, ".bun/bin/claude"),          // bun global
      join(HOME, ".npm-global/bin/claude"),   // npm global (custom prefix)
      join(HOME, ".local/share/claude/bin/claude"),
    ];

let cached: string | null = null;

/**
 * Absolute path to the claude binary, or `null` if it can't be found anywhere.
 * Honors `$CLAUDE_BIN` first, then PATH (`Bun.which`), then the known install
 * locations above. Result is memoized.
 */
export function resolveClaudeBin(): string | null {
  if (cached) return cached;

  const envBin = process.env.CLAUDE_BIN;
  if (envBin && existsSync(envBin)) return (cached = envBin);

  const inPath = Bun.which("claude");
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
export function _resetClaudeBinCache(): void {
  cached = null;
}

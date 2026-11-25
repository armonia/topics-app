import { join } from "path";
import { HOME, WINDOWS_NPM_DIR, createBinResolver } from "./cli-bin";

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
const bin = createBinResolver({
  agentId: "claude-code",
  binary: "claude",
  envVar: "CLAUDE_BIN",
  windowsDirs: [
    join(HOME, ".local/bin"), // native installer
    join(HOME, ".bun/bin"), // bun global
    WINDOWS_NPM_DIR, // npm global
    join(HOME, "AppData/Local/Microsoft/WinGet/Links"),
  ],
  posixPaths: [
    join(HOME, ".local/bin/claude"), // native installer (modern default)
    join(HOME, ".claude/local/claude"), // native installer (legacy location)
    "/opt/homebrew/bin/claude", // Homebrew (Apple Silicon)
    "/usr/local/bin/claude", // Homebrew (Intel) / manual
    join(HOME, ".bun/bin/claude"), // bun global
    join(HOME, ".npm-global/bin/claude"), // npm global (custom prefix)
    join(HOME, ".local/share/claude/bin/claude"),
  ],
});

export const resolveClaudeBin = bin.resolve;

/** Reset the memoized path, for tests that mutate the environment. */
export const _resetClaudeBinCache = bin.resetCache;

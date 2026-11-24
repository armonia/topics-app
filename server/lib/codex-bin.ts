import { join } from "path";
import { HOME, WINDOWS_NPM_DIR, createBinResolver } from "./cli-bin";

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
const bin = createBinResolver({
  agentId: "codex",
  binary: "codex",
  envVar: "CODEX_BIN",
  windowsDirs: [
    join(HOME, ".local/bin"),
    join(HOME, ".bun/bin"),
    WINDOWS_NPM_DIR,
    join(HOME, "AppData/Local/Microsoft/WinGet/Links"),
    join(HOME, "AppData/Local/Programs/codex"),
  ],
  posixPaths: [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    join(HOME, "Applications/Codex.app/Contents/Resources/codex"),
    join(HOME, ".bun/bin/codex"),
    join(HOME, ".local/bin/codex"),
    join(HOME, ".npm-global/bin/codex"),
  ],
});

export const resolveCodexBin = bin.resolve;

/** Reset the memoized path, for tests that mutate the environment. */
export const _resetCodexBinCache = bin.resetCache;

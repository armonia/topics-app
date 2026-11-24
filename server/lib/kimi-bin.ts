import { join } from "path";
import { HOME, WINDOWS_NPM_DIR, createBinResolver } from "./cli-bin";

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
const bin = createBinResolver({
  agentId: "kimi-code",
  binary: "kimi",
  envVar: "KIMI_BIN",
  windowsDirs: [
    join(HOME, ".kimi-code/bin"),
    join(HOME, ".local/bin"),
    join(HOME, ".bun/bin"),
    WINDOWS_NPM_DIR,
  ],
  posixPaths: [
    join(HOME, ".kimi-code/bin/kimi"), // official installer, the only known location
    "/opt/homebrew/bin/kimi",
    "/usr/local/bin/kimi",
    join(HOME, ".local/bin/kimi"),
    join(HOME, ".bun/bin/kimi"),
  ],
});

export const resolveKimiBin = bin.resolve;

/** Reset the memoized path, for tests that mutate the environment. */
export const _resetKimiBinCache = bin.resetCache;

import { join } from "path";
import { HOME, WINDOWS_NPM_DIR, createBinResolver } from "./cli-bin";

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
const bin = createBinResolver({
  agentId: "muse",
  binary: "muse",
  envVar: "MUSE_BIN",
  windowsDirs: [
    join(HOME, ".local/bin"),
    join(HOME, ".bun/bin"),
    WINDOWS_NPM_DIR,
    join(HOME, "AppData/Local/Microsoft/WinGet/Links"),
    join(HOME, "AppData/Local/Programs/muse"),
  ],
  posixPaths: [
    join(HOME, ".local/bin/muse"),
    join(HOME, ".bun/bin/muse"),
    "/opt/homebrew/bin/muse",
    "/usr/local/bin/muse",
    join(HOME, ".npm-global/bin/muse"),
  ],
});

export const resolveMuseBin = bin.resolve;

/** Reset the memoized path, for tests that mutate the environment. */
export const _resetMuseBinCache = bin.resetCache;

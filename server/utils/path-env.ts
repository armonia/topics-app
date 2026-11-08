/**
 * PATH augmentation for spawned child processes.
 *
 * When the server is launched from launchd, a system tray, or any context
 * that doesn't load the user's shell rc files, `process.env.PATH` may be
 * minimal (`/usr/bin:/bin`). Spawned children inherit that minimal PATH and
 * fail to find dev tools like `bun`, installed in `~/.bun/bin`.
 *
 * `augmentPath()` returns a PATH string with the common dev tool locations
 * prepended. `augmentEnv()` returns a full env object ready to pass to
 * `Bun.spawn` / `child_process.spawn`.
 */

import { execFileSync } from "child_process";
import { userInfo } from "os";

/**
 * The user's REAL home directory, resolved from the OS account database
 * (getpwuid) rather than the $HOME env var.
 *
 * WHY: when the server — or any ancestor process that launched it — runs under a
 * sandbox that overrides $HOME to a throwaway dir (observed in the wild:
 * `/tmp/tcs-h-XXXX`), every PTY we spawn inherits that bogus HOME. `claude` then
 * reads a near-empty `~/.claude.json` *there* and shows its first-run "initial
 * config" on every window — ignoring the user's real account, settings, MCP
 * servers, and history. `os.userInfo().homedir` reads `pw_dir` for the current
 * uid and is independent of $HOME, so it returns the real home even when $HOME is
 * polluted. Cached; falls back to $HOME only if getpwuid fails.
 */
let _realHome: string | undefined;
export function realHome(): string {
  if (_realHome !== undefined) return _realHome;
  let h = "";
  try { h = userInfo().homedir || ""; } catch { /* getpwuid failed — fall back to $HOME */ }
  _realHome = h || process.env.HOME || "";
  return _realHome;
}

const HOME = realHome();

/**
 * The PATH separator, which is NOT the same everywhere: `:` on unix, `;` on
 * Windows — where `:` is also the drive letter's own punctuation (`C:\...`).
 *
 * Splitting a Windows PATH on `:` does not merely fail to split: it CUTS EVERY
 * ENTRY IN HALF at its drive letter, and joining the pieces back with `:`
 * produces one long string the OS reads as a single, nonexistent directory.
 * Measured on Windows 11 on 2026-08-26: the child's PATH came out holding
 * `C:\Users\zorah/.local/bin:...:/sbin:C:\WINDOWS\system32;...`, so
 * `C:\WINDOWS\system32` was no longer an entry of its own and `ping` — a plain
 * system command — answered "not recognized" inside a Topics terminal.
 */
const SEP = process.platform === "win32" ? ";" : ":";

// Order matters: earlier entries win. User-installed tools first, then
// homebrew (Apple Silicon + Intel), then system defaults.
//
// These are UNIX locations and only make sense there: on Windows they are four
// nonexistent directories, and `/usr/bin`-style entries in a Windows PATH are
// noise at best. The Windows list carries the places per-user installs actually
// land — and NOT the system directories, which are already in the inherited
// PATH and must not be duplicated ahead of it.
export const EXTRA_PATHS: string[] =
  process.platform === "win32"
    ? [
        `${HOME}\\.local\\bin`,
        `${HOME}\\.bun\\bin`,
        `${HOME}\\.cargo\\bin`,
        `${HOME}\\AppData\\Roaming\\npm`,
        `${HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links`,
      ]
    : [
        `${HOME}/.local/bin`,
        `${HOME}/.bun/bin`,
        `${HOME}/.cargo/bin`,
        `${HOME}/.deno/bin`,
        `${HOME}/.volta/bin`,
        `${HOME}/.npm-global/bin`,
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];

/**
 * The user's REAL interactive PATH, captured by running their login shell.
 *
 * WHY: the hardcoded EXTRA_PATHS only cover the common fixed locations. Tools
 * installed via a version manager (nvm / fnm / asdf / mise / volta shims) or any
 * custom dir live wherever the user's `.zshrc`/`.zprofile` puts them — so a
 * GUI-launched server (minimal PATH, no rc files) can't find them even though
 * the user runs them fine in Terminal. This is exactly why a Topics "Claude" tab
 * opened blank on a fresh download: `claude` was installed but not on any path we
 * knew. We ask the login shell for its `$PATH` once (cached) and merge it in.
 *
 * Sentinels bracket the value so any noise a chatty `.zshrc` prints can't corrupt
 * it. Best-effort: on timeout/error we fall back to EXTRA_PATHS only (prior
 * behavior). Runs at most once per process.
 */
let _loginShellPath: string | undefined;
export function loginShellPath(): string {
  if (_loginShellPath !== undefined) return _loginShellPath;
  let result = "";
  if (process.platform !== "win32") {
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      // -l (login) + -i (interactive) so BOTH .zprofile and .zshrc are sourced —
      // version managers usually export PATH from .zshrc (interactive only).
      const out = String(
        execFileSync(shell, ["-lic", 'printf "__TP__%s__TP__" "$PATH"'], {
          timeout: 5000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      const m = out.match(/__TP__([\s\S]*?)__TP__/);
      if (m && m[1]) result = m[1].trim();
    } catch {
      /* shell missing / slow rc / non-zero exit — keep the EXTRA_PATHS fallback */
    }
  }
  _loginShellPath = result;
  return result;
}

/**
 * Build an augmented PATH: common dev-tool locations + the user's real
 * login-shell PATH + the current process PATH. De-dups, preserving order.
 */
export function augmentPath(currentPath: string = process.env.PATH || ""): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  // `loginShellPath()` is unix-only (it asks a login shell) and returns "" on
  // Windows, so its split never contributes there — but it is still split on the
  // platform separator so the two halves can never disagree.
  for (const p of [...EXTRA_PATHS, ...loginShellPath().split(SEP), ...currentPath.split(SEP)]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  return parts.join(SEP);
}

/**
 * Return a full env object with PATH augmented, suitable for `Bun.spawn`
 * or `child_process.spawn`. Pass extra vars via the second argument.
 */
export function augmentEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v != null) merged[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v != null) merged[k] = v;
  }
  merged.PATH = augmentPath(merged.PATH);
  return merged;
}

/**
 * Wrap an argv with a pseudo-tty so the child sees `isatty(stdin) === true`.
 *
 * Many CLIs (supabase login, gh auth login, npm login, brew install in some
 * paths) refuse to run when stdin is not a TTY. `Bun.spawn` doesn't allocate
 * one, so wrapping the command via `script(1)` is the cheapest way to make
 * those commands work from a server-spawned context.
 *
 * - macOS: `script -F -q /dev/null <argv...>`  (-F flushes + propagates exit code)
 * - Linux: `script -qfc "<argv joined+escaped>" /dev/null`
 * - Other platforms: returns argv unchanged (no-op).
 *
 * Caveats:
 *   - PTY output mixes stdout+stderr into one stream and can include ANSI
 *     escapes and `\r\n` line endings — strip with `stripAnsi()` if you
 *     display the captured output verbatim.
 *   - On Linux, `script` from util-linux is required (almost always present).
 */
export function wrapPty(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  switch (process.platform) {
    case "darwin":
      return ["script", "-F", "-q", "/dev/null", ...argv];
    case "linux": {
      const quoted = argv
        .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
        .join(" ");
      return ["script", "-qfc", quoted, "/dev/null"];
    }
    default:
      return argv;
  }
}

// Le sequenze ANSI che il PTY emette. La regex CONTIENE byte di controllo
// perché è esattamente ciò che deve riconoscere: la regola serve a
// intercettarli quando finiscono in un pattern per sbaglio, qui sono il
// soggetto.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex -- vedi sopra: i byte di controllo sono il soggetto, non un refuso
  /[][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

// Non-printable control bytes the PTY/script(1) injects (BEL, BS, etc.)
// — keep TAB (0x09), LF (0x0A), and ESC (0x1B handled by ANSI_RE above).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

// BSD `script(1)` on macOS prints a literal "^D\b\b" preamble at start
// (caret-notation EOT followed by backspaces). Strip the caret-letter pair
// when it sits next to backspaces so the user sees clean output.
// eslint-disable-next-line no-control-regex
const SCRIPT_PREAMBLE_RE = /\^[A-Z](?=[\x08]+)/g;

/** Strip ANSI escape sequences, control bytes, and normalize PTY `\r\n` to `\n`. */
export function stripAnsi(input: string): string {
  return input
    .replace(SCRIPT_PREAMBLE_RE, "")
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

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

const HOME = process.env.HOME || "";

// Order matters: earlier entries win. User-installed tools first, then
// homebrew (Apple Silicon + Intel), then system defaults.
export const EXTRA_PATHS: string[] = [
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
 * Build an augmented PATH by prepending common dev tool locations to the
 * current process PATH. De-duplicates entries while preserving order.
 */
export function augmentPath(currentPath: string = process.env.PATH || ""): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [...EXTRA_PATHS, ...currentPath.split(":")]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  return parts.join(":");
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

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
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

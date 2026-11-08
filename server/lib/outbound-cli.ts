/**
 * HOW TOPICS CALLS THE TWO CLIs THAT REACH THE OUTSIDE WORLD.
 *
 * Everything in here exists because the arguments come from a MODEL. A
 * recipient, a subject and a body are attacker-shaped text by default: a card
 * quotes an email it just read, that email says "; rm -rf ~", and the sentence
 * ends up in a command line. So:
 *
 *   - ARGV, NEVER A SHELL STRING. `Bun.spawn(["gws-mail", to, subject, ...])`
 *     hands each element to the child as one `argv[n]`, quoting rules included.
 *     There is no `sh -c` anywhere in this file and there must never be one:
 *     the day a template literal builds a command, every quote in every subject
 *     line becomes a parser.
 *
 *   - THE PATH COMES FROM THE VARIABLE, AND THE LOOKUP DOES NOT TRUST `PATH`.
 *     The server runs under launchd, whose `PATH` is `/usr/bin:/bin:/usr/sbin:
 *     /sbin` — no `/usr/local/bin`, no `/opt/homebrew/bin`, which is exactly
 *     where a CLI installed by a person lives. A bare name is therefore looked
 *     up in a DECLARED list of directories; `PATH`, when it exists, is only
 *     consulted after them, so a shell-started server and a launchd-started
 *     server find the same binary.
 *
 *   - THE DEADLINE IS ON THE ANSWER. Same reasoning as `bounded-capture.ts`: a
 *     timer that fires a SIGTERM is not a deadline, because a child blocked in
 *     the kernel neither dies nor closes its pipe, and the await that follows
 *     never settles. The race is the deadline; the SIGKILL after the grace is
 *     what stops a copy of the CLI surviving every call.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OutboundConfigError } from "./outbound-config";

/**
 * Where a bare CLI name is looked for, in order.
 *
 * Declared rather than derived because the environment that matters is the one
 * with the least: under launchd `PATH` is four system directories, and the two
 * package managers people actually install with are in neither.
 */
export const CLI_SEARCH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.bun/bin",
  "~/.local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** Milliseconds between the SIGTERM at the deadline and the SIGKILL after it. */
const KILL_GRACE_MS = 250;

/** How much of a child's output is kept. Enough for an error, not for a dump. */
const MAX_OUTPUT_CHARS = 4000;

/** `~/bin/gws` is what a person writes; nothing in `node:fs` expands it. */
export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path of the CLI named by `variable`, or an error that says which
 * variable holds the bad value and what was looked for.
 *
 * `searchDirs` is a parameter so the test can point the lookup at a temporary
 * directory instead of installing a fake binary into `/usr/local/bin`.
 */
export function resolveCliPath(
  value: string,
  variable: string,
  opts: { searchDirs?: string[]; pathEnv?: string } = {},
): string {
  const wanted = expandHome(value);
  if (isAbsolute(wanted)) {
    if (!isExecutableFile(wanted)) {
      throw new OutboundConfigError(variable, `${variable} points at "${wanted}", which is not an executable file`);
    }
    return wanted;
  }
  // A name with a separator but no root ("./bin/gws") is a relative path, and a
  // relative path means "relative to whatever cwd this server happens to have".
  // That is not a location, so it is refused rather than guessed at.
  if (wanted.includes("/")) {
    throw new OutboundConfigError(
      variable,
      `${variable} is the relative path "${wanted}": write an absolute path, or the bare name of a CLI on the system`,
    );
  }
  const dirs = [
    ...(opts.searchDirs ?? CLI_SEARCH_DIRS),
    ...(opts.pathEnv ?? "").split(":").filter(Boolean),
  ];
  for (const dir of dirs) {
    const candidate = join(expandHome(dir), wanted);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new OutboundConfigError(
    variable,
    `${variable} names "${wanted}", which is not in any known directory (${dirs.join(", ")}): write the absolute path`,
  );
}

export interface CliRun {
  /** Null when the child was killed at the deadline or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `file` with `argv` as SEPARATE arguments and a MINIMAL environment.
 *
 * The child inherits nothing by default: it gets `PATH`, `HOME` and whatever
 * the caller declares. A CLI that needs a token gets it named, so reading this
 * call tells you exactly what the outside world can see.
 */
export async function runCli(opts: {
  file: string;
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}): Promise<CliRun> {
  // Kept in a helper, like `bounded-capture.ts` does: the piped-stdout TYPE of
  // the subprocess must survive a spawn that throws (a path that vanished
  // between the check and the call).
  const spawnPiped = () => {
    try {
      return Bun.spawn([opts.file, ...opts.argv], {
        stdout: "pipe",
        stderr: "pipe",
        env: opts.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const spawned = spawnPiped();
  if (typeof spawned === "string") {
    return { exitCode: null, stdout: "", stderr: spawned, timedOut: false };
  }
  const child = spawned;
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const answered = (async (): Promise<CliRun> => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return {
      exitCode: child.exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
      timedOut: false,
    };
  })();
  answered.catch(() => {});
  try {
    const deadline = new Promise<null>((resolve) => {
      killer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
        hard.unref?.();
        resolve(null);
      }, opts.timeoutMs);
      killer.unref?.();
    });
    const result = await Promise.race([answered, deadline]);
    if (result === null || timedOut) {
      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    }
    return result;
  } finally {
    clearTimeout(killer);
  }
}

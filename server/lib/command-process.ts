/**
 * THE PIECES OF A `run_command` PROCESS THAT DO NOT NEED THE REGISTRY.
 *
 * `run_command` runs an arbitrary command in the topic's project as a process
 * of Topics (`routes/processes.ts`, source `command`): the Processes panel
 * shows it, it outlives the CLI that asked for it, and when it ends the topic
 * that launched it is told (`lib/process-exit-wake.ts`). The registry keeps
 * the state; what lives here is the shape of the spawn and the two reads that
 * decide how a row closes.
 */
import { readFileSync, realpathSync, statSync } from "fs";
import { resolve } from "path";
import { isInsideDir } from "./path-containment";

/**
 * The spawn, as argv. The command runs in an INNER zsh so that an early
 * `exit` in it still leaves the outer one alive to write the code, and the
 * code goes to a file beside the log: after a server reload the process is
 * re-adopted by pid, without the handle `proc.exited` needed, and that file
 * is the only witness of how it ended.
 */
export function commandArgv(command: string, exitPath: string): string[] {
  return ["/bin/zsh", "-c", 'zsh -c "$1"; rc=$?; print -r -- $rc > "$2"; exit $rc', "_", command, exitPath];
}

/**
 * The exit code the wrapper wrote, or null when there is none: the process
 * was killed before it could write (a Stop, a SIGKILL), or it never ran.
 * Null is read as «unknown», never as success.
 */
export function readExitCode(exitPath: string): number | null {
  try {
    const raw = readFileSync(exitPath, "utf8").trim();
    return /^-?\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Where the command runs: `cwd` resolved against the project root (relative,
 * or absolute but inside it), symlinks resolved on both sides, and it has to
 * be an existing directory. Null otherwise, and the route answers 400 without
 * spawning anything: `../..` and an absolute path elsewhere are the two ways
 * out, and a symlink inside the project pointing outside is the third.
 */
export function confineCommandCwd(root: string, cwd: unknown): string | null {
  if (cwd !== undefined && cwd !== null && typeof cwd !== "string") return null;
  try {
    const realRoot = realpathSync(root);
    const target = realpathSync(resolve(realRoot, typeof cwd === "string" && cwd.trim() ? cwd.trim() : "."));
    if (!isInsideDir(target, realRoot)) return null;
    return statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

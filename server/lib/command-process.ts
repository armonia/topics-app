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
 * The drain: while another process of the leader's group lives, wait.
 *
 * The scan runs `ps` in the FOREGROUND into a file of a private directory
 * (`mkdir` is atomic, so two leaders never share it), then reads it. A plain
 * external command run in the foreground inherits the drain's ignored TERM;
 * under zsh every child the shell forks for itself does not, an async job, a
 * `( )` subshell or a `$( )`, which is why none of them appears here. The scan
 * used to be `ps > fifo &` read through a FIFO, and a Stop's TERM that
 * killed that async child between its fork and the open of the FIFO's write
 * end left the leader blocked forever in the open of the read end: deaf to
 * TERM, it never wrote the exit code and lived until the SIGKILL after the
 * grace (exit code null, about one Stop in seventy on a loaded Mac).
 *
 * Every direct child of the leader at this point is the drain's own: the
 * command was reaped by the `wait` before it, and what the command left behind
 * was reparented away. So a row whose parent is the leader is the scan itself
 * and is skipped, the leader too, and anything else in the group is a peer.
 */
function waitForGroupMembersScript(platform: NodeJS.Platform): string {
  const groupSelector = platform === "linux" ? '"-$$"' : '-g "$$"';
  return [
    "_topics_group_has_peers() {",
    '  _topics_scan_dir="${TMPDIR:-/tmp}/topics-command-group-$$"',
    '  while ! mkdir "$_topics_scan_dir" 2>/dev/null; do _topics_scan_dir="${_topics_scan_dir}x"; done',
    '  _topics_list="$_topics_scan_dir/ps"',
    `  if ps -o pid=,ppid=,pgid= ${groupSelector} > "$_topics_list" 2>/dev/null; then :; else rm -f "$_topics_list"; rmdir "$_topics_scan_dir"; return 1; fi`,
    '  _topics_found=0',
    '  while IFS=" " read -r _topics_pid _topics_ppid _topics_pgid; do',
    '    if [ "$_topics_pgid" = "$$" ] && [ "$_topics_pid" != "$$" ] && [ "$_topics_ppid" != "$$" ]; then _topics_found=1; fi',
    '  done < "$_topics_list"',
    '  rm -f "$_topics_list"',
    '  rmdir "$_topics_scan_dir"',
    '  [ "$_topics_found" -eq 1 ]',
    "}",
    "_topics_wait_for_group_members() {",
    "  while _topics_group_has_peers; do sleep 1; done",
    "}",
  ].join("\n");
}

/**
 * The command starts from a guard /bin/sh that, after its own exec, looks for
 * the stop file the registry writes before it sends SIGTERM to the group.
 *
 * The leader traps TERM (`trap ':'`) to stay alive and write the exit code. A
 * TERM that lands between that trap and the child's exec hits the handler the
 * fork inherited and is lost: the command started anyway and lived until the
 * SIGKILL after the grace. After the exec TERM is back to its default, so
 * either the TERM arrives here and kills the guard, or it came earlier and the
 * file is already there. 143 is what a shell reports for a child killed by
 * TERM. The guard is always /bin/sh: zsh would read `.zshenv` once more.
 */
const START_UNLESS_STOPPING = `/bin/sh -c 'if [ -e "$1" ]; then exit 143; fi; shift; exec "$@"' _`;

/**
 * The first step of both EXIT traps, before the drain: from here on the leader
 * ignores TERM instead of trapping it.
 *
 * A trapped TERM interrupts whatever the drain is blocked in, and each place
 * ended the leader too early: when the scan still read a FIFO, dash exited on
 * the interrupted open before the exit code was written and zsh went on without
 * a scan; an interrupted scan stops the drain and the leader leaves while a peer
 * that outlives TERM still runs, and the delayed SIGKILL, which checks the
 * leader first, no longer fires.
 *
 * Ignoring is right only here. The command has already ended, and what the
 * drain starts (mkdir, ps, rm, rmdir, sleep 1) runs in the foreground,
 * inherits the ignore and lasts a second at most. Earlier the ignore would
 * pass through exec and leave the command deaf to Stop, which is why the leader starts with `trap ':'`.
 */
const DRAIN_IGNORES_TERM = `trap "" TERM`;

/**
 * Is there a POSIX shell to run a command in? Not on Windows. The one answer
 * the three places that depend on it read: the spawn below, the bridge that
 * offers `run_command` (`toolsForProfile`) and the system prompt that sends
 * the agent to it (`topicsAgentSystemPrompt`).
 */
export function hasCommandShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * The supervisor shell keeps the group identity alive while a child shell
 * runs the command. Its EXIT trap preserves the status, drains group peers,
 * and writes the code beside the log, the only witness after a server reload.
 *
 * zsh on macOS, where it is the shell the agent's own Bash tool runs, so a
 * command behaves as it would there. `/bin/sh` on the other POSIX systems the
 * sidecar ships for: zsh is not installed by default on Linux. Null on
 * Windows, which has no POSIX shell to wrap the command in: `run_command` is
 * not offered there (`toolsForProfile`).
 */
export function commandArgv(command: string, exitPath: string, stopPath: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if (!hasCommandShell(platform)) return null;
  const shell = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const script = `${waitForGroupMembersScript(platform)}\ntrap ':' TERM; trap 'rc=$?; trap - EXIT; ${DRAIN_IGNORES_TERM}; wait; _topics_wait_for_group_members; printf "%s\\n" "$rc" > "$3"; exit "$rc"' EXIT; ${START_UNLESS_STOPPING} "$4" "$1" -c "$2"; exit "$?"`;
  return [shell, "-c", script, "_", shell, command, exitPath, stopPath];
}

/** Keep the registered group leader alive through TERM while its child command exits. */
export function commandGroupArgv(argv: string[], stopPath: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return argv;
  const shell = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  return [shell, "-c", `${waitForGroupMembersScript(platform)}\n_topics_stop=$1; shift; trap ':' TERM; trap 'trap - EXIT; ${DRAIN_IGNORES_TERM}; wait; _topics_wait_for_group_members' EXIT; ${START_UNLESS_STOPPING} "$_topics_stop" "$@"`, "_", stopPath, ...argv];
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
 * When a command found dead at boot ended. It ended while the server was down,
 * and the boot is not when: the exit file is written as it exits, and without
 * one (the machine went down with it) its log was last written when it last
 * lived. Never before its start, which is what is left when neither is there.
 */
export function endedWhileAway(exitPath: string, logPath: string, startedAt: string): string {
  const mtimeOf = (path: string) => { try { return statSync(path).mtimeMs; } catch { return null; } };
  const at = mtimeOf(exitPath) ?? mtimeOf(logPath);
  const start = Date.parse(startedAt);
  return new Date(at !== null && at > start ? at : start).toISOString();
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

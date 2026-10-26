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

function waitForGroupMembersScript(platform: NodeJS.Platform): string {
  const groupSelector = platform === "linux" ? '"-$$"' : '-g "$$"';
  return [
    "_topics_group_has_peers() {",
    '  _topics_fifo="${TMPDIR:-/tmp}/topics-command-group-$$"',
    '  while ! mkfifo "$_topics_fifo" 2>/dev/null; do _topics_fifo="${_topics_fifo}x"; done',
    `  ps -o pid=,pgid= ${groupSelector} > "$_topics_fifo" 2>/dev/null &`,
    '  _topics_scan=$!',
    '  exec 3< "$_topics_fifo"',
    '  _topics_found=0',
    '  while IFS=" " read -r _topics_pid _topics_pgid; do',
    '    if [ "$_topics_pgid" = "$$" ] && [ "$_topics_pid" != "$$" ] && [ "$_topics_pid" != "$_topics_scan" ]; then _topics_found=1; fi',
    '  done <&3',
    '  exec 3<&-',
    '  if wait "$_topics_scan"; then :; else rm -f "$_topics_fifo"; return 1; fi',
    '  rm -f "$_topics_fifo"',
    '  [ "$_topics_found" -eq 1 ]',
    "}",
    "_topics_wait_for_group_members() {",
    "  while _topics_group_has_peers; do sleep 1; done",
    "}",
  ].join("\n");
}

/**
 * Il comando parte da una /bin/sh di guardia che, dopo il proprio exec, guarda
 * il file di stop scritto dal registro prima del SIGTERM al gruppo.
 *
 * Il leader intercetta TERM (`trap ':'`) per restare vivo e scrivere il codice
 * d'uscita. Un TERM che arriva fra quel trap e l'exec del figlio cade nel trap
 * ereditato dal fork e si perde: il comando partiva lo stesso e viveva fino al
 * SIGKILL dopo la grazia. Dopo l'exec TERM è di nuovo al default, quindi o il
 * TERM arriva qui e uccide la guardia, o è arrivato prima e il file c'è già.
 * 143 è il codice di una shell il cui figlio muore di TERM. La guardia è sempre
 * /bin/sh: zsh rileggerebbe `.zshenv` una volta in più.
 */
const START_UNLESS_STOPPING = `/bin/sh -c 'if [ -e "$1" ]; then exit 143; fi; shift; exec "$@"' _`;

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
  const script = `${waitForGroupMembersScript(platform)}\ntrap ':' TERM; trap 'rc=$?; trap - EXIT; wait; _topics_wait_for_group_members; printf "%s\\n" "$rc" > "$3"; exit "$rc"' EXIT; ${START_UNLESS_STOPPING} "$4" "$1" -c "$2"; exit "$?"`;
  return [shell, "-c", script, "_", shell, command, exitPath, stopPath];
}

/** Keep the registered group leader alive through TERM while its child command exits. */
export function commandGroupArgv(argv: string[], stopPath: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return argv;
  const shell = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  return [shell, "-c", `${waitForGroupMembersScript(platform)}\n_topics_stop=$1; shift; trap ':' TERM; trap 'trap - EXIT; wait; _topics_wait_for_group_members' EXIT; ${START_UNLESS_STOPPING} "$_topics_stop" "$@"`, "_", stopPath, ...argv];
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

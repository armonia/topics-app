/**
 * WHAT TOPICS RUNS FOR AN AGENT NEVER OUTRANKS THE PERSON AT THE KEYBOARD.
 *
 * Measured 2026-09-06 14:00 on the 12-core desktop: load 47, WindowServer at
 * 73 % CPU, the owner's own app freezing between keystrokes. Five cards were
 * in flight with their sub-tasks, and every delivery ran its checks - five
 * `tsc`, an `eslint`, four unit shards, a Vite build and a Chromium for the
 * e2e gate - all at the SAME scheduling priority as the desktop. The cap "by
 * resources" (KANBAN-16 and the load/RAM thresholds) decides whether a NEW
 * agent may start; it cannot make the ones already running step aside once
 * they are there. Priority can, and it is the only lever that keeps the
 * machine usable while the fleet works: a process at nice 15 in the
 * `utility` QoS class yields the CPU to anything interactive, and the fleet
 * simply takes longer when the owner is typing. That is the deal: Topics is
 * a background worker on this machine, never a rival.
 *
 * Two doors, because processes are born in two ways:
 *   · `lowPriorityArgv` wraps an argv BEFORE the spawn: `nice -n 15` on every
 *     unix, plus `taskpolicy -c utility` on macOS, where the scheduler reads
 *     the QoS class before it reads nice. Children inherit both.
 *   · `lowerPriority` demotes a pid that already exists - the root of a PTY
 *     the bridge has just created for an agent, whose descendants (the CLI,
 *     its bun/vite/git) inherit the demotion at fork.
 *
 * Windows has neither knob in this form and is left as is. Every call is
 * best-effort: a missing binary must never stop the work it was meant to
 * throttle. @covers KANBAN-78
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, sep } from "path";

/** The nice value of everything Topics runs on an agent's behalf. */
export const AGENT_NICE = 15;

/**
 * ABSOLUTE PATHS, AND ONLY IF THEY EXIST. The server runs under launchd with
 * a PATH that has no `/usr/sbin`, so a bare `taskpolicy` in the argv made
 * every check spawn fail on 2026-09-06 15:00 ("il runner dei check non
 * riesce a spawnare processi") and a delivered card bounced to «waiting» for
 * a reason that had nothing to do with its code. A knob that is not there is
 * skipped, not searched for: the work runs at normal priority, as before.
 */
const NICE_BIN = "/usr/bin/nice";
const RENICE_BIN = "/usr/bin/renice";
const TASKPOLICY_BIN = "/usr/sbin/taskpolicy";

/** Which knobs this machine actually has (probed once; tests inject). */
export interface PriorityKnobs { nice: boolean; taskpolicy: boolean }

let probed: PriorityKnobs | null = null;
function knobs(): PriorityKnobs {
  if (!probed) probed = { nice: existsSync(NICE_BIN), taskpolicy: existsSync(TASKPOLICY_BIN) };
  return probed;
}

/** Argv that runs `argv` at agent priority on this platform. */
export function lowPriorityArgv(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  have: PriorityKnobs = knobs(),
): string[] {
  if (platform === "win32") return [...argv];
  const niced = have.nice ? [NICE_BIN, "-n", String(AGENT_NICE), ...argv] : [...argv];
  // The `utility` class: long work nobody is waiting on. `background` would
  // also throttle its disk I/O to a crawl, and an agent still has to git.
  return platform === "darwin" && have.taskpolicy ? [TASKPOLICY_BIN, "-c", "utility", ...niced] : niced;
}

/** Demote a live process (and, from now on, whatever it forks). Best-effort. */
export function lowerPriority(pid: number, platform: NodeJS.Platform = process.platform, have: PriorityKnobs = knobs()): void {
  if (!Number.isInteger(pid) || pid <= 0 || platform === "win32") return;
  const run = (cmd: string, args: string[]) => {
    try {
      spawn(cmd, args, { stdio: "ignore" }).on("error", () => { /* no such binary: the work goes on at normal priority */ });
    } catch { /* same */ }
  };
  if (existsSync(RENICE_BIN)) run(RENICE_BIN, ["-n", String(AGENT_NICE), "-p", String(pid)]);
  if (platform === "darwin" && have.taskpolicy) run(TASKPOLICY_BIN, ["-c", "utility", "-p", String(pid)]);
}

/**
 * Is this PTY an agent's, not the owner's own terminal?
 *
 * Three signs, any one enough: a sub-agent has a parent session; a dispatched
 * card works in a worktree the board carved under `~/.topics/worktrees/`; a
 * Claude Code subagent or workflow works under `<repo>/.claude/worktrees/`.
 * The owner's shells in the repo itself keep their normal priority - those
 * are the ones a person is waiting on.
 */
export function isAgentWorkspace(cwd: string, parentSessionKey: string | undefined, home: string): boolean {
  if (parentSessionKey) return true;
  const norm = cwd.endsWith(sep) ? cwd : cwd + sep;
  const dispatcherRoot = join(home, ".topics", "worktrees") + sep;
  return norm.startsWith(dispatcherRoot) || norm.includes(`${sep}.claude${sep}worktrees${sep}`);
}

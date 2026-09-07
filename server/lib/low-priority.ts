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
 * every check spawn fail on 2026-09-06 15:00 (Bun: "Executable not found in
 * $PATH") and a delivered card bounced to waiting for a reason that had
 * nothing to do with its code. A knob that is not there is skipped, not
 * searched for: the work runs at normal priority, as before.
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

/** How a knob is actually invoked. Injected by the tests, spawn in production. */
export type RunKnob = (cmd: string, args: string[]) => void;

const spawnKnob: RunKnob = (cmd, args) => {
  try {
    spawn(cmd, args, { stdio: "ignore" }).on("error", () => { /* no such binary: the work goes on at normal priority */ });
  } catch { /* same */ }
};

/** Demote a live process (and, from now on, whatever it forks). Best-effort. */
export function lowerPriority(pid: number, platform: NodeJS.Platform = process.platform, have: PriorityKnobs = knobs()): void {
  if (!Number.isInteger(pid) || pid <= 0 || platform === "win32") return;
  const run = spawnKnob;
  if (existsSync(RENICE_BIN)) run(RENICE_BIN, ["-n", String(AGENT_NICE), "-p", String(pid)]);
  if (platform === "darwin" && have.taskpolicy) run(TASKPOLICY_BIN, ["-c", "utility", "-p", String(pid)]);
}

/**
 * THE THIRD DOOR: A PROCESS WE DID NOT SPAWN FOR ONE PERSON IN PARTICULAR.
 *
 * The headless Chromium of the browser tools is ONE for the whole server
 * (single-flight in `ensureBrowser`): the agents drive it, and so do the
 * browser panes of a web/mobile client. `nice` is the wrong knob for it -
 * on macOS a process cannot LOWER its own nice value again without root, so
 * a demotion would still be there when a person opens a pane. The QoS class
 * can be toggled both ways by anyone: `taskpolicy -b` puts a pid in the
 * background band (the scheduler reads the class before the nice value),
 * `-B` takes it back out. Measured 2026-09-07: a `bash` at nice 15 goes from
 * PRI 20 to PRI 4 on `-b` and back to 20 on `-B`.
 *
 * Linux has no such toggle here: `renice +15` is one-way for a non-root
 * process, so `on` demotes and `off` deliberately does NOTHING rather than
 * pretend. A Linux browser stays demoted until it is relaunched, which is
 * cheap (the idle reaper closes it after minutes of no context anyway).
 */
export function setBackground(
  pid: number,
  on: boolean,
  platform: NodeJS.Platform = process.platform,
  have: PriorityKnobs = knobs(),
  run: RunKnob = spawnKnob,
): void {
  if (!Number.isInteger(pid) || pid <= 0 || platform === "win32") return;
  if (platform === "darwin") {
    if (have.taskpolicy) run(TASKPOLICY_BIN, [on ? "-b" : "-B", "-p", String(pid)]);
    return;
  }
  // Linux and the rest: demotion only, and only downwards.
  if (on && existsSync(RENICE_BIN)) run(RENICE_BIN, ["-n", String(AGENT_NICE), "-p", String(pid)]);
}

/** Where the children of a pid come from, and what is done to each one. */
export interface BackgroundTreeDeps {
  listChildren: (pid: number) => Promise<number[]>;
  apply: (pid: number, on: boolean) => void;
}

const PGREP_BIN = "/usr/bin/pgrep";

/** The direct children of `pid`, best-effort: an empty list on any failure. */
function pgrepChildren(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    if (!existsSync(PGREP_BIN)) return resolve([]);
    let out = "";
    try {
      const p = spawn(PGREP_BIN, ["-P", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout?.on("data", (chunk) => { out += String(chunk); });
      p.on("error", () => resolve([]));
      p.on("close", () => resolve(
        out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0),
      ));
    } catch { resolve([]); }
  });
}

/**
 * The toggle on a pid AND on every descendant alive right now.
 *
 * A child born after the toggle inherits it; a child already running does
 * NOT - measured, see `setBackground`. Chromium keeps its renderers, its GPU
 * process and its network service in separate processes, and those are
 * exactly the ones burning the CPU, so the walk down is the whole point.
 * Returns the pids it touched, for the transition log line.
 */
export async function setBackgroundTree(
  pid: number,
  on: boolean,
  deps: BackgroundTreeDeps = { listChildren: pgrepChildren, apply: (p, o) => setBackground(p, o) },
): Promise<number[]> {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    deps.apply(current, on);
    try { queue.push(...(await deps.listChildren(current))); } catch { /* a tree we cannot read is a tree we stop walking */ }
  }
  return [...seen];
}

/** One live browser context, as much as the server knows about who opened it. */
export interface BrowserContextOwner {
  contextId: string;
  /** The chat/terminal session that opened it, when known. */
  sessionKey?: string;
  /** That session's working directory, when known. */
  workspace?: string;
  /** How many people are streaming this context right now. */
  watchers?: number;
}

/** The same agent/person criterion the CLI governor uses, injected. */
export interface AgentOwnerTest {
  isDispatched: (sessionKey: string) => boolean;
  isAgentCwd: (workspace: string) => boolean;
}

/**
 * May the shared Chromium go to the background right now? Pure.
 *
 * ONE person is enough to say no, because there is ONE browser: a pane a
 * human is looking at must not stutter because six cards are scraping. With
 * no context at all the answer is yes - nobody is waiting on it, and the
 * next context flips it back before its first paint. An owner nobody can
 * name counts as a person's: mis-slowing a person is worse than
 * mis-sparing an agent.
 */
export function browserShouldBeBackground(
  owners: readonly BrowserContextOwner[],
  test: AgentOwnerTest,
): boolean {
  return owners.every((owner) => {
    if ((owner.watchers ?? 0) > 0) return false;
    if (owner.sessionKey && test.isDispatched(owner.sessionKey)) return true;
    if (owner.workspace && test.isAgentCwd(owner.workspace)) return true;
    return false;
  });
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

/**
 * WHICH PROCESSES OF AN AGENT CAN BE PAUSED, AND WHICH ONE OF THEM WOULD STOP
 * TOPICS ITSELF.
 *
 * Everything here is pure over one `ps` table, because getting it wrong is not a
 * bug with a stack trace: a group signal sent one pid too far stops the server
 * that would have to continue it, and launchd sees a process that is still alive
 * and never restarts it. Measured on this Mac on 15-16/09/2026:
 *
 *   shape                          parent   group of the command
 *   Claude Code Bash tool          the CLI  ITS OWN (`Ss`, pgid == pid)
 *   MCP server, LSP, caffeinate    the CLI  the CLI's own group (shared)
 *   native runtime `bash` tool     server   THE SERVER'S (981, with start-prod.sh)
 *
 * So the native runtime - 702 of 1808 topics carry `provider = 'topics'`, plus
 * 1003 on the default runtime - is not a corner case: a group signal to the root
 * of a native command stops the server. `allowedGroups` is what makes that
 * impossible by construction, and `guardSet` is the list it checks against.
 *
 * A ROOT IS NEVER GUESSED. A Claude Code background shell is a root only when
 * its command was recorded from the CLI's own `PreToolUse` payload with
 * `run_in_background: true`; a foreground command is named as such and never
 * frozen (its CLI kills it on a wall clock that keeps running while it is
 * stopped, so freezing it is a kill with extra steps); anything else is
 * `unrecognised` and gets a log line, never a signal.
 */

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Accumulated CPU time in seconds, from `ps -o time=`. */
  cpuSeconds: number;
  command: string;
}

/** One `Bash(run_in_background: true)` the CLI announced through its hook. */
export interface BackgroundBashRecord {
  command: string;
  startedAt: number;
}

/** A live agent session with a CLI of its own. */
export interface AgentSessionRef {
  sessionKey: string;
  cliPid: number;
  topicId: string | null;
  terminalId: string | null;
  taskId: string | null;
  backgroundBash: readonly BackgroundBashRecord[];
  /** The command of the Bash tool running in the FOREGROUND right now, if any. */
  foregroundBash: string | null;
}

/** A command the native runtime started for a session, registered by `runCommand`. */
export interface NativeCommandRef {
  sessionKey: string;
  pid: number;
  command: string;
  topicId: string | null;
  terminalId: string | null;
  taskId: string | null;
}

export type ToolRootKind = "claude-background" | "native";

export interface ToolRoot {
  kind: ToolRootKind;
  pid: number;
  pgid: number;
  sessionKey: string;
  command: string;
  topicId: string | null;
  terminalId: string | null;
  taskId: string | null;
}

export interface ToolRootsResult {
  roots: ToolRoot[];
  /** Claude Code commands running in the foreground: named, never frozen. */
  foreground: { pid: number; sessionKey: string; command: string }[];
  /** A child of a CLI nobody can account for: logged once, never signalled. */
  unrecognised: { pid: number; sessionKey: string; command: string }[];
}

/**
 * A tree holding one of these is never frozen: a CLI paused mid-stream may lose
 * its connection, and how long it survives has never been measured.
 */
export const AGENT_CLI_NAMES: ReadonlySet<string> = new Set([
  "claude", "codex", "jcode", "opencode", "kimi",
]);

/** `ps -axo pid=,ppid=,pgid=,time=,command= -ww`, one row per line. */
export function parseProcessTable(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    out.push({
      pid: +m[1]!, ppid: +m[2]!, pgid: +m[3]!,
      cpuSeconds: parseCpuTime(m[4]!), command: m[5]!,
    });
  }
  return out;
}

/** `12:34.56`, `0:01.58`, `1-02:03:04`: seconds, or 0 when it will not parse. */
export function parseCpuTime(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") as [string, string] : ["0", text];
  const parts = rest.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return Number(days) * 86_400 + seconds;
}

/** The command as it is matched against a recorded one: one line, single spaces. */
export function normalizeCommandLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function commandNameOf(command: string): string {
  const argv0 = normalizeCommandLine(command).split(" ")[0] ?? "";
  return argv0.slice(argv0.lastIndexOf("/") + 1);
}

/** Children by ppid, one pass over the table. */
function childIndex(rows: readonly PsRow[]): Map<number, PsRow[]> {
  const byPpid = new Map<number, PsRow[]>();
  for (const r of rows) {
    const siblings = byPpid.get(r.ppid);
    if (siblings) siblings.push(r); else byPpid.set(r.ppid, [r]);
  }
  return byPpid;
}

/** `pid` and every descendant of it in this table. */
export function descendantPids(rows: readonly PsRow[], pid: number): Set<number> {
  const byPpid = childIndex(rows);
  const out = new Set<number>([pid]);
  const stack = [pid];
  while (stack.length) {
    for (const child of byPpid.get(stack.pop()!) ?? []) {
      if (out.has(child.pid)) continue;
      out.add(child.pid);
      stack.push(child.pid);
    }
  }
  return out;
}

/** The pid of an agent CLI inside this tree, when there is one: the tree is then out. */
export function containsAgentCli(rows: readonly PsRow[], tree: ReadonlySet<number>): number | null {
  for (const r of rows) {
    if (!tree.has(r.pid)) continue;
    if (AGENT_CLI_NAMES.has(commandNameOf(r.command))) return r.pid;
  }
  return null;
}

export interface GuardRoles {
  /** `process.pid`: the server itself. */
  serverPid: number;
  /** ai-bridge, pty bridge, webrtc sidecar (`resolveFleetRoots`). */
  sidecarPids: readonly number[];
  /** Every agent CLI alive (`listSessionCliPids` + the `ptyPid` of each agent PTY). */
  cliPids: readonly number[];
  /**
   * The roots the NATIVE runtime registered. They are children of the server and
   * share its process group, so the "everything in the server's group" rule would
   * guard the very commands this exists to freeze. They are named here, and their
   * trees are the one exception to it - which is also why a group signal is never
   * allowed for them (`allowedGroups`: group 981 holds the server).
   */
  nativeRootPids?: readonly number[];
}

/**
 * THE PIDS NO SIGNAL MAY EVER REACH, built from the same table the freeze uses.
 *
 * The server and every member of its process group (a stopped server cannot thaw
 * anything); the sidecars and their trees; every agent CLI; every child of a CLI
 * that is NOT its own group leader, which is the measured shape of an MCP server,
 * an LSP and a `caffeinate` (a frozen MCP server hangs every tool call of the
 * session, and an agent's own tool shell is always a group leader); pid 1.
 */
export function guardSet(rows: readonly PsRow[], roles: GuardRoles): Set<number> {
  const guard = new Set<number>([1, roles.serverPid]);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const nativeTrees = new Set<number>();
  for (const pid of roles.nativeRootPids ?? []) for (const p of descendantPids(rows, pid)) nativeTrees.add(p);
  nativeTrees.delete(roles.serverPid);
  const serverGroup = byPid.get(roles.serverPid)?.pgid;
  if (serverGroup != null) for (const r of rows) if (r.pgid === serverGroup && !nativeTrees.has(r.pid)) guard.add(r.pid);
  for (const pid of roles.sidecarPids) for (const p of descendantPids(rows, pid)) guard.add(p);
  const cliPids = new Set(roles.cliPids);
  for (const pid of cliPids) guard.add(pid);
  for (const r of rows) {
    if (cliPids.has(r.pgid)) guard.add(r.pid);
    if (cliPids.has(r.ppid) && r.pgid !== r.pid) guard.add(r.pid);
  }
  return guard;
}

/** Every pid sharing a process group id. */
export function groupMembers(rows: readonly PsRow[], pgid: number): number[] {
  return rows.filter((r) => r.pgid === pgid).map((r) => r.pid);
}

/**
 * The groups that may be signalled as groups: led by a member of the tree, and
 * with no guarded pid among their members. For a native root this is always
 * empty - its group is the server's - so a native tree is signalled pid by pid.
 */
export function allowedGroups(
  rows: readonly PsRow[],
  tree: ReadonlySet<number>,
  guard: ReadonlySet<number>,
): { pgid: number; members: number[] }[] {
  const out: { pgid: number; members: number[] }[] = [];
  for (const r of rows) {
    if (!tree.has(r.pid) || r.pgid !== r.pid) continue;
    const members = groupMembers(rows, r.pgid);
    if (members.some((m) => guard.has(m))) continue;
    out.push({ pgid: r.pgid, members });
  }
  return out;
}

/**
 * The roots an agent's tools started, with the two shapes told apart by evidence
 * and never by guessing. A Claude Code child counts only when its `eval` text
 * contains a command the CLI announced as background; the same text matching the
 * foreground command in flight makes it `foreground` (named, never frozen).
 */
export function toolRoots(i: {
  rows: readonly PsRow[];
  sessions: readonly AgentSessionRef[];
  natives: readonly NativeCommandRef[];
}): ToolRootsResult {
  const result: ToolRootsResult = { roots: [], foreground: [], unrecognised: [] };
  const byPpid = childIndex(i.rows);
  for (const s of i.sessions) {
    const background = s.backgroundBash.map((b) => normalizeCommandLine(b.command)).filter((c) => c.length >= 3);
    const foreground = s.foregroundBash ? normalizeCommandLine(s.foregroundBash) : null;
    for (const child of byPpid.get(s.cliPid) ?? []) {
      // An MCP server, an LSP, a `caffeinate`: the CLI's own group, not a
      // command of a tool call. They are in the guard set, never here.
      if (child.pgid !== child.pid) continue;
      const text = normalizeCommandLine(child.command);
      if (foreground && foreground.length >= 3 && text.includes(foreground)) {
        result.foreground.push({ pid: child.pid, sessionKey: s.sessionKey, command: s.foregroundBash! });
        continue;
      }
      const hit = background.find((c) => text.includes(c));
      if (!hit) {
        result.unrecognised.push({ pid: child.pid, sessionKey: s.sessionKey, command: text.slice(0, 120) });
        continue;
      }
      result.roots.push({
        kind: "claude-background", pid: child.pid, pgid: child.pgid, sessionKey: s.sessionKey,
        command: hit, topicId: s.topicId, terminalId: s.terminalId, taskId: s.taskId,
      });
    }
  }
  for (const n of i.natives) {
    const row = i.rows.find((r) => r.pid === n.pid);
    if (!row) continue;
    result.roots.push({
      kind: "native", pid: n.pid, pgid: row.pgid, sessionKey: n.sessionKey,
      command: normalizeCommandLine(n.command), topicId: n.topicId, terminalId: n.terminalId, taskId: n.taskId,
    });
  }
  return result;
}

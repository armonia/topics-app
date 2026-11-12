import { openSync, closeSync } from "fs";
import type { AppContext } from "../types";
import { augmentEnv } from "../utils/path-env";
import { killProcessTree } from "../lib/process-tree";
import { getDescendantPids } from "../lib/process-tree";
import { commandArgv, endedWhileAway, readExitCode } from "../lib/command-process";
import { captureProcessGroup, closeCommandProcessGroup, commandProcessGroupStopPath, commandProcessGroup, forgetCommandProcessGroupIfGone, processGroupAlive, processGroupIdentityMatches, registerCommandProcessGroup, type ProcessGroupIdentity } from "../lib/command-process-groups";
import { cardIdForTopic, configureCommandGroupLifecycle, createCommandGroupHooks } from "./command-process-lifecycle";
import { closeRegistryRun } from "../lib/command-runs";
import { requestProcessExitWake, wakeDelivered, wakeOwedAtExit, WAKE_TAIL_LINES } from "../lib/process-exit-wake";
import { isWatchedBySession } from "../lib/process-wait";
import { agentBaseEnv } from "../lib/agent-env";
import { applyJobQuota } from "../services/agent-job-quota";
import { commandLabel, commandWorkOver, pushBackgroundChanged } from "../lib/command-background";
import { commandProcessesOf, serviceWatch, servicesOver, SERVICE_END_SHOWN_MS, SERVICE_WATCH_MIN_MS, type ServiceRowLike } from "../lib/command-services";
import { getListeningPorts, listenersOf, servesHtml } from "../lib/listening-ports";
import { isPidAlive } from "../lib/pid-liveness";
import { topicIdOfSubject } from "../../shared/attention";
import { addToRecent, endFollow, followLog, followOf, lastLineOf, pumpTail, startFollow } from "./processes-output";
import { exitPathOf, loadProcessRegistry, logPathOf, pidStartTime, saveState } from "./processes-persist";
import { broadcastScriptsUpdate } from "./processes-snapshot";
import { type ScriptProcess, isPersonRun, recentScripts, runningScripts, _broadcastCtx } from "./processes-state";

/**
 * THE ONE WAY A COMMAND'S ROW CLOSES: its exit (`proc.exited`), the pid gone
 * after a re-adoption (`pollPidExit`), found dead at boot, or a Stop on a
 * process that was already gone. The outcome is read, never assumed: the exit
 * file the wrapper wrote, «stopped» after a Stop, and neither means unknown,
 * never «done».
 */
export function finishCommand(sp: ScriptProcess, how: { foundDead?: boolean } = {}): void {
  const cmd = sp.cmd;
  if (!cmd || sp.status !== "running") return;
  if ((cmd.closing && !cmd.stopped) || cmd.stopFailed) return;
  pumpTail(sp); // the last lines it wrote before exiting
  sp.tail = undefined;
  endFollow(sp);
  const code = readExitCode(exitPathOf(sp.processId));
  if (cmd.stopped) { sp.status = "error"; sp.exitCode = -1; }
  else if (code === null) { sp.status = "error"; sp.exitCode = undefined; }
  else { sp.status = code === 0 ? "done" : "error"; sp.exitCode = code; }
  // Found dead at boot it ended while the server was down: the boot is not when.
  sp.completedAt = how.foundDead ? endedWhileAway(exitPathOf(sp.processId), logPathOf(sp.processId), sp.startedAt) : new Date().toISOString();
  sp.proc = null;
  runningScripts.delete(sp.processId);
  addToRecent(sp);
  cmd.wake = wakeOwedAtExit({
    wake: cmd.wake, topicId: cmd.topicId, stopped: !!cmd.stopped,
    watchedBySession: isWatchedBySession(sp.processId, cmd.sessionKey),
  });
  saveState();
  if (_broadcastCtx) { broadcastScriptsUpdate(_broadcastCtx); pushBackgroundChanged(_broadcastCtx, cmd); }
  // An ended server keeps its addresses while the chat says how it ended, then they go.
  if (commandServiceWatch.listenOf(sp.processId)) setTimeout(() => commandServiceWatch.forget(sp.processId), SERVICE_END_SHOWN_MS * 2).unref?.();
  if (cmd.wake) requestWakeFor(sp);
  if (cmd.origin === "person") settlePersonRun(sp);
  forgetCommandProcessGroupIfGone(sp.processId);
}

/** A person's run ended: its row in `command_runs` closes (`closeRegistryRun`), once the router has a database. */
export function settlePersonRun(sp: ScriptProcess): void {
  if (_broadcastCtx && sp.status !== "running" && sp.cmd) closeRegistryRun(_broadcastCtx, { ...sp, stopped: !!sp.cmd.stopped });
}
/**
 * The rows that can be a chat's server, watched for their ports: every
 * `run_command` and an agent's `run_script` (BGVIS-08), and a chat's background
 * Bash (BGVIS-09). The last two read as a command that wakes nobody.
 */
function* serviceRows(rows: Iterable<ScriptProcess>): Generator<ServiceRowLike> {
  for (const sp of rows) {
    if (sp.cmd) yield sp;
    else if (sp.agentRun) yield { ...sp, cmd: { ...sp.agentRun, wake: false } };
    else if (sp.shell?.topicId) {
      const { sessionKey, topicId, stopped } = sp.shell;
      yield { ...sp, cmd: { sessionKey, topicId, wake: false, ...(stopped ? { stopped } : {}) } };
    }
  }
}
export const commandServiceWatch = serviceWatch({
  rows: () => serviceRows(runningScripts.values()),
  listenersOf: async (pids) => listenersOf(pids, await getListeningPorts(SERVICE_WATCH_MIN_MS / 2), getDescendantPids),
  alive: isPidAlive,
  onChange: (row) => { if (_broadcastCtx && row.cmd) { broadcastScriptsUpdate(_broadcastCtx); pushBackgroundChanged(_broadcastCtx, row.cmd); } },
  servesHtml,
});
export const commandBackgroundWork = commandWorkOver(() => (loadProcessRegistry(), runningScripts.values()), commandServiceWatch.listenOf); // the chat's background line (BGVIS-07)
/** Every chat's servers, running or just ended: the `services` of `GET /api/topics/streaming`. */
export const commandServices = () => (loadProcessRegistry(), servicesOver(serviceRows(runningScripts.values()), serviceRows(recentScripts), commandServiceWatch.listenOf, Date.now()));
/** A chat's `run_command` processes, for `GET /api/processes`. */
export const topicCommandProcesses = (topicId: string) => (loadProcessRegistry(), commandProcessesOf([...runningScripts.values(), ...recentScripts], topicId, commandServiceWatch.listenOf));
/**
 * A chat's processes at work now, for the strip under the chat (chat-live-work):
 * its `run_command`s and the `run_script`s its agent started, with the line each
 * prints and a server's addresses. A person's Run has its own card in the chat.
 */
export const liveCommandsOf = (topicId: string) => (loadProcessRegistry(), [...runningScripts.values()]
  .filter((sp) => sp.status === "running" && !isPersonRun(sp) && (sp.cmd?.topicId ?? sp.agentRun?.topicId) === topicId)
  .map((sp) => ({
    processId: sp.processId, name: sp.scriptName, command: sp.command, startedAt: sp.startedAt,
    lastLine: lastLineOf(sp), listen: commandServiceWatch.listenOf(sp.processId) ?? [], wakes: !!sp.cmd?.wake,
  })));

/**
 * Is this task of the attention subject a chat's server now (BGVIS-09): its
 * shell runs and its tree listens. The CLI's id links them: the `ID:` its Bash
 * answers with (the shell row's `shellId`) is the hook's `backgroundTaskId` and
 * the `task_id` keying the chat's task map (`claude-cli-2.1.282-background-work.ndjson`).
 * Shells are never persisted: a registry not yet loaded holds none.
 */
export function isChatServerTask(subject: string, taskId: string): boolean {
  const topicId = topicIdOfSubject(subject);
  if (!topicId) return false;
  for (const sp of runningScripts.values()) {
    if (sp.shell?.topicId === topicId && sp.shell.shellId === taskId) return sp.status === "running" && !!commandServiceWatch.listenOf(sp.processId)?.length;
  }
  return false;
}

/**
 * Where a session stands with the wakes its commands owe it: `running` while a
 * command that will wake it still runs, `wake-queued` once one has ended, from
 * then until the turn its row opens is over, `none` otherwise. A wake the route
 * refused for good waits for the next boot and counts as nothing: counted as
 * queued, it held a goal on a wake that could not come before a restart.
 * `ownWake`: the process whose wake opened the turn now ending, which that
 * turn's end must not wait for (`routes/chat.ts`).
 *
 * The goal loop and the board dispatcher read it beside the CLI's own
 * background work (`backgroundOfTurn`): an agent sent to `run_command` for a
 * long wait ends its turn on it, and a goal that counted it as nothing judged
 * that turn, nudged over the running command, and paused as stalled before
 * the wake came; a card spent an attempt and was parked.
 */
export type CommandWakeState = "running" | "wake-queued" | "none";
export function commandWakeState(sessionKey: string, ownWake?: string): CommandWakeState {
  loadProcessRegistry();
  for (const sp of runningScripts.values()) if (sp.cmd?.wake && sp.cmd.sessionKey === sessionKey) return "running";
  return recentScripts.some((sp) => sp.cmd?.wake && !sp.wakeFailed && sp.cmd.sessionKey === sessionKey && sp.processId !== ownWake)
    ? "wake-queued" : "none";
}

/**
 * Stop a `run_command`. Marked first, so whichever road sees the exit closes
 * it as stopped and wakes nobody. The group too: late forks are in it, not in
 * the descendants snapshot. `proc.exited` (or `pollPidExit`) closes the row.
 */
export function stopCommand(sp: ScriptProcess): void {
  if (!sp.cmd) return;
  const group = commandProcessGroup(sp.processId);
  if (group) {
    void closeCommandProcessGroup(group, commandGroupHooks);
    return;
  }
  sp.cmd.stopped = true;
  sp.cmd.wake = false;
  saveState();
  if (!sp.pid || !isPidAlive(sp.pid)) finishCommand(sp);
  else void killProcessTree(sp.pid, 5000, { group: true });
}

function processForGroup(processId: string): ScriptProcess | undefined {
  return runningScripts.get(processId) || recentScripts.find((sp) => sp.processId === processId);
}

function publishGroupChange(sp: ScriptProcess): void {
  saveState();
  if (_broadcastCtx) {
    broadcastScriptsUpdate(_broadcastCtx);
    if (sp.cmd) pushBackgroundChanged(_broadcastCtx, sp.cmd);
    else if (sp.agentRun) pushBackgroundChanged(_broadcastCtx, sp.agentRun);
  }
}

export const commandGroupHooks = createCommandGroupHooks<ScriptProcess>({
  find: processForGroup,
  publish: publishGroupChange,
  finishCommand,
  finishOther(sp) {
    sp.proc = null;
    runningScripts.delete(sp.processId);
    addToRecent(sp);
  },
});
configureCommandGroupLifecycle(commandGroupHooks, loadProcessRegistry);

/**
 * A stopped sub-agent's chat: the commands it left running that would wake it
 * are stopped with it. A wake of one already over is refused at delivery
 * (`wakeVerdict`). Returns how many it stopped.
 */
export function stopCommandWakesOf(sessionKey: string): number {
  loadProcessRegistry();
  let stopped = 0;
  for (const sp of [...runningScripts.values()]) {
    if (sp.cmd?.wake && sp.cmd.sessionKey === sessionKey) { stopCommand(sp); stopped++; }
  }
  return stopped;
}

/** Every session a command still owes a wake: the goals that wait again after a restart. */
export function sessionsAwaitingCommandWake(): string[] {
  loadProcessRegistry();
  const keys = new Set<string>();
  for (const sp of [...runningScripts.values(), ...recentScripts]) if (sp.cmd?.wake && !sp.wakeFailed) keys.add(sp.cmd.sessionKey);
  return [...keys];
}

/** Hand a finished command's wake to `process-exit-wake.ts`. */
export function requestWakeFor(sp: ScriptProcess): void {
  const cmd = sp.cmd;
  if (!cmd?.topicId) return;
  const ended = sp.completedAt ? Date.parse(sp.completedAt) : Date.now();
  requestProcessExitWake({
    processId: sp.processId,
    topicId: cmd.topicId,
    label: sp.scriptName,
    exitCode: sp.exitCode ?? null,
    durationMs: ended - Date.parse(sp.startedAt),
    lines: sp.output.slice(-WAKE_TAIL_LINES),
    settle: () => { cmd.wake = false; saveState(); },
    owed: () => cmd.wake,
    fail: () => { sp.wakeFailed = true; },
  });
}

/**
 * A live turn of the session that owns the command read its end: a
 * `wait_for_process` answer ('exit', or a 'match' on the last lines) or a
 * `read_process_output` that says done, with the status and the code. It
 * ended while no wait was open, so `finishCommand` left the wake owed, and
 * after the turn a second turn opened on an outcome the agent already had.
 * The caller has checked both: the turn is live, and its answer carried the
 * end. Settled only while the wake's row has not gone out: once the wake's own
 * turn runs, it settles at that turn's end (`ProcessExitRequest.settle`).
 */
export function settleWakeReadInTurn(sp: ScriptProcess, sessionKey: string, db: AppContext["db"]): void {
  const cmd = sp.cmd;
  if (!cmd?.wake || cmd.sessionKey !== sessionKey) return;
  if (wakeDelivered(db, sessionKey, sp.processId)) return;
  cmd.wake = false;
  saveState();
}

/**
 * `run_command`: an arbitrary command, spawned by the server (so a restart of
 * the CLI does not touch it) in its own process group (so Stop reaches every
 * child), with its output going straight into its log file (so a reload of
 * the server does not lose it).
 */
export function startCommandProcess(o: {
  projectPath: string; cwd: string; command: string; description?: unknown;
  sessionKey: string; topicId: string | null; wake: boolean; db: AppContext["db"];
  origin?: "person";
}): { processId: string; scriptName: string; pid: number | null; startedAt: string; wake: boolean } | null {
  const processId = crypto.randomUUID();
  const argv = commandArgv(o.command, exitPathOf(processId), commandProcessGroupStopPath(processId));
  if (!argv) return null; // no POSIX shell here (Windows)
  // The environment of the agent's own Bash, not the server's: its secrets
  // would reach the log, the panel and the wake row (`lib/agent-env.ts`).
  // Colours off for the agent, whose output goes to a model; on for a person,
  // whose output is drawn under the block with its colours.
  const env = augmentEnv(agentBaseEnv(), o.origin === "person"
    ? { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" }
    : { FORCE_COLOR: "0", NO_COLOR: "1" });
  if (o.origin === "person") delete env.NO_COLOR;
  // And the core quota that Bash gets when the session is a board card's
  // (`providers/claude-code.ts`): the board sends its builds, tests and
  // installs here. A chat's session gets none, and `env` stays as it is.
  applyJobQuota(o.db, o.sessionKey, env);
  // Before the start: an appending command's file is measured before it writes.
  const stdoutFile = followOf(o.command, o.cwd);
  const logPath = logPathOf(processId);
  const fd = openSync(logPath, "a");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: o.cwd, stdin: "ignore", stdout: fd, stderr: fd, detached: true, env });
  } finally {
    closeSync(fd);
  }
  const startedAt = new Date().toISOString();
  let groupIdentity: ProcessGroupIdentity | null;
  try { groupIdentity = captureProcessGroup(proc.pid); }
  catch (error) { try { proc.kill("SIGKILL"); } catch { /* the leader may already be dead; the original error is rethrown */ } throw error; }
  if (groupIdentity) {
    try {
      registerCommandProcessGroup({
        processId, ownerKey: o.sessionKey, cardId: cardIdForTopic(o.db, o.topicId), topicId: o.topicId,
        pgid: groupIdentity.pgid, leaderPid: groupIdentity.pid,
        leaderStartTime: groupIdentity.startTime, startedAt,
      });
    } catch (error) {
      if (processGroupIdentityMatches(groupIdentity) && processGroupAlive(groupIdentity.pgid)) {
        try { process.kill(-groupIdentity.pgid, "SIGKILL"); } catch { /* the group may already be gone; the original error is rethrown */ }
      }
      throw error;
    }
  }
  const sp: ScriptProcess = {
    processId, scriptName: commandLabel(o.command, o.description), command: o.command, projectPath: o.projectPath,
    status: "running", pid: proc.pid, pidLstart: pidStartTime(proc.pid), startedAt,
    output: [], outputBytes: 0, proc, source: "command",
    cmd: { sessionKey: o.sessionKey, topicId: o.topicId, wake: o.wake && !!o.topicId, ...(o.origin ? { origin: o.origin } : {}), ...stdoutFile },
  };
  runningScripts.set(processId, sp);
  followLog(sp, logPath, 0);
  startFollow(sp);
  saveState();
  if (_broadcastCtx) { broadcastScriptsUpdate(_broadcastCtx); pushBackgroundChanged(_broadcastCtx, sp.cmd!); }
  if (!sp.cmd!.wake) commandServiceWatch.kick(); // it may be a server: its port comes a moment later
  void proc.exited.then(() => finishCommand(sp));
  // `wake` as it will be honoured: a terminal's session has no topic to wake.
  return { processId, scriptName: sp.scriptName, pid: proc.pid, startedAt: sp.startedAt, wake: sp.cmd!.wake };
}

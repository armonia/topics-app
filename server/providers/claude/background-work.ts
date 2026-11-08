/**
 * THE WORK A CLOSED TURN LEAVES RUNNING.
 *
 * A turn that launched an Agent with `run_in_background`, a background Bash, a
 * Monitor or a Workflow ends with its `result` while that work goes on. The CLI
 * keeps the child alive, keeps printing the work's lines on the same stdout
 * (subagent lines with `parent_tool_use_id`, `system/task_*`,
 * `system/background_tasks_changed`), and wakes itself with a turn of its own
 * when a task reports back. Topics used to read none of it, and three clocks
 * took the silence of the closed turn for a chat with nothing to do:
 *
 *   - the stall judge SIGINTed chat 3019832f at 00:32:53Z on 25/09 while it
 *     waited for its own agent, and took the agent and four background
 *     commands with it (exit 137);
 *   - the goal loop nudged chat 7e9caa28 five times in 104 s on 24/09 while it
 *     waited for five of its own verifiers;
 *   - the idle reaper kills a child fifteen minutes after its last turn.
 *
 * A session cron (CronCreate) is pending work too: the CLI fires it by itself,
 * and killing the child takes it along. CLI 2.1.282 prints no task line about
 * it, only the tool call, its result and a `command_lifecycle` at the fire
 * (`claude-cli-2.1.282-session-cron.ndjson`). The goal loop waits on it as on a
 * task, check-ins at 30, 60 and 120 minutes included: while a recurring cron
 * is armed every turn it fires is deferred, and the check-in is the only time
 * the goal is judged. ScheduleWakeup, the other session cron (a /loop with no
 * interval), is not offered to a `--print` session: recorded on 27/09 with CLI
 * 2.1.283, init lists CronCreate, CronDelete and CronList only, and /loop with
 * no interval runs once and asks for one.
 *
 * This module is the one answer they all read: is this session's background
 * work still alive? The provider keeps one of these per process and folds every
 * stdout line into it; nothing here touches the process, the DB or a clock.
 */

import { readBackgroundTasks, readParentToolUseId } from "./events";
import type { BackgroundWorkDetail } from "../../../shared/background-work";
import { readMonitorEnd } from "./wake-source";
import type { AttentionTaskMap } from "../../../shared/attention";

export type { BackgroundWorkDetail };

/**
 * How long background work is believed without news, by EVERY clock that can
 * kill the child: the stall judge, the idle reaper, the lifetime cap, a config
 * change. One bound on purpose: the verification of 25/09 found the judge on
 * thirty minutes while the others waited two hours, and the judge is the clock
 * that killed 3019832f.
 *
 * Claude Code never kills background work for silence (its thirty minutes are
 * the delay of a goal check-in, see `goal-continuation.ts`). This bound exists
 * only so that a task the CLI stopped reporting on cannot hold a CLI in RAM
 * forever on this Mac; when it fires, the reaper says so in the chat.
 *
 * A session cron is held by the same bound, counted from its arming: its fires
 * do not extend it, or a cron firing every ten minutes would hold its CLI for
 * the seven days Claude Code gives a recurring one. Past it the lifetime cap or
 * the idle reaper closes the CLI with the cron still armed, and the chat hears
 * it named as a cron (`closedWork`).
 */
export const BACKGROUND_WORK_CAP_MS = 2 * 60 * 60_000;

/**
 * How long a reported task, or a command the CLI started by itself, keeps the
 * session busy until the CLI wakes to answer it. Recorded, the wake's
 * `system/init` follows the notification by 0.3 to 1.1 s, and a cron's fire by
 * 182 ms; Claude Code re-checks its own goal after 60 s in the same state.
 */
export const WAKE_QUEUED_MS = 60_000;

/**
 * How long a wake still queued when a turn ends may take to open. The CLI
 * holds a report that arrives inside a turn until that turn's `result` and
 * starts its wake right after it (init 0.3 to 1.1 s later, recorded), unless
 * it folded the report into the turn, which then opens no new one
 * (`wakeAboutToStart` in `claude-code.ts`). Past this, no wake is coming.
 */
export const WAKE_AFTER_RESULT_MS = 2_000;

/** What is known about one task between its start (or first listing) and its report. */
interface TaskFacts {
  /** The tool call that launched it: its subagent lines and heartbeats carry it as `parent_tool_use_id`. */
  toolUseId?: string;
  /** Owned by a subagent: its report wakes that subagent, not the model. */
  subagent: boolean;
  /** It was in a `background_tasks_changed` snapshot: a foreground Bash never is. */
  listed: boolean;
  /** Launched by the Monitor tool: its events wake the CLI with no task line. */
  monitor?: boolean;
  /** When the tracker first saw it, listed or started: what "running for" counts from. */
  startedAt?: number;
  /** Its name as the CLI last gave it: the snapshot drops a task before its `task_notification` names it again. */
  description?: string;
}

/** The last background task that reported, as the wake answering it names its source. */
interface TaskReport {
  description: string;
  monitor: boolean;
  /** A Monitor's end as the CLI worded it (`stream ended`, `stopped`, ...): the wake is that end, not an event. */
  end?: string;
  /** The line's arrival, to tell a report of this wake from one an earlier turn already answered. */
  at: number;
}

export interface BackgroundWork {
  /** The last snapshot the CLI printed, `ambient` tasks left out: task id to what it is and since when. */
  tasks: Map<string, { type: string; description: string; startedAt?: number }>;
  /** When the CLI last printed something about that work. */
  lastSignalAt: number;
  /** Tasks seen starting or listed, until their `task_notification`. */
  facts: Map<string, TaskFacts>;
  /** A background task of the model reported, or the CLI started a command of its own, and the turn answering it has not started yet. */
  wakeQueuedAt: number | null;
  /** A turn ended with that wake still queued: it opens by then or never (`WAKE_AFTER_RESULT_MS`). */
  wakeDueBy: number | null;
  /** Tool calls of the Monitor tool not yet matched to their task. */
  monitorCalls: Set<string>;
  /** Tool calls of CronCreate not yet answered with the cron's id. */
  cronCalls: Set<string>;
  /** Session crons by the id CronCreate returned, until fired (a one-shot) or deleted; `schedule` is the CLI's `humanSchedule`. */
  crons: Map<string, { recurring: boolean; armedAt: number; schedule: string }>;
  /** The `command_uuid` of every command already accounted for: a fire, or one `queued` first, which a cron trigger never is. */
  commands: Set<string>;
  /** One-shots a fire disarmed: a replay of their CronCreate result does not arm them again. */
  fired: Set<string>;
  /** The CLI started a command (a cron's fire, a peer's message): the next init opens its turn, and is no Monitor's event. */
  commandStarted: boolean;
  /** The last `task_notification` of the model's own work (`TaskReport`). */
  lastReport?: TaskReport;
  /** When the last turn ended (`result`): the wake that follows is answered from here on. */
  turnEndedAt: number;
  /** When the CLI last opened a turn (`system/init`). */
  initAt: number;
  /** The cwd and session id the CLI reported at its last init: where its own transcript is filed. */
  cliCwd?: string;
  cliSessionId?: string;
  /** The transcript time of the last notification a wake was named after (`wake-source.ts`): the next wake reads past it. */
  wakeReadUpTo: number;
}

export function newBackgroundWork(): BackgroundWork {
  return { tasks: new Map(), lastSignalAt: 0, facts: new Map(), wakeQueuedAt: null, wakeDueBy: null, monitorCalls: new Set(), cronCalls: new Set(), crons: new Map(), commands: new Set(), fired: new Set(), commandStarted: false, turnEndedAt: 0, initAt: 0, wakeReadUpTo: 0 };
}

/**
 * Fold one stdout line into a session's background work. `unattended` = no
 * turn of ours is registered on the session, so a `system/init` is the CLI
 * waking itself.
 *
 * News, which moves `lastSignalAt`, is any sign of a task in the last snapshot:
 * the snapshot itself, a `system/task_*` line about a listed task, a line whose
 * `parent_tool_use_id` is a listed task's tool call (a subagent talking, or a
 * `tool_progress` heartbeat), and a wake while a Monitor is listed. The wake is
 * the only sign a Monitor gives while it runs: its events arrive as turns of
 * the model with no `task_*` line (fixture, "Tick-2 fired."), and without
 * counting them a Monitor reporting every minute was presumed lost.
 */
export function noteBackgroundLine(
  work: BackgroundWork,
  event: unknown,
  now: number,
  opts: { unattended: boolean },
): void {
  const snapshot = readBackgroundTasks(event);
  if (snapshot) {
    const before = work.tasks;
    work.tasks = new Map();
    for (const t of snapshot) {
      // The CLI's own schema: "hosts should exclude them from activity
      // indicators" (dream, auto_mode_scan, fork workers, live watchers).
      if (t.ambient) continue;
      const f = work.facts.get(t.id);
      // Counted from the first time the task was seen: the CLI re-emits the
      // whole set on every change, and a Monitor must not restart its clock
      // each time an agent next to it comes or goes.
      const startedAt = before.get(t.id)?.startedAt ?? f?.startedAt ?? now;
      work.tasks.set(t.id, { type: t.type, description: t.description, startedAt });
      if (f) { f.listed = true; f.startedAt ??= startedAt; if (t.description) f.description = t.description; }
      else work.facts.set(t.id, { subagent: false, listed: true, startedAt, ...(t.description ? { description: t.description } : {}) });
    }
    // News only when OUR set changed: the CLI also re-emits the snapshot when
    // an ambient entry comes, goes or flips, and that says nothing about a lost
    // Bash listed next to it (review of 25/09).
    if (work.tasks.size !== before.size || [...work.tasks.keys()].some((id) => !before.has(id))) work.lastSignalAt = now;
    return;
  }
  const e = event as { type?: unknown; subtype?: unknown; task_id?: unknown; tool_use_id?: unknown; owned_by_subagent?: unknown; state?: unknown; command_uuid?: unknown; message?: { content?: unknown } } | null;
  if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
    for (const b of e.message.content as Array<{ type?: unknown; name?: unknown; id?: unknown; input?: { id?: unknown } }>) {
      if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
      if (b.name === "Monitor") work.monitorCalls.add(b.id);
      if (b.name === "CronCreate") work.cronCalls.add(b.id);
      if (b.name === "CronDelete" && typeof b.input?.id === "string") work.crons.delete(b.input.id);
    }
  }
  if (e?.type === "user" && work.cronCalls.size > 0) noteCronScheduled(work, event, now);
  // A cron's fire, turn of ours open or not. Topics writes no uuid on stdin,
  // and "commands enqueued without a uuid emit no lifecycle events" (the CLI's
  // schema), so a `started` is a command the CLI queued by itself: a cron
  // trigger, and also a peer's message, a teammate's shutdown prompt, a
  // deferred turn's resume. A peer's message is `queued` first, a cron trigger
  // never is; the other two look like a fire and are read as one.
  if (e?.type === "command_lifecycle" && (e.state === "queued" || e.state === "started")) noteCronFired(work, e.command_uuid, e.state);
  if (e?.type === "command_lifecycle" && e.state === "started") work.commandStarted = true;
  // With no turn of ours open, a started command opens the CLI's own turn. Its
  // init comes 182 ms later in the recording, and until then no turn is
  // visible: the fire has just disarmed its one-shot, and a clock ticking in
  // between kills the CLI as it starts the fire (review of 27/09).
  if (e?.type === "command_lifecycle" && e.state === "started" && opts.unattended) queueWake(work, now);
  if (e?.type === "result" && (e as { result?: unknown }).result !== "waiting for message") {
    work.turnEndedAt = now;
    // A report that came inside this turn: its wake opens right after this
    // result, or the CLI folded it into the turn and none ever comes.
    if (work.wakeQueuedAt !== null && work.wakeDueBy === null) work.wakeDueBy = now + WAKE_AFTER_RESULT_MS;
  }
  if (e?.type === "system" && typeof e.subtype === "string") {
    const id = typeof e.task_id === "string" ? e.task_id : null;
    if (e.subtype === "init") {
      // A turn of the model starts: whatever was queued is being answered.
      work.wakeQueuedAt = null;
      work.wakeDueBy = null;
      work.initAt = now;
      const init = e as { cwd?: unknown; session_id?: unknown };
      if (typeof init.cwd === "string" && init.cwd) work.cliCwd = init.cwd;
      if (typeof init.session_id === "string" && init.session_id) work.cliSessionId = init.session_id;
      const command = work.commandStarted;
      work.commandStarted = false;
      // A wake is news of a listed MONITOR, the one task whose events wake the
      // CLI with no task line. Any wake counted for every task, so a lost Bash
      // stayed kept for good by a CronCreate's wakes (second review of 25/09).
      // Not the turn of a command the CLI started: a Monitor's wake has no
      // `command_lifecycle` (2.1.282 fixture), and a recurring cron's fires
      // kept a silent Monitor for the cron's seven days (review of 28/09).
      if (opts.unattended && !command && [...work.tasks.keys()].some((t) => work.facts.get(t)?.monitor)) work.lastSignalAt = now;
      return;
    }
    if (!id || !e.subtype.startsWith("task_")) return;
    if (e.subtype === "task_started") {
      const f = work.facts.get(id);
      const toolUseId = typeof e.tool_use_id === "string" ? e.tool_use_id : f?.toolUseId;
      const monitor = !!toolUseId && work.monitorCalls.delete(toolUseId);
      const description = typeof (e as { description?: unknown }).description === "string" && (e as { description: string }).description ? (e as { description: string }).description : f?.description;
      work.facts.set(id, { toolUseId, subagent: e.owned_by_subagent === true, listed: f?.listed ?? false, monitor: monitor || f?.monitor, startedAt: f?.startedAt ?? work.tasks.get(id)?.startedAt ?? now, ...(description ? { description } : {}) });
    }
    if (e.subtype === "task_notification") {
      const f = work.facts.get(id);
      work.facts.delete(id);
      // The model's own background task reported: the CLI wakes to answer it.
      // A foreground Bash reports too, and a subagent's task wakes the subagent.
      if (f?.listed && !f.subagent) {
        queueWake(work, now);
        // What the wake answering it is about: a Monitor's end (expired, or
        // its stream closed) is reported here, by name, like a Bash or an Agent.
        const summary = typeof (e as { summary?: unknown }).summary === "string" ? (e as { summary: string }).summary : "";
        const description = f.description || work.tasks.get(id)?.description || summary;
        const end = f.monitor ? readMonitorEnd(summary)?.end : undefined;
        if (description) work.lastReport = { description, monitor: f.monitor === true, at: now, ...(end ? { end } : {}) };
      }
    }
    if (work.tasks.has(id)) work.lastSignalAt = now;
    return;
  }
  const parent = readParentToolUseId(event);
  if (parent !== null && work.tasks.size > 0) {
    for (const [id, f] of work.facts) {
      if (f.toolUseId === parent && work.tasks.has(id)) { work.lastSignalAt = now; return; }
    }
  }
}

/**
 * CronCreate's result arms the cron under the id it returned, unless durable:
 * that one survives the child ("on next launch they resume automatically",
 * the CLI's own description), so closing the CLI loses nothing. Dated by the
 * line's own `timestamp`: a reattach replays the store with "now", and a cron
 * armed hours ago must not look freshly armed after every restart.
 *
 * Never a one-shot already fired: the reattach of a row whose turn ended while
 * the server was away replays the store from that row's mark into the
 * background the scan folded, the result armed the one-shot again, its fire
 * was skipped as already seen, and the cron held its CLI for two hours (review
 * of 27/09). A CronDelete needs nothing of the kind: the replay folds it again.
 */
function noteCronScheduled(work: BackgroundWork, event: unknown, now: number): void {
  const e = event as { timestamp?: unknown; tool_use_result?: { id?: unknown; recurring?: unknown; humanSchedule?: unknown; durable?: unknown }; message?: { content?: unknown } };
  if (!Array.isArray(e.message?.content)) return;
  for (const b of e.message.content as Array<{ type?: unknown; tool_use_id?: unknown }>) {
    if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string" || !work.cronCalls.delete(b.tool_use_id)) continue;
    const id = e.tool_use_result?.id;
    if (typeof id !== "string" || work.fired.has(id)) continue; // refused (nothing armed), or fired since
    if (e.tool_use_result?.durable === true) continue; // in .claude/scheduled_tasks.json: the next launch resumes it
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    const schedule = typeof e.tool_use_result?.humanSchedule === "string" ? e.tool_use_result.humanSchedule : id;
    work.crons.set(id, { recurring: e.tool_use_result?.recurring !== false, armedAt: Number.isFinite(at) ? at : now, schedule });
  }
}

/**
 * The CLI does not say which cron fired. A one-shot is gone once it fires, so
 * the oldest one leaves; while a recurring cron is armed too the fire may be
 * that one's, and the one-shot stays, held by the bound like the rest.
 *
 * Once per command: a reattach scans the store, then folds the open turn again
 * from the last `result`, and a fire inside it folded twice disarmed a second
 * one-shot still armed in the CLI, which the reaper then closed (review of 27/09).
 * A command seen `queued` is none: its `started` comes after.
 */
function noteCronFired(work: BackgroundWork, command: unknown, state: "queued" | "started"): void {
  if (typeof command === "string") {
    if (work.commands.has(command)) return;
    work.commands.add(command);
  }
  if (state === "queued") return;
  const crons = [...work.crons];
  if (crons.some(([, c]) => c.recurring)) return;
  if (crons.length === 0) return;
  work.crons.delete(crons[0][0]);
  work.fired.add(crons[0][0]);
}

/**
 * A replay folds every line with "now". The child's last write is the true age
 * of that news: a job silent for hours must not look fresh after every restart,
 * or no clock ever collects a lost one.
 */
export function datedByLastWrite(work: BackgroundWork, lastDataAt: number): void {
  if (lastDataAt < work.lastSignalAt) work.lastSignalAt = lastDataAt;
  // A task found by the replay started no later than the child's last write.
  // Earlier is unknowable from stdout (its lines carry no time), so after a
  // restart "running for" counts from there: short, never longer than true.
  for (const t of work.tasks.values()) if (t.startedAt && lastDataAt < t.startedAt) t.startedAt = lastDataAt;
  for (const f of work.facts.values()) if (f.startedAt && lastDataAt < f.startedAt) f.startedAt = lastDataAt;
  if (work.wakeQueuedAt !== null && lastDataAt < work.wakeQueuedAt) work.wakeQueuedAt = lastDataAt;
}

/** A new report or command: its turn is owed from now, and no turn has ended on it yet. */
function queueWake(work: BackgroundWork, now: number): void {
  work.wakeQueuedAt = now;
  work.wakeDueBy = null;
}

/**
 * When the queued wake stops counting, or null when none is queued: the bound
 * `WAKE_QUEUED_MS`, or sooner `wakeDueBy`. No line says the wake is over, so
 * whoever shows it re-reads at this instant (`ClaudeCodeProvider`).
 */
export function wakeQueuedUntil(work: BackgroundWork | undefined): number | null {
  if (!work || work.wakeQueuedAt === null) return null;
  const bound = work.wakeQueuedAt + WAKE_QUEUED_MS;
  return work.wakeDueBy === null ? bound : Math.min(bound, work.wakeDueBy);
}

/** A reported task, or a command the CLI started, whose turn has not started yet, within `wakeQueuedUntil`. */
export function isWakeQueued(work: BackgroundWork | undefined, now: number): boolean {
  const until = wakeQueuedUntil(work);
  return until !== null && now < until;
}

/** Listed tasks with news within the bound. */
export function hasLiveTasks(work: BackgroundWork | undefined, now: number): boolean {
  return !!work && work.tasks.size > 0 && now - work.lastSignalAt < BACKGROUND_WORK_CAP_MS;
}

/**
 * Work that can speak while a turn of ours is open: listed tasks with news, or
 * a wake about to start. Not an armed cron: the CLI holds a fire until the
 * turn's `result` (recorded 28/09, CLI 2.1.283: a one-shot due at 10:42:00Z
 * fired 11 ms after the result of a turn whose Bash ran until 10:42:03Z), so a
 * turn silent for minutes is not waiting on it. What the stall judge and the
 * lifetime cap's wedged-turn rule read.
 */
export function hasTaskWork(work: BackgroundWork | undefined, now: number): boolean {
  return hasLiveTasks(work, now) || isWakeQueued(work, now);
}

/** The session crons armed less than `BACKGROUND_WORK_CAP_MS` ago: the CLI will fire them by itself. */
function armedCrons(work: BackgroundWork | undefined, now: number): Array<{ recurring: boolean; armedAt: number; schedule: string }> {
  return work ? [...work.crons.values()].filter((c) => now - c.armedAt < BACKGROUND_WORK_CAP_MS) : [];
}

/** A session cron armed within the bound (`armedCrons`). */
export function hasArmedCron(work: BackgroundWork | undefined, now: number): boolean {
  return armedCrons(work, now).length > 0;
}

/** One chat line about work a clock closed; `cron` = session crons past the bound, which counts from their arming. */
export type ClosedWork<Why extends string> = { tasks: string[]; why: Why; cron?: true };

/**
 * What closing the CLI takes with it, named for the chat: listed tasks by their
 * description, armed crons by their schedule, under the reason the clock gives.
 * Past the bound (`silent`) the crons get a line of their own, flagged `cron`:
 * a /loop that fired all along was never "without news". A flag and not a new
 * reason: a client older than the flag reads `why` as a key, and a reason it
 * has no sentence for threw in the render and took the whole pane down (review
 * of 27/09); with `silent` it says the tasks' sentence instead.
 */
export function closedWork<Why extends string>(work: BackgroundWork | undefined, why: Why): Array<ClosedWork<Why>> {
  const tasks = [...(work?.tasks.values() ?? [])].map((t) => t.description || t.type);
  const crons = [...(work?.crons.values() ?? [])].map((c) => `${c.schedule} (cron)`);
  const said: Array<ClosedWork<Why>> = why === "silent" ? [{ tasks, why }, { tasks: crons, why, cron: true }] : [{ tasks: [...tasks, ...crons], why }];
  return said.filter((s) => s.tasks.length > 0);
}

/**
 * The work as a chat names it: the listed tasks, only while they are alive
 * (`hasLiveTasks`), the session crons still armed within the bound
 * (`hasArmedCron`), and the last news. A list past the bound is already given
 * up on by every clock, and a reported task waiting for its wake is no longer
 * running, so both name no task. A cron is named by its schedule, as
 * `closedWork` names it when a clock closes it; its arming is news about it,
 * or a chat holding only a cron would read as silent since its last task.
 */
export function describeBackgroundWork(work: BackgroundWork | undefined, now: number): BackgroundWorkDetail {
  // A Monitor is `local_bash` to the CLI; the chat names it for what it is.
  const tasks = work && hasLiveTasks(work, now)
    ? [...work.tasks].map(([id, t]) => ({
      type: work.facts.get(id)?.monitor ? "monitor" : t.type,
      description: t.description || t.type,
      ...(t.startedAt ? { startedAt: t.startedAt } : {}),
    }))
    : [];
  const crons = armedCrons(work, now);
  return {
    tasks: [...tasks, ...crons.map((c) => ({ type: "cron", description: `${c.schedule} (cron)` }))],
    lastSignalAt: Math.max(work?.lastSignalAt ?? 0, ...crons.map((c) => c.armedAt)),
  };
}

/**
 * The named set as a string, to tell when it changed: a task listed or gone,
 * or a Monitor recognised. The chat polls the work every 15 s; a Monitor armed
 * mid-turn stayed unnamed until then, so the provider says each change at once.
 */
export function backgroundWorkKey(work: BackgroundWork | undefined): string {
  if (!work) return "";
  return [...work.tasks.keys()].map((id) => (work.facts.get(id)?.monitor ? `m:${id}` : id)).join(",") + `|${work.crons.size}`;
}

/** Is there background work alive, or a wake about to answer it, as of `now`? */
export function isBackgroundWorkAlive(work: BackgroundWork | undefined, now: number): boolean {
  return hasTaskWork(work, now) || hasArmedCron(work, now);
}

/** The work as the attention state counts it (notifications-redesign, design section 5.2). */
export interface AttentionBackground {
  /** Every task in flight by id, recurring crons included, marked. */
  tasks: AttentionTaskMap;
  /** The tasks that keep the chat waiting: not a recurring cron. */
  count: number;
  /** Their kinds, once each: what `stream:end.background.kinds` says. */
  kinds: string[];
}

function attentionKind(type: string, monitor: boolean): string {
  if (monitor) return "monitor";
  if (type.includes("agent")) return "agent";
  if (type.includes("workflow")) return "workflow";
  return "bash";
}

/**
 * What the chat waits on, for the attention state: the listed tasks alive
 * (`hasLiveTasks`), the wake the CLI is about to start (`isWakeQueued`: the
 * report arrived, its turn is coming) and the session crons, a recurring one
 * marked so it is shown and never counted. NOT `backgroundState`, which the
 * goal loop reads and which says `running` while a recurring cron is armed,
 * for two hours: right for a loop that must defer its verdict, wrong for a
 * chat that would stay grey forever under a calendar.
 */
export function attentionBackgroundOf(work: BackgroundWork | undefined, now: number): AttentionBackground {
  const tasks: AttentionTaskMap = {};
  if (work && hasLiveTasks(work, now)) {
    for (const [id, t] of work.tasks) {
      tasks[id] = {
        kind: attentionKind(t.type, work.facts.get(id)?.monitor === true),
        label: t.description || t.type,
        startedAt: new Date(t.startedAt ?? now).toISOString(),
      };
    }
  }
  for (const [id, c] of work?.crons ?? []) {
    if (now - c.armedAt >= BACKGROUND_WORK_CAP_MS) continue;
    tasks[id] = { kind: "cron", label: c.schedule, startedAt: new Date(c.armedAt).toISOString(), ...(c.recurring ? { recurring: true } : {}) };
  }
  if (work && isWakeQueued(work, now)) {
    tasks.wake = { kind: "wake", label: work.lastReport?.description ?? "wake", startedAt: new Date(work.wakeQueuedAt ?? now).toISOString() };
  }
  const counting = Object.values(tasks).filter((t) => !t.recurring);
  return { tasks, count: counting.length, kinds: [...new Set(counting.map((t) => t.kind))] };
}

/**
 * The doors to a session's background work (an Agent with `run_in_background`,
 * a Bash, a Monitor that a closed turn left running), asked of every
 * registered provider. Only claude-code answers today, and any other session
 * is `none`, which is what every clock assumed before. A probe that throws
 * claims nothing. See `claude/background-work.ts`.
 */
import type { AbortReason } from "./types";
import { registeredProviders } from "./index";
import type { BackgroundTaskSummary, BackgroundWorkDetail } from "../../shared/background-work";
import type { AttentionTaskMap } from "../../shared/attention";

/** The background probes a provider may answer. */
type BackgroundProbe = {
  attentionBackground?: (sk: string) => { tasks: AttentionTaskMap; count: number; kinds: string[] };
  hasBackgroundWork?: (sk: string) => boolean;
  hasTaskWork?: (sk: string) => boolean;
  backgroundState?: (sk: string) => string;
  backgroundWorkDetail?: (sk: string) => BackgroundWorkDetail | null;
  backgroundSessionKeys?: () => string[];
  abort?: (sk: string, runId: string | undefined, reason: AbortReason) => Promise<void>;
};

function probes(): BackgroundProbe[] {
  return [...registeredProviders()] as unknown as BackgroundProbe[];
}

/** Is this session's CLI still reporting on work its last turn left running? What every clock that kills asks. */
export function sessionHasBackgroundWork(sessionKey: string): boolean {
  for (const p of probes()) {
    try {
      if (p.hasBackgroundWork?.(sessionKey)) return true;
    } catch { /* a failing probe claims nothing */ }
  }
  return false;
}

/** `running`, `wake-queued` (a task reported or the CLI started a command, its turn is about to start) or `none`. */
export function sessionBackgroundState(sessionKey: string): string {
  for (const p of probes()) {
    try {
      const state = p.backgroundState?.(sessionKey);
      if (state && state !== "none") return state;
    } catch { /* a failing probe claims nothing */ }
  }
  return "none";
}

/**
 * The stall detector's background hold, as `server.ts` wires it: the same bound
 * as every clock that kills, over the work that can speak inside the turn it
 * watches. Not an armed cron: the CLI fires it only after the turn's `result`,
 * so a stuck turn waited thirty minutes for the send watchdog (review of 28/09).
 */
export function stallBackgroundHold(sessionKey: string): () => boolean {
  return () => probes().some((p) => {
    try { return p.hasTaskWork?.(sessionKey) === true; } catch { return false; /* a failing probe claims nothing */ }
  });
}

/**
 * The Stop of a session's background work, sent to the provider that HAS it:
 * the topic's provider may have changed since (a model switch across
 * providers), and the old child keeps running its work. `stopped` only once
 * that provider no longer reports any.
 */
export async function stopBackgroundWork(sessionKey: string, reason: AbortReason = "user"): Promise<"none" | "stopped" | "failed"> {
  // The person's Stop, or a superseded card. A stall or wall-clock stop that
  // finds no turn open was for a turn now over: the work is not its business.
  if (reason !== "user" && reason !== "superseded") return "none";
  for (const p of probes()) {
    try {
      if (!p.hasBackgroundWork?.(sessionKey) || !p.abort) continue;
      await p.abort(sessionKey, undefined, reason);
      return p.hasBackgroundWork?.(sessionKey) ? "failed" : "stopped";
    } catch { return "failed"; }
  }
  return "none";
}

/**
 * The Stop route's answer when no turn is open but background work is, or null
 * when there is none to stop. `onStopped`: a goal waiting for that work stops.
 */
export async function stopBackgroundOnly(sessionKey: string, reason: AbortReason, onStopped: () => void) {
  const stopped = await stopBackgroundWork(sessionKey, reason);
  if (stopped === "stopped") onStopped();
  return stopped === "none" ? null : { ok: stopped === "stopped", reason: `background_${stopped}`, cleared: false };
}

/** Every session with background work, for the chat status that offers its Stop. */
export function sessionsWithBackgroundWork(): string[] {
  const out: string[] = [];
  for (const p of probes()) {
    try { out.push(...(p.backgroundSessionKeys?.() ?? [])); } catch { /* a failing probe claims nothing */ }
  }
  return out;
}

/**
 * What the chat names: the tasks and the last news, from the provider that HAS
 * the work. A session whose provider cannot tell says nothing about its tasks.
 */
export function sessionBackgroundDetail(sessionKey: string): BackgroundWorkDetail {
  for (const p of probes()) {
    try {
      const detail = p.backgroundWorkDetail?.(sessionKey);
      if (detail) return detail;
    } catch { /* a failing probe claims nothing */ }
  }
  return { tasks: [], lastSignalAt: 0 };
}

/**
 * The `run_command` processes still running, by session, as the process
 * registry reports them (`commandBackgroundWork` in `routes/processes.ts`).
 * Not a provider probe: a command is a child of the server, not of the CLI,
 * and no clock that kills a CLI waits for it. It only joins what the chat's
 * background line names (BGVIS-07).
 */
export type CommandWork = { sessions: () => string[]; tasks: (sessionKey: string) => BackgroundTaskSummary[] };

/**
 * What the line names for a session: the provider's tasks, then its running
 * commands. A session with commands only has no CLI news to go stale:
 * `lastSignalAt` 0, which the line reads as "no age" (the server watches the
 * process itself, and its end is a push).
 */
function detailWithCommands(sessionKey: string, provider: BackgroundWorkDetail | null, commands: CommandWork | undefined): BackgroundWorkDetail {
  let own: BackgroundTaskSummary[] = [];
  try { own = commands?.tasks(sessionKey) ?? []; } catch { /* a failing registry claims nothing */ }
  if (!provider) return { tasks: own, lastSignalAt: 0 };
  return own.length ? { tasks: [...provider.tasks, ...own], lastSignalAt: provider.lastSignalAt } : provider;
}

function commandSessions(commands: CommandWork | undefined): string[] {
  try { return commands?.sessions() ?? []; } catch { return []; }
}

/** A background row of `/api/topics/streaming`: no turn open, work still running, and what it is. */
export type BackgroundStatusRow = { topicId: string; sessionKey: string; state: "background" } & BackgroundWorkDetail;

/**
 * A turn row of `/api/topics/streaming`: a reply in progress, or one waiting
 * for the person. `background`: the work an earlier turn left running, still
 * named while this turn is open.
 */
export type TurnStatusRow = { topicId: string; sessionKey: string; state: "streaming" | "waiting"; awaitingSince?: number; background?: BackgroundWorkDetail };

/** A row of `/api/topics/streaming`: a reply in progress, one waiting for the person, or background work only. */
export type StreamingStatusRow = TurnStatusRow | BackgroundStatusRow;

/**
 * The `/api/topics/streaming` rows for the sessions with no turn open but work
 * a closed one left running: not a reply in progress, and the Stop still applies.
 */
export function backgroundStatusRows(
  listed: ReadonlyArray<{ sessionKey: string }>,
  topicOf: (sessionKey: string) => { id: string; sessionKey?: string | null } | null | undefined,
  commands?: CommandWork,
): BackgroundStatusRow[] {
  const rows: BackgroundStatusRow[] = [];
  const provider = new Set(sessionsWithBackgroundWork());
  for (const sessionKey of new Set([...provider, ...commandSessions(commands)])) {
    const topic = listed.some((s) => s.sessionKey === sessionKey) ? null : topicOf(sessionKey);
    if (!topic?.sessionKey) continue;
    const detail = detailWithCommands(sessionKey, provider.has(sessionKey) ? sessionBackgroundDetail(sessionKey) : null, commands);
    rows.push({ topicId: topic.id, sessionKey: topic.sessionKey, state: "background", ...detail });
  }
  return rows;
}

/**
 * The whole answer of `/api/topics/streaming`: the turn rows, each carrying the
 * background work its session still runs, then a background row for every
 * session with work and no turn open.
 *
 * A NEW TURN DOES NOT END THE WORK. On 29/09 chat 33966f4e left a Bash running
 * at 20:57:54Z; a message at 21:17:15Z opened a turn, the session left the
 * background rows for a turn row, and the chat's line naming the job went
 * away while the job ran for six more minutes. The turn row stays the one row
 * of its session (every reader finds the turn by session), and names the work
 * beside it.
 *
 * Only named tasks ride along: with none listed the work has reported and a
 * turn will answer it, which an open turn already says.
 *
 * `commands`: the session's `run_command` processes still running, named
 * beside the provider's tasks, turn open or not (BGVIS-07).
 */
export function withBackgroundWork(
  turns: ReadonlyArray<TurnStatusRow>,
  topicOf: (sessionKey: string) => { id: string; sessionKey?: string | null } | null | undefined,
  commands?: CommandWork,
): StreamingStatusRow[] {
  const busy = new Set(sessionsWithBackgroundWork());
  const running = new Set(commandSessions(commands));
  const rows: StreamingStatusRow[] = turns.map((row) => {
    if (!busy.has(row.sessionKey) && !running.has(row.sessionKey)) return row;
    const detail = detailWithCommands(row.sessionKey, busy.has(row.sessionKey) ? sessionBackgroundDetail(row.sessionKey) : null, running.has(row.sessionKey) ? commands : undefined);
    return detail.tasks.length > 0 ? { ...row, background: detail } : row;
  });
  rows.push(...backgroundStatusRows(turns, topicOf, commands));
  return rows;
}

/**
 * What a chat waits on, for the attention state: the first provider that can
 * tell (`attentionBackground`, claude-code today). `null` when none can, and
 * the caller then leaves the subject's tasks as they were rather than
 * claiming there are none.
 */
export function sessionAttentionBackground(sessionKey: string): { tasks: AttentionTaskMap; count: number; kinds: string[] } | null {
  let answer: { tasks: AttentionTaskMap; count: number; kinds: string[] } | null = null;
  for (const p of probes()) {
    try {
      const b = p.attentionBackground?.(sessionKey);
      if (!b) continue;
      if (b.count > 0 || Object.keys(b.tasks).length > 0) return b;
      answer ??= b;
    } catch { /* a failing probe claims nothing */ }
  }
  return answer;
}

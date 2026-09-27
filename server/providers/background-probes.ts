/**
 * The doors to a session's background work (an Agent with `run_in_background`,
 * a Bash, a Monitor that a closed turn left running), asked of every
 * registered provider. Only claude-code answers today, and any other session
 * is `none`, which is what every clock assumed before. A probe that throws
 * claims nothing. See `claude/background-work.ts`.
 */
import type { AbortReason } from "./types";
import { registeredProviders } from "./index";
import type { BackgroundWorkDetail } from "../../shared/background-work";

/** The background probes a provider may answer. */
type BackgroundProbe = {
  hasBackgroundWork?: (sk: string) => boolean;
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

/** `running`, `wake-queued` (a task reported, its wake is about to start) or `none`. */
export function sessionBackgroundState(sessionKey: string): string {
  for (const p of probes()) {
    try {
      const state = p.backgroundState?.(sessionKey);
      if (state && state !== "none") return state;
    } catch { /* a failing probe claims nothing */ }
  }
  return "none";
}

/** The stall detector's background hold, as `server.ts` wires it: the same bound as every clock that kills. */
export function stallBackgroundHold(sessionKey: string): () => boolean {
  return () => sessionHasBackgroundWork(sessionKey);
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

/** A background row of `/api/topics/streaming`: no turn open, work still running, and what it is. */
export type BackgroundStatusRow = { topicId: string; sessionKey: string; state: "background" } & BackgroundWorkDetail;

/** A row of `/api/topics/streaming`: a reply in progress, one waiting for the person, or background work only. */
export type StreamingStatusRow =
  | { topicId: string; sessionKey: string; state: "streaming" | "waiting"; awaitingSince?: number }
  | BackgroundStatusRow;

/**
 * The `/api/topics/streaming` rows for the sessions with no turn open but work
 * a closed one left running: not a reply in progress, and the Stop still applies.
 */
export function backgroundStatusRows(
  listed: ReadonlyArray<{ sessionKey: string }>,
  topicOf: (sessionKey: string) => { id: string; sessionKey?: string | null } | null | undefined,
): BackgroundStatusRow[] {
  const rows: BackgroundStatusRow[] = [];
  for (const sessionKey of sessionsWithBackgroundWork()) {
    const topic = listed.some((s) => s.sessionKey === sessionKey) ? null : topicOf(sessionKey);
    if (topic?.sessionKey) rows.push({ topicId: topic.id, sessionKey: topic.sessionKey, state: "background", ...sessionBackgroundDetail(sessionKey) });
  }
  return rows;
}

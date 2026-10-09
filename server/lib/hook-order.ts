/**
 * THE ORDER OF A SESSION'S HOOKS, WHEN THEY NO LONGER ARRIVE IN ORDER.
 *
 * Every Topics hook but `SessionEnd` is registered `async: true`
 * (`topics-hooks.ts`): the CLI starts the script and goes on, so two hooks of
 * the same session race to the server, each through its own `sh` + `curl`. On
 * a loaded Mac they arrive in any order: a `PostToolUse` before its
 * `PreToolUse`, the `PreToolUse` of the last tool after the `Stop` of its turn,
 * a `SessionStart` after the first prompt. Applied in arrival order, each of
 * those leaves a phase that is false (a tool "running" after the turn ended, a
 * session reset to `starting` while it works).
 *
 * Two facts put them back in order:
 *  - the FIRING time, stamped by the hook script before anything else
 *    (`X-Topics-Hook-Fired-At`, see `scripts/claude-hooks/post-hook.sh`): a
 *    hook fired before the newest one already applied is stale news;
 *  - the `tool_use_id`, which pairs a `PostToolUse` with its `PreToolUse`
 *    exactly, whatever the clocks say: a `PreToolUse` of a call whose
 *    `PostToolUse` already arrived describes a tool that has finished, and a
 *    `PostToolUse` that comes right after its own `PreToolUse` closes that call
 *    even when the jitter of the two shells stamped it a few ms earlier.
 *
 * A turn the transcript opens counts as a fact too (see `opened`): the tail
 * reads it before the late hook lands.
 *
 * Pure and in memory: after a server restart the first hook of a session is
 * simply in order, which is what it was before this existed.
 */

/** How far in the future a firing time may claim to be before it is not believed. */
const FUTURE_SKEW_MS = 2_000;
/** Finished tool calls remembered per session: a late `PreToolUse` comes seconds late, not hundreds of calls late. */
const MAX_ENDED_CALLS = 64;
/** Sessions remembered, so a long-lived server cannot grow the map without bound. */
const MAX_SESSIONS = 500;

/**
 * When the hook FIRED, in epoch ms: the script's stamp when it is one we can
 * believe, the arrival time otherwise (an older script, a stamp from a clock
 * that is not this machine's). A stamp is never later than the arrival.
 */
export function hookEventTime(firedAt: unknown, arrivedAt: number): number {
  const n = typeof firedAt === "string" && /^\d{10,16}$/.test(firedAt.trim()) ? Number(firedAt.trim())
    : typeof firedAt === "number" ? firedAt
    : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return arrivedAt;
  if (n > arrivedAt + FUTURE_SKEW_MS) return arrivedAt;
  return Math.min(n, arrivedAt);
}

/**
 * The dedup key of a hook. The tool call is part of it: two parallel tool calls
 * fire their `PreToolUse` a few ms apart (86 ms, measured on the CLI 2.1.289)
 * and are two events, while the same call registered twice (global settings +
 * `--settings`) carries the same `tool_use_id` and still collapses.
 */
export function hookDedupKey(claudeSessionId: string, event: string, toolUseId: unknown): string {
  return typeof toolUseId === "string" && toolUseId ? `${claudeSessionId}|${event}|${toolUseId}` : `${claudeSessionId}|${event}`;
}

/**
 * - `in-order`: newer than everything applied; apply it whole.
 * - `stale`: fired before a hook already applied; its phase change is old news.
 * - `finished-call`: a `PreToolUse` whose `PostToolUse` already arrived; the
 *   tool it starts has ended, so it changes nothing at all.
 */
export type HookOrderVerdict = "in-order" | "stale" | "finished-call";

interface SessionOrder {
  newestAt: number;
  endedCalls: string[];
  /** The `tool_use_id` of the last hook applied in order when it was a `PreToolUse`, null otherwise. */
  lastStartedCall: string | null;
}

export interface HookOrder {
  admit(claudeSessionId: string, event: string, toolUseId: unknown, at: number): HookOrderVerdict;
  /**
   * A turn the transcript opened at `at` (a prompt or a delivered notice, read
   * by the tail): a hook fired before it and arriving after is stale news, as
   * one fired before a hook already applied.
   */
  opened(claudeSessionId: string, at: number): void;
}

export function createHookOrder(): HookOrder {
  const sessions = new Map<string, SessionOrder>();

  function orderOf(sid: string): SessionOrder {
    let found = sessions.get(sid);
    if (!found) {
      found = { newestAt: -Infinity, endedCalls: [], lastStartedCall: null };
      sessions.set(sid, found);
      if (sessions.size > MAX_SESSIONS) {
        // Map iteration is insertion order: the first key is the oldest session.
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
    }
    return found;
  }

  return {
    admit(sid, event, toolUseId, at) {
      const s = orderOf(sid);
      const id = typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : null;
      if (event === "PostToolUse" && id && !s.endedCalls.includes(id)) {
        s.endedCalls.push(id);
        if (s.endedCalls.length > MAX_ENDED_CALLS) s.endedCalls.shift();
      }
      if (event === "PreToolUse" && id && s.endedCalls.includes(id)) return "finished-call";
      // The Post of the call whose Pre is the newest hook applied: nothing else happened in between,
      // so it is in order whatever its stamp says. The clock stays where the Pre put it.
      if (event === "PostToolUse" && id && id === s.lastStartedCall) {
        s.lastStartedCall = null;
        return "in-order";
      }
      if (at < s.newestAt) return "stale";
      s.newestAt = at;
      s.lastStartedCall = event === "PreToolUse" ? id : null;
      return "in-order";
    },
    opened(sid, at) {
      const s = orderOf(sid);
      if (at > s.newestAt) { s.newestAt = at; s.lastStartedCall = null; }
    },
  };
}

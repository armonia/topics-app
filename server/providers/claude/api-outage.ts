/**
 * THE API'S HEALTH, READ OFF THE CLI'S OWN STREAM (card e30f35e4).
 *
 * Topic 3019832f, 25/09: the API dark from 02:00 to 03:20Z. The CLI said so on
 * stdout, a `system/api_retry` line every six minutes, and Topics dropped every
 * `system/*` line as noise: the send watchdog read a child that was retrying
 * as a wedged one, killed it at 02:30 and closed the turn with a bare text no
 * sweep recognised. Stopped 52 minutes, until a person resent by hand.
 *
 * Two decisions live here, next to each other because they read the same
 * line: what a live line says about the API (a retry opens the `api-down`
 * hold, a streamed answer lifts it), and how a turn the watchdog closed ends.
 * The provider keeps the state on the child; this module decides, and keeps
 * the hold.
 */
import { holdForApiDown, liftApiDownHold } from "../../lib/provider-hold";
import { cancelled, type TurnEndInfo } from "../stop-reason";
import { readApiRetry, type StreamLineKind } from "./events";

/** The CLI's last retry of the API: when, and whether the API itself was down. */
export interface ApiRetryMark {
  at: number;
  outage: boolean;
}

/**
 * One LIVE line of any child, attended or not. A streamed answer, which only
 * the API can start, lifts the hold for every chat (on 25/09 the first one
 * after the blackout came from a woken turn on another chat, at 03:20Z). A
 * retry of an API that is down opens it, or pushes its horizon on. Returns the
 * retry to keep on the child, null for any other line.
 */
export function noteApiHealth(kind: StreamLineKind, event: unknown, nowMs: number = Date.now()): ApiRetryMark | null {
  if (kind === "partial") liftApiDownHold(nowMs);
  const retry = kind === "noise" ? readApiRetry(event) : null;
  if (!retry) return null;
  if (retry.outage) holdForApiDown(nowMs);
  return { at: nowMs, outage: retry.outage };
}

/**
 * How a turn the send watchdog closed ends: with a cause, the one thing the
 * resume reads. The child's last word decides which. A retry of an API that
 * is down, with nothing after it, means the API left the turn unanswered, and
 * that resume waits for the API; anything else is a stall.
 *
 * The cut is itself a reading of the API, and it opens the hold again. It
 * comes thirty minutes after that retry, whose own hold ran out after ten:
 * without it the next sweep would resend into the API the cut calls down.
 */
export function silentTurnEnd(retry: ApiRetryMark | undefined, lastEventAt: number, detail: string, nowMs: number = Date.now()): TurnEndInfo {
  if (!retry?.outage || retry.at < lastEventAt) return cancelled("watchdog", detail);
  holdForApiDown(nowMs);
  return { end: "error", cause: "api-unavailable", detail };
}

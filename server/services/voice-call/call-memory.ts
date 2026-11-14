/**
 * The short memory between two calls of the same person: the line drops, they
 * call back a minute later, and the assistant must not start again from "Hi,
 * tell me" without knowing what they were talking about. Kept in memory only,
 * for a few minutes: it is the thread of one conversation, not an archive.
 */
import type { PreviousCall } from "./call-rules";

/** Past this the second call is a new conversation. */
export const RESUME_WINDOW = 10 * 60_000;

const last = new Map<string, { lines: string[]; dropped: boolean; at: number }>();

/** Remembers how a call ended; a call nobody talked in leaves nothing. */
export function rememberCall(who: string, lines: readonly string[], dropped: boolean, at: number): void {
  if (lines.length === 0) return;
  last.set(who, { lines: [...lines], dropped, at });
}

/** The call before, if it ended a short while ago: used once, then forgotten. */
export function previousCall(who: string, now: number): PreviousCall | null {
  const p = last.get(who);
  if (!p) return null;
  last.delete(who);
  if (now - p.at > RESUME_WINDOW) return null;
  return { lines: p.lines, dropped: p.dropped, agoMin: Math.max(1, Math.round((now - p.at) / 60_000)) };
}

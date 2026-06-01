/**
 * session-digest — pure aggregation for the periodic "what needs attention"
 * ping (interactive-claude-primitive, free monitor).
 *
 * Takes the per-session state the workspace already tracks (no model call) and
 * returns the subset that needs the user's attention + a one-line summary. A
 * server timer broadcasts this every N minutes so the user gets a proactive
 * nudge without the Master ever reasoning on a timer (which would cost — see
 * project_claude-billing-constraint). Pure + side-effect-free → bun:test.
 */

export type SessionState = "empty" | "streaming" | "update" | "waiting" | "idle";

export interface SessionStateRow {
  topicId: string;
  name: string;
  state: SessionState;
  unread?: number;
}

export interface AttentionDigest {
  /** Sessions that have something new the user hasn't seen / acted on. */
  items: { topicId: string; name: string; reason: string }[];
  count: number;
  /** One-line human summary, or "" when nothing needs attention. */
  summary: string;
}

/**
 * A session "needs attention" when there's an unseen assistant reply
 * (state="update") or any unread messages. `streaming` (mid-reply) and plain
 * `idle`/`empty` do NOT — they're not waiting on the user. `waiting` (user sent,
 * no reply yet) is the AI's ball, so it's excluded too.
 */
function attentionReason(s: SessionStateRow): string | null {
  if (s.state === "update") return "nuova risposta non letta";
  if ((s.unread ?? 0) > 0) return `${s.unread} non letti`;
  return null;
}

export function buildAttentionDigest(sessions: SessionStateRow[]): AttentionDigest {
  const items: AttentionDigest["items"] = [];
  for (const s of sessions) {
    const reason = attentionReason(s);
    if (reason) items.push({ topicId: s.topicId, name: s.name, reason });
  }
  const count = items.length;
  let summary = "";
  if (count === 1) {
    summary = `1 sessione richiede attenzione: ${items[0].name} (${items[0].reason}).`;
  } else if (count > 1) {
    const names = items.slice(0, 3).map((i) => i.name).join(", ");
    const more = count > 3 ? ` +${count - 3}` : "";
    summary = `${count} sessioni richiedono attenzione: ${names}${more}.`;
  }
  return { items, count, summary };
}

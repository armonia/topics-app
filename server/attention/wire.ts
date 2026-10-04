/**
 * THE WIRES FROM THE EVENTS THE SERVER ALREADY HAS TO THE ATTENTION STORE
 * (notifications-redesign, design section 2.2).
 *
 * The store composes; the facts are born elsewhere. This module holds the few
 * translations that need to know where a fact is born:
 *
 *   - the waits of the ask and permission bridges (`human-hold-events`), on the
 *     chat's subject, or on the card's when the session is a board agent's in
 *     flight (the dispatcher lends its session -> card lookup);
 *   - the plan panel the chat route opens at the end of a plan-mode turn;
 *   - the chat's background work, from the provider's own snapshot;
 *   - the tombstone of a terminal's pane.
 */
import { onHumanHoldChange } from "../lib/human-hold-events";
import { taskSubject, terminalSubject, type AttentionTaskMap } from "../../shared/attention";
import { closeHold, openHold, setBackgroundTasks, setClosed } from "./store";

export interface AttentionWireDeps {
  /** The subject of a chat session (`topic:<id>`), or null when no topic owns it. */
  subjectForSessionKey: (sessionKey: string) => string | null;
  /** The card a board agent's session works for, while its turn is in flight. */
  cardForSession: (sessionKey: string) => string | null;
}

let wire: AttentionWireDeps = {
  subjectForSessionKey: () => null,
  cardForSession: () => null,
};

export function configureAttentionWire(partial: Partial<AttentionWireDeps>): void {
  wire = { ...wire, ...partial };
}

/**
 * Where a session's wait goes: the card of a board agent in flight (the topic
 * stays idle, rule 2), otherwise the chat.
 */
export function waitSubjectOfSession(sessionKey: string): string | null {
  let card: string | null = null;
  try { card = wire.cardForSession(sessionKey); } catch { card = null; }
  if (card) return taskSubject(card);
  try { return wire.subjectForSessionKey(sessionKey); } catch { return null; }
}

/** The chat subject of a session, whatever card it works for. */
export function chatSubjectOfSession(sessionKey: string): string | null {
  try { return wire.subjectForSessionKey(sessionKey); } catch { return null; }
}

/**
 * Listen to the bridges' waits. A question from the ask bridge is
 * `needs-you(question)`, a request of the permission bridge
 * `needs-you(permission)`. Returns the unsubscribe.
 */
export function wireHumanHolds(): () => void {
  // Where each session's wait went, so the release closes the same subject
  // even if the card's turn ended in between.
  const placed = new Map<string, string>();
  return onHumanHoldChange(({ sessionKey, phase, source, id }) => {
    const key = `${source}\u0000${sessionKey}`;
    if (phase === "held") {
      const subject = waitSubjectOfSession(sessionKey);
      if (!subject) return;
      placed.set(key, subject);
      openHold(subject, source, { kind: source === "ask" ? "question" : "permission", id: id ?? `${source}:${Date.now()}` });
      return;
    }
    const subject = placed.get(key) ?? waitSubjectOfSession(sessionKey);
    placed.delete(key);
    if (subject) closeHold(subject, source);
  });
}

/**
 * The chat route asked the person to approve a plan (`chat.ts`, the plan
 * panel): a wait like a question, `needs-you(plan)`, never "finished". The
 * next turn, which the answer opens, closes it.
 */
export function planApprovalOpened(sessionKey: string, toolCallId: string, text?: string | null): void {
  const subject = waitSubjectOfSession(sessionKey);
  if (!subject) return;
  openHold(subject, "plan", { kind: "plan", id: toolCallId, text: text ? text.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? null : null });
}

/** The chat's tasks as its CLI's snapshot lists them now (`attentionBackground`). */
export function chatBackgroundChanged(sessionKey: string, tasks: AttentionTaskMap): void {
  const subject = chatSubjectOfSession(sessionKey);
  if (subject) setBackgroundTasks(subject, tasks);
}

/**
 * A pane was closed for good (its tombstone in the pane store). A terminal's
 * pane is the terminal: closing it is T13, the subject idle and its rows seen.
 * Accepts the pane id (`terminal:<id>`) or the bare terminal id.
 */
export function paneTombstoned(paneId: string): void {
  const subject = paneId.startsWith("terminal:") ? paneId : null;
  if (!subject) return;
  setClosed(subject, { closed: true });
}

/** A terminal's session was retired (closed by the person, or swept as an orphan). */
export function terminalClosed(terminalId: string): void {
  setClosed(terminalSubject(terminalId), { closed: true });
}

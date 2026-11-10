/**
 * Cards tied to a channel chat: a turn of that chat is the card's work.
 *
 * The board gateway opens a card with `originTopicId` = the channel chat that
 * asked for it. When that chat starts a turn the card moves to `in_progress`
 * (from backlog or todo only), and when the turn ends in an error (a provider
 * message such as "credit balance is too low") the text lands on the card as
 * a comment, so the person watching the board sees why nothing moves.
 */
import type { Database } from "bun:sqlite";
import { onTurnEnd, onTurnStart } from "../providers/turn-end-registry";
import type { TaskService } from "../services/tasks";

type Svc = Pick<TaskService, "update" | "addComment">;

const MAX_ERROR_CHARS = 400;

export function configureChannelOriginCards(db: Database, svc: Svc): () => void {
  const topicOf = (sessionKey: string): string | null => {
    const row = db.query(`SELECT id FROM topics WHERE session_key = ? LIMIT 1`).get(sessionKey) as { id: string } | null;
    return row?.id ?? null;
  };
  const cardsOf = (topicId: string, statuses: string[]): Array<{ id: string; project_id: string }> =>
    db.query(
      `SELECT id, project_id FROM tasks WHERE origin_topic_id = ? AND status IN (${statuses.map(() => "?").join(",")})`,
    ).all(topicId, ...statuses) as Array<{ id: string; project_id: string }>;

  const offStart = onTurnStart((sessionKey) => {
    try {
      const topicId = topicOf(sessionKey);
      if (!topicId) return;
      for (const c of cardsOf(topicId, ["backlog", "todo"])) {
        try {
          svc.update({ taskId: c.id, actor: "agent", by: "channel-turn", patch: { status: "in_progress" }, projectId: c.project_id });
        } catch { /* a card that refuses the move stays where it is */ }
      }
    } catch { /* a failing hook must not break the turn */ }
  });

  const offEnd = onTurnEnd((sessionKey, info) => {
    try {
      if (info.end !== "error" || !info.detail) return;
      const topicId = topicOf(sessionKey);
      if (!topicId) return;
      const text = info.detail.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
      for (const c of cardsOf(topicId, ["in_progress"])) {
        svc.addComment({ taskId: c.id, author: "system", content: `Il turno del canale è finito in errore: ${text}`, kind: "service", once: true });
      }
    } catch { /* best effort */ }
  });

  return () => { offStart(); offEnd(); };
}

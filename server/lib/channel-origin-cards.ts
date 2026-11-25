/**
 * Cards tied to a channel chat: a turn of that chat is the card's work.
 *
 * The board gateway opens a card with `originTopicId` = the channel chat that
 * asked for it. When that chat starts a turn the card moves to `in_progress`
 * (from backlog or todo only), and when the turn ends in an error (a provider
 * message such as "credit balance is too low") the text lands on the card as
 * a comment, so the person watching the board sees why nothing moves.
 *
 * ONLY A CARD THAT IS REALLY TIED TO A CHANNEL TURN. Two facts, both written
 * by the server and never declared by the caller:
 *  - the origin chat wears a channel mark (`channelKindOfIcon` on its icon,
 *    the same contract the board uses to name a card's channel);
 *  - the card was not opened by that chat itself: a `create_task` from a chat
 *    stamps `created_by_topic_id` = the chat, and that card is an intake, left
 *    in backlog until a person moves it. Promoted anyway, it sat in
 *    `in_progress` with nobody on it for hours, false on the board and in the
 *    chat's «waiting» line (17/11: 16 cards, none of a channel).
 */
import type { Database } from "bun:sqlite";
import { onTurnEnd, onTurnStart } from "../providers/turn-end-registry";
import type { TaskService } from "../services/tasks";
import { channelKindOfIcon } from "../../shared/channel-origin";

type Svc = Pick<TaskService, "update" | "addComment">;

const MAX_ERROR_CHARS = 400;

export function configureChannelOriginCards(db: Database, svc: Svc): () => void {
  const topicOf = (sessionKey: string): string | null => {
    const row = db.query(`SELECT id FROM topics WHERE session_key = ? LIMIT 1`).get(sessionKey) as { id: string } | null;
    return row?.id ?? null;
  };
  const isChannelChat = (topicId: string): boolean => {
    const row = db.query(`SELECT icon FROM topics WHERE id = ? LIMIT 1`).get(topicId) as { icon: string | null } | null;
    return channelKindOfIcon(row?.icon) !== null;
  };
  /** The cards tied to a turn of this chat: opened FOR it (gateway), not BY it (`create_task`). */
  const cardsOf = (topicId: string, statuses: string[]): Array<{ id: string; project_id: string }> => {
    if (!isChannelChat(topicId)) return [];
    return db.query(
      `SELECT id, project_id FROM tasks WHERE origin_topic_id = ? AND status IN (${statuses.map(() => "?").join(",")})
         AND (created_by_topic_id IS NULL OR created_by_topic_id != origin_topic_id)`,
    ).all(topicId, ...statuses) as Array<{ id: string; project_id: string }>;
  };

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

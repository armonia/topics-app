/**
 * A REQUEST THAT BECOMES A CARD IS CONFIRMED IN THE CHAT THAT ASKED FOR IT.
 *
 * A card opened from a chat (`created_by_topic_id`) used to be silent: the
 * person never saw that the request had become work, and the coordinator did
 * not know which chat it came from. Here an assistant line with the title and
 * a link to the card is written into the origin chat, plus a `board` activity
 * log row the coordinator reads even when not connected.
 *
 * The line wakes NO turn: it is a note written straight onto the message
 * chain, like the boot note and the one from `goal-continuation`. The "card
 * without an owner for ten minutes" check already lives in `task-dispatcher`
 * (`task:unowned`) and does not belong here.
 */

import type { Database } from "bun:sqlite";
import type { ActivityLogEntry } from "../db/activity-log";
import type { OutboundMessage } from "../../shared/ws-outbound";

/** How many title characters go in the line: the chat is not the place for the full text. */
const TITLE_MAX_CHARS = 120;

export interface CardOriginInput {
  taskId: string;
  projectId: string;
  title: string;
  /** `agent:session`, `agent:coordinator`: who opened it. */
  createdBy: string;
  sessionKey: string;
  topicId: string;
}

export interface CardOriginDeps {
  db: Database;
  broadcast(msg: OutboundMessage): void;
  recordActivity(entry: ActivityLogEntry): void;
}

/** The line text: one sentence, the title between « » and the link to the card. */
export function cardOriginText(taskId: string, title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  const short = oneLine.length > TITLE_MAX_CHARS ? `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…` : oneLine;
  return `È diventata una card: «${short}». [Apri la card](/task/${taskId})`;
}

/**
 * Writes the confirmation into the origin chat and records it for the
 * coordinator. Never throws: the confirmation is information, and a created
 * card must not fail because the chat could not be written to.
 */
export function confirmCardOrigin(deps: CardOriginDeps, input: CardOriginInput): string | null {
  const { db } = deps;
  const text = cardOriginText(input.taskId, input.title);
  try {
    const id = crypto.randomUUID();
    const maxRow = db
      .query(`SELECT COALESCE(MAX(sort_order), -1) AS mo FROM messages WHERE session_key = ?`)
      .get(input.sessionKey) as { mo: number } | null;
    const last = db
      .query(`SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1`)
      .get(input.sessionKey) as { id: string } | null;
    db.run(
      `INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index)
       VALUES (?, ?, 'assistant', ?, NULL, 0, ?, ?, ?, 0)`,
      [id, input.sessionKey, text, new Date().toISOString(), (maxRow?.mo ?? -1) + 1, last?.id ?? null],
    );
    deps.broadcast({
      type: "message:new",
      topicId: input.topicId,
      sessionKey: input.sessionKey,
      role: "assistant",
      messageId: id,
      content: text,
      preview: text.slice(0, 100),
    });
  } catch {
    return null;
  }
  deps.recordActivity({
    category: "board", level: "info", title: "card aperta da una chat",
    detail: `${input.title || "Task"} (da ${input.createdBy})`,
    entityType: "task", entityId: input.taskId, actor: input.createdBy,
    sessionKey: input.sessionKey,
    metadata: { projectId: input.projectId, createdBy: input.createdBy, topicId: input.topicId },
  });
  return text;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala

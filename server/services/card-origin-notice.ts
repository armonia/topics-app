/**
 * LA RICHIESTA CHE DIVENTA CARD SI CONFERMA NELLA CHAT CHE L'HA CHIESTA.
 *
 * Una card aperta da una chat (`created_by_topic_id`) era muta: chi aveva
 * chiesto non vedeva da nessuna parte che la richiesta era diventata lavoro, e
 * il coordinatore non sapeva da quale chat fosse arrivata. Qui si scrive una
 * riga d'assistente nella chat d'origine, con il titolo e il link alla card, e
 * una riga nel log attività (categoria `board`), che il coordinatore legge anche
 * quando non è collegato.
 *
 * La riga NON sveglia nessun turno: è una nota, come quella del boot e quella
 * di `goal-continuation`, scritta direttamente sulla catena dei messaggi. Il
 * controllo «card senza padrone oltre dieci minuti» è già in
 * `task-dispatcher` (`task:unowned`) e non va qui.
 */

import type { Database } from "bun:sqlite";
import type { ActivityLogEntry } from "../db/activity-log";
import type { OutboundMessage } from "../../shared/ws-outbound";

/** Quanti caratteri del titolo finiscono nella riga: la chat non è il posto del testo intero. */
const TITLE_MAX_CHARS = 120;

export interface CardOriginInput {
  taskId: string;
  projectId: string;
  title: string;
  /** `agent:session`, `agent:coordinator`: chi l'ha aperta. */
  createdBy: string;
  sessionKey: string;
  topicId: string;
}

export interface CardOriginDeps {
  db: Database;
  broadcast(msg: OutboundMessage): void;
  recordActivity(entry: ActivityLogEntry): void;
}

/** Il testo della riga: una frase, il titolo fra «» e il link alla card. */
export function cardOriginText(taskId: string, title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  const short = oneLine.length > TITLE_MAX_CHARS ? `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…` : oneLine;
  return `È diventata una card: «${short}». [Apri la card](/task/${taskId})`;
}

/**
 * Scrive la conferma nella chat d'origine e la registra per il coordinatore.
 * Non lancia: la conferma è informazione, e una card creata non deve fallire
 * perché la chat non si è lasciata scrivere.
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

/**
 * THE PERSON'S LAST MESSAGE ALREADY HAD ITS TURN: read off the thread.
 *
 * The resume sweep resends the person's last message (lib/ripresa-boot.ts),
 * and every notice that promises that resend has to ask the same question
 * first: did a turn under that message already end before this row? The
 * route's notices and the late-answer lane (routes/chat.ts), the stale
 * sweeper's finalize (lib/closed-outside.ts) and the sweep itself read the
 * one rule here, so "Riprende da solo" is written where the sweep keeps it.
 *
 * With it, the two readers of a row's blocks the rule is made of: where the
 * last interruption verdict of ours sits, and what counts as produced.
 */
import type { Database } from "bun:sqlite";
import type { ContentBlock } from "../types";
import { decodeCol } from "../../shared/message-blob";
import {
  eCartelloDiInterruzione, isResumableCause, STOP_PRESSED_LOG_TITLE, USER_ABORT_LOG_TITLE,
} from "./cancelled-notice";

/** A chain longer than this is not a chain: `parent_id` is cyclic or corrupt. */
export const CHAIN_WALK_LIMIT = 64;

/** An interruption verdict of ours: recognised by its text or by its cause. */
function isInterruptionVerdict(b: ContentBlock | null | undefined): boolean {
  if (b?.kind !== "error") return false;
  const text = (b as { text?: unknown }).text;
  return eCartelloDiInterruzione(typeof text === "string" ? text : "")
    || isResumableCause((b as { cause?: unknown }).cause);
}

/** Where the last interruption verdict sits among a row's blocks, or -1. */
export function lastInterruptionIndex(blocks: ContentBlock[] | null): number {
  if (!Array.isArray(blocks)) return -1;
  for (let i = blocks.length - 1; i >= 0; i--) if (isInterruptionVerdict(blocks[i])) return i;
  return -1;
}

/** Something a turn produced: prose with words in it, or a tool call. The
 *  resend trace (`ripreso`) and an empty text block are not an answer. */
export function isProducedContent(b: ContentBlock | null | undefined): boolean {
  if (b?.kind === "tool") return true;
  const text = (b as { text?: unknown } | null | undefined)?.text;
  return b?.kind === "text" && typeof text === "string" && text.trim() !== "";
}

/** A row of the thread, as `answeredBeforeRow` reads it. */
interface ThreadRow {
  role: string; content: unknown; blocks: unknown; parent_id: string | null; timestamp: string;
  partial: number | null; latency_ms: number | null; end_reason: string | null;
}

/**
 * THE PERSON'S LAST MESSAGE HAD ITS TURN BEFORE THIS ROW.
 *
 * The resend is the person's last message. A row that comes after a turn
 * which already ended under that message is a later turn, one the CLI opened
 * on its own (a wake: a Monitor firing, a background task reporting), and a
 * resend would run the answered message a second time: a paid turn, with every
 * effect again. The row's own `woken` mark cannot be the proof: the route
 * keeps it in memory until the first tool or the tenth chunk of text, and a
 * reload in that window (every save under server/ on this Mac) hands the row
 * to a reattach that never writes it, or to a history cleanup that deletes
 * the row and lets the reattach open a new one.
 *
 * Walks `parent_id` up from the row to the person's message. A row met on the
 * way is a turn that ended (`turnEndedUncut`), or it is not; at the message,
 * a turn that ended and left no row (`turnLeftNoRow`). What a resend chain
 * leaves between the message and its cut (the cut turns, the boot's and the
 * sweep's notices, service lines written whole) is none of that, and keeps
 * its resend. A database that cannot answer is no evidence.
 */
export function answeredBeforeRow(db: Pick<Database, "query">, sessionKey: string, rowId: string): boolean {
  try {
    const read = db.query(
      `SELECT role, content, blocks, parent_id, timestamp, partial, latency_ms, end_reason
         FROM messages WHERE id = ? AND session_key = ?`,
    );
    const cutRow = read.get(rowId, sessionKey) as ThreadRow | null;
    let id = cutRow?.parent_id ?? null;
    for (let hop = 0; cutRow && id && hop < CHAIN_WALK_LIMIT; hop++) {
      const row = read.get(id, sessionKey) as ThreadRow | null;
      if (row?.role === "user") return turnLeftNoRow(db, sessionKey, { id, timestamp: row.timestamp }, cutRow.timestamp);
      if (!row || row.role !== "assistant") return false;
      if (turnEndedUncut(row)) return true;
      id = row.parent_id;
    }
  } catch { /* no evidence: the resend keeps the rule it had */ }
  return false;
}

/**
 * A row closed as a turn that ended, and not by a cut of ours.
 *
 * Read off how the row was closed: `end_reason` where it is written, and
 * `latency_ms`, which only the route's own finalize writes, for the rows
 * before that column. Closed from outside or by a restart is not an end: the
 * late-answer lane writes the end on a row whose answer came after all. An
 * interruption verdict with nothing produced after it is a cut. A row written
 * whole (`done` with no latency) ended only when it holds an answer: a
 * regenerated or streamed reply, a command's answer, a report. The notices
 * and the service lines hold no prose and no tool.
 */
function turnEndedUncut(row: ThreadRow): boolean {
  if (row.partial) return false;
  if (row.end_reason === "closed-outside" || row.end_reason === "cut-by-restart") return false;
  let blocks: ContentBlock[] | null = null;
  try { blocks = JSON.parse(decodeCol(row.blocks) ?? "null") as ContentBlock[] | null; } catch { return false; }
  const cut = lastInterruptionIndex(blocks);
  if (cut >= 0) return (blocks ?? []).slice(cut + 1).some(isProducedContent);
  if (row.latency_ms != null) return true;
  if (row.end_reason !== "done") return false;
  return blocks?.length ? blocks.some(isProducedContent) : (decodeCol(row.content) ?? "").trim() !== "";
}

/**
 * A TURN UNDER THE MESSAGE ENDED AND LEFT NO ROW, before the cut row was born.
 *
 * The route discards an empty answer: a /compact ends at its boundary with
 * nothing to show, a Stop before any output leaves nothing. The next turn
 * then hangs from the message itself, as its own answer would. What stays on
 * disk says it apart: the /compact's divider anchored to the message (the
 * route writes it against the answer's parent), and the person's Stop in
 * `activity_log`. Both only between the message and the birth of the cut row:
 * a compaction or a Stop during the cut turn itself is that turn's own.
 *
 * Only a divider the person asked for (`manual`). The CLI also compacts by
 * itself in the middle of a long turn, and the route anchors that divider to
 * the message the turn answers: an `auto` one is the answer's own work, and it
 * stays anchored there when the answer's row is not the cut row (a restart
 * cuts it and writes its notice after it; the history's cleanup deletes it
 * empty and the reattach opens a row of its own).
 */
function turnLeftNoRow(
  db: Pick<Database, "query">, sessionKey: string, message: { id: string; timestamp: string }, rowBornAt: string,
): boolean {
  const compacted = () => !!db.query(
    `SELECT 1 FROM compaction_markers
      WHERE session_key = ? AND after_message_id = ? AND trigger = 'manual' AND created_at < ? LIMIT 1`,
  ).get(sessionKey, message.id, rowBornAt);
  const stopped = () => !!db.query(
    `SELECT 1 FROM activity_log
      WHERE session_key = ? AND category = 'stream' AND title IN (?, ?) AND timestamp >= ? AND timestamp < ? LIMIT 1`,
  ).get(sessionKey, USER_ABORT_LOG_TITLE, STOP_PRESSED_LOG_TITLE, message.timestamp, rowBornAt);
  // Each on its own: a database without one of the tables is no evidence from it.
  const holds = (probe: () => boolean) => { try { return probe(); } catch { return false; } };
  return holds(compacted) || holds(stopped);
}

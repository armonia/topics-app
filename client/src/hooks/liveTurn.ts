/**
 * The identity of the bubble a turn is WRITING, and what a broadcast may do to it.
 *
 * `stream:start` announces the durable id of the in-flight assistant row and the
 * placeholder carries it. Two things read that name, and both used to guess:
 *
 *  - the three writers of a live turn (`updateLastMessage`, `appendToLastMessage`,
 *    `addToolCallToLastMessage`) picked "the last assistant message", which stops
 *    being the turn as soon as the server persists a sub-agent report mid-turn
 *    (`server/lib/subagent-watch.ts`);
 *  - the id dedupe of a persisted broadcast, which now matches the placeholder
 *    (same durable id) and so returned early instead of filling it.
 *
 * Both decisions live here, pure and testable. The registry is bounded because
 * `useChat` is one instance for the life of the page: a Map keyed by sessionKey
 * that only ever gets `set` grows with every chat ever opened.
 */

import type { ChatMessage } from '../types';

/**
 * How many sessions keep a remembered in-flight id.
 *
 * Eviction is not a correctness risk: without a name the readers fall back to
 * "the last assistant message", which is the behaviour that shipped for a year.
 * The cap only bounds what a long-lived page retains.
 */
export const LIVE_TURN_MAX_SESSIONS = 64;

/**
 * sessionKey -> id of the row the in-flight turn is writing. Lives as long as
 * the turn: every path on which a turn dies must call `end`, or a dead name
 * outlives its bubble and the NEXT turn writes into the corpse (the reader
 * finds the old id at its old index and never looks at the fresh placeholder).
 */
export class LiveTurnIds {
  private readonly ids = new Map<string, string>();

  begin(sessionKey: string, messageId: string): void {
    // Delete before set so insertion order is recency order: the Map iterator
    // yields oldest first, which is what the eviction below drops.
    this.ids.delete(sessionKey);
    this.ids.set(sessionKey, messageId);
    while (this.ids.size > LIVE_TURN_MAX_SESSIONS) {
      const oldest = this.ids.keys().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
  }

  end(sessionKey: string): void {
    this.ids.delete(sessionKey);
  }

  get(sessionKey: string): string | undefined {
    return this.ids.get(sessionKey);
  }

  get size(): number {
    return this.ids.size;
  }
}

/**
 * The bubble the turn is WRITING, by name when we know it.
 *
 * "The last assistant message" was a good approximation while nothing else
 * arrived during an open turn. The server writes plenty: a sub-agent exit is a
 * row of its own, persisted and broadcast while the turn continues, and from
 * that moment "the last one" is IT, so the rest of the answer ended up glued
 * under the sub-agent report.
 *
 * Without an announced name (the SSE path, where these events do not travel at
 * all) it falls back to the last message, which is the long-standing behaviour.
 */
export function liveAssistantIndex(msgs: ChatMessage[], liveId: string | undefined): number {
  if (liveId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].id === liveId && msgs[i].role === 'assistant') return i;
    }
  }
  const last = msgs.length - 1;
  return last >= 0 && msgs[last].role === 'assistant' ? last : -1;
}

/**
 * The bubble a FRAME names, when it names one.
 *
 * A turn the server already closed can still receive its answer (a send that
 * waited in the provider's queue), and the server keeps it on that turn's row.
 * The client had cleared the turn's live id at `stream:end`, so the late frames
 * fell to "the last assistant message": the sweep's notice, or the next turn
 * while it streams (review of PR #135). A frame that names its row goes there;
 * a LATE frame whose bubble is not in view goes nowhere, since the database has
 * it and a reload shows it where it belongs. A live frame whose name is unknown
 * here (a window that only watches another's turn holds a local id) keeps the
 * long-standing fallback.
 */
export function frameTargetIndex(
  msgs: ChatMessage[],
  liveId: string | undefined,
  frame: { messageId?: string; late?: true } | undefined,
): number {
  if (frame?.messageId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].id === frame.messageId && msgs[i].role === 'assistant') return i;
    }
    if (frame.late) return -1;
  }
  return liveAssistantIndex(msgs, liveId);
}

/**
 * A persisted row arrived for a message we ALREADY have. Does its content still
 * need to land?
 *
 * Yes exactly when the local row is an assistant bubble that is empty or still
 * partial and the broadcast carries more text than we hold. That is the window
 * without deltas: content chunks travel through `broadcastToTopicSubscribers`
 * and are dropped for a client whose `openTopicIds` lacks the topic, while
 * `stream:start` / `message:new` / `stream:end` are broadcast to all. Such a
 * window used to be filled by the adopt branch, which no longer runs now that
 * the placeholder carries the durable id: the id dedupe matches first and the
 * bubble stayed empty until the next `loadHistory`.
 *
 * Strictly-longer is the guard against the opposite mistake: `message:new` may
 * carry a TRUNCATED preview, and a shorter text must never overwrite the full
 * one we streamed.
 */
export function shouldFillFromBroadcast(existing: ChatMessage | undefined, incomingContent: string): boolean {
  if (!existing || existing.role !== 'assistant') return false;
  const held = existing.content ?? '';
  if (held.length > 0 && !existing.partial) return false;
  return incomingContent.length > held.length;
}

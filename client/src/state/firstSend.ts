import type { ChatMessage } from '../types';
import { CLIENT_MESSAGE_ID_PREFIX } from '../hooks/streamCatchupMerge';
import { evictSessions, getSessionMessagesFromStore, updateMessages } from './messageStore';

/**
 * The user's bubble of a draft's first send, on screen before the topic exists.
 *
 * The first message of a new chat waited for the topic: `promoteDraft` created
 * it on the server, remapped the pane, and only then did `sendMessage` put the
 * bubble in the message store. The request is quick (POST /api/topics 2-17 ms);
 * what the bubble waited for was the frame after it, and the renders the
 * promotion sets off (client-speed audit, 30/09: 192-341 ms from Enter to the
 * bubble on a copy of a real workspace).
 *
 * So the bubble goes into the DRAFT's session at the key, and the draft's own
 * pane draws it on the next frame. When the topic exists it is copied, with its
 * id, into the topic's session before anything renders the promoted pane, and
 * `sendMessage` is told that id (`userMessageId`): the send adds nothing new,
 * and the pane, which the promotion does not remount, keeps the same row.
 *
 * If the promotion ends without a send (no topic, or the id already open in
 * another pane) the bubble is withdrawn: nothing was sent.
 */

/** The session a draft pane shows (see `useActivePaneState`'s synthetic topics). */
export function draftSessionKey(draftId: string): string {
  return `draft-session:${draftId}`;
}

const newMessageId = () => `${CLIENT_MESSAGE_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

/** Put the first message in the draft's session, as the optimistic bubble `sendMessage` would have added. Returns its id. */
export function stageFirstBubble(sessionKey: string, content: string): string {
  const bubble: ChatMessage = { id: newMessageId(), role: 'user', content, timestamp: new Date().toISOString() };
  updateMessages((prev) => ({ ...prev, [sessionKey]: [...(prev[sessionKey] ?? []), bubble] }));
  return bubble.id;
}

/**
 * Copy the draft's rows into the topic's session, ids included.
 *
 * COPIED, not moved: the draft's pane can still render once or twice with its
 * old topic inside the promotion's own task (measured: two renders between this
 * write and the one that brings the new topic). An emptied draft session there
 * is an empty chat for a frame: the list unmounts, the greeting comes back, and
 * the bubble is a new node when the list returns. The draft's copy goes once
 * nobody shows it any more (`evictSessions` refuses a watched session).
 */
export function carryFirstBubble(from: string, to: string): void {
  const rows = getSessionMessagesFromStore(from);
  if (rows.length === 0) return;
  updateMessages((prev) => ({ ...prev, [to]: [...(prev[to] ?? []), ...rows] }));
  setTimeout(() => evictSessions([from]), 0);
}

/** Take the staged bubble away: the promotion ended without sending it. */
export function withdrawFirstBubble(sessionKey: string, id: string): void {
  updateMessages((prev) => {
    const rows = prev[sessionKey];
    if (!rows || !rows.some((m) => m.id === id)) return prev;
    const kept = rows.filter((m) => m.id !== id);
    const next = { ...prev };
    if (kept.length > 0) next[sessionKey] = kept;
    else delete next[sessionKey];
    return next;
  });
}

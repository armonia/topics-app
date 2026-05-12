// Pure merge logic for `stream:catchup` events.
//
// The server emits `stream:catchup` on every fresh WS connect (initial app
// load, browser refresh, network reconnect, second window). It carries the
// in-memory accumulated text + thinking AND the persisted toolCalls + blocks
// from the partial DB row, so a late joiner sees the full mid-stream state
// instead of an empty bubble that suddenly fills in via subsequent
// stream:content_chunk deltas.
//
// This module isolates the merge from React state hooks so the invariants
// can be unit-tested without rendering the chat. The actual integration
// path lives in `useChat.ts` (case 'stream:catchup').
//
// Merge invariants
// ────────────────
// 1. When a partial assistant message already exists locally (e.g. a tool
//    call that arrived via WS before catchup, or a previous catchup), we
//    UPDATE it in place — never replace it. Replacing would discard local
//    progress that the server hasn't observed yet.
//
// 2. Server-truth fields (toolCalls/blocks from DB) take precedence ONLY
//    when present in the catchup event. `undefined` means "server did not
//    send this — keep whatever the local partial already had". This is
//    what makes a tool_call event arriving before catchup safe: catchup
//    doesn't wipe it.
//
// 3. Content/thinking: catchup carries the cumulative text from the
//    in-memory stream buffer. We prefer the catchup value when non-empty,
//    but fall back to the existing partial to avoid clobbering local
//    state with a "" (e.g. when the stream just started and the buffer
//    hasn't received its first delta yet).

import type { ChatMessage, ContentBlock, ToolCall } from '../types';

export interface CatchupPayload {
  messageId?: string;
  content?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  blocks?: ContentBlock[];
}

/**
 * Compute the next assistant message for a session given the incoming
 * catchup payload and the current last message (may be undefined).
 *
 * Returns the new/updated assistant message that should replace or be
 * appended to the session's message list. The caller is responsible for
 * splicing it into state.
 */
export function mergeCatchupIntoPartial(
  payload: CatchupPayload,
  lastMessage: ChatMessage | undefined,
  generateId: () => string,
  nowIso: string,
): ChatMessage {
  // Prefer server-truth tool/block lists when the catchup carries them;
  // otherwise keep whatever the local partial already has so a tool_call
  // event that arrived between WS open and catchup delivery isn't lost.
  const mergedToolCalls = payload.toolCalls ?? lastMessage?.toolCalls;
  const mergedBlocks = payload.blocks ?? lastMessage?.blocks;

  if (lastMessage?.role === 'assistant' && lastMessage.partial) {
    return {
      ...lastMessage,
      content: payload.content || lastMessage.content || '',
      thinking: payload.thinking || lastMessage.thinking,
      toolCalls: mergedToolCalls,
      blocks: mergedBlocks,
    };
  }

  return {
    id: payload.messageId || generateId(),
    role: 'assistant',
    content: payload.content || '',
    thinking: payload.thinking || undefined,
    toolCalls: mergedToolCalls,
    blocks: mergedBlocks,
    timestamp: nowIso,
    partial: true,
  };
}

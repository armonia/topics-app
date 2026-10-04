// A fact about a tool row that reaches the window BEFORE the row does.
//
// The window that sent the message builds its rows from its own SSE and takes
// only a few frames from WS (`senderAlsoSees.ts`). Two of those frames turn the
// row into a panel waiting for the person: `stream:tool_user_input_required`
// (the question form) and `stream:tool_permission_required` (the permission
// panel). They were applied by id to the rows already on screen, and when the
// row was not there yet the frame was dropped.
//
// It is not there yet more often than it looks. WebKit can hold a burst of the
// fetch stream until the next byte arrives: in the native runtime a question
// queued behind a shell is announced in a burst that stays held until the shell
// ends, and the shell's end is the very moment the question is asked. Measured
// on 04/10 (`chat-native-tool-phases.spec.ts`, sender timeline): the WS frame
// with the form landed while the row's announcements were still held; the held
// burst then gave birth to the row as `pending`, then `running`, and the SSE
// copy of the question was the last byte before the turn paused, so WebKit
// kept that one back for good. The row spun with a clock and no form until a
// reload, while the database and every other window said "waiting for you".
//
// So a fact for a row that does not exist yet is held here, per session and per
// id, and applied the moment the row is born. From there `withToolAnnouncement`
// keeps it: a later announcement cannot take a row out of `waiting_for_input`
// or `awaiting_permission`.

import type { ChatMessage, ContentBlock, ToolCall } from '../types';
import { withToolAnnouncement } from './toolUpdatePatch';

/** What a frame does to its row: a pure function of the row. */
export type ToolFact = (tc: ToolCall) => ToolCall;

/** Facts waiting for their row, by session and tool-call id. */
export class HeldToolFacts {
  private readonly bySession = new Map<string, Map<string, ToolFact>>();

  /** Keeps a fact for a row not born yet; a second fact for the same row applies after the first. */
  hold(sessionKey: string, toolCallId: string, fact: ToolFact): void {
    const forSession = this.bySession.get(sessionKey) ?? new Map<string, ToolFact>();
    const earlier = forSession.get(toolCallId);
    forSession.set(toolCallId, earlier ? (tc) => fact(earlier(tc)) : fact);
    this.bySession.set(sessionKey, forSession);
  }

  /** The row as it is born: with the held facts applied, which are then gone. */
  bear(sessionKey: string, toolCall: ToolCall): ToolCall {
    const forSession = this.bySession.get(sessionKey);
    const fact = forSession?.get(toolCall.id);
    if (!forSession || !fact) return toolCall;
    forSession.delete(toolCall.id);
    if (forSession.size === 0) this.bySession.delete(sessionKey);
    return fact(toolCall);
  }

  /** Drops what a session held: its turn ended, and the history reload carries the server's state. */
  clear(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }
}

/** The question a `stream:tool_user_input_required` frame asks, on its row. */
export function withQuestionAsked(schema: ToolCall['userInputSchema']): ToolFact {
  return (tc) => ({ ...tc, status: 'waiting_for_input', userInputSchema: schema });
}

/** The permission a `stream:tool_permission_required` frame asks for, on its row. */
export function withPermissionAsked(request: ToolCall['permissionRequest']): ToolFact {
  return (tc) => ({ ...tc, status: 'awaiting_permission', permissionRequest: request, permissionOutcome: undefined });
}

/**
 * The messages with one tool row patched by id, in both the legacy `toolCalls`
 * bucket and the `blocks` timeline. The same array when the row is not there,
 * or when the patch changed nothing, so an unknown id redraws nothing.
 */
export function patchToolCallInMessages(msgs: ChatMessage[], toolCallId: string, patch: ToolFact): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    // One application of the patch: both containers must end with the SAME object.
    const source =
      (m.toolCalls ?? []).find((t) => t.id === toolCallId) ??
      (m.blocks ?? []).flatMap((b) => (b.kind === 'tool' && b.toolCall.id === toolCallId ? [b.toolCall] : []))[0];
    if (!source) continue;
    const next = patch(source);
    if (next === source) return msgs; // a patch that changed nothing (a late partial) redraws nothing
    const nextCalls = m.toolCalls?.map((t) => (t.id === toolCallId ? next : t));
    const nextBlocks = m.blocks?.map((b) =>
      b.kind === 'tool' && b.toolCall.id === toolCallId ? { kind: 'tool' as const, toolCall: next } : b,
    );
    const out = msgs.slice();
    out[i] = { ...m, ...(nextCalls ? { toolCalls: nextCalls } : {}), ...(nextBlocks ? { blocks: nextBlocks } : {}) };
    return out;
  }
  return msgs;
}

function hasToolCall(msgs: ChatMessage[], toolCallId: string): boolean {
  return msgs.some((m) => m.role === 'assistant' && (
    (m.toolCalls ?? []).some((t) => t.id === toolCallId)
    || (m.blocks ?? []).some((b) => b.kind === 'tool' && b.toolCall.id === toolCallId)));
}

/** The messages with a fact applied to its row, or untouched with the fact held when the row is not born yet. */
export function patchToolCallOrHold(
  msgs: ChatMessage[],
  held: HeldToolFacts,
  sessionKey: string,
  toolCallId: string,
  fact: ToolFact,
): ChatMessage[] {
  if (!hasToolCall(msgs, toolCallId)) {
    held.hold(sessionKey, toolCallId, fact);
    return msgs;
  }
  return patchToolCallInMessages(msgs, toolCallId, fact);
}

/**
 * The message with an announced tool call merged in by id
 * (`withToolAnnouncement`), or appended as a new row with whatever facts were
 * held for it. A new tool block goes at the end of the timeline.
 */
export function withAnnouncedToolCall(
  msg: ChatMessage,
  announced: ToolCall,
  held: HeldToolFacts,
  sessionKey: string,
): ChatMessage {
  const existingIdx = (msg.toolCalls ?? []).findIndex((t) => t.id === announced.id);
  if (existingIdx >= 0) {
    const nextToolCalls = msg.toolCalls!.slice();
    const merged = withToolAnnouncement(msg.toolCalls![existingIdx]!, announced);
    nextToolCalls[existingIdx] = merged;
    const nextBlocks = msg.blocks?.map((b) =>
      b.kind === 'tool' && b.toolCall.id === announced.id ? { kind: 'tool' as const, toolCall: merged } : b,
    );
    return { ...msg, toolCalls: nextToolCalls, blocks: nextBlocks };
  }
  const born = held.bear(sessionKey, announced);
  const block: ContentBlock = { kind: 'tool', toolCall: born };
  return {
    ...msg,
    toolCalls: msg.toolCalls ? [...msg.toolCalls, born] : [born],
    blocks: [...(msg.blocks ?? []), block],
  };
}

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ChatFindPart } from '../../../shared/chat-find';
import { useChatTopicId } from '../components/Chat/chatTopicContext';

/**
 * The chat find result the reader is ON right now, so the closed thing that
 * holds it opens (CHAT-FIND-02): the reasoning row, the tool row and the tool
 * group around it, the clamped body of a long output.
 *
 * One value for the whole app: only one result is "current" at a time, the
 * one the last Enter / ⌘G moved to. `seq` changes at every move, so a row
 * opens on the EDGE of becoming current (the way the failure badge opens a
 * row, `ToolCallRow.highlighted`) and then stays as the reader leaves it:
 * closing the bar does not close what it opened.
 */
export interface ChatFindFocus {
  topicId: string;
  messageId: string;
  part: ChatFindPart;
  toolCallId?: string;
  /** The searched word, for the clamped body to know whether to expand. */
  query: string;
  matchCase: boolean;
  seq: number;
}

let current: ChatFindFocus | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function setChatFindFocus(f: Omit<ChatFindFocus, 'seq'> | null): void {
  current = f ? { ...f, seq: ++seq } : null;
  for (const fn of [...listeners]) fn();
}

export function getChatFindFocus(): ChatFindFocus | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The focus `seq` when `pick` says the focus is about the caller, else 0. */
function useFocusSeq(pick: (f: ChatFindFocus) => boolean): number {
  return useSyncExternalStore(
    subscribe,
    () => (current && pick(current) ? current.seq : 0),
    () => 0,
  );
}

/** A tool row: non-zero while the current result is inside this call. */
export function useFindFocusTool(toolCallId: string | undefined): number {
  return useFocusSeq((f) => !!toolCallId && f.part === 'tool' && f.toolCallId === toolCallId);
}

/** A tool group: non-zero (and which call) while the current result is in one of its calls. */
export function useFindFocusToolIn(toolCallIds: readonly string[]): { seq: number; toolCallId: string | null } {
  const s = useFocusSeq((f) => f.part === 'tool' && !!f.toolCallId && toolCallIds.includes(f.toolCallId));
  return { seq: s, toolCallId: s && current ? current.toolCallId ?? null : null };
}

/**
 * A reasoning row: non-zero while the current result is a reasoning of this
 * chat that holds the word. Matched on the chat and the text, not only on the
 * message id: a run of work-only messages is drawn as ONE item carrying the
 * id of its first message (`coalesceToolRun`), so the id the row knows can be
 * another message's.
 */
export function useFindFocusThinking(messageId: string | undefined, text: string): number {
  const topicId = useChatTopicId();
  return useFocusSeq((f) => f.part === 'thinking'
    && (f.messageId === messageId || (!!topicId && f.topicId === topicId))
    && includesQuery(text, f));
}

/** What a closed fold holds, for {@link useFindFocusInFold}. */
export interface FindFoldScope {
  messageId?: string;
  /** The tool calls inside the fold. */
  toolCallIds: readonly string[];
  /** The text and reasoning inside the fold; absent = the whole message folds. */
  texts?: readonly string[];
}

/**
 * A fold (a finished turn's work, `turnFold.ts`; a board task's message):
 * non-zero while the current result is inside it. The fold mounts its rows
 * only when open (`DisclosureBody`), so the rows' own subscriptions above
 * cannot open anything until the fold has.
 */
export function useFindFocusInFold(scope: FindFoldScope): number {
  const topicId = useChatTopicId();
  return useFocusSeq((f) => {
    if (f.part === 'tool') {
      return (!!f.toolCallId && scope.toolCallIds.includes(f.toolCallId))
        || (!scope.texts && f.messageId === scope.messageId);
    }
    // Reasoning matched on the chat too, as `useFindFocusThinking` does.
    const mine = f.messageId === scope.messageId || (f.part === 'thinking' && !!topicId && f.topicId === topicId);
    if (!mine) return false;
    return !scope.texts || scope.texts.some((t) => includesQuery(t, f));
  });
}

function includesQuery(text: string, f: ChatFindFocus): boolean {
  if (!f.query) return false;
  return f.matchCase ? text.includes(f.query) : text.toLowerCase().includes(f.query.toLowerCase());
}

/** The tool call whose body is being drawn, for {@link useFindExpandsClamp}. */
export const FindToolIdContext = createContext<string | null>(null);

/**
 * A clamped body (`clampBody`, 20,000 characters) expands when the current
 * result is in its tool call and the word is past the cut.
 */
export function useFindExpandsClamp(full: string, shown: string): boolean {
  const toolCallId = useContext(FindToolIdContext);
  const s = useFocusSeq((f) => !!toolCallId && f.part === 'tool' && f.toolCallId === toolCallId
    && includesQuery(full, f) && !includesQuery(shown, f));
  return s > 0;
}

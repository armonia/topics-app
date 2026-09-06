/**
 * "This chat is the session of a board task" travels as a context, and not as
 * a prop, for one reason: the only place that needs the answer is the message
 * row, five levels down a list that re-renders on every streamed token. A prop
 * would have to cross `MessageList`, its Virtuoso item and `MessageBubble`,
 * which is memoised precisely so that it does NOT re-render.
 *
 * False everywhere else, which is the whole no-regression promise: a normal
 * conversation renders as it always has.
 */
import { createContext, useContext } from 'react';

export const TaskWorkFoldContext = createContext(false);

/** True only inside the chat of a task. */
export function useTaskWorkFold(): boolean {
  return useContext(TaskWorkFoldContext);
}

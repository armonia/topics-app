/**
 * The topic of the chat being drawn, for the rows deep in the list that need it
 * (the browser marker reopens a page in THIS chat's window). A context and not
 * a prop for the reason `taskWorkFoldContext` gives: the list is memoised so
 * that a streamed token does not re-render every bubble.
 *
 * Empty outside a chat pane: the marker then opens its page as a tab.
 */
import { createContext, useContext } from 'react';

export const ChatTopicContext = createContext('');

export function useChatTopicId(): string {
  return useContext(ChatTopicContext);
}

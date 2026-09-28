/**
 * A USER ROW OF THE CARD'S SESSION, as the drawer draws it.
 *
 * Something typed into the topic itself rather than into the card gets the
 * same grey bubble a comment of yours gets: it is the same voice, and two
 * greys for one person would be a difference that means nothing. The end of
 * a command the agent started is a `user` row too (a provider only answers
 * those), and it is the machine's line, as in the chat.
 *
 * In its own file so that it can be rendered by a test: `TaskDetail.tsx`
 * imports through the `@/` alias, which `bun test` does not resolve.
 */
import { ChatMarkdown } from '../ChatMarkdown';
import { processExitOf } from '../Chat/machineRow';
import { ProcessExitRow } from '../Chat/ProcessExitRow';
import { COMPACT_MD_CLS } from './constants';
import type { ChatMessage } from '../../types';

export function TaskSessionUserRow({ message }: { message: Pick<ChatMessage, 'id' | 'content' | 'blocks'> }) {
  const exit = processExitOf(message.blocks);
  if (exit) return <ProcessExitRow messageId={message.id} block={exit} content={message.content} />;
  return (
    <div className="flex justify-end">
      <div className="user-bubble max-w-[88%] rounded-lg bg-app-user-bubble px-2.5 py-1.5 text-body-lg leading-5 text-app-text">
        <div className={COMPACT_MD_CLS}><ChatMarkdown components={{}}>{message.content}</ChatMarkdown></div>
      </div>
    </div>
  );
}

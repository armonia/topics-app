import { MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';

export interface ChatRowModel {
  id: string;
  title: string;
  /** The last line of the conversation. */
  last: string;
  /** When it last moved, in words. */
  when: string;
}

/** Every chat, newest first: title, last line, when. */
export function ChatList({ chats, label, openLabel, onOpen }: {
  chats: ChatRowModel[];
  label: string;
  openLabel: (title: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <ul aria-label={label} data-chat-list="" className="mx-auto w-full max-w-[760px] px-4 py-3">
      {chats.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            data-chat-row={c.id}
            aria-label={openLabel(c.title)}
            onClick={() => onOpen(c.id)}
            className={clsx('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}
          >
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-black/[0.05] text-app-text-tertiary dark:bg-white/[0.08]">
              <MessageSquare size={15} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-prose font-semibold text-app-text">{c.title}</span>
              <span className="block truncate text-compact text-app-text-secondary">{c.last}</span>
            </span>
            <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{c.when}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

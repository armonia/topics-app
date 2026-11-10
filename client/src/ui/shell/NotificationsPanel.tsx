import clsx from 'clsx';
import { Popover } from '../primitives/Popover';
import { NOTICE_ICON, NOTICE_TEXT, type NoticeTone } from '../primitives/notice';
import { FOCUS_RING } from './pressable';

export interface NotificationModel {
  id: string;
  title: string;
  body?: string;
  /** When, already formatted: `ora`, `12 min`, `ieri`. */
  when: string;
  tone: NoticeTone;
  unread: boolean;
}

/**
 * The notifications, under the bell of the sidebar (fixed 8px from the left,
 * 44px from the top); on a phone a sheet across the top. A row per message
 * with its kind's glyph, unread ones in bold with a blue dot; pressing a row
 * opens what it is about. «Mark all read» shows only while something is unread.
 */
export function NotificationsPanel({ title, items, onOpen, onMarkAllRead, markAllLabel, empty, onClose, unreadLabel }: {
  title: string;
  items: NotificationModel[];
  onOpen: (id: string) => void;
  onMarkAllRead?: () => void;
  markAllLabel: string;
  /** The line shown when there is nothing. */
  empty: string;
  onClose: () => void;
  /** Read by a screen reader after an unread row. */
  unreadLabel?: string;
}) {
  const unread = items.filter((n) => n.unread).length;
  return (
    <Popover
      fixed
      onClose={onClose}
      ariaLabel={title}
      className="left-2 top-11 flex max-h-[min(560px,calc(100dvh-56px))] w-[360px] flex-col overflow-hidden max-sm:inset-x-0 max-sm:top-0 max-sm:max-h-[80dvh] max-sm:w-auto max-sm:rounded-t-none max-sm:border-x-0 max-sm:border-t-0 max-sm:pt-[env(safe-area-inset-top)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-app-border pl-3.5 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-prose font-semibold text-app-text">{title}</h2>
        {onMarkAllRead && unread > 0 && (
          <button
            type="button"
            onClick={onMarkAllRead}
            className={clsx('rounded-md px-1.5 py-1 text-mini font-medium text-primary transition-colors hover:bg-primary/10 dark:text-primary-dark', FOCUS_RING)}
          >
            {markAllLabel}
          </button>
        )}
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-10 text-center text-prose text-app-text-tertiary">{empty}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {items.map((n) => {
            const Icon = NOTICE_ICON[n.tone];
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onOpen(n.id)}
                  className={clsx('flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-black/[0.04] coarse:py-3 dark:hover:bg-white/[0.06]', FOCUS_RING, 'focus-visible:ring-inset')}
                >
                  <Icon size={15} className={clsx('mt-0.5 shrink-0', NOTICE_TEXT[n.tone])} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className={clsx('min-w-0 flex-1 truncate text-prose leading-5', n.unread ? 'font-semibold text-app-text' : 'text-app-text-secondary')}>{n.title}</span>
                      <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{n.when}</span>
                    </span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-mini leading-4 text-app-text-secondary">{n.body}</span>}
                  </span>
                  <span className="flex h-5 w-2 shrink-0 items-center">
                    {n.unread && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#0a84ff]" />}
                  </span>
                  {n.unread && unreadLabel && <span className="sr-only">{unreadLabel}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}

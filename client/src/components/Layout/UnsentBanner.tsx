// UnsentBanner: the unsent messages of chats that are NOT on screen, grouped
// BY CHAT, in a band at the foot of the grid.
//
// History. It started as one amber pill reading "1 message not sent": a global
// count, English only, one Retry for everything. Then it named the chat and
// took you there (CHAT-QUEUE-05). It still floated `absolute` over the grid,
// though, and on 24/09 it was reported sitting on top of a random pane's
// composer and cut off: with three columns the centred toast landed on
// whatever pane was under the middle of the screen.
//
// Now a message of a chat on screen is shown INSIDE that chat, above its
// composer (`UnsentStrip`), and this band only lists the rest. It is laid out
// IN FLOW, never as an overlay: under the grid on the desktop, so it takes its
// own height instead of covering a pane; inside the alarm band above the
// bottom bar on the phone, which reserves its own height and stays visible
// with the drawer open (the phone's home screen IS the drawer).
//
// A row is still the way in: clicking it opens (or focuses) that chat through
// the same `topics:open-topic` funnel the notifications use, and once the chat
// is on screen its message moves into the chat's own strip. Retry and discard
// stay PER ROW; "all" appears only with more than one chat, and acts on the
// rows of this band only, not on the messages already shown inside a chat.
import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTopics } from '../../contexts/TopicsContext';
import { openUnsentChat, useOnScreenSessions, useUnsent } from '../../state/unsentMessages';
import { groupUnsentBySession, previewLine, type UnsentGroup } from './unsentGroups';

interface UnsentBannerProps {
  /** Outer spacing, which belongs to the host: the grid foot and the phone's
   *  alarm band inset their rows differently. */
  className?: string;
}

export function UnsentBanner({ className = '' }: UnsentBannerProps) {
  const tr = useT();
  const topics = useTopics();
  const { messages, retrySession, dismissSession } = useUnsent();
  const onScreen = useOnScreenSessions();
  const groups = useMemo(
    () => groupUnsentBySession([...messages], topics).filter((g) => !onScreen.has(g.sessionKey)),
    [messages, topics, onScreen],
  );
  if (groups.length === 0) return null;

  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const retryGroup = (group: UnsentGroup) => retrySession(group.sessionKey);

  return (
    <div
      data-testid="unsent-banner"
      role="status"
      className={`flex-shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-400 ${className}`}
    >
      <div className="flex items-center gap-2">
        <TriangleAlert size={14} aria-hidden="true" className="flex-shrink-0 text-amber-600 dark:text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-mini font-medium">
          {tr(count === 1 ? 'app.unsent.title.one' : 'app.unsent.title.many', { n: count })}
        </span>
        {groups.length > 1 && (
          <>
            <button
              type="button"
              data-testid="unsent-retry-all"
              onClick={() => groups.forEach(retryGroup)}
              className="flex-shrink-0 rounded-md px-2 py-0.5 text-mini font-medium transition-colors hover:bg-amber-500/15"
            >
              {tr('app.unsent.retryAll')}
            </button>
            <button
              type="button"
              data-testid="unsent-dismiss-all"
              onClick={() => groups.forEach((g) => dismissSession(g.sessionKey))}
              className="flex-shrink-0 rounded-md px-2 py-0.5 text-mini transition-colors hover:bg-amber-500/15"
            >
              {tr('app.unsent.discardAll')}
            </button>
          </>
        )}
      </div>
      {/* A long list scrolls inside the band instead of pushing the grid
          off screen: the band takes height from the panes, so it is capped. */}
      <div className="max-h-32 overflow-y-auto">
        {groups.map((group) => {
          const label = group.name ?? tr('app.unsent.unknownChat');
          return (
            <div
              key={group.sessionKey}
              data-testid="unsent-row"
              data-session-key={group.sessionKey}
              className="flex items-center gap-2 rounded-md py-0.5 pl-[22px]"
            >
              <button
                type="button"
                data-testid="unsent-row-open"
                onClick={() => { if (group.topicId) openUnsentChat(group.topicId); }}
                disabled={!group.topicId}
                title={tr('app.unsent.openChat', { name: label })}
                className="flex min-w-0 flex-1 items-baseline gap-2 rounded text-left text-mini hover:underline disabled:cursor-default disabled:no-underline"
              >
                <span className="flex-shrink-0 font-medium max-w-[50%] truncate">
                  {tr(group.items.length === 1 ? 'app.unsent.chatLine.one' : 'app.unsent.chatLine.many', { name: label, n: group.items.length })}
                </span>
                <span className="min-w-0 truncate text-amber-600 dark:text-amber-500">
                  {previewLine(group.items[0]?.content ?? '')}
                </span>
              </button>
              <button
                type="button"
                data-testid="unsent-row-retry"
                onClick={() => retryGroup(group)}
                className="flex-shrink-0 rounded-md bg-amber-500 px-2.5 py-0.5 text-mini text-white transition-colors hover:bg-amber-600"
              >
                {tr('app.unsent.retry')}
              </button>
              <button
                type="button"
                data-testid="unsent-row-dismiss"
                onClick={() => dismissSession(group.sessionKey)}
                className="flex-shrink-0 rounded-md px-2 py-0.5 text-mini transition-colors hover:bg-amber-500/15"
              >
                {tr('app.unsent.discard')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

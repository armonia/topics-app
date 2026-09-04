// UnsentBanner — the messages that never reached the server, grouped BY CHAT.
//
// It used to be one amber pill reading "1 message not sent": a global count,
// in English only, with a Retry that resent everything at once. Reported from
// the board: you could see that something had not been sent, but not WHICH
// chat, and there was no way to get there. So the banner now says the chat's
// name, shows a one-line preview of the first message it is holding, and the
// row itself is the way in: clicking it opens (or focuses) that chat, going
// through the same `topics:open-topic` funnel the notifications use, which
// routes a project topic to its project pane and therefore switches project
// on its own.
//
// Retry and discard are PER ROW, because a row is a chat: retrying everything
// because one chat is worth retrying is exactly the gesture the reporter did
// not have. "Retry all" survives only when there is more than one chat.
import { useMemo } from 'react';
import { useT } from '../../hooks/useT';
import type { Topic } from '@/types';
import { groupUnsentBySession, previewLine, type UnsentGroup, type UnsentMessage } from './unsentGroups';

interface UnsentBannerProps {
  messages: UnsentMessage[];
  topics: Record<string, Topic>;
  /** Mobile lifts the banner above the bottom bar instead of floating centred. */
  mobile?: boolean;
  /** Resend every unsent message of ONE chat. */
  onRetrySession?: (sessionKey: string) => void;
  onDismissSession?: (sessionKey: string) => void;
  onDismissAll?: () => void;
  onOpenChat?: (topicId: string) => void;
}

export function UnsentBanner({
  messages,
  topics,
  mobile = false,
  onRetrySession,
  onDismissSession,
  onDismissAll,
  onOpenChat,
}: UnsentBannerProps) {
  const tr = useT();
  const groups = useMemo(() => groupUnsentBySession(messages, topics), [messages, topics]);
  if (groups.length === 0) return null;

  const retryGroup = (group: UnsentGroup) => onRetrySession?.(group.sessionKey);

  return (
    <div
      data-testid="unsent-banner"
      className={
        mobile
          // Above the bottom bar and full width: on a phone the banner used to
          // sit on top of the composer, i.e. on top of the very thing you need
          // to write the message again.
          ? 'fixed left-0 right-0 z-50 px-2 flex flex-col gap-1 rounded-t-lg border-t border-amber-500/30 bg-amber-500/15 py-1.5 text-[12px] text-amber-700 dark:text-amber-400 backdrop-blur-sm'
          : 'absolute bottom-2 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-1 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[12px] shadow-lg backdrop-blur-sm max-w-[min(28rem,90vw)]'
      }
      style={mobile ? { bottom: 'calc(var(--mobile-chrome-h, 0px) + 0.25rem)' } : undefined}
    >
      <span className="font-medium">
        {tr(messages.length === 1 ? 'app.unsent.title.one' : 'app.unsent.title.many', { n: messages.length })}
      </span>
      {groups.map((group) => {
        const label = group.name ?? tr('app.unsent.unknownChat');
        return (
          <div
            key={group.sessionKey}
            data-testid="unsent-row"
            data-session-key={group.sessionKey}
            className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-amber-500/10"
          >
            <button
              type="button"
              data-testid="unsent-row-open"
              onClick={() => { if (group.topicId && onOpenChat) onOpenChat(group.topicId); }}
              disabled={!group.topicId || !onOpenChat}
              title={tr('app.unsent.openChat', { name: label })}
              className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
            >
              <span className="truncate font-medium max-w-full">
                {tr(group.items.length === 1 ? 'app.unsent.chatLine.one' : 'app.unsent.chatLine.many', { name: label, n: group.items.length })}
              </span>
              <span className="truncate opacity-70 max-w-full">
                {previewLine(group.items[0]?.content ?? '')}
              </span>
            </button>
            <button
              type="button"
              data-testid="unsent-row-retry"
              onClick={() => retryGroup(group)}
              className="rounded bg-amber-500/20 px-2 py-0.5 font-medium transition-colors hover:bg-amber-500/30"
            >
              {tr('app.unsent.retry')}
            </button>
            <button
              type="button"
              data-testid="unsent-row-dismiss"
              onClick={() => onDismissSession?.(group.sessionKey)}
              className="rounded px-1.5 py-0.5 transition-colors hover:bg-amber-500/20"
            >
              {tr('app.unsent.discard')}
            </button>
          </div>
        );
      })}
      {groups.length > 1 && (
        <div className="flex items-center gap-2 self-end">
          <button
            type="button"
            data-testid="unsent-retry-all"
            onClick={() => groups.forEach(retryGroup)}
            className="rounded bg-amber-500/20 px-2 py-0.5 font-medium transition-colors hover:bg-amber-500/30"
          >
            {tr('app.unsent.retryAll')}
          </button>
          <button
            type="button"
            data-testid="unsent-dismiss-all"
            onClick={() => onDismissAll?.()}
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-amber-500/20"
          >
            {tr('app.unsent.discardAll')}
          </button>
        </div>
      )}
    </div>
  );
}

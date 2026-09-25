/**
 * The service line about a chat's background work (server/lib/background-notice.ts):
 * a config change waiting for the work, or the work a clock closed. One line,
 * no bubble, drawn the same in the chat and in a card's session.
 */
import { Layers } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { backgroundNoticeSentence, type BackgroundNoticeBlock } from './machineRow';

export function BackgroundNoticeLine({ notice }: { notice: BackgroundNoticeBlock }) {
  const tr = useT();
  return (
    <div
      data-testid="background-notice-row"
      data-background-notice={notice.event === 'closed' ? `closed:${notice.why ?? 'silent'}` : `deferred:${notice.change}`}
      className="my-1 flex items-center justify-center gap-1.5 px-2 text-mini text-app-text-muted"
    >
      <Layers size={11} className="flex-shrink-0" />
      <span className="truncate" title={notice.event === 'closed' ? notice.tasks.join('\n') : undefined}>
        {backgroundNoticeSentence(tr, notice)}
      </span>
    </div>
  );
}

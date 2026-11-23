/**
 * The service line of a turn a user's `turn-end` hook asked for (HOOKS-04,
 * server/services/hook-continuation.ts): the row is `user` because a provider
 * only answers that role, but the words are the hook's, so the chat draws one
 * compact line with the first line of the text and the whole text on hover,
 * never a bubble the person did not type.
 */
import { RefreshCw } from 'lucide-react';
import { useT } from '../../hooks/useT';

export function HookNudgeLine({ attempt, firstLine, content }: { attempt: number; firstLine: string; content?: string | null }) {
  const tr = useT();
  return (
    <div
      data-testid="hook-nudge-row"
      data-hook-nudge={String(attempt)}
      className="my-1 flex items-center justify-center gap-1.5 px-2 text-mini text-app-text-muted"
    >
      <RefreshCw size={11} className="flex-shrink-0" />
      <span className="truncate" title={content || undefined}>
        {tr('hook.turnEnd.continuing')}{firstLine ? `: ${firstLine}` : ''}
      </span>
    </div>
  );
}

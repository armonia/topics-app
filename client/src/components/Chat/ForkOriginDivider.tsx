/**
 * «Forked from <name>» (CHAT-FORK-05).
 *
 * Drawn under the branch's copy of the fork point, where the copied history
 * ends and the branch's own turns begin. Display only, like
 * `CompactionDivider`: not a message row, so it never reaches the provider's
 * history, the export or a message count.
 *
 * The name opens the original through the shared `topics:open-topic` funnel;
 * when the original is gone (`topicId` null) it stays text.
 */
import { GitBranch } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { Topic } from '../../types';

export function ForkOriginDivider({ origin }: { origin: NonNullable<Topic['forkedFrom']> }) {
  const tr = useT();
  const { topicId } = origin;
  return (
    <div data-testid="fork-origin-divider" className="my-3 px-2 text-app-text-muted select-none">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-app-border/60" />
        <div className="flex items-center gap-1.5 rounded-full border border-app-border/60 bg-app-hover/40 px-2.5 py-0.5 text-mini">
          <GitBranch size={12} className="flex-shrink-0" />
          <span>{tr('chat.fork.divider')}</span>
          {topicId ? (
            <button
              type="button"
              data-testid="fork-origin-open"
              title={tr('chat.fork.openOrigin')}
              className="font-medium underline-offset-2 hover:underline"
              onClick={(e) => {
                // Not up to the chat panel: its own click focuses THIS chat,
                // after this handler, and took the focus back from the original.
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId, mode: 'permanent', reveal: true } }));
              }}
            >
              {origin.name}
            </button>
          ) : (
            <span className="font-medium">{origin.name}</span>
          )}
        </div>
        <div className="h-px flex-1 bg-app-border/60" />
      </div>
    </div>
  );
}

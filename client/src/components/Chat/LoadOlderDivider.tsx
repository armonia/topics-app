/**
 * The row at the top of a PARTIAL transcript (CHAT-HIST-01).
 *
 * A tail-first open holds only the last page of a chat until the rest is
 * merged out of sight (`shared/history-paging.ts`). Whoever scrolls to the top
 * of the loaded window before that finds this row instead of a chat that seems
 * to begin mid-conversation: it names how many messages sit above and loads
 * them on click. A click is a request, so the jump it causes is not a shift -
 * the list re-anchors on the row that was first, and the reader keeps reading
 * upwards from there.
 *
 * Same geometry as `CompactionDivider`, deliberately: it is the one other thing
 * that sits between rows without being a row, and two dividers that look like
 * two different things would make the reader wonder which is which.
 */

import { History, Loader2 } from 'lucide-react';
import { useT } from '../../hooks/useT';

export function LoadOlderDivider({
  count,
  loading,
  onLoad,
}: {
  /** How many messages the server holds before the first one on screen. */
  count: number;
  /** The rest is on its way: the click has been made, the button waits. */
  loading: boolean;
  onLoad: () => void;
}) {
  const tr = useT();
  const label = tr('chat.history.loadOlder', { n: count });
  return (
    <div data-testid="chat-load-older" className="my-3 px-2 text-app-text-muted select-none">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-app-border/60" />
        <button
          type="button"
          onClick={onLoad}
          disabled={loading}
          data-testid="chat-load-older-button"
          aria-busy={loading || undefined}
          title={label}
          className="flex items-center gap-1.5 rounded-full border border-app-border/60 bg-app-hover/40 px-2.5 py-0.5 text-[11px] hover:bg-app-hover transition-colors disabled:cursor-progress"
        >
          {loading ? <Loader2 size={12} className="flex-shrink-0 animate-spin" /> : <History size={12} className="flex-shrink-0" />}
          <span className="font-medium">{label}</span>
        </button>
        <div className="h-px flex-1 bg-app-border/60" />
      </div>
    </div>
  );
}

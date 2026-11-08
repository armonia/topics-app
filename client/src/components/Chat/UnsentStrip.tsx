/**
 * The unsent messages of THIS chat, above its composer.
 *
 * Same geometry as the other strips over the composer (`CHAT_STRIP`) and the
 * same amber as the interrupted-turn notice, because it says the same kind of
 * thing: something you wrote here did not go through. It sits in flow in the
 * input area, so it pushes the composer's stack up instead of covering it.
 *
 * It renders only when its pane has a box (`usePaneAlive`): a hidden tab's
 * strip would claim the chat as on screen and take its messages away from the
 * global band, where they are the only way to learn about them.
 */
import { useLayoutEffect } from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { CHAT_STRIP } from '../../lib/chatStripStyles';
import { usePaneAlive } from '../../state/paneLiveness';
import { claimOnScreen, useUnsentFor } from '../../state/unsentMessages';
import { previewLine } from '../Layout/unsentGroups';

export function UnsentStrip({ sessionKey }: { sessionKey: string }) {
  const tr = useT();
  const alive = usePaneAlive();
  const unsent = useUnsentFor(sessionKey);
  const shown = alive && !!unsent;
  // Behind the phone's drawer the strip is drawn and not seen: it stays, so
  // closing the drawer finds it in place, but the band keeps listing the chat.
  const seen = shown && !unsent.gridCovered;

  // Layout effect, not a plain effect: the band reads the claim, and a claim
  // that lands after paint shows the same row twice for one frame.
  useLayoutEffect(() => {
    if (!seen) return;
    return claimOnScreen(sessionKey);
  }, [seen, sessionKey]);

  if (!shown || !unsent) return null;
  const { items } = unsent;

  return (
    <div
      data-testid="unsent-strip"
      role="status"
      className={`${CHAT_STRIP} flex-shrink-0 border border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/20`}
    >
      <div
        data-testid="unsent-row"
        data-session-key={sessionKey}
        className="flex items-center gap-2 px-3 py-2"
      >
        <TriangleAlert size={14} aria-hidden="true" className="flex-shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-mini font-medium text-amber-700 dark:text-amber-400">
            {tr(items.length === 1 ? 'app.unsent.title.one' : 'app.unsent.title.many', { n: items.length })}
          </div>
          {/* The text itself, so you know which message it is without opening
              anything; the full text is in the tooltip. */}
          <div className="truncate text-mini text-amber-600 dark:text-amber-500" title={items[0]?.content}>
            {previewLine(items[0]?.content ?? '')}
          </div>
        </div>
        <button
          type="button"
          data-testid="unsent-row-retry"
          onClick={unsent.retry}
          className="flex flex-shrink-0 items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-mini text-white transition-colors hover:bg-amber-600"
        >
          <RotateCw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {tr('app.unsent.retry')}
        </button>
        <button
          type="button"
          data-testid="unsent-row-dismiss"
          onClick={unsent.dismiss}
          className="flex-shrink-0 rounded-md px-2 py-1.5 text-mini text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
        >
          {tr('app.unsent.discard')}
        </button>
      </div>
    </div>
  );
}

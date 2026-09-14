import { PanelRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { reopenTopicBrowserWindow } from './topicBrowserWindowLazy';

/**
 * THE WAY BACK IN, when the window is hidden but its pages are still alive.
 *
 * It sits at the TOP of the topic, next to its bar. It used to be a fixed
 * pill above the composer, where it covered 11px of the send button: the
 * way back into the browser must not stand on the way to send a message.
 *
 * `top-11` AND NOT `top-1`, WHICH IS WHERE THE HOVER TOOLBAR LIVES.
 *
 * The transcript leaves a band free above its first message for that
 * message's action toolbar (`bottom-full` on the bubble), and for a user
 * message the toolbar is right-aligned: measured at 1280, the bar landed at
 * x 1102..1260 / y 76.5..110.5 and this button at x 1248..1272 / y 78..102 —
 * a 7 px bite out of «Elimina il messaggio», taken by the button on top allow-italian: quoted UI label
 * (z-20 over the toolbar's z-10), i.e. a delete that could not be clicked.
 *
 * Sideways there is no room: only 20 px separate the toolbar's right edge
 * from the pane's, and this button is 24 px wide. So it moves DOWN, by the
 * least the measurement allows — `top-10` (40 px) still leaves 3.5 px, and
 * `top-11` (44 px) clears the toolbar by 7.5 px.
 */
export function TopicBrowserReopen({ topicId }: { topicId: string }) {
  const t = useT();
  return (
    <div className="absolute top-11 right-2 z-20">
      <button
        data-testid="topic-browser-reopen"
        type="button"
        onClick={() => reopenTopicBrowserWindow(topicId)}
        title={t('topicBrowser.reopen')}
        aria-label={t('topicBrowser.reopen')}
        className="w-6 h-6 flex items-center justify-center rounded border border-app-border bg-surface text-app-text-tertiary hover:text-app-text shadow-sm"
      >
        <PanelRight size={13} />
      </button>
    </div>
  );
}

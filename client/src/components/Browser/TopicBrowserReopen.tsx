import { PanelRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { reopenTopicBrowserWindow } from './topicBrowserWindowLazy';

/**
 * THE WAY BACK IN, when the window is hidden but its pages are still alive.
 *
 * It sits at the TOP of the topic, next to its bar. It used to be a fixed
 * pill above the composer, where it covered 11px of the send button: the
 * way back into the browser must not stand on the way to send a message.
 */
export function TopicBrowserReopen({ topicId }: { topicId: string }) {
  const t = useT();
  return (
    <div className="absolute top-1 right-2 z-20">
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

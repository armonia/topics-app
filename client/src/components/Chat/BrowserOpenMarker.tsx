/**
 * THE PAGE THE AGENT OPENED, IN THE TURN WHERE IT HAPPENED (CHAT-BROWSER-01/02).
 *
 * One row as tall as a tool row: favicon, title (the agent's name for the tab,
 * else the page title, else the host), host, where the page lives now, and an
 * arrow. The whole row is the target: it brings the page back on screen
 * wherever it lives, and reopens it in this chat's window when it lives nowhere
 * (`focusBrowserContext`). No picture of the page: the live view is already
 * beside the chat, and a webview inside a message is the occlusion bug class.
 *
 * The state is derived from the live surfaces and follows them: closing the
 * sheet in the window turns «in the window» into «closed» with no reload.
 */
import { memo, useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { BrowserFavicon } from '../Browser/BrowserFavicon';
import { loadTopicWindowStore, type TopicWindowStore } from '../Browser/topicBrowserWindowLazy';
import { focusBrowserContextLive, liveBrowserSurfaces, locateBrowserContext } from '../../lib/focusBrowserContext';
import { usePaneStore } from '../../state/pane/store';
import { subscribeTaskTabs } from '../../state/taskBrowserTabs';
import { pageHost } from '../../../../shared/tool-detail';
import { browserPageLabel } from './toolDetail';
import { useChatTopicId } from './chatTopicContext';
import {
  browserMarkerState,
  currentPage,
  markerTitle,
  type BrowserMarker,
  type BrowserMarkerState,
  type BrowserPlaceKind,
} from './browserOpens';

const STATE_LABEL: Record<BrowserMarkerState, string> = {
  window: 'chat.browserMarker.state.window',
  tab: 'chat.browserMarker.state.tab',
  closed: 'chat.browserMarker.state.closed',
  offscreen: 'chat.browserMarker.state.offscreen',
};

/** The site's own icon, by convention; `BrowserFavicon` draws a monogram when it fails. */
function faviconFor(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}/favicon.ico` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the context lives now, following every surface that can hold it.
 * `undefined` until the window store has answered: saying «closed» for the
 * instant before would flash a false state on every load.
 */
function useBrowserPlace(contextId: string, topicId: string): BrowserPlaceKind | null | undefined {
  const [place, setPlace] = useState<BrowserPlaceKind | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let store: TopicWindowStore | null = null;
    // A string: an unchanged answer does not re-render the row.
    const read = (): void => {
      if (alive && store) setPlace(locateBrowserContext(contextId, topicId, liveBrowserSurfaces(store))?.kind ?? null);
    };
    const stops = [usePaneStore.subscribe(read), subscribeTaskTabs(read)];
    void loadTopicWindowStore().then(async (s) => {
      if (topicId) await s.ensureTopicWindowLoaded(topicId);
      if (!alive) return;
      store = s;
      stops.push(s.subscribeTopicWindows(read));
      read();
    });
    return () => {
      alive = false;
      for (const stop of stops) stop();
    };
  }, [contextId, topicId]);
  return place;
}

/** The click of a marker: to the page wherever it lives, back in this chat's window if nowhere. */
function useGoToPage(marker: BrowserMarker): () => void {
  const topicId = useChatTopicId();
  const url = currentPage(marker).url;
  return () => {
    void focusBrowserContextLive({ contextId: marker.contextId, topicId: topicId || undefined, url, reopen: true });
  };
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const BrowserOpenMarker = memo(function BrowserOpenMarker({ marker }: { marker: BrowserMarker }) {
  const tr = useT();
  const topicId = useChatTopicId();
  const go = useGoToPage(marker);
  const place = useBrowserPlace(marker.contextId || topicId, topicId);
  const [listOpen, setListOpen] = useState(false);
  const page = currentPage(marker);
  const title = markerTitle(marker);
  const host = pageHost(page.url);
  const state = place === undefined ? null : browserMarkerState(place, marker.visible);

  return (
    <div
      data-testid="browser-open-marker"
      data-context-id={marker.contextId ?? ''}
      data-state={state ?? 'unknown'}
      className="text-compact"
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={go}
          title={page.url}
          aria-label={tr('chat.browserMarker.open', { url: page.url })}
          data-testid="browser-open-marker-go"
          className="group/bmark flex-1 min-w-0 flex items-center gap-2 py-1 coarse:min-h-11 text-left text-app-text-secondary hover:text-app-text transition-colors"
        >
          <BrowserFavicon url={page.url} faviconUrl={faviconFor(page.url)} size={14} />
          <span data-testid="browser-open-marker-title" className="truncate font-medium text-app-text">{title}</span>
          {title !== host && (
            <span data-testid="browser-open-marker-host" className="truncate text-mini text-app-text-muted">{host}</span>
          )}
          {state && (
            <span data-testid="browser-open-marker-state" className="flex-shrink-0 text-mini text-app-text-muted">
              {tr(STATE_LABEL[state])}
            </span>
          )}
          <ArrowUpRight size={12} className="flex-shrink-0 text-app-text-muted group-hover/bmark:text-app-text" />
        </button>
        {marker.pages.length > 1 && (
          <button
            type="button"
            onClick={() => setListOpen((v) => !v)}
            aria-expanded={listOpen}
            data-testid="browser-open-marker-pages"
            className="flex-shrink-0 inline-flex items-center gap-1 py-1 coarse:min-h-11 text-mini text-app-text-muted hover:text-app-text transition-colors"
          >
            {listOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {tr('chat.browserMarker.pages', { n: marker.pages.length })}
          </button>
        )}
      </div>
      {listOpen && (
        <ol data-testid="browser-open-marker-page-list" className="ml-[22px] mb-1 space-y-0.5 text-mini text-app-text-secondary">
          {marker.pages.map((p) => (
            <li key={p.toolCallId} className="flex items-center gap-2 min-w-0">
              <span className="truncate" title={p.url}>{browserPageLabel(p)}</span>
              {p.at !== undefined && <span className="flex-shrink-0 tabular-nums text-app-text-muted">{timeOf(p.at)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

/** The same page as a chip, for the summary line of a task's folded work. */
export function BrowserMarkerChip({ marker }: { marker: BrowserMarker }) {
  const tr = useT();
  const go = useGoToPage(marker);
  const page = currentPage(marker);
  return (
    <button
      type="button"
      onClick={go}
      title={page.url}
      aria-label={tr('chat.browserMarker.open', { url: page.url })}
      data-testid="browser-marker-chip"
      className="flex-shrink-0 max-w-[12rem] inline-flex items-center gap-1 rounded px-1 py-0.5 coarse:min-h-11 text-mini text-app-text-secondary hover:bg-app-hover hover:text-app-text transition-colors"
    >
      <BrowserFavicon url={page.url} faviconUrl={faviconFor(page.url)} size={12} />
      <span className="truncate">{markerTitle(marker)}</span>
    </button>
  );
}

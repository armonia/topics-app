/**
 * WHERE A REMOTE PANE'S PAGE IS, AND WHERE IT IS GOING.
 *
 * Two urls, because they answer two different questions and the pane used to
 * keep only one. `url` is the address bar: where the user asked to go, set the
 * moment they ask. `pageUrl` is what the server's browser actually shows, and
 * it moves only when the server says so. While they differ, the pane is waiting
 * on its page, and when the server's page is still blank there is nothing to
 * look at but the wait itself: that is when the pane has to say what it is
 * waiting FOR (BROWSER-LOAD-01). On 13/10 it said "starting the shared
 * session" instead, for as long as anybody looked, about a page whose server
 * never answered.
 *
 * Pure: the hook keeps the state, this decides what each message does to it.
 */
import type { BrowserWsMessage } from '../../../shared/browser-ws-messages';
import { keepConsoleOfPage, type StreamConsoleEntry } from '../components/Browser/streamConsole';
import { applyHistoryUpdate, historyFlagsOf } from '../components/Browser/streamNavHistory';

export interface RemoteNavFields {
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  errorUrl: string | null;
  /** When the load under way set off, on this device's clock. Null when none is. */
  loadingSince: number | null;
  /** The page the server's browser is on, as last reported ('' before any report). */
  pageUrl: string;
  consoleEntries: StreamConsoleEntry[];
  canGoBack?: boolean;
  canGoForward?: boolean;
}

type NavMessage = Extract<BrowserWsMessage, { type: 'nav' }>;

/** True when the server's page has nothing on it yet. */
export function isBlankPage(url: string): boolean {
  return !url || url === 'about:blank';
}

export function applyNavMessage<S extends RemoteNavFields>(s: S, msg: NavMessage, now: number): S {
  switch (msg.phase) {
    case 'response':
      // A loaded document: the rows of any other page leave the tally (the new
      // page's own load-time errors carry its url and stay).
      return {
        ...s, url: msg.url, pageUrl: msg.url, loading: false, loadingSince: null, error: null, errorUrl: null,
        consoleEntries: keepConsoleOfPage(s.consoleEntries, msg.url),
        ...historyFlagsOf(msg),
      };
    case 'history':
      // Same-document navigation, or only the history moved: the url and the
      // arrows follow, the loading state and the console rows do not.
      return applyHistoryUpdate(s, msg);
    case 'error':
      // Failed goto/launch: the page is still on the previous url. Surface the
      // reason instead of silently clearing the spinner (BRW-REL-02).
      return { ...s, loading: false, loadingSince: null, error: msg.error || 'Navigation failed', errorUrl: msg.url };
    case 'loading':
      // Somebody sent the page somewhere, this pane or another device, or this
      // socket opened while it was on its way. The time is the server's count.
      return { ...s, url: msg.url, loading: true, loadingSince: now - (msg.elapsedMs ?? 0), error: null, errorUrl: null };
    default:
      return s;
  }
}

/**
 * This pane asked for `url`: the address bar moves now, the page when it loads.
 * Asking for the url already on its way keeps its clock, as the server joins
 * the load it has (a reloaded pane seeds its url again, BROWSER-LOAD-01).
 */
export function startNavigation<S extends RemoteNavFields>(s: S, url: string, now: number): S {
  const same = s.loading && s.url === url && s.loadingSince !== null;
  return { ...s, url, loading: true, loadingSince: same ? s.loadingSince : now, error: null, errorUrl: null };
}

/**
 * The context info the server answers on connect. A blank page there says
 * nothing about where the page is going, so it neither overwrites a destination
 * nor ends a load: it arrives racing the socket's own news about the very load
 * it cannot see.
 */
export function applyContextInfo<S extends RemoteNavFields>(
  s: S,
  info: { url?: string; title?: string; canGoBack?: unknown; canGoForward?: unknown },
): S {
  const url = info.url ?? '';
  if (isBlankPage(url)) return { ...s, pageUrl: url, title: info.title || s.title, ...historyFlagsOf(info) };
  return { ...s, url, pageUrl: url, title: info.title || s.title, loading: false, loadingSince: null, ...historyFlagsOf(info) };
}

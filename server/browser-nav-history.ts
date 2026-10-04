/**
 * server/browser-nav-history.ts — tells the streaming pane whether its back and
 * forward arrows lead anywhere.
 *
 * The pane used to keep both arrows always enabled, because it had no way to
 * know: the history lives in the server's Chromium, and the wire only carried
 * the url. A click on an arrow with nothing behind it was a silent no-op.
 *
 * The flags travel inside the `nav` messages the pane already listens to:
 *   - `phase: 'response'` (the page finished loading) carries them read fresh;
 *   - `phase: 'history'` is sent when the main frame navigates WITHOUT a load,
 *     which is the same-document case (pushState, a fragment, an SPA route)
 *     and the case where only the history moved. It is published only when the
 *     url or a flag actually changed, so a page that rewrites its url on every
 *     scroll does not turn into a message per scroll step it has already sent.
 *
 * Kept apart from browser-service.ts so the coalescing and the dedup can be
 * tested with plain fakes, without a browser.
 */
import type { NavigationHistoryFlags } from "./browser-cdp-surface";

export interface NavHistoryUpdate extends NavigationHistoryFlags {
  url: string;
}

export interface NavHistoryPublisher {
  /**
   * The page finished loading at `url`: read the flags now, for the `response`
   * message. Null when they cannot be read (the message then goes without
   * them, and the pane keeps what it had). Recorded as the last published
   * state: the response carries them, so a later navigation event that finds
   * the same url and flags has nothing new to say.
   */
  flagsForLoad(url: string): Promise<NavigationHistoryFlags | null>;
  /** The main frame navigated. Fire-and-forget; calls during a read coalesce
   *  into ONE more read after it, never into one read per call. */
  navigated(): void;
  /** The last flags read, or null if none yet: the info route returns them to
   *  a pane that reconnects, which hears no navigation until the next one. */
  current(): NavigationHistoryFlags | null;
}

/** Only real pages reach the pane: the initial about:blank and Chromium's own
 *  error pages must not overwrite its url (same guard as the load broadcast). */
export function isPublishableUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

export function createNavHistoryPublisher(deps: {
  /** Read the flags from the browser; null when it cannot answer. */
  read: () => Promise<NavigationHistoryFlags | null>;
  /** The page's url right now. */
  currentUrl: () => string;
  /** Send a `history` update to every viewer of the pane. */
  publish: (update: NavHistoryUpdate) => void;
}): NavHistoryPublisher {
  let last: NavHistoryUpdate | null = null;
  let flags: NavigationHistoryFlags | null = null;
  let reading = false;
  let again = false;

  const sameAsLast = (u: NavHistoryUpdate) =>
    last !== null && last.url === u.url && last.canGoBack === u.canGoBack && last.canGoForward === u.canGoForward;

  async function drain(): Promise<void> {
    reading = true;
    try {
      do {
        again = false;
        const read = await deps.read();
        if (!read) continue;
        flags = read;
        const url = deps.currentUrl();
        if (!isPublishableUrl(url)) continue;
        const update = { url, ...read };
        if (sameAsLast(update)) continue;
        last = update;
        deps.publish(update);
      } while (again);
    } finally {
      reading = false;
    }
  }

  return {
    async flagsForLoad(url) {
      const read = await deps.read();
      if (!read) return null;
      flags = read;
      last = { url, ...read };
      return read;
    },
    navigated() {
      if (reading) { again = true; return; }
      void drain().catch(() => { /* a failed read only leaves the arrows as they were */ });
    },
    current() {
      return flags;
    },
  };
}

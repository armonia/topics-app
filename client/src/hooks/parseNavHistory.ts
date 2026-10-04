/**
 * What the shell's `browser_nav_entries` says about this pane's history: the
 * list for the history menu, and whether ‹ and › have somewhere to go.
 *
 * The arrows come from the shell's own `canGoBack` / `canGoForward` when it
 * sends them, and that is the WebView2 case: WebView2 exposes no history LIST,
 * only the two flags, so its list is always empty and an arrow derived from the
 * list was disabled for good on Windows. Without the flags (WKWebView,
 * WebKitGTK) they are read off the list: an entry behind the active one, an
 * entry ahead of it.
 */
export function parseNavHistory(raw: string): {
  entries: { url: string; title: string; index: number }[];
  activeIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
} {
  let parsed: {
    entries?: { url: string; title: string }[];
    activeIndex?: number;
    canGoBack?: unknown;
    canGoForward?: unknown;
  } = {};
  try {
    parsed = JSON.parse(raw || '{}') ?? {};
  } catch {
    parsed = {};
  }
  const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map((e, index) => ({
    url: e.url,
    title: e.title,
    index,
  }));
  const activeIndex = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0;
  return {
    entries,
    activeIndex,
    canGoBack: typeof parsed.canGoBack === 'boolean' ? parsed.canGoBack : activeIndex > 0,
    canGoForward: typeof parsed.canGoForward === 'boolean' ? parsed.canGoForward : activeIndex < entries.length - 1,
  };
}

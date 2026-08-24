/**
 * WHAT IS WRITTEN ON A BROWSER TAB.
 *
 * It used to be the page `<title>`, which is what a general-purpose browser
 * does because its tabs sit under one address bar that says where you are.
 * Here the address bar is gone from the pane (the tab IS the chrome), so the
 * tab has to answer the question the address bar answered: WHICH page is this.
 *
 * A page title cannot answer it. Half the pages this pane opens are local dev
 * servers, and three dev servers in three tabs are all called "Vite + React".
 * The address distinguishes them, and `prettyUrl` keeps the part that does the
 * distinguishing (the port) while dropping the part that never does (`https://`,
 * `www.`, a lone trailing slash).
 *
 * The one thing that still beats the address is a name somebody DECIDED: a
 * manual rename from the tab menu, or the name an agent gave the tab it opened
 * for a task. That is the existing `titleSource` contract from
 * `state/pane/browserPaneUrl` and it is unchanged here: a decided label is
 * sticky, an automatic one is not.
 */
import { prettyUrl } from './browserNavUrl';

/** Mirrors `Pane['titleSource']`: who decided the current title. */
export type BrowserTitleSource = 'auto' | 'agent' | 'user' | undefined;

export interface BrowserTabLabelInput {
  /** The persisted pane title (the live page title, or a decided name). */
  title?: string;
  titleSource?: BrowserTitleSource;
  /** The pane's current URL, when it has one. */
  url?: string;
  /** Label of last resort, from the pane config ("Browser"). */
  fallback: string;
}

/**
 * The tab's visible label. Order: a decided name, then the address, then the
 * live page title (a page reached without a URL we can parse still deserves a
 * word), then the constant.
 */
export function browserTabLabel({ title, titleSource, url, fallback }: BrowserTabLabelInput): string {
  const decided = titleSource === 'user' || titleSource === 'agent';
  const named = (title ?? '').trim();
  if (decided && named) return named;

  const address = prettyUrl(url ?? '').trim();
  // `about:blank` is not an address, it is the absence of one: a new tab says
  // "New tab", never the internal URL of the empty page.
  if (address && address !== 'about:blank') return address;

  return named || fallback;
}

/**
 * The SECOND line, for the surfaces that have room for two (the drag preview,
 * the tooltip). It is the complement of the label: when the label is the
 * address, this is the page title, and the other way round. Empty when it would
 * only repeat what is already on screen.
 */
export function browserTabSubtitle(input: BrowserTabLabelInput): string {
  const label = browserTabLabel(input);
  const named = (input.title ?? '').trim();
  if (named && named !== label) return named;
  const address = prettyUrl(input.url ?? '').trim();
  if (!address || address === 'about:blank' || address === label) return '';
  return address;
}

/**
 * WHAT IS WRITTEN ON A BROWSER TAB.
 *
 * The tab writes the PAGE TITLE, always, in whatever state it is in. That is
 * what every browser on earth writes, and it is the right answer for a reason:
 * a tab is read out of the corner of the eye, and "Anthropic Console" is
 * remembered where `console.anthropic.com/dashboard/usage` is only decoded.
 *
 * This module used to argue the opposite for the ACTIVE tab, and the argument
 * was: half the pages this pane opens are local dev servers, three of them are
 * all called "Vite + React", and with no address bar under the tab the label
 * was the only place left to tell them apart. The premise was true and the
 * conclusion was wrong. Telling them apart is a question you ask ONCE, on
 * purpose, and there are now two surfaces that answer it without touching the
 * label: the hover card (name on the first line, the whole address on the
 * second) and the address DROPDOWN that opens under the tab
 * (`BrowserTabAddress`). Stealing the label to answer it made the tab you are
 * working in the one tab in the bar that does not say what page it is, and it
 * made the label CHANGE under you every time focus moved.
 *
 * So the order is: a name somebody DECIDED, then the page title, then the
 * address as a FALLBACK for a page that has no title, then "New tab" for a pane
 * that has neither. The decided name is the existing `titleSource` contract
 * from `state/pane/browserPaneUrl` and it is unchanged: a manual rename from
 * the tab menu, or the name an agent gave the tab it opened for a task, is
 * sticky where an automatic one is not.
 *
 * "New tab" and not the pane config's "Browser": a blank pane is a place you
 * are about to type an address into, not a category of pane. "Browser" named
 * the widget, which the user can already see.
 */
import { prettyUrl } from './browserNavUrl';

/** Mirrors `Pane['titleSource']`: who decided the current title. */
export type BrowserTitleSource = 'auto' | 'agent' | 'user' | undefined;

/** What a pane with no title and no address is called. */
export const NEW_TAB_LABEL = 'New tab';

export interface BrowserTabLabelInput {
  /** The persisted pane title (the live page title, or a decided name). */
  title?: string;
  titleSource?: BrowserTitleSource;
  /** The pane's current URL, when it has one. */
  url?: string;
}

/**
 * The address as a tab would write it, or `''` when there is none to write.
 * `about:blank` is not an address, it is the absence of one: a new tab says
 * "New tab", never the internal URL of the empty page.
 */
function tabAddress(url: string | undefined): string {
  const address = prettyUrl(url ?? '').trim();
  return address && address !== 'about:blank' ? address : '';
}

/**
 * The tab's visible label: a decided name, then the page title, then the
 * address, then the constant.
 */
export function browserTabLabel({ title, titleSource, url }: BrowserTabLabelInput): string {
  const decided = titleSource === 'user' || titleSource === 'agent';
  const named = (title ?? '').trim();
  if (decided && named) return named;
  return named || tabAddress(url) || NEW_TAB_LABEL;
}

/**
 * The SECOND line, for the surfaces that have room for two (the drag preview,
 * the hover card). It is the complement of the label, and since the label is
 * now always the name, the complement is always the address: the line that
 * tells two tabs of the same dev server apart. Empty when it would only repeat
 * what is already on screen, which is every case where the label IS the
 * address (or where there is no address at all).
 */
export function browserTabSubtitle(input: BrowserTabLabelInput): string {
  const label = browserTabLabel(input);
  const named = (input.title ?? '').trim();
  const candidates = [tabAddress(input.url), named];
  return candidates.find((c) => c && c !== label) ?? '';
}

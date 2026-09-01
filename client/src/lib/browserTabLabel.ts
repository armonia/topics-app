/**
 * WHAT IS WRITTEN ON A BROWSER TAB.
 *
 * Two questions, and they are not the same question:
 *
 *  - WHICH PAGE IS THIS, asked of the tab you are working in. The pane has no
 *    address bar any more (the tab IS the chrome), so the answer has to be the
 *    ADDRESS: half the pages this pane opens are local dev servers, and three
 *    dev servers in three tabs are all called "Vite + React". `prettyUrl` keeps
 *    the part that does the distinguishing (the port) and drops the part that
 *    never does (`https://`, `www.`, a lone trailing slash).
 *  - WHICH PAGE WAS THAT, asked of the tabs you are NOT in. Here every browser
 *    on earth writes the page TITLE, and it is the right answer for a reason:
 *    a resting tab is a memory aid, and "Anthropic Console" is remembered where
 *    `console.anthropic.com/dashboard/usage` is only read.
 *
 * So the label follows the tab's state, which is what `prefer` carries: the
 * ACTIVE browser tab (expanded, click-to-edit) writes the address, the resting
 * ones write the title. Nothing is lost by the resting tab: hovering it opens
 * the hover card, whose second line is the full address.
 *
 * The one thing that beats both is a name somebody DECIDED: a manual rename
 * from the tab menu, or the name an agent gave the tab it opened for a task.
 * That is the existing `titleSource` contract from `state/pane/browserPaneUrl`
 * and it is unchanged here: a decided label is sticky, an automatic one is not.
 */
import { prettyUrl } from './browserNavUrl';

/** Mirrors `Pane['titleSource']`: who decided the current title. */
export type BrowserTitleSource = 'auto' | 'agent' | 'user' | undefined;

/**
 * Which of the two truths goes on the tab when both exist.
 * `'title'` is the resting default (a browser's standard); `'address'` is what
 * the focused tab asks for, because that is the one you navigate.
 */
export type BrowserLabelPreference = 'title' | 'address';

export interface BrowserTabLabelInput {
  /** The persisted pane title (the live page title, or a decided name). */
  title?: string;
  titleSource?: BrowserTitleSource;
  /** The pane's current URL, when it has one. */
  url?: string;
  /** Label of last resort, from the pane config ("Browser"). */
  fallback: string;
  /** Defaults to `'title'`: the tab at rest reads like any other browser's. */
  prefer?: BrowserLabelPreference;
}

/**
 * The tab's visible label. A decided name first, then whichever of page title /
 * address `prefer` asks for, then the other one, then the constant.
 */
export function browserTabLabel({ title, titleSource, url, fallback, prefer = 'title' }: BrowserTabLabelInput): string {
  const decided = titleSource === 'user' || titleSource === 'agent';
  const named = (title ?? '').trim();
  if (decided && named) return named;

  const address = prettyUrl(url ?? '').trim();
  // `about:blank` is not an address, it is the absence of one: a new tab says
  // "New tab", never the internal URL of the empty page.
  const realAddress = address && address !== 'about:blank' ? address : '';

  if (prefer === 'address') return realAddress || named || fallback;
  return named || realAddress || fallback;
}

/**
 * The SECOND line, for the surfaces that have room for two (the drag preview,
 * the hover card). It is the complement of the label: when the label is the
 * address, this is the page title, and the other way round. Empty when it would
 * only repeat what is already on screen.
 */
export function browserTabSubtitle(input: BrowserTabLabelInput): string {
  const label = browserTabLabel(input);
  const named = (input.title ?? '').trim();
  const address = prettyUrl(input.url ?? '').trim();
  const realAddress = address && address !== 'about:blank' ? address : '';
  // The complement of a title-first label is the address, and the other way
  // round. When the label is a DECIDED name neither of the two has been said
  // yet, and the address goes first: it is the line that tells two tabs apart.
  const candidates = input.prefer === 'address' ? [named, realAddress] : [realAddress, named];
  return candidates.find((c) => c && c !== label) ?? '';
}

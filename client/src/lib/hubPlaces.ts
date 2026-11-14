/**
 * OPENING THE PLACES OF TOPICS that took over the hub's pages
 * (hub-smistamento), and the hub's OLD BOOKMARKS (hub-tutto-in-topics, C2).
 *
 * `http://127.0.0.1:3360/#automations` answers a 302 to Topics without a
 * fragment: the browser keeps the old one, so Topics opens on
 * `/#automations`. Here the fragment becomes the right place and leaves the
 * address, so a reload does not open the view again. A fragment that is not a
 * page of the hub stays where it is: it is not ours.
 */
import { automationKeyOfLink, hubPlaceOfLink, type HubPlace } from './hubSystem';
import { OPEN_INBOX_EVENT, type OpenInboxDetail } from './inboxEvents';
import { openUserMenu } from './openUserMenu';
import { openProcessesLog } from '../state/processesLog';
import { openAutomation } from '../state/automationTarget';
import { onServerHydrated } from '../state/pane/middleware/serverHydrated';

/** Open the place of Topics that took over a page of the hub. */
export function openHubPlace(place: HubPlace): void {
  if (place.kind === 'menu') openUserMenu(place.level);
  else if (place.kind === 'log') openProcessesLog();
  else if (place.kind === 'bell') window.dispatchEvent(new CustomEvent<OpenInboxDetail>(OPEN_INBOX_EVENT, { detail: { tab: place.tab } }));
  else window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: place.type } }));
}

/** Where an old bookmark of the hub leads: one automation, a place, or null for any other fragment. */
export type HubBookmarkTarget = { automationKey: string } | { place: HubPlace };

export function hubBookmarkTarget(hash: string): HubBookmarkTarget | null {
  const automationKey = automationKeyOfLink(hash);
  if (automationKey) return { automationKey };
  const place = hubPlaceOfLink(hash);
  return place ? { place } : null;
}

/** Like `tabLink`'s: without a hydrate (offline, first launch) the bookmark still opens. */
const HYDRATE_FALLBACK_MS = 1500;

/**
 * At boot: a hub bookmark in `location.hash` opens its place once the pane
 * store has hydrated (before it, the `topics:open-utility` listeners are not
 * there yet), and the fragment is dropped with `replaceState`. Returns the
 * canceller.
 *
 * The fragment is read and dropped INSIDE the shot, not at mount: in
 * StrictMode the first mount is cancelled before it fires, and the second
 * one must still find the fragment in the address.
 */
export function openHubBookmarkWhenHydrated(): () => void {
  let done = false;
  let off: () => void = () => {};
  const fire = () => {
    if (done) return;
    done = true;
    off();
    clearTimeout(timer);
    consumeHubBookmarkFromUrl();
  };
  const timer = setTimeout(fire, HYDRATE_FALLBACK_MS);
  off = onServerHydrated(fire);
  return () => {
    done = true;
    off();
    clearTimeout(timer);
  };
}

/** Open the place the fragment names and drop it from the address; false for any other fragment. */
export function consumeHubBookmarkFromUrl(): boolean {
  let target: HubBookmarkTarget | null;
  try {
    target = hubBookmarkTarget(window.location.hash);
  } catch {
    return false;
  }
  if (!target) return false;
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', pathname + search);
  } catch {
    /* no history here: the place opens all the same */
  }
  if ('automationKey' in target) openAutomation(target.automationKey);
  else openHubPlace(target.place);
  return true;
}

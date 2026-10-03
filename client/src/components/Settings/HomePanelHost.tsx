/**
 * THE ONE HOST OF THE FORMS THAT LIVE WHERE THEY ARE USED.
 *
 * AI providers belong to the model selector, the MCP tools to the composer, the
 * calendar to the pinned calendar tile (SETHOME-01). Each of those homes may be
 * unmounted when someone asks for it (no chat open, no calendar pinned), and
 * three copies of a popover that holds a form would be three ways to get Escape
 * or a confirm wrong. So the homes only say WHERE (the element the panel hangs
 * from) and this host draws the panel:
 *
 *  · ANCHORED, on the desktop, when the door hands over an element or the home
 *    is on screen (`data-home-anchor`): a popover beside it, ~420 px wide, the
 *    body scrolling inside under the menu's own cap.
 *  · A CENTRED SHEET, on the desktop, when nothing of the home is mounted (the
 *    palette with no chat open).
 *  · A BOTTOM SHEET on the phone, either way: that is how every popover of the
 *    app opens under 768 px.
 *
 * The plan, the machines, the look and the notifications are the user menu's own
 * levels: a request for them is passed on to `openUserMenu`.
 *
 * What makes a form work inside a popover (typing, a `Select`, a confirm asked
 * from inside, Escape closing only the panel, the focus going back to the
 * trigger) is the same frame the user menu's form levels use
 * (`FormPanelFrame`), on the same `Menu` primitive.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { closeAllPopovers, closePopoversAround } from '@/lib/popoverRegistry';
import { HOME_ANCHOR_ATTR, HOME_ANCHOR_FOCUSED_ATTR, OPEN_HOME_EVENT, isPanelHome, type OpenHomeDetail, type PanelHome } from '@/lib/openHome';
import { openUserMenu, type UserMenuLevel } from '@/lib/openUserMenu';
import type { HomeRequest } from './HomePanel';

// The panel, its frame and the forms load the first time a home is asked for:
// this listener is all the app's first paint carries.
const HomePanel = lazy(async () => {
  const { HomePanel: Panel } = await import('./HomePanel');
  return { default: Panel };
});

/** The user menu's level for the homes that are levels of it. */
const MENU_LEVEL: Record<Exclude<OpenHomeDetail['home'], PanelHome>, UserMenuLevel> = {
  plan: 'plan',
  machines: 'nodes',
  appearance: 'appearance',
  notifications: 'notifications',
};

/**
 * The home's own element, when one is ON SCREEN: the first whose box meets the
 * window. Being laid out is not enough: the collapsed sidebar slides off with
 * a transform (`translateX(-100%)`), so the pinned calendar tile keeps its
 * client rects at x -250, and the panel hung from it, and Escape gave the
 * focus to a tile nobody can see.
 *
 * The FOCUSED pane's first: with two chats on screen there are two «+» and two
 * model chips, and the first in the document is the left pane's, whichever
 * pane the person is in (`HOME_ANCHOR_FOCUSED_ATTR`).
 */
function mountedAnchor(home: PanelHome): HTMLElement | null {
  const visible = Array.from(document.querySelectorAll<HTMLElement>(`[${HOME_ANCHOR_ATTR}~="${home}"]`))
    .filter((el) => onScreen(el.getBoundingClientRect()));
  return visible.find((el) => el.hasAttribute(HOME_ANCHOR_FOCUSED_ATTR)) ?? visible[0] ?? null;
}

/** Its middle is inside the window: a sliver left by a slide does not count. */
function onScreen(r: DOMRect): boolean {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
}

export function HomePanelHost() {
  const [request, setRequest] = useState<HomeRequest | null>(null);
  const close = useCallback(() => setRequest(null), []);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<OpenHomeDetail>).detail;
      if (!detail) return;
      if (!isPanelHome(detail.home)) {
        openUserMenu(MENU_LEVEL[detail.home]);
        return;
      }
      const anchor = detail.anchor?.isConnected ? detail.anchor : mountedAnchor(detail.home);
      // The menu that held the door (the model selector, the «+», the tile's
      // menu) goes away first: its trigger is the anchor, so the registry
      // would otherwise take this panel for its child and keep both open. A
      // menu that holds the anchor in its body stays (the board settings
      // around their model selector): it is the panel's parent.
      if (anchor) closePopoversAround(anchor);
      else closeAllPopovers();
      const returnFocus = detail.returnFocus?.isConnected ? detail.returnFocus : null;
      setRequest((r) => ({ home: detail.home as PanelHome, anchor, returnFocus, n: (r?.n ?? 0) + 1 }));
    };
    window.addEventListener(OPEN_HOME_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_HOME_EVENT, onRequest);
  }, []);

  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <HomePanel key={request.n} request={request} onClose={close} />
    </Suspense>
  );
}


/**
 * THE PROFILE MENU, LOADED WHEN SOMEBODY ASKS FOR IT.
 *
 * It is the content of a popover that opens on a click of the user card, so
 * nothing of it is on screen at first paint; as a static import it sat in the
 * eager entry together with the people list and the row styles behind it
 * (measured 2026-09-06: 9.7 KB raw of the entry chunk, paid by every session,
 * including the ones that never open the card). Same gesture, same reasoning as
 * `accountPanelLazy.ts` next door — the panel it now wraps.
 *
 * `lazyWarm`, NOT `React.lazy`: the card asks for the chunk on hover and on
 * focus, and a warm `lazyWarm` renders in the same pass as its parent, with no
 * fallback frame in between. That matters here more than for the account
 * panel: eight E2E specs measure this menu's geometry (sheet height on mobile,
 * tooltips, the perf panel behind it), and a menu that commits empty and fills
 * in a frame later is a menu whose height those specs read too early.
 *
 * WHY A MODULE OF ITS OWN: a file that exports both components and plain
 * functions loses fast refresh (`react-refresh/only-export-components`), and
 * the menu is a component file.
 */
import { lazyWarm, warm } from '@/lib/lazyWarm';
import { prefetchAccountPanel } from './accountPanelLazy';

const loadProfileMenu = () => import('./ProfileMenu');

export const ProfileMenu = lazyWarm(loadProfileMenu, (m) => m.ProfileMenu);

let prefetched = false;

/** The menu and the account panel inside it are one gesture: warm both. */
export function prefetchProfileMenu(): void {
  prefetchAccountPanel();
  if (prefetched) return;
  prefetched = true;
  warm(loadProfileMenu).catch(() => { prefetched = false; });
}

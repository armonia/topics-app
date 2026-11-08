/**
 * THE PHONE'S TITLE MENU ROWS AND IDENTITY BLOCK, LOADED WHEN THE MENU CAN BE
 * ASKED FOR.
 *
 * On the desktop these rows live in the user card's menu, already a lazy chunk
 * (`profileMenuLazy`). On the phone they hang off the title, and they grew the
 * preference levels' rows: as a static import of `App` they sat in the eager
 * entry, paid by every session including every desktop one, which never draws
 * them there.
 *
 * `lazyWarm`, NOT `React.lazy`, for the reason written in `profileMenuLazy`:
 * a warmed module renders in the same pass as its parent, with no fallback
 * frame, and the phone specs measure this sheet's geometry on open. `App`
 * warms it once the phone layout is up and on the first touch of the title.
 *
 * A module of its own: a component file that also exports plain functions
 * loses fast refresh.
 */
import { lazyWarm, warm } from '@/lib/lazyWarm';
import { prefetchAccountPanel } from './accountPanelLazy';

// Destructured on purpose: a bare `import()` is opaque to knip.
const loadTopicsMenuItems = async () => {
  const { TopicsMenuItems: Body } = await import('./TopicsMenuItems');
  return { TopicsMenuItems: Body };
};

export const TopicsMenuItems = lazyWarm(loadTopicsMenuItems, (m) => m.TopicsMenuItems);

// The identity block at the top of the same sheet: warmed with the rows, or
// the sheet would open short and grow under the finger a frame later.
const loadMobileIdentityMenuItems = async () => {
  const { MobileIdentityMenuItems: Body } = await import('./MobileIdentityMenuItems');
  return { MobileIdentityMenuItems: Body };
};

export const MobileIdentityMenuItems = lazyWarm(loadMobileIdentityMenuItems, (m) => m.MobileIdentityMenuItems);

let prefetched = false;

export function prefetchTopicsMenuItems(): void {
  prefetchAccountPanel();
  if (prefetched) return;
  prefetched = true;
  Promise.all([warm(loadTopicsMenuItems), warm(loadMobileIdentityMenuItems)]).catch(() => { prefetched = false; });
}

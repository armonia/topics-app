/**
 * THE ACCOUNT PANEL, LOADED WHEN SOMEBODY ASKS FOR IT.
 *
 * It is the content of a popover that opens on a click, so nothing of it is on
 * screen at first paint; as a static import it sat in the eager entry together
 * with `useAccountLink` and the account state behind it (measured 2026-09-03:
 * 6.9 KB raw of the entry chunk, paid by every session, including the ones that
 * never open the card).
 *
 * THE PREFETCH IS WHAT MAKES THE FIRST CLICK FULL. The card asks for it on
 * hover and on focus, so by the time the menu opens the chunk is there and the
 * panel is not an empty box that fills in a frame later.
 *
 * WHY A MODULE OF ITS OWN: a file that exports both components and plain
 * functions loses fast refresh (`react-refresh/only-export-components`), and
 * the menu is a component file.
 */
import { lazy } from 'react';

const importAccountPanel = async () => {
  const { AccountPanel: Component } = await import('./AccountPanel');
  return { default: Component };
};

export const AccountPanel = lazy(importAccountPanel);

let prefetched = false;

export function prefetchAccountPanel(): void {
  if (prefetched) return;
  prefetched = true;
  importAccountPanel().catch(() => { prefetched = false; });
}

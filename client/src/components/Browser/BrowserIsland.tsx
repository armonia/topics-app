import type { ReactNode } from 'react';

/**
 * The window's corner radius on macOS 26 (16pt, see `window_corner_radius` in
 * the shell) less the islands' gap (6px): concentric with the window's corner
 * the page sits in, so the band between the two arcs stays even.
 */
export const ISLAND_RADIUS = 10;

/**
 * THE PAGE AS AN ISLAND (25/11, "an island, four corners").
 *
 * With the tabs at the side the project's sections are islands on the window's
 * ground (`SECTION_ISLAND`), and the browser beside them was a square slab
 * against the window's rounded corner. Here it is a card of its own: off the
 * window's edges by the islands' gap, its four corners rounded.
 *
 * The DOM rounds what it draws; the native page sits ABOVE the DOM and has to be
 * rounded by the shell, which reads `data-native-card-radius` off the slot's
 * ancestors (`resolveCornerShape` in `useTauriBrowser`).
 *
 * Off, the wrapper is `display: contents`: the same element either way, so
 * switching it never remounts the page underneath.
 *
 * `besideColumn`: the project's column of islands is on the left, and its
 * islands' own margin already makes the gap.
 */
export function BrowserIsland({ on, besideColumn = false, children }: { on: boolean; besideColumn?: boolean; children: ReactNode }) {
  return (
    <div
      data-testid={on ? 'browser-island' : undefined}
      data-native-card-radius={on ? ISLAND_RADIUS : undefined}
      // Top level with the column's first island, 6px off the window's right
      // and bottom edges like its last one (measured in SPLIT-03f).
      className={on ? `flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden mb-1.5 mr-1.5 ${besideColumn ? '' : 'ml-1.5'}` : 'contents'}
      style={on ? { borderRadius: ISLAND_RADIUS } : undefined}
    >
      {children}
    </div>
  );
}

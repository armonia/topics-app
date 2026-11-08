/**
 * THE BODY OF THE TAB SHEET, LOADED WHEN SOMEBODY REACHES FOR IT.
 *
 * `TabSheet` is drawn from the tab strip, and the tab strip is in the eager
 * entry chunk: as a static import, everything the sheet draws (the console
 * panel and its log model, the downloads list, the suggestions, the levels and
 * their rows) came with it, and every session paid for it before the first
 * paint. Measured on the CI of PR #34: entry_eager 1,403,155 raw / 439,747 gz
 * against a budget of 1,393,840 / 435,687.
 *
 * So the sheet is cut in two. What must LISTEN stays eager (which sheet is
 * open, the browser pane's requests, Esc and click-outside, the freeze of the
 * page), what DRAWS is `TabSheetBody`, behind this loader.
 *
 * `lazyWarm`, NOT `React.lazy`: the tab warms the chunk on pointer-enter and on
 * focus, so by the time the gesture lands a warm body renders in the same pass
 * as the tab, with no empty frame where the panel should be.
 *
 * A MODULE OF ITS OWN: a component file that also exports a function loses
 * fast refresh, and knip reads a bare `import()` as opaque.
 */
import type { ComponentProps, ComponentType } from 'react';
import { lazyWarm, warm } from '../../lib/lazyWarm';
// Type-only: erased from the output, so the body stays out of this chunk.
import type { TabSheetBody as Body } from './TabSheetBody';

const loadTabSheetBody = async () => {
  const { TabSheetBody: Component } = await import('./TabSheetBody');
  return { TabSheetBody: Component };
};

// Annotated with the props of the real component: an inferred type would name
// the body's props interface, which that module does not export (TS4023).
export const TabSheetBody: ComponentType<ComponentProps<typeof Body>> = lazyWarm(
  loadTabSheetBody,
  (m) => m.TabSheetBody,
);

let prefetched = false;

/** Warm the body before the gesture that opens it. A failed load re-arms. */
export function prefetchTabSheet(): void {
  if (prefetched) return;
  prefetched = true;
  warm(loadTabSheetBody).catch(() => { prefetched = false; });
}

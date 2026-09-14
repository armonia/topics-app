/**
 * THE BODY OF THE TAB SHEET, LOADED WHEN SOMEBODY REACHES FOR IT.
 *
 * `BrowserTabSheet` is drawn from the tab strip, and the tab strip is in the
 * eager entry chunk: as a static import, everything the sheet draws came with
 * it - the console panel and its log model, the downloads list, the suggestion
 * lists, eight rows of commands - and every session paid for it before the
 * first paint, including the ones that never open a browser. Measured on the
 * CI of PR #34: entry_eager 1,403,155 raw / 439,747 gz against a budget of
 * 1,393,840 / 435,687.
 *
 * So the sheet is cut in two. What must LISTEN stays eager (the request
 * counters that decide when it opens, and the freeze of the page), what DRAWS
 * is `BrowserTabSheetBody`, behind this loader.
 *
 * `lazyWarm`, NOT `React.lazy`: the tab warms the chunk on pointer-enter and on
 * focus, so by the time the click lands a warm body renders in the same pass as
 * the tab, with no empty frame where the panel should be. Same gesture, same
 * reasoning as `Sidebar/profileMenuLazy.ts`.
 *
 * A MODULE OF ITS OWN for that file's two reasons: a component file that also
 * exports a function loses fast refresh, and knip reads a bare `import()` as
 * opaque (every export of the target would count as used).
 */
import { lazyWarm, warm } from '../../lib/lazyWarm';

const loadBrowserTabSheetBody = async () => {
  const { BrowserTabSheetBody: Body } = await import('./BrowserTabSheetBody');
  return { BrowserTabSheetBody: Body };
};

export const BrowserTabSheetBody = lazyWarm(loadBrowserTabSheetBody, (m) => m.BrowserTabSheetBody);

let prefetched = false;

/** Warm the body before the gesture that opens it. A failed load re-arms. */
export function prefetchBrowserTabSheet(): void {
  if (prefetched) return;
  prefetched = true;
  warm(loadBrowserTabSheetBody).catch(() => { prefetched = false; });
}

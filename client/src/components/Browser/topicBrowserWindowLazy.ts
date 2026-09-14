/**
 * THE TOPIC'S BROWSER WINDOW, LOADED WHEN A TOPIC ACTUALLY HAS ONE.
 *
 * `ChatPanel` is in the eager entry chunk, and everyone downloads that chunk
 * before the first paint, including the sessions that never open a browser. A
 * static import of the window would have carried `RemoteBrowserPanel`, the
 * native placeholder and the whole per-topic store in with it, on a budget
 * (`check:bundle`, entry_eager gz) that is already a few hundred bytes from its
 * ceiling. Same cut, same reasoning as `browserTabSheetLazy.ts`.
 *
 * So the eager side keeps only what it needs to DECIDE: does this topic have a
 * window, in which mode, how wide. That is `useTopicBrowserPresence`, and it is
 * also what tells `ChatPanel` how much room to cede. Everything that DRAWS is
 * behind the loader, warmed as soon as the topic turns out to have sheets, so
 * the first paint of the window has no empty frame in front of it.
 *
 * A MODULE OF ITS OWN, not an export of the component file: a component file
 * that also exports functions loses fast refresh, and knip reads a bare
 * `import()` as opaque (every export of the target would count as used).
 */
import { useEffect, useState, type ComponentProps, type ComponentType } from 'react';
import { lazyWarm, warm } from '../../lib/lazyWarm';
// Type-only: erased from the output, so the body stays out of this chunk.
import type { TopicBrowserWindow as Window } from './TopicBrowserWindow';
import type { TopicBrowserMode } from '../../state/topicBrowserWindow';

const loadTopicBrowserWindow = async () => {
  const { TopicBrowserWindow: Component } = await import('./TopicBrowserWindow');
  return { TopicBrowserWindow: Component };
};

export const TopicBrowserWindow: ComponentType<ComponentProps<typeof Window>> = lazyWarm(
  loadTopicBrowserWindow,
  (m) => m.TopicBrowserWindow,
);

// Destructured, not handed around whole: a bare `import()` is opaque to knip
// and would make every export of the store immortal.
const loadStore = async () => {
  const { getTopicWindow, subscribeTopicWindows, ensureTopicWindowLoaded } = await import(
    '../../state/topicBrowserWindow'
  );
  return { getTopicWindow, subscribeTopicWindows, ensureTopicWindowLoaded };
};
let storePromise: ReturnType<typeof loadStore> | null = null;
const store = () => (storePromise ??= loadStore());

/** What the eager side knows about a topic's window: enough to lay out around
 *  it, not enough to draw it. */
export interface TopicBrowserPresence {
  mode: TopicBrowserMode;
  /** px, null = the default width of the expanded window. */
  expandedWidth: number | null;
  sheets: number;
  /** Pages of this topic currently ON LOAN to the layout as tabs. A window with
   *  none of its own sheets left still has to exist for them: it is what gives
   *  them back, and what notices when one is closed out there. */
  promoted: number;
}

/** Width of the expanded window before anyone drags its edge. Lives here, on
 *  the eager side, because `ChatPanel` has to cede exactly this much. */
export const DEFAULT_EXPANDED_WIDTH = 520;

/** The chat never cedes below this: an expanded window on a narrow pane would
 *  otherwise push the conversation down to a sliver, or past zero. */
export const MIN_CHAT_WIDTH = 320;

const ABSENT: TopicBrowserPresence = { mode: 'hidden', expandedWidth: null, sheets: 0, promoted: 0 };

const same = (a: TopicBrowserPresence, b: TopicBrowserPresence): boolean =>
  a.mode === b.mode && a.expandedWidth === b.expandedWidth && a.sheets === b.sheets && a.promoted === b.promoted;

/**
 * Subscribe to the shape of a topic's window. Hydrates the row on first use
 * (`ensureTopicWindowLoaded`), then follows every local and remote change.
 *
 * An empty `topicId` (a draft, or a viewport too narrow for a window) reads as
 * absent and loads nothing at all.
 */
export function useTopicBrowserPresence(topicId: string): TopicBrowserPresence {
  // Keyed by topic: the row hydrates asynchronously, and returning the previous
  // topic's window while the new one loads would make the chat cede space to a
  // window that is not there.
  const [entry, setEntry] = useState<{ topicId: string; presence: TopicBrowserPresence }>(
    { topicId: '', presence: ABSENT },
  );
  useEffect(() => {
    if (!topicId) return;
    let alive = true;
    let stop = (): void => {};
    void store().then(async (s) => {
      if (!alive) return;
      await s.ensureTopicWindowLoaded(topicId);
      if (!alive) return;
      const read = (): void => {
        const w = s.getTopicWindow(topicId);
        const next: TopicBrowserPresence = {
          mode: w.mode, expandedWidth: w.expandedWidth, sheets: w.tabs.length, promoted: w.promoted.length,
        };
        setEntry((prev) => (prev.topicId === topicId && same(prev.presence, next) ? prev : { topicId, presence: next }));
        // A topic with sheets is a topic whose window can be asked for at any
        // moment: warm the chunk now, not on the click.
        if (w.tabs.length || w.promoted.length) void warm(loadTopicBrowserWindow);
      };
      read();
      stop = s.subscribeTopicWindows(read);
    });
    return () => { alive = false; stop(); };
  }, [topicId]);
  return topicId && entry.topicId === topicId ? entry.presence : ABSENT;
}

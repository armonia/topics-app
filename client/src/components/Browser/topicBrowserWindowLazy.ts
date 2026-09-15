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
import { registerTopicWindowDoor } from '../../lib/topicWindowDoor';
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
  const { getTopicWindow, subscribeTopicWindows, ensureTopicWindowLoaded, topicBrowserWindow } = await import(
    '../../state/topicBrowserWindow'
  );
  return { getTopicWindow, subscribeTopicWindows, ensureTopicWindowLoaded, topicBrowserWindow };
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

/** Narrowest the expanded window is allowed to be. Declared here, on the eager
 *  side, so `expandedInsetFor` can ask "does this area fit a window at all?"
 *  without pulling the store in; `EXPANDED_WIDTH_BOUNDS` reads it from here, so
 *  the two cannot drift apart. */
export const MIN_EXPANDED_WIDTH = 360;

/** Narrowest a docked window can be and still be OPERABLE: its bar has to
 *  show the handful of buttons that get you back out of it. Deliberately
 *  well BELOW MIN_EXPANDED_WIDTH: a window narrower than it would like is
 *  a nuisance and the chat floor still wins, but a 2px one traps you. */
export const MIN_OPERABLE_WINDOW_WIDTH = 160;

/** Narrowest area that can hold an operable docked window AND a usable chat
 *  beside it. Below this the window does not dock at all. */
export const MIN_DOCK_AREA = MIN_CHAT_WIDTH + MIN_OPERABLE_WINDOW_WIDTH;

/** Can this area hold a docked window at all? The rendering asks this before
 *  dressing the window as expanded, so a persisted `exp` cannot survive in
 *  an area too narrow to show the way out of it. */
export function canExpandInArea(areaWidth: number): boolean {
  return areaWidth >= MIN_DOCK_AREA;
}

/**
 * HOW MUCH THE CHAT ACTUALLY CEDES, computed ONCE for both sides.
 *
 * The window's left edge and the chat's right padding have to be the SAME
 * edge. They were two formulas: the window floored its width at its own
 * minimum, the padding did not, and between 320 and 740 px of area the window
 * came out wider than the space the chat had given up. The difference landed
 * on the composer, which the page then covered (measured at 900 px: 96 px of
 * "send" under the window, and `elementFromPoint` returning the window).
 *
 * So there is one number now, and whoever needs it asks for it. The chat's
 * floor wins over the window's preferred minimum: a window a bit narrower than
 * it would like is a nuisance, a covered composer is a broken chat.
 *
 * AND BELOW A POINT THERE IS NO WINDOW TO PLACE. Letting the chat's floor win
 * without a floor of its own meant the leftover could be anything: in a split
 * project the area is a few hundred pixels, and the expanded window came out
 * 80 px wide at 1280 and 2 px at 1024, too narrow to hit its own minimise
 * button. A window nobody can grab is worse than no window, and the mode is
 * persisted, so the topic stayed stuck in it. Under `MIN_DOCK_AREA` the
 * answer is zero: the caller falls back to the floating window, which is
 * always reachable.
 */
export function expandedInsetFor(areaWidth: number, requestedWidth: number): number {
  if (areaWidth < MIN_DOCK_AREA) return 0;
  return Math.max(0, Math.min(requestedWidth, areaWidth - MIN_CHAT_WIDTH));
}

/**
 * HOW MUCH THIS CHAT CEDES, measured.
 *
 * This used to be the same clamp written a second time in CSS, over `100%` of
 * the padded element. It agreed with `expandedInsetFor` only as long as the
 * rule was a pure clamp: the moment the rule gained a THRESHOLD ("below this
 * area, nothing"), CSS could no longer state it, because a step function of a
 * length is not expressible in `min`/`max`/`calc`. The two sides would have
 * drifted exactly where it hurts, leaving the chat a 359 px gutter next to a
 * window that had fallen back to floating.
 *
 * So the chat measures the element it is about to pad, and asks the same
 * function as everyone else. The border box does not move when the padding
 * changes, so the measurement is stable and this does not oscillate.
 */
export function useTopicBrowserInset(
  areaRef: { current: HTMLElement | null },
  requestedWidth: number,
): number {
  const [areaWidth, setAreaWidth] = useState(0);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const read = (): void => setAreaWidth((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [areaRef]);
  return requestedWidth > 0 && areaWidth > 0 ? expandedInsetFor(areaWidth, requestedWidth) : 0;
}

/**
 * Is there a window to mount for this topic?
 *
 * HIDDEN IS NOT ABSENT. The X puts the window away and KEEPS its sheets, so a
 * hidden window with pages behind it still has to be mounted: it is the only
 * thing that draws the command bringing it back. Gated on the mode alone, the
 * X unmounted the component that owns `topic-browser-reopen`, and the pages of
 * that topic became unreachable for good.
 *
 * One predicate because there are two mounts (`ChatPanel` and `ChatPane`), and
 * two copies of this rule is how one of them ends up wrong.
 */
export function hasTopicBrowserWindow(presence: TopicBrowserPresence): boolean {
  return presence.mode !== 'hidden' || presence.sheets > 0 || presence.promoted > 0;
}

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

/**
 * OPEN THE DOOR OF THIS TOPIC, for as long as its chat is on screen.
 *
 * Called with EXACTLY the expression the presence hook gets, so the two rules
 * that decide whether a window is possible at all - wide enough, and this pane
 * is the one that would draw it - are written once. An empty string is "no
 * door": a draft, a viewport under 768 px, or a chat pane with a `ChatPanel`
 * above it that already owns the window.
 *
 * The body is async because the store is a lazy chunk, and the answer to the
 * caller is not: see `topicWindowDoor` for why that is sound.
 */
export function useTopicWindowDoor(topicId: string): void {
  useEffect(() => {
    if (!topicId) return;
    return registerTopicWindowDoor(topicId, (sheet) => {
      void store().then(async (s) => {
        // The row has to be read before it is written: opening onto an
        // un-hydrated window would publish an empty one over the sheets this
        // device has not seen yet.
        await s.ensureTopicWindowLoaded(topicId);
        s.topicBrowserWindow.open(
          topicId,
          { contextId: sheet.contextId, url: sheet.url, openedBy: sheet.openedBy },
          sheet.mode,
        );
      });
      return true;
    });
  }, [topicId]);
}

/** Bring a parked window back into the topic. The command lives in the
 *  topic header, which is eager, so it goes through the same bridge the
 *  presence hook uses: by the time the button is on screen the chunk is
 *  already loaded, so the click resolves from cache. */
export function reopenTopicBrowserWindow(topicId: string): void {
  void store().then((s) => s.topicBrowserWindow.setMode(topicId, 'min'));
}

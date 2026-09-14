/**
 * WHERE A PAGE OPENED WITHOUT A LAYOUT GESTURE GOES, WHEN A TOPIC IS ON SCREEN.
 *
 * A REGISTRY AND NOT A LISTENER, and the reason is the dispatch itself. The
 * surfaces that can host a tab claim `browser:open-tab` by calling
 * `preventDefault()` from a listener on `window`; listeners on the target of an
 * event run in REGISTRATION order, and the capture flag does not reorder them
 * there. As a listener the topic's window would always lose the race it has to
 * win. `openLink` therefore asks here BEFORE it dispatches: one question,
 * answered synchronously, by the one surface that owns that conversation.
 *
 * THE CHAT REGISTERS THE DOOR, NOT THE MOUNTED WINDOW. It used to be the
 * window, and that made the rule "a topic that ALREADY has a window keeps its
 * own links": with no window yet, a link from the chat still tiled a pane
 * somewhere in the layout, which is the very thing TOPIC-BROWSER-04 forbids.
 * The chat is the surface that knows whether a window is possible at all (a
 * real topic, wide enough, and this pane is the one that would draw it), and it
 * is eager, so it is registered long before any click. The window itself is a
 * lazy chunk: the door OPENS it, it does not wait for it.
 *
 * THE DECISION IS SYNCHRONOUS, THE OPENING IS NOT. `openLink` needs a boolean
 * now; loading the store's chunk takes a turn. So "I take it" is answered from
 * the registry alone and the sheet lands a microtask later. The only thing that
 * could make that promise false is a page ALREADY on loan to the layout as a
 * tab, and that case never reaches here: the callers check the layout first.
 *
 * The promotion trip does NOT come through here: "open as tab" dispatches the
 * event itself, so a sheet on its way OUT of the window is never caught by the
 * window's own door and bounced back in.
 */
import type { OpenTabDetail } from './openLink';
// Type-only: erased from the output, so the store's body stays out of every
// eager chunk that imports this router (`check:bundle`).
import type { TopicBrowserMode, TopicBrowserOpenedBy } from '../state/topicBrowserWindow';

/** What the door is asked to put in the window. */
export interface TopicWindowSheet {
  contextId: string;
  url: string;
  openedBy: TopicBrowserOpenedBy;
  /** Which state to leave the window in. Omitted, a hidden window only wakes to
   *  minimised: an opening nobody asked for does not take the screen. */
  mode?: TopicBrowserMode;
}

/** Takes the page and says so. False means "not mine": the caller carries on to
 *  the layout, exactly as if this topic had no window. */
export type TopicWindowDoor = (sheet: TopicWindowSheet) => boolean;

const doors = new Map<string, TopicWindowDoor>();

/** Register the door of `topicId`. Returns the un-register, for the effect that
 *  called it. */
export function registerTopicWindowDoor(topicId: string, door: TopicWindowDoor): () => void {
  if (!topicId) return () => {};
  doors.set(topicId, door);
  return () => {
    // Only drop it if it is still ours: a remount registers before the previous
    // effect cleans up, and deleting then would shut a live door.
    if (doors.get(topicId) === door) doors.delete(topicId);
  };
}

/**
 * Does a topic's window take this link?
 *
 * `nearPaneId` is the disqualifier: a link clicked inside a browser PANE names
 * the pane it came from and belongs to that strip, whatever conversation the
 * pane happens to sit next to.
 */
export function topicWindowTakesLink(detail: OpenTabDetail): boolean {
  if (!detail.topicId || detail.nearPaneId) return false;
  return openInTopicWindow(detail.topicId, {
    contextId: detail.contextId,
    url: detail.url,
    openedBy: 'link',
  });
}

/**
 * The same door, for the origins that are not a clicked link: the agent's
 * `open_browser_pane` and the `/browser` command. They reach the layout through
 * their own events, so they ask directly instead of going through `openLink`.
 *
 * True means the window has it and the layout must not be touched.
 */
export function openInTopicWindow(topicId: string | undefined, sheet: TopicWindowSheet): boolean {
  if (!topicId || !sheet.contextId) return false;
  return doors.get(topicId)?.(sheet) ?? false;
}

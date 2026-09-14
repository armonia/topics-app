/**
 * WHERE A LINK CLICKED IN A TOPIC'S CHAT GOES, WHEN THAT TOPIC HAS A WINDOW.
 *
 * A REGISTRY AND NOT A LISTENER, and the reason is the dispatch itself. The
 * surfaces that can host a tab claim `browser:open-tab` by calling
 * `preventDefault()` from a listener on `window`; listeners on the target of an
 * event run in REGISTRATION order, and the capture flag does not reorder them
 * there. The topic's window is a lazy chunk that mounts long after the layout
 * hooks have registered, so as a listener it would always lose the race it has
 * to win. `openLink` therefore asks here BEFORE it dispatches: one question,
 * answered synchronously, by the one surface that owns that conversation.
 *
 * ONLY A TOPIC THAT ALREADY HAS A WINDOW answers, because only a mounted window
 * registers. A topic without one keeps the behaviour it always had (a tab in
 * the layout), which is what keeps this change off every other open path.
 *
 * The promotion trip does NOT come through here: "open as tab" dispatches the
 * event itself, so a sheet on its way OUT of the window is never caught by the
 * window's own door and bounced back in.
 */
import type { OpenTabDetail } from './openLink';

/** Takes the page and says so. False means "not mine": the link carries on to
 *  the layout, exactly as if this topic had no window. */
export type TopicWindowDoor = (detail: OpenTabDetail) => boolean;

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
  return doors.get(detail.topicId)?.(detail) ?? false;
}

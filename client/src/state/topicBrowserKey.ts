/**
 * The ui-state key of a topic's browser window, on its own.
 *
 * It lives apart from `topicBrowserWindow.ts` so the WS bridge
 * (`useTaskBrowserTabsSync`, mounted in App) can tell a `topic-browser:` frame
 * from every other one WITHOUT importing the store: the store is loaded with
 * `import()` and stays out of the entry chunk, while the check that decides
 * whether a frame belongs to it has to answer synchronously.
 */

const TOPIC_BROWSER_KEY_PREFIX = 'topic-browser:';

export const topicBrowserKeyFor = (topicId: string): string => `${TOPIC_BROWSER_KEY_PREFIX}${topicId}`;

/** Extract the topicId from a `topic-browser:<topicId>` ui-state key (or null
 *  when the key is not one). Lets the WS bridge route broadcasts. */
export function topicIdFromKey(key: string): string | null {
  return typeof key === 'string' && key.startsWith(TOPIC_BROWSER_KEY_PREFIX)
    ? key.slice(TOPIC_BROWSER_KEY_PREFIX.length)
    : null;
}

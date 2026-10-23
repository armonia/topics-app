/**
 * Drops the browser history of topics that no longer exist.
 *
 * Each topic keeps its own list of visited URLs under `browser-history-<id>`
 * (at most 50 entries). Nothing removes that key when the topic is deleted, so
 * the lists of deleted topics stayed in localStorage for good and counted
 * against the same 5 MiB quota as the topics themselves.
 *
 * Only call this with the WHOLE topic set (live and archived): an id missing
 * from `liveIds` must mean deleted, and a partial set would erase the history
 * of a topic that is only not loaded yet.
 */
const PREFIX = 'browser-history-';

export function pruneBrowserHistory(liveIds: ReadonlySet<string>): number {
  let removed = 0;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(PREFIX) && !liveIds.has(key.slice(PREFIX.length))) stale.push(key);
    }
    for (const key of stale) {
      localStorage.removeItem(key);
      removed++;
    }
  } catch {
    // Storage can refuse the walk; the history is only a convenience.
  }
  return removed;
}

/**
 * THE TOPICS THIS WINDOW DECLARES ON THE WIRE, BEYOND ITS OPEN PANES.
 *
 * Per-token deltas (`stream:content_chunk`, `thinking_chunk`, `tool_call`,
 * `tool_update`, `tool_result`) reach a window only if it declared their topic:
 * the server REPLACES the set at every `subscribe` frame
 * (`server/lib/ws-topic-routing.ts`), and the client builds that frame from
 * `presenceTopicIds`, i.e. the open panes. A surface that is not a pane — the
 * task drawer, which shows the agent's session inside the board — would then
 * see only `stream:start` / `message:new` / `stream:end` and sit on an empty
 * bubble for the whole turn.
 *
 * So it asks. `holdTopic(id)` adds the topic to the set this window declares
 * and returns the release; the frame carries `presenceTopicIds ∪ extra`.
 *
 * COUNTED, not a plain set: two drawers on the same topic (two windows of the
 * board, a card open twice) each hold and each release, and the first release
 * must not silence the second reader. The count is the only thing that gets
 * this right without the holders knowing about each other.
 *
 * STABLE BY REFERENCE: `getExtraTopicIds()` returns the same array until the
 * set of KEYS changes, so `useSyncExternalStore` does not loop and the effect
 * that sends the frame does not fire on a hold that changed nothing but a
 * counter.
 *
 * Presence is a separate question and does NOT change: the drawer is not "a
 * chat open in this window" for the other windows.
 */

/** How many holders per topic. A key exists only while its count is > 0. */
const counts = new Map<string, number>();
const subs = new Set<() => void>();

/** The current snapshot, rebuilt only when the KEY SET changes. */
let snapshot: readonly string[] = [];

function publish(): void {
  snapshot = Array.from(counts.keys());
  for (const fn of subs) fn();
}

/**
 * Declares `topicId` for as long as the returned release is not called.
 * The release is idempotent: calling it twice does not free somebody else's
 * hold, which is what a React effect cleanup running twice would otherwise do.
 */
export function holdTopic(topicId: string): () => void {
  if (!topicId) return () => {};
  const before = counts.get(topicId) ?? 0;
  counts.set(topicId, before + 1);
  if (before === 0) publish();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = counts.get(topicId) ?? 0;
    if (now <= 1) {
      counts.delete(topicId);
      publish();
      return;
    }
    counts.set(topicId, now - 1);
  };
}

/** The extra topics, same array reference until the set of keys changes. */
export function getExtraTopicIds(): readonly string[] {
  return snapshot;
}

/**
 * The topic set to declare on the wire: the open panes plus the extra holds,
 * deduplicated. The server REPLACES its set with this one, so it has to be the
 * whole truth of what this window wants to hear, not a delta.
 */
export function withExtraTopics(
  presenceTopicIds: readonly string[],
  extraTopicIds: readonly string[],
): string[] {
  return Array.from(new Set([...presenceTopicIds, ...extraTopicIds]));
}

/** Wakes up when the extra set gains or loses a topic. */
export function subscribeExtraTopics(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Tests only: back to boot. */
export function __resetTopicSubscriptions(): void {
  counts.clear();
  subs.clear();
  snapshot = [];
}

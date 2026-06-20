/**
 * Per-topic WS delta routing (P6).
 *
 * Streaming deltas (`stream:content_chunk`, etc.) used to fan out to EVERY
 * connected socket via broadcastToAll — one chat's chunks hit every tab/window/
 * PWA regardless of whether they had that topic open. broadcastToTopic was the
 * opposite extreme: FOCUSED client only, which drops deltas for a topic open in
 * a background tab or a second window (the user's multi-client convergence).
 *
 * The fix: each client declares the SET of topics it currently has open (via a
 * `subscribe` inbound frame → `WSData.openTopicIds`). A delta goes to every
 * client that has the topic open — preserving multi-window/background streaming
 * while skipping clients that aren't showing it.
 *
 * Pure + tiny so the routing rule is unit-tested without spinning up a server.
 */
export interface TopicRoutingState {
  /** Set of topic ids this connection currently has open; `undefined` for a
   *  client that has not (yet) declared one — e.g. just-connected or an older
   *  client that doesn't send `subscribe`. Such clients receive everything so
   *  the change can never make an undeclared client miss its own stream. */
  openTopicIds?: Set<string>;
  /** The single focused topic (legacy signal); still honoured as a fallback. */
  focusedTopicId: string | null;
}

/**
 * Should this connection receive a streaming delta for `topicId`?
 *
 * - No declared open-set → yes (legacy/just-connected: never starve a client).
 * - Declared open-set → yes iff the topic is in it, or it is the focused topic.
 */
export function clientReceivesTopicDelta(
  state: TopicRoutingState,
  topicId: string,
): boolean {
  if (!state.openTopicIds) return true;
  return state.openTopicIds.has(topicId) || state.focusedTopicId === topicId;
}

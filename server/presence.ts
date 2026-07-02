/**
 * Cross-window presence — pure snapshot builder.
 *
 * The WS presence channel rebroadcasts the FULL list of windows that have
 * declared themselves (via `hello` / `presence:announce`), plus the topics each
 * holds. Building that list from the live socket set is the only logic worth
 * unit-testing; keeping it pure (input = the presence facts on each socket,
 * output = the deduped window list) lets server.ts stay a thin adapter over it.
 */

/** The presence-bearing subset of a socket's WSData (what the builder reads). */
export interface PresenceSource {
  id: string;
  windowId?: string;
  windowLabel?: string;
  detached?: boolean;
  presenceTopicIds?: string[];
  presenceFocusedTopicId?: string;
}

export interface PresenceWindowEntry {
  windowId: string;
  clientId: string;
  windowLabel?: string;
  detached?: boolean;
  topicIds: string[];
  focusedTopicId?: string;
}

/**
 * Deduped list of windows that have declared presence. A socket without a
 * `windowId` has not announced and is skipped; when two sockets carry the same
 * `windowId` (a reconnect race) the first wins. Order follows iteration order.
 */
export function buildPresenceSnapshot(sources: Iterable<PresenceSource>): PresenceWindowEntry[] {
  const seen = new Set<string>();
  const windows: PresenceWindowEntry[] = [];
  for (const s of sources) {
    if (!s.windowId || seen.has(s.windowId)) continue;
    seen.add(s.windowId);
    windows.push({
      windowId: s.windowId,
      clientId: s.id,
      windowLabel: s.windowLabel,
      detached: s.detached,
      topicIds: s.presenceTopicIds ?? [],
      focusedTopicId: s.presenceFocusedTopicId,
    });
  }
  return windows;
}

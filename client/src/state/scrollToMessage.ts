/**
 * Pending scroll-to-message targets — the bridge between the command palette's
 * message-search results and the (possibly not-yet-mounted) MessageList.
 *
 * The palette can't scroll directly: clicking a hit opens the topic, whose
 * MessageList mounts later and loads its thread async. So the click REGISTERS
 * a target here keyed by topicId, and MessageList consumes it once its
 * messages actually contain the id (mount-load path) or immediately via the
 * event (topic-already-open path). Targets expire after a short TTL so a hit
 * whose open never completed can't hijack an unrelated visit minutes later.
 */

export const SCROLL_TO_MESSAGE_EVENT = 'topics:scroll-to-message';

const TTL_MS = 30_000;
/** How long a target survives AFTER its first jump. Opening a topic from the
 *  palette also triggers a message reload that completes right after the
 *  first jump; its bottom-anchor pass would drag the list back to the bottom
 *  if the target were consumed immediately (observed live). Keeping the entry
 *  briefly (a) suppresses the bottom anchors via peek and (b) lets the
 *  post-reload pass re-jump. */
const FIRED_GRACE_MS = 2_000;

const targets = new Map<string, { messageId: string; at: number; firedAt?: number }>();

/** Register a target and nudge any already-mounted list for this topic. */
export function requestScrollToMessage(topicId: string, messageId: string): void {
  targets.set(topicId, { messageId, at: Date.now() });
  // Guarded so the pure register/peek/consume core stays testable under
  // bun:test (no DOM there).
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SCROLL_TO_MESSAGE_EVENT, { detail: { topicId } }));
  }
}

/** Read the pending target without consuming it. Null (and purged) once the
 *  registration TTL — or the post-fire grace — has elapsed. */
export function peekScrollToMessage(topicId: string): string | null {
  const entry = targets.get(topicId);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.at > TTL_MS || (entry.firedAt !== undefined && now - entry.firedAt > FIRED_GRACE_MS)) {
    targets.delete(topicId);
    return null;
  }
  return entry.messageId;
}

/** Record that the jump ran (starts the post-fire grace; first call wins). */
export function markScrollToMessageFired(topicId: string): void {
  const entry = targets.get(topicId);
  if (entry && entry.firedAt === undefined) entry.firedAt = Date.now();
}

/** Drop the pending target (after scrolling, or when it's unfindable). */
export function consumeScrollToMessage(topicId: string): void {
  targets.delete(topicId);
}

/** Test hook. */
export function _clearAllScrollTargets(): void {
  targets.clear();
}

// The banner's pure decisions, kept out of the component file: what the rows
// are (one per chat) and what the preview line says. They live here because
// they are the part worth unit-testing without a DOM, and because a .tsx that
// also exports plain functions breaks fast refresh.
import type { Topic } from '@/types';

export interface UnsentMessage {
  sessionKey: string;
  content: string;
  timestamp: string;
  options?: unknown;
}

export interface UnsentGroup {
  sessionKey: string;
  topicId?: string;
  name?: string;
  items: UnsentMessage[];
}

/**
 * One group per chat, in first-seen order. A session with no topic still gets
 * a row: losing a message because its chat was deleted would be worse than an
 * unnamed row, and the caller falls back to a generic label.
 */
export function groupUnsentBySession(
  messages: UnsentMessage[],
  topics: Record<string, Topic>,
): UnsentGroup[] {
  const bySession = new Map<string, UnsentGroup>();
  const topicOf = new Map<string, Topic>();
  for (const topic of Object.values(topics)) {
    if (topic.sessionKey) topicOf.set(topic.sessionKey, topic);
  }
  for (const item of messages) {
    let group = bySession.get(item.sessionKey);
    if (!group) {
      const topic = topicOf.get(item.sessionKey);
      group = { sessionKey: item.sessionKey, topicId: topic?.id, name: topic?.name, items: [] };
      bySession.set(item.sessionKey, group);
    }
    group.items.push(item);
  }
  return [...bySession.values()];
}

/** One line, cut short: the preview says WHICH message, it does not reprint it. */
export function previewLine(content: string, max = 80): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

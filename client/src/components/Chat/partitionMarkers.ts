/**
 * Position compaction markers within the visible transcript (CHAT-COMPACT-01).
 *
 * A marker renders right AFTER the message whose id equals its `afterMessageId`.
 * Markers with a null anchor — or an anchor that isn't in the currently visible
 * (possibly paginated / filtered) message set — surface at the TOP so they are
 * never silently lost. Pure so it unit-tests under bun:test.
 */

import type { ChatMessage, CompactionMarker } from '../../types';

export interface PartitionedMarkers {
  /** Shown before the first message (null-anchored or anchor off-screen). */
  leading: CompactionMarker[];
  /** messageId → markers to render immediately after that message. */
  byAfter: Map<string, CompactionMarker[]>;
}

function byCreatedAt(a: CompactionMarker, b: CompactionMarker): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export function partitionMarkers(
  messages: ChatMessage[],
  markers: CompactionMarker[] | undefined,
): PartitionedMarkers {
  const leading: CompactionMarker[] = [];
  const byAfter = new Map<string, CompactionMarker[]>();
  if (!markers || markers.length === 0) return { leading, byAfter };

  const visible = new Set<string>();
  for (const m of messages) if (m.id) visible.add(m.id);

  for (const mk of [...markers].sort(byCreatedAt)) {
    if (mk.afterMessageId && visible.has(mk.afterMessageId)) {
      const arr = byAfter.get(mk.afterMessageId) ?? [];
      arr.push(mk);
      byAfter.set(mk.afterMessageId, arr);
    } else {
      leading.push(mk);
    }
  }
  return { leading, byAfter };
}

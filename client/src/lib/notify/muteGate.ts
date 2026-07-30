import type { Topic } from '../../types';

/**
 * Pure decision: is this topic's completion notification muted?
 *
 * Two independent mute sources, EITHER of which silences the banner + sound:
 *   - per-TOPIC   → `Topic.muted` (migration 073), travels with the topic
 *   - per-PROJECT → the topic's `projectPath` is in `mutedProjects`
 *                   (AppSettings.mutedProjects), keyed by path
 *
 * A muted topic produces NO banner and NO sound — but the completion is NOT
 * swallowed: the app-badge path (useTabNotifications → setAppBadge) is driven by
 * the attention rollup, which never consults this gate, so the count still
 * rises. This function only decides the *interruption*, never the count.
 *
 * Defensive: an unknown/undefined topic is treated as NOT muted (fail open —
 * losing a banner is worse than an extra one), and a missing `mutedProjects`
 * list is treated as empty.
 */
export function isTopicMuted(
  topic: Topic | undefined | null,
  mutedProjects: readonly string[] | undefined | null,
): boolean {
  if (!topic) return false;
  if (topic.muted) return true;
  const proj = topic.projectPath;
  if (!proj) return false;
  return (mutedProjects ?? []).includes(proj);
}

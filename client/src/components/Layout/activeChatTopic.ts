/**
 * Which topic the chrome strip is talking about.
 *
 * The strip above a tab bar says what THIS topic touched, so it has exactly
 * one source: the active tab of that bar, and only when that tab is a chat.
 * A terminal, a browser or a file tab has no topic, and a draft chat has no
 * topic id yet: in all those cases the answer is "nobody", which is how the
 * strip stays silent instead of keeping the previous chat's list on screen.
 */
import type { Pane } from '../../state/pane/types';

export function activeChatTopicId(panes: Pane[], activePaneId: string | null): string | undefined {
  if (!activePaneId) return undefined;
  const active = panes.find((p) => p.id === activePaneId);
  if (!active || active.type !== 'chat') return undefined;
  return active.topicId || undefined;
}

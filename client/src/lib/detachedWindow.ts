// Shared projection helpers for a detached (popped-out) OS window, used by both
// surfaces that render presence: the grid card (DetachedWindowMarker) and the
// sidebar row (DetachedWindowsSection). Keeping the label build + the
// focus-or-reopen click in one place stops the two views from drifting.
import { tauriInvoke } from '@/lib/shell/tauri';
import type { PresenceWindow } from '@/state/windowPresence';
import type { Topic } from '@/types';

/** Join names, capped with a trailing `+N`. The one rule every surface that
 *  names a CLUSTER (a detached window, a workspace group) shares, so they all
 *  read identically. */
export function capNamesLabel(names: readonly string[], max = 3): string {
  const kept = names.filter(Boolean);
  const shown = kept.slice(0, max);
  const extra = kept.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra}` : '');
}

/** Human label for a set of topics: their names, capped with a trailing `+N`. */
export function topicNamesLabel(
  topicIds: readonly string[],
  topics: Record<string, Topic>,
  max = 3,
): string {
  return capNamesLabel(topicIds.map((id) => topics[id]?.name || topics[id]?.icon || id), max);
}

/** Human label for a detached window: its topics' names, capped with a `+N`. */
export function detachedWindowLabel(
  w: PresenceWindow,
  topics: Record<string, Topic>,
  max = 3,
): string {
  return topicNamesLabel(w.topicIds, topics, max);
}

/** Click behaviour shared by both surfaces: focus the real OS window natively;
 *  if it's gone / on another machine (`window_focus_label` false or throwing),
 *  fall back to reopening its topics locally. */
export function focusOrReopenDetachedWindow(
  w: PresenceWindow,
  onReopenTopic: (topicId: string) => void,
): void {
  const reopenAll = () => {
    for (const id of w.topicIds) onReopenTopic(id);
  };
  if (w.windowLabel) {
    void tauriInvoke<boolean>('window_focus_label', { label: w.windowLabel })
      .then((focused) => {
        if (!focused) reopenAll();
      })
      .catch(reopenAll);
    return;
  }
  reopenAll();
}

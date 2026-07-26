// Shared projection helpers for a detached (popped-out) OS window, used by both
// surfaces that render presence: the grid card (DetachedWindowMarker) and the
// sidebar row (DetachedWindowsSection). Keeping the label build + the
// focus-or-reopen click in one place stops the two views from drifting.
import { tauriInvoke } from '@/lib/shell/tauri';
import type { PresenceWindow } from '@/state/windowPresence';
import type { Topic } from '@/types';

/** Human label for a detached window: its topics' names, capped with a `+N`. */
export function detachedWindowLabel(
  w: PresenceWindow,
  topics: Record<string, Topic>,
  max = 3,
): string {
  const names = w.topicIds
    .map((id) => topics[id]?.name || topics[id]?.icon || id)
    .filter(Boolean);
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra}` : '');
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

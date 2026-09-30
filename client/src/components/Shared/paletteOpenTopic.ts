import type { Topic } from '../../types';
import { chatApi } from '../../lib/api';
import { afterNextPaint } from '../../lib/afterNextPaint';
import { createPaneId } from '../../state/pane/adapters';
import { usePaneStore } from '../../state/pane/store';
import { isResident } from '../../state/pane/residency/registry';

/**
 * Whether the chat a palette row leads to is already mounted (resident) on
 * this page, by its own pane or by the project pane that hosts it.
 */
function topicPaneIsResident(topic: Topic): boolean {
  const pane = usePaneStore.getState().panes[topic.id];
  if (pane && isResident(pane.stableKey ?? pane.id)) return true;
  return !!topic.projectPath && isResident(createPaneId('project', topic.projectPath));
}

/**
 * Open a chat chosen in the palette.
 *
 * A RESIDENT chat opens in the input task, as before: its switch is cheap, and
 * its final content must be on the first frame after the input (TABSWITCH-01,
 * tab-switch-instant.spec.ts). Deferring it put the old pane on that frame.
 *
 * A chat that has to MOUNT cost the whole render of the new pane inside the
 * keydown (CS-05: a 150-190 ms frame with the palette frozen on screen), and
 * its history request only left from the pane's mount effect, after that
 * render. There nothing of the chat could be on the first frame anyway (the
 * list waits for its history behind the curtain), so the request leaves now,
 * the palette closes in the input frame, and the pane renders in the task
 * after the paint, adopting the request already in flight.
 */
export function openTopicFromPalette(topic: Topic, onOpenTopic: (id: string) => void, onClose: () => void): void {
  if (topicPaneIsResident(topic)) {
    onOpenTopic(topic.id);
    onClose();
    return;
  }
  chatApi.warmHistory(topic.sessionKey);
  onClose();
  afterNextPaint(() => onOpenTopic(topic.id));
}

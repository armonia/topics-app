/**
 * The per-topic status line, in the chrome instead of in the transcript.
 *
 * What a topic touched is not part of the conversation: it is the state of the
 * thing you are working on, and it belongs where the rest of the chrome lives,
 * above the tab bar. Inside the transcript it scrolled with the messages and
 * pushed the first message down; up here it sits still, and the tab content
 * (the transcript and every other pane) stays where it was, under the bar.
 *
 * Per-topic and nothing else: it follows the ACTIVE tab of this bar, it says
 * nothing for a terminal or a browser tab, and it renders nothing at all when
 * the topic wrote nothing (`ChangedFilesStrip` returns null). A tab bar with
 * nothing to report keeps the exact height it had.
 */
import { useTopics } from '../../contexts/TopicsContext';
import { ChangedFilesStrip } from '../Chat/ChangedFilesStrip';
import { subscribeFrames } from '../../lib/wsFrameBus';
import type { WSMessage } from '../../types';
import type { Pane } from '../../state/pane/types';
import { activeChatTopicId } from './activeChatTopic';

/**
 * The socket, without the prop drilling. The strip only needs the end of a
 * turn to refresh; taking it from the module-level frame bus keeps
 * `onWSMessage` out of the four layout components between here and App, and
 * the type filter means chat tokens never walk this path.
 */
function subscribeTurnEnd(handler: (msg: WSMessage) => void): () => void {
  return subscribeFrames((frame) => handler(frame as WSMessage), { types: ['stream:end'] });
}

interface TopicStatusStripProps {
  panes: Pane[];
  activePaneId: string | null;
}

export function TopicStatusStrip({ panes, activePaneId }: TopicStatusStripProps) {
  const topics = useTopics();
  const topicId = activeChatTopicId(panes, activePaneId);
  if (!topicId) return null;
  return (
    <ChangedFilesStrip
      key={topicId}
      topicId={topicId}
      projectPath={topics[topicId]?.projectPath}
      onWSMessage={subscribeTurnEnd}
    />
  );
}

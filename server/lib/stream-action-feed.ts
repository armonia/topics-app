/**
 * WHAT EACH TOPIC'S AGENT IS DOING, as the one light frame every window gets.
 *
 * The frames that say it (`stream:tool_call`, `stream:content_chunk`, the
 * thinking ones, the permission ones, `stream:error`) are `topic` class: they
 * reach only the windows holding that topic. The board, the sidebar, the project
 * folders and the tray hold other things, so they never saw the action. This
 * feed watches every stream frame the server sends, derives the action with the
 * same pure rule the client uses (`streamFrameAction`), and says it again as a
 * `global` `stream:action` frame, only when it CHANGES: a long run of
 * `content_chunk` is one frame, not hundreds.
 *
 * State is one small record per topic with a turn in flight. It is dropped when
 * the turn ends or fails, so it cannot grow past the number of live turns; a
 * turn that dies without a word is closed by the stale sweep, which broadcasts
 * a `stream:end` like any other.
 */
import { streamFrameAction, type AgentAction, type StreamFrameLite } from "../../shared/agent-action";

/** The frame fields the feed reads; any outbound frame fits. */
export interface ObservedFrame extends StreamFrameLite {
  topicId?: string;
  sessionKey?: string;
}

export interface StreamActionPayload {
  topicId: string;
  sessionKey: string;
  action: AgentAction;
}

interface TopicActionState {
  /** The last action said for this topic. */
  last?: AgentAction;
  /** The action of the last tool call: a granted permission resumes that tool. */
  lastTool?: AgentAction;
}

export function createStreamActionFeed(emit: (payload: StreamActionPayload) => void) {
  const topics = new Map<string, TopicActionState>();

  return {
    /** Feed every frame the server sends; those that are not stream frames cost one prefix check. */
    observe(frame: ObservedFrame): void {
      if (!frame.type.startsWith("stream:") || frame.type === "stream:action") return;
      const { topicId, sessionKey } = frame;
      if (!topicId || !sessionKey) return;

      const state = topics.get(topicId) ?? {};
      const action = streamFrameAction(frame, state.lastTool);
      if (action === null) return;
      if (action === "clear") {
        topics.delete(topicId);
        return;
      }
      if (frame.type === "stream:tool_call") state.lastTool = action;
      const changed = action !== state.last;
      if (action === "error") {
        // The turn failed: say it once, then forget the topic.
        topics.delete(topicId);
      } else {
        state.last = action;
        topics.set(topicId, state);
      }
      if (changed) emit({ topicId, sessionKey, action });
    },

    /** Topics with a turn in flight, for tests and diagnostics. */
    size(): number {
      return topics.size;
    },
  };
}

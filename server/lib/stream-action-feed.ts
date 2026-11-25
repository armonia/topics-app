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
 * a `stream:end` like any other. An end whose topic no longer resolves carries
 * only its session, and closes the entry by that. `current()` hands the open
 * turns to a socket that connects mid-turn, since the feed says only changes.
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
  /** The session the turn runs on, so a late joiner can be told and an end without a topic can find it. */
  sessionKey: string;
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
      if (!sessionKey) return;
      if (!topicId) {
        // The end of a turn carries only its session. When its topic no longer
        // resolves (deleted mid-turn) the entry would stay for good, and a late
        // joiner would be told about a turn that is over: close it by session.
        const closing = streamFrameAction(frame);
        if (closing === "clear" || closing === "error") {
          for (const [id, entry] of topics) if (entry.sessionKey === sessionKey) topics.delete(id);
        }
        return;
      }

      const state = topics.get(topicId) ?? { sessionKey };
      state.sessionKey = sessionKey;
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

    /**
     * What every open turn is doing right now, one payload per topic. A window
     * that connects mid-turn would otherwise stay on `think` until the action
     * changed, because the feed only says changes.
     */
    current(): StreamActionPayload[] {
      const now: StreamActionPayload[] = [];
      for (const [topicId, state] of topics) {
        if (state.last) now.push({ topicId, sessionKey: state.sessionKey, action: state.last });
      }
      return now;
    },

    /** Topics with a turn in flight, for tests and diagnostics. */
    size(): number {
      return topics.size;
    },
  };
}

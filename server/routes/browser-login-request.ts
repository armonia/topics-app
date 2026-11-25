import { recordHistoryRow } from "../attention/store";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { loginNoticeInput } from "../mcp/login-notice";

/**
 * A login wall: the person has to type credentials the agent never handles, so
 * the focus also asks the window to take the screen (raised, optionally
 * detached) and records a notice that links to the topic.
 */
export function announceLoginRequest(
  deps: {
    broadcastToAll: (message: OutboundMessage) => void;
    getTopicBySessionKey: (key: string) => { id: string } | null | undefined;
  },
  args: { contextId: string; url: string; detached: boolean; topicId?: string; sessionKey?: string },
): void {
  const { contextId, url, detached } = args;
  const topicId = args.topicId ?? (args.sessionKey ? deps.getTopicBySessionKey(decodeURIComponent(args.sessionKey))?.id : undefined);
  deps.broadcastToAll({ type: "browser:login-request", contextId, url, detached, ...(topicId ? { topicId } : {}) });
  recordHistoryRow(loginNoticeInput({ contextId, url, topicId }));
}

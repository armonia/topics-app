import { sendPushToAll } from "./push-service";

/**
 * Evaluate a WebSocket broadcast message and send push notifications for meaningful events.
 * Called after broadcastToAll — only triggers on selective, non-spammy events.
 */
export function maybeSendPush(message: Record<string, any>): void {
  const type = message.type;

  // Agent completed or errored
  if (type === "agents:stopped") {
    sendPushToAll({
      title: "Agent stopped",
      body: `Session ${message.sessionKey || "unknown"} was stopped`,
      tag: "agent-stopped",
      url: "/",
    });
    return;
  }

  // Approval created — someone needs to review
  if (type === "approval:created") {
    const approval = message.approval;
    sendPushToAll({
      title: "Approval needed",
      body: approval?.description || "A new approval request is waiting",
      tag: `approval-${approval?.id || "new"}`,
      url: "/",
    });
    return;
  }

  // Stream ended — Claude finished responding in a topic
  if (type === "stream:end" && message.sessionKey) {
    sendPushToAll({
      title: "✅ Response complete",
      body: `Claude finished responding`,
      tag: `stream-end-${message.sessionKey}`,
      url: "/",
    });
    return;
  }

  // Agent session status changes (error) from the session watcher
  if (type === "agents:sessions" && Array.isArray(message.sessions)) {
    for (const session of message.sessions) {
      if (session.status === "error") {
        const updatedAt = session.updatedAt || 0;
        const age = Date.now() - updatedAt;
        if (age < 60_000) {
          sendPushToAll({
            title: `❌ Agent error`,
            body: `${session.displayName || session.key} failed`,
            tag: `agent-${session.key}-error`,
            url: "/",
          });
        }
      }
    }
    return;
  }
}

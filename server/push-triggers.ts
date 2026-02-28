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

  // Agent session status changes (completed/error) from the session watcher
  if (type === "agents:sessions" && Array.isArray(message.sessions)) {
    for (const session of message.sessions) {
      if (session.status === "completed" || session.status === "error") {
        // Only notify if the session was recently active (check updatedAt within last 60s)
        const updatedAt = session.updatedAt || 0;
        const age = Date.now() - updatedAt;
        if (age < 60_000) {
          const statusEmoji = session.status === "completed" ? "✅" : "❌";
          sendPushToAll({
            title: `${statusEmoji} Agent ${session.status}`,
            body: `${session.displayName || session.key} ${session.status === "completed" ? "finished" : "failed"}`,
            tag: `agent-${session.key}-${session.status}`,
            url: "/",
          });
        }
      }
    }
    return;
  }
}

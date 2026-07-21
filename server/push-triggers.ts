import { sendPushToAll } from "./push-service";

// Fire-and-forget: maybeSendPush runs synchronously after broadcastToAll, so a
// rejected sendPushToAll (DB closed mid-shutdown, VAPID init failure — its top
// getDatabase()/initVapid() calls are NOT internally caught) would surface as an
// unhandled promise rejection. Push is best-effort; swallow and log.
function firePush(payload: { title: string; body: string; tag?: string; url?: string }): void {
  sendPushToAll(payload).catch(err => console.warn("[Push] send failed:", err?.message || err));
}

/**
 * Evaluate a WebSocket broadcast message and send push notifications for meaningful events.
 * Called after broadcastToAll — only triggers on selective, non-spammy events.
 */
export function maybeSendPush(message: Record<string, any>): void {
  const type = message.type;

  // Agent completed or errored
  if (type === "agents:stopped") {
    firePush({
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
    firePush({
      title: "Approval needed",
      body: approval?.description || "A new approval request is waiting",
      tag: `approval-${approval?.id || "new"}`,
      url: "/",
    });
    return;
  }

  // A board task just entered review — the end-of-task signal. Tied to the
  // task's terminal state (not the fragile session-idle inference), so it fires
  // for a clean self-delivery AND the previously-silent system-delivered review
  // after a timeout. `tag` keyed by taskId so a re-emit replaces, not stacks.
  if (type === "task:review-ready") {
    firePush({
      title: "📋 Task pronto per la review",
      body: message.taskTitle || "Un task è pronto per la review",
      tag: `task-review-${message.taskId || "new"}`,
      url: "/",
    });
    return;
  }

  // Stream ended — Claude finished responding in a topic
  if (type === "stream:end" && message.sessionKey) {
    firePush({
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
          firePush({
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

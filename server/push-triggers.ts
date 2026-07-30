import { sendPushToAll } from "./push-service";

// Fire-and-forget: maybeSendPush runs synchronously after broadcastToAll, so a
// rejected sendPushToAll (DB closed mid-shutdown, VAPID init failure — its top
// getDatabase()/initVapid() calls are NOT internally caught) would surface as an
// unhandled promise rejection. Push is best-effort; swallow and log.
function firePush(payload: { title: string; body: string; tag?: string; url?: string }): void {
  sendPushToAll(payload).catch(err => console.warn("[Push] send failed:", err?.message || err));
}

/**
 * La destinazione del click, non la home.
 *
 * `url` finisce in `notification.data.url` e il service worker lo passa al
 * client (`topics:open-url` → `openTaskInApp`). Finché era "/" la push ti
 * SVEGLIAVA e poi ti scaricava sulla board generale: sapevi che qualcosa era
 * successo ma dovevi ritrovare tu quale task. `/task/<id>` è la stessa rotta
 * dei link copiabili (`client/src/lib/openTaskLink.ts`), quindi apre il drawer
 * giusto sia in-app sia da finestra chiusa.
 */
function taskUrl(taskId: unknown): string {
  return typeof taskId === "string" && taskId ? `/task/${taskId}` : "/";
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
      url: taskUrl(message.taskId),
    });
    return;
  }

  // Il gemello di fallimento: il task è stato PARCHEGGIATO e non riparte da
  // solo. Emesso solo sul park terminale (`releaseAndEmit` nel dispatcher), mai
  // su una rimessa in coda che si auto-guarisce. `tag` keyed by taskId così un
  // re-emit sostituisce invece di impilare.
  if (type === "task:parked") {
    firePush({
      title: message.state === "blocked" ? "🔧 Task da sistemare" : "⛔️ Task non consegnato",
      body: message.taskTitle || "Un task è stato parcheggiato",
      tag: `task-park-${message.taskId || "new"}`,
      url: taskUrl(message.taskId),
    });
    return;
  }

  // NIENTE push su `stream:end`. C'era, e diceva "✅ Response complete —
  // Claude finished responding" per OGNI fine turno: anche quando eri stato TU
  // ad annullare (`reason: user_abort`), anche quando il watchdog aveva ucciso
  // il turno (`stopCause: watchdog`), anche per ognuno delle decine di turni di
  // un agente sulla board. Senza nome del topic e senza deep link. Era rumore
  // che a volte mentiva. I fronti di fine lavoro corretti sono `review-ready` e
  // `parked` qui sopra; una push di fine risposta per la CHAT va rifatta con
  // nome del topic, deep link al topic e i turni d'agente esclusi — è un lavoro
  // a sé, non una riga da rimettere qui.

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

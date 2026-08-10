import { sendPushToAll } from "./push-service";

// Il modulo è puro (nessuna dipendenza dal DB), ma la push di fine chat vuole il
// NOME del topic, non il suo id: senza, la notifica ti sveglia senza dirti DI
// COSA parlava. I resolver sono iniettati una volta al bootstrap
// (`configurePushTriggers`), così i test possono passarne di finti e il modulo
// resta testabile in isolamento.
let resolveTopicName: ((topicId: string) => string | null | undefined) | null = null;
let resolveTopicSilenced: ((topicId: string) => boolean) | null = null;

export function configurePushTriggers(opts: {
  getTopicName: (topicId: string) => string | null | undefined;
  /**
   * Il topic è da zittire? La push di fine risposta è l'unica che parte da un
   * evento di chat, ed era l'unica superficie di notifica senza questo
   * cancello: il banner in-app lo ha (`isTopicMuted` in
   * useCompletionNotifier), la push no. Finché non esiste una subscription
   * attiva il buco non si vede — ed è esattamente il motivo per cui va chiuso
   * ora e non quando colleghi il telefono.
   *
   * OBBLIGATORIO di proposito: un default «non silenziato» rimetterebbe la
   * perdita in piedi in silenzio se un domani il cablaggio si perde. Il
   * chiamante di prod è uno solo (createAppContext) e il tipo lo costringe.
   *
   * La DECISIONE è `isTopicSilenced` qui sotto (pura, testata); questo hook
   * porta solo i due dati che le servono e che vivono sul DB — la riga del
   * topic e `mutedProjects` letto da `ui_state.settings`.
   */
  isTopicSilenced: (topicId: string) => boolean;
}): void {
  resolveTopicName = opts.getTopicName;
  resolveTopicSilenced = opts.isTopicSilenced;
}

/**
 * Il minimo che serve per decidere il silenzio. Forma STRUTTURALE, non
 * `Topic`: un `Topic` intero la soddisfa (è come la chiama `createAppContext`)
 * ma il modulo resta senza dipendenze sullo schema, e il test può montare tre
 * campi invece di venti.
 */
export type SilenceableTopic = {
  archived?: boolean | null;
  muted?: boolean | null;
  projectPath?: string | null;
};

/**
 * Questo topic va zittito? Decisione PURA — tre sorgenti di mute indipendenti,
 * una qualsiasi basta:
 *   · `archived`  → una chat che l'interfaccia non mostra più. Un turno che si
 *     chiude lì (il dispatcher che pota, un reattach che finisce un giro) non è
 *     un evento per cui svegliare qualcuno.
 *   · `muted`     → mute per-TOPIC (migration 073), viaggia col topic.
 *   · progetto in `mutedProjects` → mute per-PROGETTO, chiavato per
 *     `projectPath`. Vive in `AppSettings` e il client lo pubblica al server da
 *     sempre (`PUT /api/ui-state/settings`: non è un campo device-local, quindi
 *     è dentro `syncableSettings`) — mancava solo qualcuno che lo LEGGESSE.
 *     Stesso spazio di chiavi del gate in-app: `mutedProjects` contiene
 *     `item.projectPath` grezzo (TopicTree) e qui si confronta con
 *     `Topic.projectPath`, senza normalizzazioni che i due lati non fanno.
 *
 * Il verso di sicurezza è OPPOSTO a quello del gemello client
 * (`client/src/lib/notify/muteGate.ts`), di proposito: là un topic sconosciuto
 * NON è mutato (perdere un banner è peggio di averne uno di troppo), qui un
 * topic che non esiste è zittito — non c'è niente da nominare, e una push è
 * un'interruzione su un telefono, non una riga in una lista.
 */
export function isTopicSilenced(
  topic: SilenceableTopic | null | undefined,
  mutedProjects: readonly string[] | null | undefined,
): boolean {
  if (!topic) return true;
  if (topic.archived || topic.muted) return true;
  const proj = topic.projectPath;
  if (!proj) return false;
  return (mutedProjects ?? []).includes(proj);
}

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
 * Il gemello di `taskUrl` per la CHAT: il click su una push di fine risposta
 * deve ATTERRARE sul topic, non sulla home. `/topic/<id>` è la rotta che
 * `client/src/lib/openTaskLink.ts` riconosce (apre la tab del topic in-app, sia
 * a finestra aperta via service worker sia da finestra chiusa al boot).
 */
function topicUrl(topicId: unknown): string {
  return typeof topicId === "string" && topicId ? `/topic/${topicId}` : "/";
}

/**
 * Evaluate a WebSocket broadcast message and send push notifications for meaningful events.
 * Called after broadcastToAll — only triggers on selective, non-spammy events.
 */
export function maybeSendPush(message: Record<string, any>): void {
  const type = message.type;

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

  // Fine risposta della CHAT UMANA. La vecchia versione diceva "Response
  // complete" per OGNI `stream:end` — ecco perché ora ogni ramo è a gate:
  //  · `completed !== true`  → è un `stream:end` sporco (errore/annullo/finally
  //     dell'SSE): solo il completamento pulito porta il marcatore esplicito.
  //  · `dispatched`          → turno d'AGENTE guidato dalla board (runHeadlessTurn
  //     passa `dispatched:true`): decine di turni = spam, e non è "la tua" chat.
  //  · `reason: user_abort` / `stopCause: watchdog` / `stopReason: cancelled`
  //     → ridondanti col marcatore `completed`, ma tenuti espliciti come rete.
  // Titolo = nome del topic (serve al risveglio sapere DI COSA), deep link al
  // topic, `tag` per topicId così una seconda risposta rimpiazza invece di
  // impilare.
  if (type === "stream:end") {
    const topicId = typeof message.topicId === "string" ? message.topicId : "";
    const dispatched = message.dispatched === true;
    const dirty =
      message.reason === "user_abort" ||
      message.stopCause === "watchdog" ||
      message.stopReason === "cancelled";
    if (message.completed !== true || dispatched || dirty || !topicId) return;
    // Archiviato o mutato → niente push. Una chat chiusa che finisce un turno
    // (il dispatcher che pota, un reattach che chiude un giro) non è un evento
    // per cui svegliare qualcuno, e il nome che porterebbe è quello di una
    // conversazione che l'interfaccia non mostra più.
    if (resolveTopicSilenced?.(topicId)) return;
    const name = resolveTopicName?.(topicId);
    firePush({
      title: name ? `💬 ${name}` : "💬 Risposta pronta",
      body: "Claude ha finito di rispondere",
      tag: `chat-end-${topicId}`,
      url: topicUrl(topicId),
    });
    return;
  }

}

import { sendPushToAll } from "./push-service";
import { buildNotifyActionBundle, type NotifyAction, type NotifyActionRequest, type NotifyEvent } from "../shared/notify-actions";
import {
  approvalNotificationKey,
  chatErrorNotificationKey,
  chatNotificationKey,
  taskParkedNotificationKey,
  taskReviewNotificationKey,
  type NotificationRecordInput,
} from "../shared/notification-log";
import { questionAsksHuman } from "../shared/board";

// Il modulo è puro (nessuna dipendenza dal DB), ma la push di fine chat vuole il
// NOME del topic, non il suo id: senza, la notifica ti sveglia senza dirti DI
// COSA parlava. I resolver sono iniettati una volta al bootstrap
// (`configurePushTriggers`), così i test possono passarne di finti e il modulo
// resta testabile in isolamento.
let resolveTopicName: ((topicId: string) => string | null | undefined) | null = null;
let resolveTopicSilenced: ((topicId: string) => boolean) | null = null;
let recordSent: ((input: NotificationRecordInput) => void) | null = null;

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
  /**
   * Scrivi la notifica nel REGISTRO (migration 102). Opzionale perché un
   * contesto ridotto — i test di questo modulo — non ha un DB: senza, la push
   * parte lo stesso e semplicemente non lascia traccia, che è il verso giusto
   * in cui mancare (una cronologia incompleta è meglio di una notifica persa).
   *
   * La chiave di dedup è la STESSA che usa il client per il banner dello stesso
   * evento (shared/notification-log.ts): un `task:review-ready` esce da due
   * porte e deve lasciare una riga sola.
   */
  recordNotification?: (input: NotificationRecordInput) => void;
}): void {
  resolveTopicName = opts.getTopicName;
  resolveTopicSilenced = opts.isTopicSilenced;
  recordSent = opts.recordNotification ?? null;
}

/** Registra la push appena mandata. Best-effort: il registro non deve mai
 *  poter rompere la consegna. */
function logSent(input: NotificationRecordInput): void {
  try {
    recordSent?.(input);
  } catch (err) {
    console.warn("[Push] registro notifiche:", (err as Error)?.message || err);
  }
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
function firePush(payload: PushPayload): void {
  sendPushToAll(payload).catch(err => console.warn("[Push] send failed:", err?.message || err));
}

/**
 * Il payload che arriva al service worker. `actions` sono i TASTI del banner e
 * `requests` dice, per ciascuno, quale chiamata fare.
 *
 * La richiesta viaggia già composta di proposito: sw.js è JS servito a parte,
 * fuori dal bundle, e non può importare `shared/notify-actions`. Mandargli il
 * solo id lo costringerebbe a una copia del `switch` che decide gli endpoint —
 * la copia che nessun test compila e che si disallinea al primo cambio di
 * rotta. Così il worker resta stupido: esegue quello che gli è arrivato, dopo
 * aver controllato che il path sia della board.
 */
interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  actions?: NotifyAction[];
  requests?: Record<string, NotifyActionRequest>;
}

/**
 * Attacca i tasti al payload — solo quando ce ne sono, e solo quando il task è
 * identificabile: un bottone che non sa a chi parlare non si disegna proprio.
 */
function withActions(payload: PushPayload, event: NotifyEvent, message: Record<string, any>): PushPayload {
  const projectId = typeof message.projectId === "string" ? message.projectId : "";
  const taskId = typeof message.taskId === "string" ? message.taskId : "";
  if (!projectId || !taskId) return payload;
  const { actions, requests } = buildNotifyActionBundle(event, { projectId, taskId });
  if (actions.length === 0) return payload;
  return { ...payload, actions, requests };
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
 * La domanda pendente come arriva dal broadcast (`emitReviewReadyEdge`),
 * ricontrollata invece che creduta: questo modulo prende `Record<string, any>`,
 * e la differenza tra «non c'è domanda» e «c'è ma è malformata» decide QUALI
 * tasti compaiono — nel primo caso "Approva", nel secondo nessuno. Un campo
 * storto che passasse per "assente" produrrebbe un tasto Approva su un task che
 * sta aspettando una risposta.
 */
function readQuestion(raw: unknown): { text: string; options: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as { text?: unknown; options?: unknown };
  const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [];
  return { text: typeof q.text === "string" ? q.text : "", options };
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
    const title = "Approval needed";
    const body = approval?.description || "A new approval request is waiting";
    firePush({ title, body, tag: `approval-${approval?.id || "new"}`, url: "/" });
    logSent({
      kind: "approval",
      title,
      body,
      dedupeKey: approvalNotificationKey(String(approval?.id || "new")),
      source: "push",
    });
    return;
  }

  // A board task just entered review — the end-of-task signal. Tied to the
  // task's terminal state (not the fragile session-idle inference), so it fires
  // for a clean self-delivery AND the previously-silent system-delivered review
  // after a timeout. `tag` keyed by taskId so a re-emit replaces, not stacks.
  if (type === "task:review-ready") {
    // La consegna che È una domanda si annuncia come tale: il corpo porta la
    // domanda (il titolo del task lo dice già il titolo del banner) e i tasti
    // sono le sue opzioni. Svegliarti con «pronto per la review» quando in
    // realtà ti stanno CHIEDENDO una cosa è la stessa notifica per due eventi
    // diversi — e quello che chiede è l'unico che non può aspettare.
    //
    // WHICH of the two it is comes from `questionAsksHuman`, not from "is there
    // a question block": the kickoff envelope orders a landable delivery to
    // attach `options=["Landa su main"]`, which the service wraps in that very
    // fence, so a plain delivery woke you up as a question. The OPTIONS stay
    // whole either way — they are the notification's buttons, and a delivery
    // offering one-click "Landa su main" is exactly what should be tappable.
    const question = readQuestion(message.question);
    // Two verdicts, in order of how much each one saw.
    //
    // `message.isAsk` is decided upstream in routes/tasks.ts by
    // `commentAsksHuman`, which reads the RAW comment: strictly more than what
    // survives into the parsed question, so it wins when it is there.
    //
    // When it is absent (an older server, a frame built elsewhere) the fallback
    // is `questionAsksHuman`, which derives the same answer from the options we
    // do have. What the fallback must NEVER be is `!!question`: that is the
    // original defect, since the kickoff envelope orders every landable delivery
    // to attach `options=["Landa su main"]`, which the service wraps in this very
    // fence. Falling back to it would restore the bug on exactly the servers that
    // cannot fix it.
    const asksHuman = message.isAsk ?? questionAsksHuman(question);
    const title = asksHuman ? "❓ L'agent ti sta chiedendo una cosa" : "📋 Task pronto per la review";
    const body = question?.text || message.taskTitle || "Un task è pronto per la review";
    firePush(withActions({
      title,
      body,
      tag: `task-review-${message.taskId || "new"}`,
      url: taskUrl(message.taskId),
    }, { kind: "review-ready", question }, message));
    if (typeof message.taskId === "string" && message.taskId) {
      logSent({
        kind: "task-review",
        title,
        body,
        targetKind: "task",
        targetId: message.taskId,
        dedupeKey: taskReviewNotificationKey(message.taskId),
        source: "push",
      });
    }
    return;
  }

  // Il gemello di fallimento: il task è stato PARCHEGGIATO e non riparte da
  // solo. Emesso solo sul park terminale (`releaseAndEmit` nel dispatcher), mai
  // su una rimessa in coda che si auto-guarisce. `tag` keyed by taskId così un
  // re-emit sostituisce invece di impilare.
  if (type === "task:parked") {
    // Tre stati, tre titoli. `waited_out` (la serie di attese dichiarate ha
    // sfondato il tetto) non è un fallimento e non ha niente da riparare: la
    // condizione esterna non è arrivata e la decisione torna all'umano, quindi
    // né 🔧 né ⛔️. Gemello del banner in useCompletionNotifier: stessa copy.
    const title = message.state === "blocked"
      ? "🔧 Task da sistemare"
      : message.state === "waited_out"
        ? "⏳ Task in attesa, decidi tu"
        : "⛔️ Task non consegnato";
    const body = message.taskTitle || "Un task è stato parcheggiato";
    firePush(withActions({
      title,
      body,
      tag: `task-park-${message.taskId || "new"}`,
      url: taskUrl(message.taskId),
    }, { kind: "parked" }, message));
    if (typeof message.taskId === "string" && message.taskId) {
      logSent({
        kind: "task-parked",
        title,
        body,
        targetKind: "task",
        targetId: message.taskId,
        dedupeKey: taskParkedNotificationKey(message.taskId),
        source: "push",
      });
    }
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
    // THE DEAD TURN, first. Gating the reply push on `completed` (below) was
    // right, but for a long time it replaced a false reply-ready push with
    // nothing at all: on 2026-09-03 three chats died (overloaded_error after 27
    // retries) and nobody was told. A death is the one end that needs a gesture
    // (the Retry button), so it is the one that cannot stay quiet. The wire says it
    // with `reason: "error"` + the notice text (routes/chat.ts attaches it on
    // every path that writes an error block); an unclean end WITHOUT a text
    // (user stop, stale sweep) is not a death to announce and falls through to
    // the gates below. Board agents keep their own channel (`task:parked`),
    // and a server shutdown resumes the turn at boot by itself: neither is a
    // push. Mute rules are the same three as the reply push.
    const errorText = typeof message.error === "string" ? message.error.trim() : "";
    if (message.reason === "error" && errorText && topicId && !dispatched && message.stopCause !== "server-shutdown") {
      if (resolveTopicSilenced?.(topicId)) return;
      const name = resolveTopicName?.(topicId);
      const title = name ? `⚠️ ${name}` : "⚠️ La chat si è fermata";
      // The notice already opens with the warning sign the title carries.
      const body = errorText.replace(/^⚠️\s*/, "").slice(0, 120);
      firePush({ title, body, tag: `chat-error-${topicId}`, url: topicUrl(topicId) });
      logSent({
        kind: "chat-error",
        title,
        body,
        targetKind: "topic",
        targetId: topicId,
        dedupeKey: chatErrorNotificationKey(topicId),
        source: "push",
      });
      return;
    }
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
    const title = name ? `💬 ${name}` : "💬 Risposta pronta";
    const body = "Claude ha finito di rispondere";
    firePush({ title, body, tag: `chat-end-${topicId}`, url: topicUrl(topicId) });
    // Stessa chiave del banner di `message:new` lato client: per chi la riceve
    // «Claude ha risposto in questo topic» è UN evento, non due, anche se le
    // superfici sono due (banner sul desktop aperto, push sul telefono).
    logSent({
      kind: "chat-message",
      title,
      body,
      targetKind: "topic",
      targetId: topicId,
      dedupeKey: chatNotificationKey(topicId),
      source: "push",
    });
    return;
  }

}

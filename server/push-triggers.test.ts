/**
 * `maybeSendPush` is the closed-app half of the end-of-task notification: it
 * turns the `task:review-ready` WS broadcast into a task-aware web-push. Pin
 * that it fires with the task title + a taskId-keyed tag (so a re-emit replaces
 * rather than stacks), and that it stays quiet for unrelated broadcasts.
 *
 * `push-service` (DB + VAPID) is mocked so the trigger logic is tested in
 * isolation — no database, no network.
  * @covers PUSH-04
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

type PushPayload = { title: string; body: string; tag?: string; url?: string };
const pushCalls: PushPayload[] = [];
// In bun a module mock outlives the file that installed it, so this factory is
// the ONLY `push-service` any later file in the same run will see. It must
// therefore carry every export the real module has, not just the one this file
// exercises: `routes/push.ts` imports `getVapidPublicKey`, and without it that
// route fails to load whenever this spec is ordered first.
mock.module("./push-service", () => ({
  sendPushToAll: async (payload: PushPayload) => { pushCalls.push(payload); },
  getVapidPublicKey: () => "test-vapid-public-key",
}));

const { maybeSendPush, configurePushTriggers, isTopicSilenced } = await import("./push-triggers");
import type { NotificationRecordInput } from "../shared/notification-log";

/**
 * Finto "DB": la tabella dei topic e le AppSettings del server. I resolver
 * iniettati portano solo QUESTI dati — la decisione la prende il gate vero
 * (`isTopicSilenced`), non il finto. Un fake che rispondesse `id === "arch"`
 * testerebbe se stesso: passerebbe anche con il gate rotto.
 *
 * `zzz` esiste ma non ha nome: serve al caso «push senza nome risolto». Senza
 * la riga sarebbe un topic inesistente, che il gate zittisce (fail-closed).
 */
const TOPICS: Record<string, { name?: string | null; archived?: boolean; muted?: boolean; projectPath?: string | null }> = {
  tp1:   { name: "Rifai la migration", projectPath: "/w/alfa" },
  zzz:   { name: null, projectPath: "/w/alfa" },
  arch:  { name: "Vecchia chat", archived: true },
  quiet: { name: "Dentro il progetto zittito", projectPath: "/w/muto" },
};
/** Lo specchio di `AppSettings.mutedProjects` (in prod: `ui_state.settings`). */
const MUTED_PROJECTS = ["/w/muto"];

configurePushTriggers({
  getTopicName: (id: string) => TOPICS[id]?.name ?? null,
  isTopicSilenced: (id: string) => isTopicSilenced(TOPICS[id] ?? null, MUTED_PROJECTS),
});

describe("maybeSendPush — task:review-ready", () => {
  beforeEach(() => { pushCalls.length = 0; });

  test("fires a task-aware push when a task enters review", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "p", taskId: "t9", taskTitle: "Rifai lo schema" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toContain("review");
    expect(pushCalls[0].body).toBe("Rifai lo schema");
    expect(pushCalls[0].tag).toBe("task-review-t9");
  });

  test("degrades gracefully when the title is missing", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "p", taskId: "t1" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].body.length).toBeGreaterThan(0);
    expect(pushCalls[0].tag).toBe("task-review-t1");
  });

  // Il click deve ATTERRARE sul task. Con url:"/" la push ti svegliava e ti
  // scaricava sulla board generale a cercare da solo quello di cui ti aveva
  // appena parlato.
  test("il click porta al task, non alla home", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "p", taskId: "t9", taskTitle: "x" });
    expect(pushCalls[0].url).toBe("/task/t9");
  });

  test("senza taskId ripiega sulla home invece di costruire una URL rotta", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "p", taskTitle: "x" });
    expect(pushCalls[0].url).toBe("/");
  });

  test("stays quiet for unrelated broadcasts (e.g. task:updated)", () => {
    maybeSendPush({ type: "task:updated", projectId: "p", task: { id: "t1", status: "review" } });
    maybeSendPush({ type: "task:created", projectId: "p", task: { id: "t2" } });
    expect(pushCalls).toHaveLength(0);
  });
});

/**
 * I TASTI della push. La regola sotto tutto: un tasto è la chiamata che fa la
 * board, già composta, perché il service worker non può importare niente e non
 * deve decidere niente — se dovesse ricomporre gli endpoint, la copia dentro
 * sw.js sarebbe l'unica non coperta da un test.
 */
describe("maybeSendPush — i tasti di azione", () => {
  beforeEach(() => { pushCalls.length = 0; });

  const REVIEW = { type: "task:review-ready", projectId: "proj-x", taskId: "t9", taskTitle: "Rifai lo schema" };

  test("la domanda dell'agente diventa i tasti, e la richiesta viaggia già composta", () => {
    maybeSendPush({ ...REVIEW, question: { text: "Lando su main?", options: ["Landa su main", "Aspetta"] } });
    const p = pushCalls[0] as any;
    expect(p.actions.map((a: any) => a.title)).toEqual(["Landa su main", "Aspetta"]);
    // Il corpo dice la DOMANDA: il titolo del task non è ciò che ti sta
    // chiedendo, e con due tasti sotto sarebbe l'unica riga che non lo spiega.
    expect(p.body).toBe("Lando su main?");
    expect(p.title).toContain("chiedendo");
    expect(p.requests[p.actions[0].id]).toEqual({
      method: "POST",
      path: "/api/boards/proj-x/tasks/t9/review",
      body: { decision: "reject", comment: "Landa su main" },
    });
  });

  // L'envelope ordina agli agenti di allegare `options=["Landa su main"]` a
  // OGNI consegna landabile, e il server la avvolge nella stessa fence
  // ```question di una vera domanda. Se il titolo guardasse solo la presenza
  // di `question` (come faceva prima), questa consegna finita si annuncerebbe
  // come "l'agent ti sta chiedendo una cosa" — il guasto di questo task.
  test("consegna con la sola opzione Landa → titolo di review, e il tasto Landa resta", () => {
    maybeSendPush({ ...REVIEW, isAsk: false, question: { text: "", options: ["Landa su main"] } });
    const p = pushCalls[0] as any;
    expect(p.title).toContain("review");
    expect(p.title).not.toContain("chiedendo");
    expect(p.actions.map((a: any) => a.title)).toEqual(["Landa su main"]);
    expect(p.requests[p.actions[0].id]).toEqual({
      method: "POST",
      path: "/api/boards/proj-x/tasks/t9/review",
      body: { decision: "reject", comment: "Landa su main" },
    });
  });

  test("domanda mista (un'opzione che il sistema non esegue) → titolo di domanda", () => {
    maybeSendPush({ ...REVIEW, isAsk: true, question: { text: "Lando su main?", options: ["Landa su main", "Aspetta"] } });
    const p = pushCalls[0] as any;
    expect(p.title).toContain("chiedendo");
    expect(p.title).not.toContain("review");
  });

  test("consegna senza domanda → un solo tasto: Approva", () => {
    maybeSendPush(REVIEW);
    const p = pushCalls[0] as any;
    expect(p.actions).toEqual([{ id: "approve", title: "Approva" }]);
    expect(p.requests.approve).toEqual({
      method: "POST",
      path: "/api/boards/proj-x/tasks/t9/review",
      body: { decision: "approve" },
    });
    expect(p.body).toBe("Rifai lo schema");
  });

  test("domanda con troppe opzioni → nessun tasto, ma la push parte lo stesso", () => {
    maybeSendPush({ ...REVIEW, question: { text: "Quale?", options: ["a", "b", "c"] } });
    const p = pushCalls[0] as any;
    expect(p.actions).toBeUndefined();
    expect(p.url).toBe("/task/t9"); // resta il click che apre il task
  });

  test("una `question` malformata NON diventa «nessuna domanda» (niente Approva)", () => {
    // Il caso che conta: un campo storto che passasse per assente metterebbe un
    // tasto "Approva" su un task che sta aspettando una risposta.
    maybeSendPush({ ...REVIEW, question: { text: 42, options: "non un array" } });
    expect((pushCalls[0] as any).actions).toBeUndefined();
  });

  // ── WHICH OF THE TWO VOICES, and why the fence could not tell ─────────────
  //
  // The kickoff envelope orders a landable delivery to attach
  // `options=["Landa su main"]`, and the service wraps any options in a
  // ```question fence, so `pendingQuestion` hands this trigger a non-null
  // `question` for finished work. Choosing the title on "is question non-null"
  // woke you at 3am with "the agent is asking you something" over a delivery
  // that asked nothing. The rule is `questionAsksHuman`, the same one behind
  // the dispatch chip and the two review gates.
  test("a delivery offering only «Landa su main»: review title, button untouched", () => {
    maybeSendPush({ ...REVIEW, question: { text: "Fatto: sei cancelli verdi.", options: ["Landa su main"] } });
    const p = pushCalls[0] as any;
    expect(p.title).not.toContain("chiedendo");
    expect(p.title).toContain("review");
    // The OPTIONS stay: a button that lands in one tap is exactly what a
    // delivery wants, and it is why the rule touches the title and not them.
    expect(p.actions.map((a: any) => a.title)).toEqual(["Landa su main"]);
  });

  test("MIXED question: one option the board cannot run and the voice is «chiedendo» again", () => {
    maybeSendPush({ ...REVIEW, question: { text: "Fatto, ma il nome del flag non mi convince.", options: ["Landa su main", "Aspetta, ho un dubbio"] } });
    expect((pushCalls[0] as any).title).toContain("chiedendo");
  });

  test("parcheggiato → «Rimetti in coda», che è la PATCH dello stato", () => {
    maybeSendPush({ type: "task:parked", projectId: "proj-x", taskId: "t4", taskTitle: "x", state: "failed" });
    const p = pushCalls[0] as any;
    expect(p.actions).toEqual([{ id: "requeue", title: "Rimetti in coda" }]);
    expect(p.requests.requeue).toEqual({
      method: "PATCH",
      path: "/api/boards/proj-x/tasks/t4",
      body: { status: "todo" },
    });
  });

  test("senza taskId non si disegna nessun tasto (non saprebbe a chi parlare)", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "proj-x", taskTitle: "x" });
    expect((pushCalls[0] as any).actions).toBeUndefined();
    maybeSendPush({ type: "task:parked", taskId: "t4", taskTitle: "x", state: "failed" });
    expect((pushCalls[1] as any).actions).toBeUndefined();
  });

  test("la push della chat resta senza tasti: non c'è un click che risponda", () => {
    maybeSendPush({ type: "stream:end", topicId: "tp1", completed: true });
    expect((pushCalls[0] as any).actions).toBeUndefined();
  });
});

/**
 * Il gemello di fallimento. `task:review-ready` copre l'esito buono; il park
 * terminale (l'agente si è arreso / serve una mano) era muto ad app chiusa —
 * cioè proprio quando NON puoi accorgertene guardando la board. I due stati
 * hanno testi diversi apposta: "non consegnato" è un esito, "da sistemare" è
 * una richiesta di intervento.
 */
describe("maybeSendPush — task:parked", () => {
  beforeEach(() => { pushCalls.length = 0; });

  test("failed → push di consegna mancata, tag per taskId", () => {
    maybeSendPush({ type: "task:parked", projectId: "p", taskId: "t4", taskTitle: "Rifai lo schema", state: "failed" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toContain("non consegnato");
    expect(pushCalls[0].body).toBe("Rifai lo schema");
    expect(pushCalls[0].tag).toBe("task-park-t4");
  });

  test("blocked → testo diverso: chiede un intervento, non annuncia un esito", () => {
    maybeSendPush({ type: "task:parked", projectId: "p", taskId: "t5", taskTitle: "Migra la 041", state: "blocked" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toContain("sistemare");
    expect(pushCalls[0].tag).toBe("task-park-t5");
  });

  test("waited_out → né «non consegnato» né «da sistemare»: chiede una decisione", () => {
    maybeSendPush({ type: "task:parked", projectId: "p", taskId: "t8", taskTitle: "Aspetta la CI", state: "waited_out" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toContain("decidi tu");
    expect(pushCalls[0].title).not.toContain("consegnato");
    expect(pushCalls[0].title).not.toContain("sistemare");
    expect(pushCalls[0].tag).toBe("task-park-t8");
  });

  test("degrada senza titolo", () => {
    maybeSendPush({ type: "task:parked", projectId: "p", taskId: "t6", state: "failed" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].body.length).toBeGreaterThan(0);
  });

  test("anche qui il click porta al task", () => {
    maybeSendPush({ type: "task:parked", projectId: "p", taskId: "t7", state: "blocked" });
    expect(pushCalls[0].url).toBe("/task/t7");
  });
});

/**
 * Push di fine risposta della CHAT, rifatta. La vecchia versione diceva
 * "Response complete" per OGNI `stream:end` — anche su un annullo dell'utente,
 * sul kill del watchdog, e per ognuno delle decine di turni di un agente sulla
 * board — senza nome del topic e senza deep link. Questi test sono il chiodo che
 * fissa il nuovo contratto: push SOLO su fine PULITA di CHAT, muta su tutto il
 * resto, titolo col nome del topic, deep link e tag per topicId.
 */
describe("maybeSendPush — fine risposta della chat", () => {
  beforeEach(() => { pushCalls.length = 0; });

  test("fine PULITA di chat → una push col nome del topic, tag+url per topicId", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toContain("Rifai la migration");
    expect(pushCalls[0].body.length).toBeGreaterThan(0);
    expect(pushCalls[0].tag).toBe("chat-end-tp1");
    expect(pushCalls[0].url).toBe("/topic/tp1");
  });

  test("senza nome risolto degrada a un titolo generico, ma manda la push", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:zzz", topicId: "zzz", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].tag).toBe("chat-end-zzz");
    expect(pushCalls[0].url).toBe("/topic/zzz");
  });

  test("MUTA su annullo dell'utente", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", completed: true, reason: "user_abort" });
    expect(pushCalls).toHaveLength(0);
  });

  test("MUTA sul kill del watchdog", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", stopReason: "cancelled", stopCause: "watchdog" });
    expect(pushCalls).toHaveLength(0);
  });

  test("MUTA su un turno d'AGENTE guidato dalla board", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", messageId: "m1", completed: true, dispatched: true });
    expect(pushCalls).toHaveLength(0);
  });

  test("MUTA su un `stream:end` NON pulito (nessun marcatore completed)", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", messageId: "m1" });
    expect(pushCalls).toHaveLength(0);
  });

  test("MUTA senza topicId (non saprebbe DI COSA né DOVE mandarti)", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(0);
  });

  // Il cancello che questa superficie non aveva. Il banner in-app lo ha da
  // sempre (`isTopicMuted` in useCompletionNotifier); la push no, e una chat
  // ARCHIVIATA che chiude un turno — il dispatcher che pota, un reattach che
  // finisce un giro — ti svegliava col nome di una conversazione che
  // l'interfaccia non mostra più.
  test("MUTA su un topic archiviato o mutato", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:arch", topicId: "arch", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(0);
  });

  // La terza sorgente di mute, quella che il gate non guardava: il topic è
  // sano — non archiviato, non mutato — ma il suo PROGETTO è in
  // `AppSettings.mutedProjects`. Muti un progetto intero dalla sidebar, il
  // banner in-app tace (`isTopicMuted`) e la push partiva lo stesso.
  test("MUTA un topic NON mutato il cui PROGETTO è mutato", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:quiet", topicId: "quiet", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(0);
  });

  // Il controllo che rende falsificabile quello sopra: stesso percorso, stessa
  // forma di topic, progetto NON mutato → la push parte. Senza questo, un gate
  // che zittisce tutto passerebbe il test precedente.
  test("un topic in un progetto NON mutato manda la push", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(1);
  });
});

/**
 * THE DEAD TURN. Gating the end-of-reply push on `completed` was right (a dead
 * turn must not announce a ready reply), but it replaced a lie with
 * silence: three chats died on 2026-09-03 (overloaded_error after 27 retries)
 * and nothing told anyone. The one signal that needs a gesture (Retry) is
 * the one that was missing. These tests pin the failure push: exactly one per
 * dead turn, its own tag and registry kind, the same mute rules as the reply
 * push, and quiet for board agents and for a clean end.
 */
describe("maybeSendPush — turno morto (chat-error)", () => {
  const sent: NotificationRecordInput[] = [];
  beforeEach(() => {
    pushCalls.length = 0;
    sent.length = 0;
    configurePushTriggers({
      getTopicName: (id: string) => TOPICS[id]?.name ?? null,
      isTopicSilenced: (id: string) => isTopicSilenced(TOPICS[id] ?? null, MUTED_PROJECTS),
      recordNotification: (input) => { sent.push(input); },
    });
  });

  const DEAD = {
    type: "stream:end",
    sessionKey: "topic:tp1",
    topicId: "tp1",
    messageId: "m1",
    reason: "error",
    error: "⚠️ overloaded_error: il provider ha risposto errore per 27 tentativi di fila. «Riprova» rimanda il tuo messaggio.",
  };

  test("un turno morto manda ESATTAMENTE una push di errore, col nome del topic", () => {
    maybeSendPush(DEAD);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toBe("⚠️ Rifai la migration");
    expect(pushCalls[0].tag).toBe("chat-error-tp1");
    expect(pushCalls[0].url).toBe("/topic/tp1");
  });

  test("il corpo e' il testo dell'errore, senza l'icona doppia e tagliato a 120", () => {
    maybeSendPush({ ...DEAD, error: "⚠️ " + "x".repeat(300) });
    expect(pushCalls[0].body).toBe("x".repeat(120));
  });

  test("finisce nel registro come `chat-error`, con la sua chiave, non quella della risposta", () => {
    maybeSendPush(DEAD);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("chat-error");
    expect(sent[0].dedupeKey).toBe("chat-error:tp1");
    expect(sent[0].targetKind).toBe("topic");
    expect(sent[0].targetId).toBe("tp1");
    expect(sent[0].source).toBe("push");
  });

  test("anche il watchdog e' una morte: stopCause watchdog + testo → push di errore", () => {
    maybeSendPush({ ...DEAD, stopReason: "cancelled", stopCause: "watchdog" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].tag).toBe("chat-error-tp1");
  });

  /**
   * THE TURN CUT BY THE OUTPUT CAP IS A DEATH TOO.
   *
   * The `max_tokens` branch in routes/chat.ts wrote the amber band and the
   * error block but left `turnError` unset, so `stream:end` went out without
   * `reason: "error"` and this trigger returned at its gate: no push of any
   * kind, on the very turn that stopped half way through a document (card
   * 6c2dc14c).
   */
  test("tagliato dal tetto dei token: stopReason max_tokens + testo -> push chat-error", () => {
    maybeSendPush({
      ...DEAD,
      stopReason: "max_tokens",
      error: "⚠️ Risposta tagliata dal tetto dei token: chiedi la parte che manca.",
    });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].tag).toBe("chat-error-tp1");
    expect(sent[0].kind).toBe("chat-error");
  });

  test("un turno FINITO manda ancora la push di risposta, e nessun errore", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", messageId: "m1", completed: true });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].tag).toBe("chat-end-tp1");
    expect(sent.map((s) => s.kind)).toEqual(["chat-message"]);
  });

  test("MUTA sulla morte di un turno d'AGENTE della board (ha il suo canale)", () => {
    maybeSendPush({ ...DEAD, dispatched: true });
    expect(pushCalls).toHaveLength(0);
  });

  test("MUTA quando il server si sta spegnendo: quel turno riparte da solo al boot", () => {
    maybeSendPush({ ...DEAD, stopReason: "cancelled", stopCause: "server-shutdown" });
    expect(pushCalls).toHaveLength(0);
  });

  test("MUTA su topic archiviato, mutato o in progetto mutato: le stesse regole della risposta", () => {
    maybeSendPush({ ...DEAD, sessionKey: "topic:arch", topicId: "arch" });
    maybeSendPush({ ...DEAD, sessionKey: "topic:quiet", topicId: "quiet" });
    expect(pushCalls).toHaveLength(0);
  });

  test("senza topicId non sa DOVE mandarti: muta", () => {
    maybeSendPush({ ...DEAD, topicId: undefined });
    expect(pushCalls).toHaveLength(0);
  });

  test("uno stream:end sporco SENZA testo d'errore (annullo, stale) resta muto", () => {
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", reason: "user_abort" });
    maybeSendPush({ type: "stream:end", sessionKey: "topic:tp1", topicId: "tp1", reason: "stale_timeout", stopReason: "cancelled", stopCause: "watchdog" });
    expect(pushCalls).toHaveLength(0);
  });
});

/**
 * Il gate, da solo. `maybeSendPush` lo esercita attraverso l'iniezione; qui si
 * fissano i casi limite che in prod arrivano dal DB e da un JSON scritto dal
 * client — inclusi i due versi di sicurezza, che sono opposti apposta.
 */
describe("isTopicSilenced — il gate puro", () => {
  test("topic sano in un progetto non mutato → parla", () => {
    expect(isTopicSilenced({ projectPath: "/w/alfa" }, ["/w/muto"])).toBe(false);
  });

  test("archiviato o mutato → zitto, qualunque sia il progetto", () => {
    expect(isTopicSilenced({ archived: true, projectPath: "/w/alfa" }, [])).toBe(true);
    expect(isTopicSilenced({ muted: true, projectPath: "/w/alfa" }, [])).toBe(true);
  });

  test("progetto in mutedProjects → zitto", () => {
    expect(isTopicSilenced({ projectPath: "/w/muto" }, ["/w/alfa", "/w/muto"])).toBe(true);
  });

  test("confronto per path ESATTO: un prefisso non è il progetto", () => {
    expect(isTopicSilenced({ projectPath: "/w/muto-bis" }, ["/w/muto"])).toBe(false);
  });

  test("topic senza projectPath → il mute per progetto non lo tocca", () => {
    expect(isTopicSilenced({ projectPath: null }, ["/w/muto"])).toBe(false);
  });

  test("lista assente o vuota = nessun progetto mutato (si sbaglia verso la push)", () => {
    expect(isTopicSilenced({ projectPath: "/w/muto" }, undefined)).toBe(false);
    expect(isTopicSilenced({ projectPath: "/w/muto" }, [])).toBe(false);
  });

  // Verso di sicurezza OPPOSTO al gemello client (`muteGate.ts`, dove un topic
  // sconosciuto NON è mutato): una push è un'interruzione su un telefono, e di
  // un topic che non esiste non sapremmo nemmeno il nome da metterci.
  test("topic inesistente → zitto (fail-closed)", () => {
    expect(isTopicSilenced(null, [])).toBe(true);
    expect(isTopicSilenced(undefined, [])).toBe(true);
  });
});

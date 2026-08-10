/**
 * `maybeSendPush` is the closed-app half of the end-of-task notification: it
 * turns the `task:review-ready` WS broadcast into a task-aware web-push. Pin
 * that it fires with the task title + a taskId-keyed tag (so a re-emit replaces
 * rather than stacks), and that it stays quiet for unrelated broadcasts.
 *
 * `push-service` (DB + VAPID) is mocked so the trigger logic is tested in
 * isolation — no database, no network.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const pushCalls: Array<{ title: string; body: string; tag?: string; url?: string }> = [];
mock.module("./push-service", () => ({
  sendPushToAll: async (payload: any) => { pushCalls.push(payload); },
}));

const { maybeSendPush, configurePushTriggers, isTopicSilenced } = await import("./push-triggers");

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

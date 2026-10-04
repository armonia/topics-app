/**
 * The words, the buttons and the link of a new epoch (`buildAnnouncement`),
 * the meaning of a chat turn's end (`classifyTurnEnd`), and the mute gate
 * (`isTopicSilenced`).
 *
 * Until notifications-redesign these were one function, `maybeSendPush`, run
 * on every `broadcastToAll` frame. The decision moved to the attention store
 * (a push exists only for a new epoch, design section 10.1): every test of
 * that function is here, rewritten on the point that now holds its rule. The
 * PUSH-04 texts and buttons on `buildAnnouncement`; the gates on the end of a
 * chat turn (a stop of the person, the watchdog's cut, a board agent, an
 * unclean end, a resume by itself) on `classifyTurnEnd`; the mute, the
 * archive and the "same wait announced again" on the store
 * (`announce gates in the store`, below).
 * @covers PUSH-04
 * @covers ATTN-11
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAnnouncement, classifyTurnEnd, isTopicSilenced, type AnnounceFact } from "./push-triggers";
import { configureAttentionStore, getAttention, openHold, resetAttentionStore, setCard, setClosed, setDispatched, turnEnded, turnStarted } from "./attention/store";
import { avvisoPerTurno } from "./lib/cancelled-notice";
import type { NotificationRecordInput } from "../shared/notification-log";

afterAll(() => resetAttentionStore());

const push = (fact: AnnounceFact) => buildAnnouncement(fact)!.push as Record<string, any>;
const REVIEW = { kind: "review" as const, subject: "task:t9", projectId: "proj-x", taskId: "t9", taskTitle: "Rifai lo schema" };

describe("buildAnnouncement: a card enters review", () => {
  test("a task-aware push when a task enters review", () => {
    const p = push({ kind: "review", subject: "task:t9", projectId: "p", taskId: "t9", taskTitle: "Rifai lo schema" });
    expect(p.title).toContain("review");
    expect(p.body).toBe("Rifai lo schema");
    expect(p.tag).toBe("task-review-t9");
  });

  test("degrades gracefully when the title is missing", () => {
    const p = push({ kind: "review", subject: "task:t1", projectId: "p", taskId: "t1" });
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.tag).toBe("task-review-t1");
  });

  // Il click deve ATTERRARE sul task, non sulla board generale.
  test("il click porta al task, non alla home", () => {
    expect(push({ ...REVIEW, taskTitle: "x" }).url).toBe("/task/t9");
  });

  test("senza taskId ripiega sulla home invece di costruire una URL rotta", () => {
    expect(push({ kind: "review", subject: "task:", projectId: "p", taskTitle: "x" }).url).toBe("/");
  });
});

/**
 * I TASTI della push: la chiamata che fa la board, già composta, perché il
 * service worker non può importare niente e non deve decidere niente.
 */
describe("buildAnnouncement: i tasti di azione", () => {
  test("la domanda dell'agente diventa i tasti, e la richiesta viaggia già composta", () => {
    const p = push({ ...REVIEW, question: { text: "Lando su main?", options: ["Landa su main", "Aspetta"] } });
    expect(p.actions.map((a: any) => a.title)).toEqual(["Landa su main", "Aspetta"]);
    expect(p.body).toBe("Lando su main?");
    expect(p.title).toContain("chiedendo");
    expect(p.requests[p.actions[0].id]).toEqual({
      method: "POST",
      path: "/api/boards/proj-x/tasks/t9/review",
      body: { decision: "reject", comment: "Landa su main" },
    });
  });

  test("consegna con la sola opzione Landa → titolo di review, e il tasto Landa resta", () => {
    const p = push({ ...REVIEW, isAsk: false, question: { text: "", options: ["Landa su main"] } });
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
    const p = push({ ...REVIEW, isAsk: true, question: { text: "Lando su main?", options: ["Landa su main", "Aspetta"] } });
    expect(p.title).toContain("chiedendo");
    expect(p.title).not.toContain("review");
  });

  test("consegna senza domanda → un solo tasto: Approva", () => {
    const p = push(REVIEW);
    expect(p.actions).toEqual([{ id: "approve", title: "Approva" }]);
    expect(p.requests.approve).toEqual({ method: "POST", path: "/api/boards/proj-x/tasks/t9/review", body: { decision: "approve" } });
    expect(p.body).toBe("Rifai lo schema");
  });

  test("domanda con troppe opzioni → nessun tasto, ma la push parte lo stesso", () => {
    const p = push({ ...REVIEW, question: { text: "Quale?", options: ["a", "b", "c"] } });
    expect(p.actions).toBeUndefined();
    expect(p.url).toBe("/task/t9");
  });

  test("una `question` malformata NON diventa «nessuna domanda» (niente Approva)", () => {
    expect(push({ ...REVIEW, question: { text: 42, options: "non un array" } }).actions).toBeUndefined();
  });

  // The kickoff envelope orders a landable delivery to attach
  // `options=["Landa su main"]`: the title follows `questionAsksHuman`, not
  // the presence of a question block.
  test("a delivery offering only «Landa su main»: review title, button untouched", () => {
    const p = push({ ...REVIEW, question: { text: "Fatto: sei cancelli verdi.", options: ["Landa su main"] } });
    expect(p.title).not.toContain("chiedendo");
    expect(p.title).toContain("review");
    expect(p.actions.map((a: any) => a.title)).toEqual(["Landa su main"]);
  });

  test("MIXED question: one option the board cannot run and the voice is «chiedendo» again", () => {
    expect(push({ ...REVIEW, question: { text: "Fatto, ma il nome del flag non mi convince.", options: ["Landa su main", "Aspetta, ho un dubbio"] } }).title).toContain("chiedendo");
  });

  test("parcheggiato → «Rimetti in coda», che è la PATCH dello stato", () => {
    const p = push({ kind: "parked", subject: "task:t4", projectId: "proj-x", taskId: "t4", taskTitle: "x", state: "failed" });
    expect(p.actions).toEqual([{ id: "requeue", title: "Rimetti in coda" }]);
    expect(p.requests.requeue).toEqual({ method: "PATCH", path: "/api/boards/proj-x/tasks/t4", body: { status: "todo" } });
  });

  test("senza taskId non si disegna nessun tasto (non saprebbe a chi parlare)", () => {
    expect(push({ kind: "review", subject: "task:", projectId: "proj-x", taskTitle: "x" }).actions).toBeUndefined();
    expect(push({ kind: "parked", subject: "task:t4", taskId: "t4", taskTitle: "x", state: "failed" }).actions).toBeUndefined();
  });

  test("la push della chat resta senza tasti: non c'è un click che risponda", () => {
    expect(push({ kind: "finished", subject: "topic:tp1", topicId: "tp1", name: "Rifai la migration" }).actions).toBeUndefined();
  });
});

describe("buildAnnouncement: a card parked", () => {
  test("failed → push di consegna mancata, tag per taskId", () => {
    const p = push({ kind: "parked", subject: "task:t4", projectId: "p", taskId: "t4", taskTitle: "Rifai lo schema", state: "failed" });
    expect(p.title).toContain("non consegnato");
    expect(p.body).toBe("Rifai lo schema");
    expect(p.tag).toBe("task-park-t4");
  });

  test("blocked → testo diverso: chiede un intervento, non annuncia un esito", () => {
    const p = push({ kind: "parked", subject: "task:t5", projectId: "p", taskId: "t5", taskTitle: "Migra la 041", state: "blocked" });
    expect(p.title).toContain("sistemare");
    expect(p.tag).toBe("task-park-t5");
  });

  test("waited_out → né «non consegnato» né «da sistemare»: chiede una decisione", () => {
    const p = push({ kind: "parked", subject: "task:t8", projectId: "p", taskId: "t8", taskTitle: "Aspetta la CI", state: "waited_out" });
    expect(p.title).toContain("decidi tu");
    expect(p.title).not.toContain("consegnato");
    expect(p.title).not.toContain("sistemare");
    expect(p.tag).toBe("task-park-t8");
  });

  test("degrada senza titolo", () => {
    expect(push({ kind: "parked", subject: "task:t6", projectId: "p", taskId: "t6", state: "failed" }).body.length).toBeGreaterThan(0);
  });

  test("anche qui il click porta al task", () => {
    expect(push({ kind: "parked", subject: "task:t7", projectId: "p", taskId: "t7", state: "blocked" }).url).toBe("/task/t7");
  });
});

describe("buildAnnouncement: a chat finished, and what a turn's end means", () => {
  test("fine PULITA di chat → una push col nome del topic, tag+url per topicId", () => {
    expect(classifyTurnEnd({ completed: true }).outcome).toBe("done");
    const p = push({ kind: "finished", subject: "topic:tp1", topicId: "tp1", name: "Rifai la migration" });
    expect(p.title).toContain("Rifai la migration");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.tag).toBe("chat-end-tp1");
    expect(p.url).toBe("/topic/tp1");
  });

  test("senza nome risolto degrada a un titolo generico, ma manda la push", () => {
    const p = push({ kind: "finished", subject: "topic:zzz", topicId: "zzz", name: null });
    expect(p.title).toBe("💬 Risposta pronta");
    expect(p.tag).toBe("chat-end-zzz");
    expect(p.url).toBe("/topic/zzz");
  });

  test("MUTA su annullo dell'utente: nothing to announce", () => {
    expect(classifyTurnEnd({ completed: true, reason: "user_abort" }).outcome).toBeNull();
  });

  test("MUTA sul kill del watchdog senza avviso", () => {
    expect(classifyTurnEnd({ stopReason: "cancelled", stopCause: "watchdog" }).outcome).toBeNull();
  });

  test("MUTA su un turno d'AGENTE guidato dalla board", () => {
    expect(classifyTurnEnd({ completed: true, dispatched: true }).outcome).toBeNull();
  });

  test("MUTA su un `stream:end` NON pulito (nessun marcatore completed)", () => {
    expect(classifyTurnEnd({}).outcome).toBeNull();
  });

  test("MUTA senza topicId (non saprebbe DI COSA né DOVE mandarti)", () => {
    expect(buildAnnouncement({ kind: "finished", subject: "topic:", name: "x" })).toBeNull();
  });

  test("MUTA su un turno scartato perché vuoto (T17)", () => {
    expect(classifyTurnEnd({ completed: true, discarded: true }).outcome).toBeNull();
  });
});

/**
 * THE DEAD TURN: one signal, with its own tag and registry kind, for a turn
 * that died and left its notice; quiet for a board agent and for a turn the
 * system resumes by itself.
 */
describe("a dead turn (chat-error)", () => {
  const DEAD = {
    reason: "error",
    error: "⚠️ overloaded_error: il provider ha risposto errore per 27 tentativi di fila. «Riprova» rimanda il tuo messaggio.",
  };
  const words = (error = DEAD.error) => buildAnnouncement({ kind: "error", subject: "topic:tp1", topicId: "tp1", name: "Rifai la migration", error })!;

  test("un turno morto è un errore, e la sua push porta il nome del topic", () => {
    expect(classifyTurnEnd(DEAD).outcome).toBe("error");
    expect(words().push.title).toBe("⚠️ Rifai la migration");
    expect(words().push.tag).toBe("chat-error-tp1");
    expect(words().push.url).toBe("/topic/tp1");
  });

  test("il corpo e' il testo dell'errore, senza l'icona doppia e tagliato a 120", () => {
    expect(words("⚠️ " + "x".repeat(300)).push.body).toBe("x".repeat(120));
  });

  test("finisce nel registro come `chat-error`, con la sua chiave, non quella della risposta", () => {
    const logged = words().record;
    expect(logged.kind).toBe("chat-error");
    expect(logged.dedupeKey).toBe("chat-error:tp1");
    expect(logged.targetKind).toBe("topic");
    expect(logged.targetId).toBe("tp1");
    expect(logged.source).toBe("push");
    expect(logged.groupKey).toBe("topic:tp1");
  });

  test("anche il watchdog e' una morte: stopCause watchdog + testo → errore", () => {
    expect(classifyTurnEnd({ ...DEAD, stopReason: "cancelled", stopCause: "watchdog" }).outcome).toBe("error");
  });

  test("tagliato dal tetto dei token: stopReason max_tokens + testo -> errore", () => {
    expect(classifyTurnEnd({ ...DEAD, stopReason: "max_tokens", error: "⚠️ Risposta tagliata dal tetto dei token: chiedi la parte che manca." }).outcome).toBe("error");
  });

  test("un turno FINITO resta una risposta, e nessun errore", () => {
    expect(classifyTurnEnd({ completed: true })).toMatchObject({ outcome: "done", resumes: false });
    expect(buildAnnouncement({ kind: "finished", subject: "topic:tp1", topicId: "tp1" })!.record.kind).toBe("chat-message");
  });

  test("MUTA sulla morte di un turno d'AGENTE della board (ha il suo canale)", () => {
    expect(classifyTurnEnd({ ...DEAD, dispatched: true }).outcome).toBeNull();
  });

  test("quando il server si sta spegnendo il turno riparte da solo: nessuna epoca (T10b)", () => {
    expect(classifyTurnEnd({ ...DEAD, stopReason: "cancelled", stopCause: "server-shutdown" })).toMatchObject({ outcome: null, resumes: true });
  });

  test("un guasto fuori dal turno che si riprende da solo (l'API giù, il daemon morto) non è un'epoca", () => {
    expect(classifyTurnEnd({ ...DEAD, stopCause: "api-unavailable", error: "⚠️ Turno interrotto: l'API di Claude non rispondeva più. Riprende da solo appena torna a rispondere." }).resumes).toBe(true);
    expect(classifyTurnEnd({ ...DEAD, stopCause: "broker-died", error: "⚠️ Turno interrotto: si è fermato il processo che ospitava l'agente (ai-bridge). Riprende da solo." }).resumes).toBe(true);
  });

  test("every notice that promises the resume is no epoch: the rate limit and the cut the sweep resends (T10b)", () => {
    const rateLimit = avvisoPerTurno({ end: "error", cause: "rate-limit" } as never, { haProdotto: true, riprendeDaSolo: true })!;
    expect(classifyTurnEnd({ ...DEAD, stopCause: "rate-limit", error: rateLimit })).toMatchObject({ outcome: null, resumes: true });
    const withHour = avvisoPerTurno({ end: "error", cause: "rate-limit", detail: "resets at 2026-10-04T12:00:00Z" } as never, { haProdotto: true })!;
    expect(classifyTurnEnd({ ...DEAD, stopCause: "rate-limit", error: withHour }).resumes).toBe(true);
    const watchdog = avvisoPerTurno({ end: "cancelled", cause: "watchdog" } as never, { haProdotto: true, riprendeDaSolo: true })!;
    expect(classifyTurnEnd({ ...DEAD, stopReason: "cancelled", stopCause: "watchdog", error: watchdog })).toMatchObject({ outcome: null, resumes: true });
    // The same cut without the promise asks the person: an error.
    const asks = avvisoPerTurno({ end: "cancelled", cause: "watchdog" } as never, { haProdotto: true, riprendeDaSolo: false })!;
    expect(classifyTurnEnd({ ...DEAD, stopReason: "cancelled", stopCause: "watchdog", error: asks }).outcome).toBe("error");
  });

  test("the same outage on a wake is NOT muted: its notice asks the person", () => {
    for (const cause of ["api-unavailable", "broker-died"] as const) {
      const error = avvisoPerTurno({ end: "error", cause }, { haProdotto: true, riprendeDaSolo: false })!;
      expect(classifyTurnEnd({ ...DEAD, stopCause: cause, error }).outcome).toBe("error");
    }
  });

  test("senza topicId non sa DOVE mandarti: muta", () => {
    expect(buildAnnouncement({ kind: "error", subject: "topic:", error: DEAD.error })).toBeNull();
  });

  test("uno stream:end sporco SENZA testo d'errore (annullo, stale) non annuncia niente", () => {
    expect(classifyTurnEnd({ reason: "user_abort" }).outcome).toBeNull();
    expect(classifyTurnEnd({ reason: "stale_timeout", stopReason: "cancelled", stopCause: "watchdog" }).outcome).toBeNull();
  });
});

describe("a chat waiting for you (PUSH-05)", () => {
  test("the entry into the wait: topic name, the question, deep link to the topic, its registry row", () => {
    const a = buildAnnouncement({ kind: "waiting", subject: "topic:tp1", reason: "question", topicId: "tp1", name: "Rifai la migration", prompt: "Quale schema uso, A o B?" })!;
    expect(a.push).toEqual({ title: "❓ Rifai la migration", body: "Quale schema uso, A o B?", tag: "chat-wait-tp1", url: "/topic/tp1" });
    expect(a.record).toMatchObject({ kind: "session", targetKind: "topic", targetId: "tp1", dedupeKey: "session:tp1:awaiting-approval", source: "push" });
  });

  test("without a question text, and without a topic name, it still announces with generic copy", () => {
    const a = buildAnnouncement({ kind: "waiting", subject: "topic:zzz", reason: "question", topicId: "zzz", prompt: "" })!;
    expect(a.push.title).toBe("❓ Claude ti sta aspettando");
    expect(a.push.body.length).toBeGreaterThan(0);
  });
});

/**
 * The gates the reply push applied to a frame now live where the epoch is
 * decided: a silenced chat (muted, in a muted project) writes its row and
 * does not announce; an archived chat and a board agent's topic never light;
 * the same wait announced again is the same epoch, a new question after the
 * answer is a new one; a card that moves but stays out of review is no fact.
 */
describe("announce gates in the store", () => {
  const rows: NotificationRecordInput[] = [];
  const pushes: unknown[] = [];
  const frames: Array<Record<string, any>> = [];
  const TOPICS: Record<string, { name?: string | null; archived?: boolean; muted?: boolean; projectPath?: string | null }> = {
    tp1: { name: "Rifai la migration", projectPath: "/w/alfa" },
    arch: { name: "Vecchia chat", archived: true },
    quiet: { name: "Dentro il progetto zittito", projectPath: "/w/muto" },
  };
  beforeEach(() => {
    resetAttentionStore();
    rows.length = 0; pushes.length = 0; frames.length = 0;
    configureAttentionStore({
      db: () => null,
      recordRow: (i) => { rows.push(i); return null; },
      sendPush: (p) => { pushes.push(p); },
      broadcast: (f) => { frames.push(f as Record<string, any>); },
      describe: (subject) => {
        const id = subject.slice("topic:".length);
        return { name: TOPICS[id]?.name ?? null, silenced: isTopicSilenced(TOPICS[id] ?? null, ["/w/muto"]) };
      },
    });
  });
  const finish = (topicId: string) => { turnStarted(`topic:${topicId}`); turnEnded(`topic:${topicId}`, { turnId: "m1", outcome: "done" }); };

  test("a topic in a project NOT muted announces and pushes", () => {
    finish("tp1");
    expect(pushes).toHaveLength(1);
    expect(frames.filter((f) => f.announce)).toHaveLength(1);
  });

  test("a topic whose PROJECT is muted writes its row, and does not announce nor push", () => {
    finish("quiet");
    expect(rows).toHaveLength(1);
    expect(pushes).toHaveLength(0);
    expect(frames.filter((f) => f.announce)).toHaveLength(0);
    expect(getAttention("topic:quiet").lit).toBe(true);
  });

  test("an archived topic never lights: no row, no push", () => {
    setClosed("topic:arch", { archived: true });
    finish("arch");
    expect(rows).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  test("a board agent's topic never lights: its card speaks", () => {
    setDispatched("topic:tp1", true);
    finish("tp1");
    expect(rows).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  test("the same wait announced again does not announce twice; a NEW question after the answer does", () => {
    turnStarted("topic:tp1");
    openHold("topic:tp1", "phase", { kind: "question", id: "phase:1000", text: "Quale schema uso, A o B?" });
    openHold("topic:tp1", "phase", { kind: "question", id: "phase:1000", text: "Quale schema uso, A o B?" });
    expect(pushes).toHaveLength(1);
    turnStarted("topic:tp1");
    openHold("topic:tp1", "phase", { kind: "question", id: "phase:5000", text: "E adesso?" });
    expect(pushes).toHaveLength(2);
    expect((pushes[1] as { body: string }).body).toBe("E adesso?");
  });

  test("a dead turn in a muted project: the row, no announce, no push (the same rules as the reply)", () => {
    turnStarted("topic:quiet");
    turnEnded("topic:quiet", { turnId: "m9", outcome: "error", detail: "overloaded" });
    expect(rows.map((r) => r.kind)).toEqual(["chat-error"]);
    expect(pushes).toHaveLength(0);
  });

  test("a wait of a muted project or an archived chat: quiet", () => {
    openHold("topic:quiet", "ask", { kind: "question", id: "ask:1" });
    setClosed("topic:arch", { archived: true });
    openHold("topic:arch", "ask", { kind: "question", id: "ask:1" });
    expect(pushes).toHaveLength(0);
    expect(getAttention("topic:arch").lit).toBe(false);
  });

  test("every phase that is not a wait opens nothing: a turn at work is not announced", () => {
    turnStarted("topic:tp1");
    expect(rows).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  test("a card that moves without entering review or its park is no fact (stays quiet)", () => {
    setCard("task:t1", null);
    expect(rows).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });
});

/**
 * Il gate, da solo: i casi limite che in prod arrivano dal DB e da un JSON
 * scritto dal client, inclusi i due versi di sicurezza, che sono opposti apposta.
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

  test("topic inesistente → zitto (fail-closed)", () => {
    expect(isTopicSilenced(null, [])).toBe(true);
    expect(isTopicSilenced(undefined, [])).toBe(true);
  });
});

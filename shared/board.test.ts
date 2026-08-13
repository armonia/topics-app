import { test, expect, describe } from "bun:test";
import {
  QUEUE_REASON_UNKNOWN,
  STATUS_EVENT_REASON_MAX,
  deriveQueueReason,
  deriveSubtaskWork,
  formatStatusEvent,
  isAncestorAtWork,
  isUnattributedSubtask,
  parseStatusEvent,
  pendingQuestion,
  statusEventEnters,
  type BlockerRef,
  type QueueReason,
} from "./board";

/**
 * Il formato dell'evento di stato ha UN writer e UN parser, perché lo leggono in
 * tre (il gate della consegna muta lato servizio, il dispatcher, la riga della
 * timeline). Finché la transizione era `from→to` e basta, ognuno se lo
 * spacchettava a modo suo; qui si pinna che la ragione non sposta il confine
 * della destinazione — cioè che i tre lettori continuano a leggere lo stesso
 * stato di prima.
 */
describe("evento di stato: from→to (· ragione)", () => {
  test("senza ragione il contenuto è identico a prima (le righe già scritte restano leggibili)", () => {
    expect(formatStatusEvent("todo", "in_progress")).toBe("todo→in_progress");
    expect(formatStatusEvent("todo", "in_progress", "")).toBe("todo→in_progress");
    expect(formatStatusEvent("todo", "in_progress", "   ")).toBe("todo→in_progress");
    expect(parseStatusEvent("todo→in_progress")).toEqual({ from: "todo", to: "in_progress", reason: null });
  });

  test("con ragione: la destinazione resta la destinazione", () => {
    const c = formatStatusEvent("done", "in_progress", "il land ha fatto conflitto con main");
    expect(c).toBe("done→in_progress · il land ha fatto conflitto con main");
    expect(parseStatusEvent(c)).toEqual({
      from: "done", to: "in_progress", reason: "il land ha fatto conflitto con main",
    });
    // Il predicato che i tre lettori usano davvero.
    expect(statusEventEnters(c, "in_progress")).toBe(true);
    expect(statusEventEnters(c, "done")).toBe(false);
  });

  test("una ragione con dentro una freccia o un altro separatore non sposta il confine", () => {
    const c = formatStatusEvent("review", "in_progress", "rifiutato: A → B · e poi C");
    expect(parseStatusEvent(c)?.to).toBe("in_progress");
    expect(parseStatusEvent(c)?.reason).toBe("rifiutato: A → B · e poi C");
    expect(statusEventEnters(c, "in_progress")).toBe(true);
  });

  test("la ragione è UNA riga e ha un tetto (è una riga di timeline, non un thread)", () => {
    const multi = formatStatusEvent("done", "in_progress", "  prima riga\n\nseconda   riga  ");
    expect(multi).toBe("done→in_progress · prima riga seconda riga");
    const long = formatStatusEvent("done", "in_progress", "x".repeat(500));
    expect(parseStatusEvent(long)!.reason!.length).toBe(STATUS_EVENT_REASON_MAX);
    expect(statusEventEnters(long, "in_progress")).toBe(true);
  });

  test("ciò che non è una transizione non viene letto come tale", () => {
    expect(parseStatusEvent("un commento qualunque")).toBeNull();
    expect(statusEventEnters("un commento qualunque", "in_progress")).toBe(false);
    // Un commento che PARLA di in_progress non è un inizio di turno: era il
    // rischio della lettura per suffisso (`endsWith`).
    expect(statusEventEnters("ho messo il task in in_progress", "in_progress")).toBe(false);
  });
});

/**
 * Una card `in_progress` senza topic e senza chip è ambigua: o la lavora un
 * antenato dentro il proprio turno (il flusso voluto, e la norma), o è rimasta
 * lì e non la lavora nessuno. Qui si pinna che le due risposte restino DUE — il
 * modo in cui questo si rompe è collassare su una sola, e collassa in silenzio.
 */
describe("chi lavora un sottotask senza agente suo", () => {
  const parent = (over: Partial<{ id: string; text: string; status: string; dispatchState: string | null; archived: boolean }> = {}) => ({
    id: "p1", text: "il padre", status: "in_progress", dispatchState: "working", archived: false, ...over,
  });
  const child = (over: Partial<{ status: string; parentTaskId: string | null; assignedTopicId: string | null; dispatchState: string | null }> = {}) => ({
    status: "in_progress", parentTaskId: "p1", assignedTopicId: null, dispatchState: null, ...over,
  });

  test("la forma ambigua è UNA sola: in corso, figlio, senza topic e senza chip", () => {
    expect(isUnattributedSubtask(child())).toBe(true);
    // Un topic suo: la card ha già il deep-link, la domanda non si pone.
    expect(isUnattributedSubtask(child({ assignedTopicId: "t1" }))).toBe(false);
    // Un chip suo: lo stato è già scritto sulla card.
    expect(isUnattributedSubtask(child({ dispatchState: "working" }))).toBe(false);
    expect(isUnattributedSubtask(child({ dispatchState: "needs_input" }))).toBe(false);
    // Non è un sottotask: un task radice fermo è un altro problema.
    expect(isUnattributedSubtask(child({ parentTaskId: null }))).toBe(false);
    // Non è in corso: in backlog o in review nessuno si aspetta che qualcuno la tenga.
    expect(isUnattributedSubtask(child({ status: "todo" }))).toBe(false);
    expect(isUnattributedSubtask(child({ status: "review" }))).toBe(false);
  });

  test("un antenato è al lavoro solo se è VIVO, in corso e con un agente dentro", () => {
    expect(isAncestorAtWork(parent())).toBe(true);
    expect(isAncestorAtWork(parent({ dispatchState: "queued" }))).toBe(true);
    expect(isAncestorAtWork(parent({ dispatchState: "starting" }))).toBe(true);
    // Fermo: consegnato, in attesa di risposta, mai partito.
    expect(isAncestorAtWork(parent({ dispatchState: "delivered" }))).toBe(false);
    expect(isAncestorAtWork(parent({ dispatchState: "needs_input" }))).toBe(false);
    expect(isAncestorAtWork(parent({ dispatchState: null }))).toBe(false);
    // `dispatch_state` resta scritto anche su righe che nel frattempo si sono
    // mosse: da solo direbbe «al lavoro» su un padre già chiuso o archiviato.
    expect(isAncestorAtWork(parent({ status: "review" }))).toBe(false);
    expect(isAncestorAtWork(parent({ status: "backlog" }))).toBe(false);
    expect(isAncestorAtWork(parent({ archived: true }))).toBe(false);
  });

  test("(a) il padre la lavora nel proprio turno: la card lo dice, e dice chi", () => {
    expect(deriveSubtaskWork(child(), [parent()])).toEqual({
      kind: "parent-turn", ancestor: { id: "p1", text: "il padre" },
    });
  });

  test("(b) nessun antenato al lavoro: la card lo dice, così il triage la vede", () => {
    // Il caso misurato: il padre è tornato in backlog/blocked senza topic.
    expect(deriveSubtaskWork(child(), [parent({ status: "backlog", dispatchState: null })]))
      .toEqual({ kind: "unattended" });
    // Catena vuota: il padre non c'è più (edge orfano). Nessuno la lavora.
    expect(deriveSubtaskWork(child(), [])).toEqual({ kind: "unattended" });
  });

  test("vince il primo antenato AL LAVORO, non il padre diretto", () => {
    // Il padre diretto è a sua volta un sottotask fermo; chi tiene il turno è il nonno.
    const chain = [
      parent({ id: "p1", text: "lo step", status: "in_progress", dispatchState: null }),
      parent({ id: "g1", text: "il nonno" }),
    ];
    expect(deriveSubtaskWork(child(), chain)).toEqual({
      kind: "parent-turn", ancestor: { id: "g1", text: "il nonno" },
    });
  });

  test("`null` vuol dire «niente da dire», mai «non la lavora nessuno»", () => {
    // La distinzione che conta: con un topic suo non si disegna NIENTE — non il
    // chip rosso. Collassare i due su un falsy è il modo in cui questo si rompe.
    expect(deriveSubtaskWork(child({ assignedTopicId: "t1" }), [])).toBeNull();
    expect(deriveSubtaskWork(child({ dispatchState: "working" }), [])).toBeNull();
    expect(deriveSubtaskWork(child({ status: "done" }), [])).toBeNull();
    expect(deriveSubtaskWork(child({ parentTaskId: null }), [])).toBeNull();
  });
});

/**
 * La ragione della coda: ogni ramo del dispatcher ha la SUA frase, e i rami si
 * distinguono per TONO — «la coda scorre» contro «non riparte finché non
 * decidi tu». Prima erano tutti la parola «in coda», che è esattamente il
 * difetto che questa funzione chiude.
 *
 * Gira qui e non in un test del client perché è qui che la frase nasce: il
 * client la riceve già scritta. Se un giorno la deducesse da capo, questo test
 * resterebbe verde mentre la card mente — per quello il patto «viene dal
 * server» ha il suo test, in `server/services/tasks.queue-reason.test.ts`.
 */
describe("perché questa card è ferma", () => {
  const NOW = "2026-08-12T10:00:00.000Z";
  const base = {
    status: "todo" as string,
    parentTaskId: null as string | null,
    dispatchState: null as string | null,
    dispatchAttempts: 0,
    dispatchDeferredUntil: null as string | null,
    blockedByTaskId: null as string | null,
    blockedBy: null as BlockerRef | null,
  };
  const ctx = {
    now: NOW, autoDispatch: true, retryCap: 2, ahead: 0,
    heavyHeld: false, behind: 0,
    parentStatus: null as string | null, projectless: false, openSubtasks: 0,
    formatTime: () => "06:40",
  };
  const reason = (t: Partial<typeof base>, c: Partial<typeof ctx> = {}) =>
    deriveQueueReason({ ...base, ...t }, { ...ctx, ...c })!;

  /**
   * IL VICOLO CIECO CHE LA CARD NON DICEVA — otto card nella notte del 12/08.
   *
   * Un padre in review con la checklist ancora aperta sembra una consegna che
   * aspetta una persona. Non lo è: quella persona non ha mosse. Approvare porta
   * a `done`, e `done` con un sottotask aperto è rifiutato (`open_subtasks`); e
   * i sottotask non li dispaccia nessuno da solo, li lavora solo l'agente del
   * padre dentro il proprio turno, che è finito. La card taceva, e il motivo
   * viveva soltanto nel log di una sonda che nessuno lancia.
   */
  test("in review con la checklist aperta: è ferma, e la card lo dice", () => {
    const r = reason({ status: "review" }, { openSubtasks: 2 });
    expect(r).toMatchObject({ kind: "checklist_frozen", tone: "stalled", head: "ferma" });
    expect(r.detail).toContain("2");
    // Il tooltip deve dire la CONSEGUENZA, non ripetere il conto: è la cosa che
    // chi guarda non sa, cioè che approvare non chiuderà niente.
    expect(r.title.toLowerCase()).toContain("done");
  });

  test("in review con la checklist CHIUSA non c'è niente da dire", () => {
    expect(deriveQueueReason({ ...base, status: "review" }, { ...ctx, openSubtasks: 0 })).toBeNull();
  });

  test("il singolare non dice «1 sottotask aperti»", () => {
    expect(reason({ status: "review" }, { openSubtasks: 1 }).detail).toBe("1 sottotask aperto");
  });

  /**
   * LA CARD CHE STA GIÀ CHIEDENDO NON SI FA ZITTIRE.
   *
   * `needs_input` è l'unico stato in cui la card porta addosso una DOMANDA con
   * una risposta possibile: quella di sistema sui figli parcheggiati (due
   * bottoni, «rimettili in coda» / «archiviali») o quella vera dell'agente, che
   * si risponde nella sessione. Il chip rosa «serve te» dice esattamente quella
   * mossa; «ferma · 1 sottotask aperto» la cancella e al suo posto consiglia
   * cose che o ci sono già o non c'entrano.
   *
   * Ed è anche la riga su cui la sonda e questa funzione si davano risposta
   * opposta: `stalled-parents.ts` esclude `review + delivered_reason =
   * 'parked_children'` dicendo «STA GIÀ CHIEDENDO», e qui si leggeva «ferma».
   * Escludere `needs_input` CONTIENE quell'esclusione — `askParkedChildren`
   * scrive i due campi nella stessa UPDATE — quindi le due funzioni non possono
   * più contraddirsi su nessuna riga.
   */
  test("in review con una domanda aperta la ragione TACE: «serve te» è la mossa", () => {
    expect(deriveQueueReason(
      { ...base, status: "review", dispatchState: "needs_input" },
      { ...ctx, openSubtasks: 2 },
    )).toBeNull();
  });

  /**
   * `delivered` invece PERDE il suo chip verde, ed è voluto: «consegnato,
   * approva» è una bugia quando approvare viene rifiutato (`open_subtasks`).
   * Non c'è nessuna domanda da cancellare — quel chip non chiede niente, dice
   * che si può chiudere — e non si può.
   */
  test("una consegna pulita con la checklist aperta non è pulita: vince «ferma»", () => {
    expect(reason({ status: "review", dispatchState: "delivered" }, { openSubtasks: 1 }))
      .toMatchObject({ kind: "checklist_frozen", tone: "stalled" });
  });

  test("in review senza domanda («waiting») il chip nuovo resta", () => {
    expect(reason({ status: "review", dispatchState: "waiting" }, { openSubtasks: 3 }))
      .toMatchObject({ kind: "checklist_frozen", detail: "3 sottotask aperti" });
  });

  test("fuori da todo e review la domanda resta senza risposta", () => {
    for (const status of ["backlog", "in_progress", "done"]) {
      expect(deriveQueueReason({ ...base, status }, { ...ctx, openSubtasks: 3 })).toBeNull();
    }
  });

  test("aspetta uno slot: dice QUANTI ne ha davanti, e il tono resta «la coda scorre»", () => {
    expect(reason({}, { ahead: 3 })).toMatchObject({
      kind: "slot", tone: "queued", head: "in coda", detail: "3 davanti",
    });
    expect(reason({}, { ahead: 0 }).detail).toBe("la prossima");
  });

  test("un pesante trattenuto dice che è LUI il tappo, non «in coda, 0 davanti»", () => {
    // Il guasto del 12/08: un pesante con priorità alta si piazza in testa, il
    // ramo trattenuto del tick fa `break`, e la board intera si ferma. Ogni card
    // portava lo stesso chip «in coda», compresa quella che le fermava tutte.
    const tappo = reason({ dispatchState: "queued" }, { heavyHeld: true, behind: 7, ahead: 0 });
    expect(tappo.kind).toBe("heavy_hold");
    expect(tappo.detail).toContain("7 dietro");
    expect(tappo.title).toContain("7 task");
    // Riparte da sé (c'è un tetto all'attesa): è «waiting», non «stalled».
    expect(tappo.tone).toBe("waiting");
    // E soprattutto NON è la frase di prima, che a fila ferma diceva pure il vero.
    expect(reason({}, { ahead: 0 }).detail).toBe("la prossima");
    expect(tappo.detail).not.toBe("la prossima");
  });

  test("il tappo non copre le ragioni della card, né l'interruttore spento", () => {
    // Precedenza: un pesante trattenuto che ha finito i tentativi non «tiene la
    // coda», è fermo per conto suo; e a dispatch spento non c'è coda da tappare.
    const held = { heavyHeld: true, behind: 4 };
    expect(reason({ dispatchAttempts: 2, dispatchState: "queued" }, held).kind).toBe("attempts");
    expect(reason({ dispatchState: "queued" }, { ...held, autoDispatch: false }).kind).toBe("dispatch_off");
    expect(reason({ dispatchState: "queued", blockedByTaskId: "x" }, held).kind).toBe("blocked");
  });

  test("«aspetta uno slot» e «non partirà mai» non sono più la stessa parola", () => {
    // È la barra n.3 del task: i due casi che oggi collassano su «in coda».
    const slot = reason({}, { ahead: 2 });
    const mai = reason({ dispatchAttempts: 2 });
    expect(slot.tone).toBe("queued");
    expect(mai.tone).toBe("stalled");
    expect(mai.detail).toBe("tentativi finiti, rimettila in coda");
    expect(slot.detail).not.toBe(mai.detail);
  });

  test("rinviata: sotto l'ora e mezza si dice in minuti, oltre con l'orologio", () => {
    expect(reason({ dispatchDeferredUntil: "2026-08-12T10:12:00.000Z" })).toMatchObject({
      kind: "deferred", tone: "waiting", head: "rinviata", detail: "riprende fra 12 min",
    });
    // `formatTime` iniettato: il ramo con l'orologio non dipende dal fuso della
    // macchina che fa girare il test.
    expect(reason({ dispatchDeferredUntil: "2026-08-13T04:40:00.000Z" }).detail)
      .toBe("riprende alle 06:40");
  });

  test("una finestra di rinvio già scaduta non ferma più niente", () => {
    expect(reason({ dispatchDeferredUntil: "2026-08-12T09:00:00.000Z" }).kind).toBe("slot");
  });

  test("bloccata: porta l'id del bloccante, e il titolo per esteso nel tooltip", () => {
    const r = reason({
      blockedByTaskId: "12b4f9a1-0000-4000-8000-000000000000",
      blockedBy: { id: "12b4f9a1-0000-4000-8000-000000000000", text: "Migrare le foto", status: "in_progress", archived: false },
    });
    expect(r).toMatchObject({ kind: "blocked", tone: "waiting", detail: "aspetta 12b4f9a1" });
    expect(r.title).toContain("Migrare le foto");
  });

  test("un bloccante chiuso o archiviato non blocca più: stesso predicato del gate di dispatch", () => {
    const done = { id: "b1", text: "chiuso", status: "done" as const, archived: false };
    expect(reason({ blockedByTaskId: "b1", blockedBy: done }).kind).toBe("slot");
    expect(reason({ blockedByTaskId: "b1", blockedBy: { ...done, status: "todo", archived: true } }).kind).toBe("slot");
  });

  test("rinvio e bloccante vengono PRIMA del budget dei tentativi (l'ordine del tick)", () => {
    // Invertirli darebbe «tentativi finiti» a una card che sta solo aspettando:
    // è il guasto dell'11/08, la UAT uccisa mentre la sua finestra scorreva.
    expect(reason({ dispatchAttempts: 5, dispatchDeferredUntil: "2026-08-12T10:10:00.000Z" }).kind)
      .toBe("deferred");
    expect(reason({
      dispatchAttempts: 5, blockedByTaskId: "b1",
      blockedBy: { id: "b1", text: "il bloccante", status: "todo", archived: false },
    }).kind).toBe("blocked");
  });

  test("interruttore spento e board senza directory: due «non partirà», detti diversi", () => {
    expect(reason({}, { autoDispatch: false })).toMatchObject({
      kind: "dispatch_off", tone: "stalled", detail: "dispatch spento",
    });
    // Senza progetto non c'è cwd: vale anche a interruttore acceso, e vince.
    expect(reason({}, { projectless: true, autoDispatch: true }).kind).toBe("no_project");
  });

  test("l'interruttore spento sostituisce «in coda», non le ragioni della card", () => {
    // È una proprietà della BOARD: messo per primo stamperebbe la stessa frase
    // su quaranta card e coprirebbe l'unica cosa vera di ognuna.
    const spento = { autoDispatch: false };
    expect(reason({ dispatchAttempts: 9 }, spento).kind).toBe("attempts");
    expect(reason({ dispatchDeferredUntil: "2026-08-12T10:30:00.000Z" }, spento).kind).toBe("deferred");
    expect(reason({
      blockedByTaskId: "b1",
      blockedBy: { id: "b1", text: "il bloccante", status: "todo", archived: false },
    }, spento).kind).toBe("blocked");
    // Solo chi altrimenti direbbe «in coda, 3 davanti» cambia frase: quella, a
    // interruttore spento, è la sola risposta che sarebbe falsa.
    expect(reason({}, { ...spento, ahead: 3 }).kind).toBe("dispatch_off");
  });

  test("uno step non è mai in coda: la sua ragione è sempre il padre", () => {
    const step = { parentTaskId: "p1" };
    expect(reason(step, { parentStatus: "review" })).toMatchObject({
      kind: "parent_review", tone: "stalled", detail: "il padre aspetta te",
    });
    expect(reason(step, { parentStatus: "in_progress" })).toMatchObject({
      kind: "parent_turn", tone: "waiting",
    });
    expect(reason(step, { parentStatus: "backlog" })).toMatchObject({
      kind: "parent_idle", tone: "stalled",
    });
    // Anche con un bloccante addosso: il tick lista `rootsOnly`, quindi uno step
    // non viene reclamato comunque e dire «aspetta una card» sarebbe fuorviante.
    expect(reason({ ...step, blockedByTaskId: "b1" }, { parentStatus: "in_progress" }).kind)
      .toBe("parent_turn");
  });

  test("`null` quando la domanda non si pone: fuori da todo, o con un agente già in volo", () => {
    const q = (t: Partial<typeof base>) => deriveQueueReason({ ...base, ...t }, ctx);
    expect(q({ status: "in_progress" })).toBeNull();
    expect(q({ status: "backlog" })).toBeNull();
    expect(q({ status: "review" })).toBeNull();
    // 'queued' invece È la parola che questa funzione sostituisce: non è un'uscita.
    expect(q({ dispatchState: "queued" })!.kind).toBe("slot");
    expect(q({ dispatchState: "starting" })).toBeNull();
    expect(q({ dispatchState: "working" })).toBeNull();
  });

  test("il buco si dichiara: quando la ragione non si sa, non si scrive «in coda»", () => {
    // Un ripiego su una parola generica sarebbe la stessa bugia di prima, con
    // l'aggravante di sembrare una risposta.
    expect(QUEUE_REASON_UNKNOWN.detail).toBe("motivo non registrato");
    expect(QUEUE_REASON_UNKNOWN.tone).toBe("stalled");
    expect(QUEUE_REASON_UNKNOWN.detail).not.toContain("in coda");
    expect(QUEUE_REASON_UNKNOWN.detail).not.toContain("in attesa");
  });

  test("nessuna frase usa «in attesa», che sulla card significa il CONTRARIO", () => {
    // «N in attesa» sulla card vuol dire «altri N aspettano questa»: se una
    // ragione di coda usasse quella parola direbbe il rovescio della verità.
    for (const [kind, t, c] of [
      ["slot", {}, { ahead: 3 }],
      ["deferred", { dispatchDeferredUntil: "2026-08-12T10:12:00.000Z" }, {}],
      ["blocked", { blockedByTaskId: "b1", blockedBy: { id: "b1", text: "x", status: "todo", archived: false } }, {}],
      ["attempts", { dispatchAttempts: 9 }, {}],
      ["dispatch_off", {}, { autoDispatch: false }],
      ["no_project", {}, { projectless: true }],
      ["parent_review", { parentTaskId: "p" }, { parentStatus: "review" }],
      ["parent_turn", { parentTaskId: "p" }, { parentStatus: "in_progress" }],
      ["parent_idle", { parentTaskId: "p" }, { parentStatus: "done" }],
    ] as const) {
      const r = reason(t, c);
      expect(`${r.head} ${r.detail}`, `${kind} usa la parola ambigua`).not.toContain("in attesa");
    }
  });

  test("ogni motivo ha una frase, e la frase dice cosa succede dopo", () => {
    // Il cricchetto: un ramo nuovo senza `title` (o con un `title` che è solo
    // l'etichetta ripetuta) passerebbe inosservato finché non lo legge un umano.
    const tutti: QueueReason[] = [
      reason({}, { ahead: 3 }),
      reason({ dispatchAttempts: 2 }),
      reason({ dispatchDeferredUntil: "2026-08-12T10:12:00.000Z" }),
      reason({ blockedByTaskId: "b1", blockedBy: { id: "b1", text: "x", status: "todo", archived: false } }),
      reason({}, { autoDispatch: false }),
      reason({}, { projectless: true }),
      reason({ parentTaskId: "p" }, { parentStatus: "review" }),
      reason({ parentTaskId: "p" }, { parentStatus: "in_progress" }),
      reason({ parentTaskId: "p" }, { parentStatus: "done" }),
    ];
    expect(new Set(tutti.map((r) => r.kind)).size).toBe(tutti.length);
    for (const r of tutti) {
      expect(r.detail.length, `${r.kind} senza detail`).toBeGreaterThan(3);
      expect(r.title.length, `${r.kind}: il tooltip deve dire cosa succede dopo`).toBeGreaterThan(60);
      expect(r.title).not.toBe(r.detail);
    }
  });
});

/**
 * Bookkeeping must not take the question's place at the end of the thread.
 *
 * The dispatcher writes its own notes (a queue hold, a server restart) under
 * author 'system' while the agent is parked on a question. Those rows land
 * AFTER the question, and `pendingQuestion` reads the last word: without a
 * gate, the quick-reply buttons vanish from the card and the drawer the moment
 * the dispatcher says anything at all. 'service' joins 'status' as history
 * rather than speech.
 */
describe("pendingQuestion, la contabilita' non e' l'ultima parola", () => {
  const question = ["```question", "Procedo?", "- Si'", "- No", "```"].join("\n");

  test("una nota di servizio dopo la domanda non se la mangia", () => {
    const q = pendingQuestion([
      { content: question, kind: "comment" },
      { content: "In coda: questo task e' PESANTE", kind: "service" },
    ]);
    expect(q).not.toBeNull();
    expect(q?.text).toBe("Procedo?");
    expect(q?.options).toEqual(["Si'", "No"]);
  });

  test("una parola vera dopo la domanda la chiude comunque", () => {
    // Il gate esclude la contabilita', non il thread: se l'agente o l'umano
    // parlano dopo, la domanda non e' piu' in coda e i tasti devono sparire.
    expect(pendingQuestion([
      { content: question, kind: "comment" },
      { content: "ok, fatto", kind: "comment" },
    ])).toBeNull();
  });
});

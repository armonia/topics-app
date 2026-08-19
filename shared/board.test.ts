import { test, expect, describe } from "bun:test";
import {
  ARCHIVE_PARKED_LABEL,
  LAND_ACTION_LABEL,
  PARKED_STOPPED,
  PUBLISH_ACTION_LABEL,
  QUEUE_REASON_UNKNOWN,
  PROMOTE_PARKED_LABEL,
  REQUEUE_PARKED_LABEL,
  STATUS_EVENT_REASON_MAX,
  deriveQueueReason,
  deriveSubtaskWork,
  formatStatusEvent,
  isAncestorAtWork,
  isBoardActionLabel,
  isUnattributedSubtask,
  parseQuestionBlock,
  parseStatusEvent,
  pendingQuestion,
  projectIdForPath,
  questionAsksHuman,
  showsLandingDebt,
  statusEventEnters,
  type BlockerRef,
  type QueueReason,
} from "./board";

/**
 * L'identita' della board: unica copia, tre lati del filo.
 *
 * Fino al 18/08 la funzione esisteva in 49 copie indipendenti: il servizio,
 * una closure in routes/topics.ts, il client, 45 spec E2E e il bench di
 * concorrenza. Ora vive qui. Questo test e' la prova che non si tratta di un
 * alias silenzioso verso un algoritmo derivato: il vettore inchiodato
 * `/x/proj` -> `proj-xwac8t` e' lo stesso che gia' passava in tasks.test.ts,
 * board.test.ts (client) e routes/tasks.test.ts, ora al posto canonico, quello
 * da cui gli altri importano.
 */
describe("projectIdForPath", () => {
  test("formato: basename-dir + 6 cifre base36, deterministico", () => {
    const a = projectIdForPath("/Users/utente/Projects/topics-app");
    expect(a).toBe(projectIdForPath("/Users/utente/Projects/topics-app"));
    expect(a.startsWith("topics-app-")).toBe(true);
    expect(a.slice("topics-app-".length)).toMatch(/^[0-9a-z]{1,6}$/);
  });

  test("vettore inchiodato: /x/proj -> proj-xwac8t (qualunque copia che deriva nega questo)", () => {
    expect(projectIdForPath("/x/proj")).toBe("proj-xwac8t");
  });

  test("slash finale cambia l'hash (topic.projectPath e' normalizzato, non morde)", () => {
    expect(projectIdForPath("/x/proj")).not.toBe(projectIdForPath("/x/proj/"));
  });
});

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
    // Chi ha portato la card in review quando non è stato l'agente: apre il ramo
    // del chip coi figli fermi, e solo quello.
    deliveredReason: null as string | null,
    blockedByTaskId: null as string | null,
    blockedBy: null as BlockerRef | null,
  };
  const ctx = {
    now: NOW, autoDispatch: true, retryCap: 2, ahead: 0,
    heavyHeld: false, heavyInFlight: false, behind: 0,
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

  /**
   * …TRANNE QUANDO LA CARD PROMETTE DI RIPARTIRE. Il chip `waiting` dice
   * «rinviata: lo slot è libero, riparte da sola» in qualunque colonna — è una
   * mappa da `dispatch_state` a una frase — ma il rinvio lo onora il tick, e il
   * tick reclama solo `todo`. Una card in Review non la dispaccia nessuno:
   * misurate il 13/08 due card lì con rinvii dell'11 agosto e quel chip addosso.
   */
  test("in review «rinviata» è una bugia: nessuno dispaccia questa colonna", () => {
    const r = reason(
      { status: "review", dispatchState: "waiting", dispatchDeferredUntil: "2026-08-11T13:30:00.000Z" },
      { openSubtasks: 0 },
    );
    expect(r).toMatchObject({ kind: "parked", tone: "stalled", head: "ferma" });
    expect(r.detail).toContain("review");
    expect(r.tone).not.toBe("waiting");
    // Il tooltip nomina le mosse VERE di chi guarda una review, non «aspetta».
    expect(r.title).toContain("approvala");
  });

  test("la checklist aperta batte la promessa: è la mossa più utile delle due", () => {
    expect(reason({ status: "review", dispatchState: "waiting" }, { openSubtasks: 2 }))
      .toMatchObject({ kind: "checklist_frozen", detail: "2 sottotask aperti" });
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
   * CON UNA ECCEZIONE: LA DOMANDA DI SISTEMA SUI FIGLI FERMI PORTA IL NUMERO.
   *
   * «Serve te» dice la mossa ma non dice quanto lavoro c'è sotto, e il numero è
   * la sola parte che si legge dalla colonna senza aprire il drawer: la board
   * fetcha `rootsOnly`, quindi gli step non compaiono in nessuna colonna e da
   * fuori una checklist ferma è indistinguibile da una card qualunque in
   * review. Il 13/08 erano sette padri e ventuno card, con Backlog e Todo che
   * si disegnavano vuote.
   */
  test("la domanda sui figli fermi porta il NUMERO nel chip", () => {
    const r = reason(
      { status: "review", dispatchState: "needs_input", deliveredReason: "parked_children" },
      { openSubtasks: 3 },
    );
    expect(r).toMatchObject({ kind: "children_parked", tone: "stalled", head: "serve te" });
    expect(r.detail).toBe("3 step fermi");
    expect(r.title.toLowerCase()).toContain("archivia");
  });

  test("il singolare non dice «1 step fermi»", () => {
    expect(reason(
      { status: "review", dispatchState: "needs_input", deliveredReason: "parked_children" },
      { openSubtasks: 1 },
    ).detail).toBe("1 step fermo");
  });

  // La domanda dell'AGENTE resta muta: quella si risponde nella sessione, e il
  // conto dei figli non c'entra con la mossa da fare. Solo la firma di sistema
  // apre il ramo nuovo.
  test("una domanda dell'agente non eredita il chip dei figli fermi", () => {
    expect(deriveQueueReason(
      { ...base, status: "review", dispatchState: "needs_input", deliveredReason: "retries_exhausted" },
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

  test("su una card chiusa la domanda non si pone", () => {
    expect(deriveQueueReason({ ...base, status: "done" }, { ...ctx, openSubtasks: 3 })).toBeNull();
  });

  /**
   * LA PROMESSA CHE NESSUNO MANTIENE — misurata il 13/08 sul database vivo.
   *
   * Il chip `waiting` dice «rinviata: aspetta una condizione esterna, lo slot è
   * libero, riparte da sola», e lo dice in QUALUNQUE colonna: è una mappa da
   * `dispatch_state` a una frase, e la colonna non la guarda nessuno. Ma il tick
   * reclama `status = 'todo'` e basta, quindi in Backlog quella finestra non
   * scade per nessuno: sulla board c'era una card con la finestra scaduta il 3
   * agosto, ferma da dieci giorni, che continuava a dire che sarebbe ripartita.
   *
   * La ragione vince sul chip di dispatch (`Card.tsx`), quindi coprire `backlog`
   * qui è l'unico modo di correggerla.
   */
  test("in backlog «rinviata» diventa «ferma»: da lì non riparte niente", () => {
    const r = reason(
      { status: "backlog", dispatchState: "waiting", dispatchDeferredUntil: "2026-08-12T10:12:00.000Z" },
    );
    expect(r).toMatchObject({ kind: "parked", tone: "stalled", head: "ferma" });
    // Il tono è la parte che si legge a un metro: `waiting` significa «riparte
    // da sola», ed è esattamente ciò che qui non succede.
    expect(r.tone).not.toBe("waiting");
    expect(`${r.head} ${r.detail}`).not.toContain("rinviata");
    expect(r.title).toContain("Todo");
  });

  test("una finestra di rinvio scaduta in Backlog resta una bugia (la colonna, non l'orologio)", () => {
    // `dispatchDeferredUntil` è nel passato: in `todo` non fermerebbe più
    // niente, qui la card è ferma lo stesso — e per un altro motivo.
    expect(reason({ status: "backlog", dispatchDeferredUntil: "2026-08-01T10:00:00.000Z" }).kind)
      .toBe("parked");
  });

  test("in backlog senza nessuna promessa si TACE: il parcheggio si vede dalla colonna", () => {
    expect(deriveQueueReason({ ...base, status: "backlog" }, ctx)).toBeNull();
    // Un park dichiarato ha già il suo chip, e non promette nessun ritorno.
    expect(deriveQueueReason({ ...base, status: "backlog", dispatchState: PARKED_STOPPED }, ctx)).toBeNull();
  });

  /**
   * IN CORSO SENZA NESSUNO DENTRO — quattro card così, sulla stessa board.
   *
   * `in_progress` senza `dispatch_state` non aveva alcun chip: la colonna diceva
   * «in corso» e non c'era nessun agente, nessun turno, e nessun dispatcher che
   * l'avrebbe reclamata (il tick guarda solo `todo`). Il silenzio, lì, si legge
   * come «sta andando».
   */
  test("in corso senza agente: la card lo dice, invece di sembrare in movimento", () => {
    const r = reason({ status: "in_progress" });
    expect(r).toMatchObject({ kind: "no_agent", tone: "stalled", head: "ferma", detail: "nessun agente" });
    expect(r.title).toContain("Todo");
  });

  test("in corso con un agente dentro (o una persona sopra) non c'è niente da dire", () => {
    const q = (t: Partial<typeof base>) => deriveQueueReason({ ...base, status: "in_progress", ...t }, ctx);
    for (const dispatchState of ["queued", "starting", "working"]) expect(q({ dispatchState })).toBeNull();
    // «Serve a me» scrive l'assegnatario: lì «in corso» è vero, e un chip
    // «ferma» sarebbe un allarme addosso a chi sta lavorando.
    expect(deriveQueueReason({ ...base, status: "in_progress", assignedTo: "io" }, ctx)).toBeNull();
  });

  test("uno step fuori da todo tace: chi lo lavora lo dice `deriveSubtaskWork`", () => {
    for (const status of ["backlog", "in_progress"]) {
      expect(deriveQueueReason(
        { ...base, status, parentTaskId: "p1", dispatchState: "waiting" },
        { ...ctx, parentStatus: "in_progress" },
      )).toBeNull();
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

  /**
   * IL MOTIVO DELL'ATTESA, SCRITTO DOVE NESSUNO GUARDAVA.
   *
   * Misurato sul DB vivo il 12/08 in tarda serata, mentre l'utente chiedeva
   * «ci sono 4 task in coda e non capisco se è per il carico, perché non vedo
   * il limite abilitato». Non era il carico e non era il tetto: c'era una card
   * PESANTE in volo, e «un pesante in volo blocca OGNI claim»
   * (`task-dispatcher.ts`, ramo `heavyBusy`). Il sistema lo sapeva e l'aveva
   * già scritto — nel THREAD di ognuna delle tre card. Sulla card c'era solo il
   * chip generico «in coda».
   *
   * `heavyHeld` non copre quel ramo, e non deve: porta `&& !heavyInFlight()`
   * apposta, perché senza direbbe quattro cose false («tiene la testa della
   * coda», «aspetta che la macchina abbia margine», «parte entro il tetto
   * d'attesa», «abbassagli la priorità») — nel ramo `heavyBusy` l'ordine della
   * fila non lo legge nessuno, l'attesa non ha tetto e la priorità non sblocca
   * niente. Tolta la bugia, però, la card restava MUTA: ricadeva su «in coda, N
   * davanti», che è la parola vaga da cui si era partiti.
   */
  test("un PESANTE IN VOLO ha una frase sua, e non è quella del carico", () => {
    const busy = reason({ dispatchState: "queued" }, { heavyInFlight: true, ahead: 3 });
    expect(busy.kind).toBe("heavy_busy");
    // Riparte da sé quando finisce quel turno: attesa, non stallo.
    expect(busy.tone).toBe("waiting");

    // LE QUATTRO BUGIE, nominate una per una: nessuna può ricomparire.
    const tutto = `${busy.head} ${busy.detail} ${busy.title}`;
    expect(tutto).not.toContain("testa della coda");
    expect(tutto).not.toContain("margine");
    expect(tutto).not.toContain("tetto");
    expect(tutto).not.toContain("priorità");
    // E nemmeno la fila, che qui non la legge nessuno.
    expect(tutto).not.toContain("3 davanti");

    // La frase del CARICO è un'altra cosa, e resta l'altra cosa.
    const carico = reason({ dispatchState: "queued" }, { heavyHeld: true, behind: 4 });
    expect(carico.kind).toBe("heavy_hold");
    expect(busy.detail).not.toBe(carico.detail);
    expect(busy.title).not.toBe(carico.title);
  });

  test("il pesante in volo ferma OGNI card, non solo le pesanti", () => {
    // È il ramo `heavyBusy` del tick: mette il chip `queued` su ogni todo della
    // board, non solo sui pesanti. La ragione deve valere altrettanto, o le
    // leggere ricadrebbero su «in coda» proprio mentre non parte nessuno.
    const leggera = reason({}, { heavyInFlight: true, ahead: 0 });
    expect(leggera.kind).toBe("heavy_busy");
    expect(leggera.detail).not.toBe("la prossima");
  });

  test("il pesante in volo non copre le ragioni della card né l'interruttore", () => {
    // Stessa precedenza del tappo da carico: quello che è fermo per conto suo
    // resta fermo per conto suo, e a dispatch spento non c'è coda da bloccare.
    const busy = { heavyInFlight: true };
    expect(reason({ dispatchAttempts: 2 }, busy).kind).toBe("attempts");
    expect(reason({}, { ...busy, autoDispatch: false }).kind).toBe("dispatch_off");
    expect(reason({ blockedByTaskId: "x" }, busy).kind).toBe("blocked");
    expect(reason({ parentTaskId: "p" }, { ...busy, parentStatus: "in_progress" }).kind).toBe("parent_turn");
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

  test("`null` quando la domanda non si pone: card chiusa, o agente già in volo", () => {
    const q = (t: Partial<typeof base>) => deriveQueueReason({ ...base, ...t }, ctx);
    expect(q({ status: "done" })).toBeNull();
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
      ["parked", { status: "backlog", dispatchState: "waiting" }, {}],
      ["no_agent", { status: "in_progress" }, {}],
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
      reason({ status: "backlog", dispatchState: "waiting" }),
      reason({ status: "in_progress" }),
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
/**
 * LA PASTIGLIA CHE CONTAVA LA COLONNA — misurata il 13/08 sulle 14 card che la
 * portavano: 2 debiti veri, 2 col contenuto già su main, 3 superate da lavoro
 * atterrato dopo, e 4 senza uno sha di consegna, cioè senza niente che sia mai
 * stato verificato. Undici rossi su quattordici erano falsi, ed è il modo in cui
 * un allarme smette di essere letto.
 *
 * Questa metà è la quarta riga: senza la fotografia della consegna nessuno ha
 * MAI posto la domanda, quindi non c'è nessuna risposta da mostrare. Le altre
 * tre le raddrizza il verdetto, dove si guarda il repo.
 */
describe("«non su main» dice il vero, oppure tace", () => {
  const done = { status: "done", landingState: "unlanded", deliveryCommit: "a".repeat(40) };

  test("debito vero: consegna registrata, verdetto misurato, contenuto fuori", () => {
    expect(showsLandingDebt(done)).toBe(true);
  });

  test("senza sha di consegna non è stato verificato NIENTE: si tace", () => {
    expect(showsLandingDebt({ ...done, deliveryCommit: null })).toBe(false);
    expect(showsLandingDebt({ ...done, deliveryCommit: "" })).toBe(false);
  });

  test("«non lo so» non è un'accusa più debole: solo `unlanded` accusa", () => {
    for (const landingState of ["landed", "unverifiable", null, undefined]) {
      expect(showsLandingDebt({ ...done, landingState })).toBe(false);
    }
  });

  test("solo su una card chiusa: in review non essere su main è la norma", () => {
    for (const status of ["review", "in_progress", "todo", "backlog"]) {
      expect(showsLandingDebt({ ...done, status })).toBe(false);
    }
  });
});

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

/**
 * A DELIVERY THAT WEARS A QUESTION'S CLOTHES IS STILL A DELIVERY.
 *
 * The kickoff envelope orders a landable delivery to attach
 * `options=["Landa su main"]`, and `addComment` wraps any options in a
 * ```question fence. So every reader that asked "does this contain a question
 * block" answered yes on finished work. Measured on 13/08 against the live
 * board db: of the 437 agent comments carrying that fence, 331 are deliveries.
 *
 * Four surfaces depend on this verdict and two of them live in the client (the
 * push title, the in-app banner title), which is why the rule sits in `shared/`
 * and not in the task service.
 */
describe("questionAsksHuman", () => {
  test("all options are board actions: a DELIVERY, not a question", () => {
    expect(questionAsksHuman({ options: [LAND_ACTION_LABEL] })).toBe(false);
    expect(questionAsksHuman({ options: [REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL] })).toBe(false);
    // Tolerant on the label, like the predicates it delegates to: the model
    // decorates its options, and a 🚀 must not turn a delivery into a question.
    expect(questionAsksHuman({ options: ["🚀  landa su  main."] })).toBe(false);
  });

  /**
   * PUBLISH IS NOT DEAD CODE INSIDE `isBoardActionLabel`, and this is the shape
   * that proves it. `parseQuestionBlock` drops "Landa e pubblica" from the
   * rendered options, but its filter is an exact compare after lowercase +
   * whitespace collapse, while `isPublishActionLabel` normalises away emoji and
   * punctuation too. A decorated publish label therefore SURVIVES the filter,
   * reaches the options, and is a board action: the card draws it as a button
   * and `POST …/review` executes it. Drop `isPublishActionLabel` from
   * `isBoardActionLabel` and this flips to `true`.
   */
  test("a decorated «Landa e pubblica» survives the parser filter and is still a board action", () => {
    const parsed = parseQuestionBlock("```question\nFatto.\n- 🚀 Landa e pubblica!\n```");
    expect(parsed?.options).toEqual(["🚀 Landa e pubblica!"]);
    expect(questionAsksHuman(parsed)).toBe(false);
  });

  test("MIXED stays a question: one option the board cannot run needs a person", () => {
    expect(questionAsksHuman({ options: [LAND_ACTION_LABEL, "Aspetta, ho un dubbio"] })).toBe(true);
    expect(questionAsksHuman({ options: ["JWT in cookie", "Bearer token"] })).toBe(true);
    // A plan waiting for its verdict is the case this must never swallow.
    expect(questionAsksHuman({ options: ["Approva il piano", "Da rivedere"] })).toBe(true);
  });

  test("no options is still a question; no block at all is not", () => {
    expect(questionAsksHuman({ options: [] })).toBe(true);
    expect(questionAsksHuman(null)).toBe(false);
    expect(questionAsksHuman(undefined)).toBe(false);
  });

  test("isBoardActionLabel covers the five the server runs, and nothing else", () => {
    for (const l of [LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL, REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL, PROMOTE_PARKED_LABEL]) {
      expect(isBoardActionLabel(l)).toBe(true);
    }
    // A plan verdict resumes the AGENT with the human's words: an answer, not
    // an order the board executes.
    expect(isBoardActionLabel("Approva il piano")).toBe(false);
    expect(isBoardActionLabel("Aspetta, ho un dubbio")).toBe(false);
    expect(isBoardActionLabel(null)).toBe(false);
  });
});

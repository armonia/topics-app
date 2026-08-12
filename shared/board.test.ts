import { test, expect, describe } from "bun:test";
import {
  STATUS_EVENT_REASON_MAX,
  deriveSubtaskWork,
  formatStatusEvent,
  isAncestorAtWork,
  isUnattributedSubtask,
  parseStatusEvent,
  statusEventEnters,
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

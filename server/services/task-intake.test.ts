/**
 * @covers KANBAN-21
 */
import { describe, test, expect } from "bun:test";
import { proposeLink, tokenize, linkNotes, type IntakeCandidate } from "./task-intake";
import type { TaskStatus } from "../../shared/board";

const card = (
  id: string,
  text: string,
  status: TaskStatus = "todo",
  description: string | null = null,
  updatedAt = "2026-08-10T10:00:00.000Z",
): IntakeCandidate => ({ id, text, description, status, updatedAt });

// Il caso concreto della richiesta: una lista di feedback grafici su un
// progetto è già aperta, ne arrivano altri. Oggi nascono orfani.
const FEEDBACK_CARD = card(
  "t-feedback",
  "Feedback grafici sulla landing: spaziature e contrasto",
  "in_progress",
  "La colonna di lettura è troppo larga e i chip hanno poco contrasto sul velo.",
);
const NOISE = [
  card("t-pty", "Il bridge PTY perde le tab dopo il reattach"),
  card("t-relay", "Relay Cloudflare: decidere se tenerlo acceso di notte"),
];

describe("tokenize", () => {
  test("normalizza accenti, minuscole e confini non alfanumerici", () => {
    expect(tokenize("Perché la Landing è LENTA?")).toEqual(["landing", "lenta"]);
  });
  test("butta via le parole troppo corte e le parole-riempitivo", () => {
    // "un", "po" (< 3), "fare"/"task"/"non" sono stopword: resta il tema.
    expect(tokenize("un po' di task da fare non sulla landing")).toEqual(["landing"]);
  });
});

describe("proposeLink — quando NON si propone", () => {
  test("board vuota → nessuna proposta", () => {
    expect(proposeLink({ text: "spaziature della landing", candidates: [] })).toBeNull();
  });
  test("testo su un tema estraneo → nessuna proposta", () => {
    expect(proposeLink({
      text: "Aggiornare le dipendenze di Rust nel sidecar",
      candidates: [FEEDBACK_CARD, ...NOISE],
    })).toBeNull();
  });
  test("una sola parola in comune non basta (è una coincidenza, non un tema)", () => {
    expect(proposeLink({
      text: "landing page nuova da zero con storia diversa",
      candidates: [card("t-x", "Feedback grafici sulla landing", "todo")],
    })).toBeNull();
  });
  test("le card CHIUSE non sono destinazioni", () => {
    const done = { ...FEEDBACK_CARD, status: "done" as TaskStatus };
    expect(proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [done, ...NOISE],
    })).toBeNull();
  });
  test("la card esclusa non si propone da sola", () => {
    expect(proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [FEEDBACK_CARD],
      excludeTaskId: "t-feedback",
    })).toBeNull();
  });
});

describe("proposeLink — la proposta", () => {
  test("altri feedback sullo stesso tema trovano la card in corso", () => {
    const p = proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [FEEDBACK_CARD, ...NOISE],
    });
    expect(p).not.toBeNull();
    expect(p!.targetTaskId).toBe("t-feedback");
    expect(p!.score).toBeGreaterThanOrEqual(0.34);
    expect(p!.sharedTerms).toContain("landing");
  });

  test("card che sta girando → consiglia la CATENA (è un seguito)", () => {
    const p = proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [FEEDBACK_CARD],
    });
    expect(p!.recommended).toBe("chain");
    expect(p!.targetStatus).toBe("in_progress");
  });

  test("card ferma in coda → consiglia il SOTTOTASK (è un pezzo)", () => {
    const p = proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [{ ...FEEDBACK_CARD, status: "todo" }],
    });
    expect(p!.recommended).toBe("subtask");
  });

  test("il perché è leggibile e cita la card e le parole", () => {
    const p = proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [FEEDBACK_CARD],
    });
    expect(p!.reason).toContain("Feedback grafici sulla landing");
    expect(p!.reason).toContain("landing");
    expect(p!.reason.length).toBeGreaterThan(30);
  });

  test("fra due card sullo stesso tema vince quella che condivide di più", () => {
    const generic = card("t-generic", "Landing: varie ed eventuali", "todo");
    const p = proposeLink({
      text: "Altri feedback grafici sulla landing: contrasto dei chip e spaziature",
      candidates: [generic, FEEDBACK_CARD],
    });
    expect(p!.targetTaskId).toBe("t-feedback");
  });

  test("a parità di punteggio vince la card toccata più di recente, e l'esito è stabile", () => {
    const a = card("t-a", "Contrasto dei chip sulla landing", "todo", null, "2026-08-01T00:00:00.000Z");
    const b = card("t-b", "Contrasto dei chip sulla landing", "todo", null, "2026-08-09T00:00:00.000Z");
    const text = "Contrasto dei chip sulla landing";
    const first = proposeLink({ text, candidates: [a, b] });
    const second = proposeLink({ text, candidates: [b, a] });
    expect(first!.targetTaskId).toBe("t-b");
    expect(second!.targetTaskId).toBe("t-b");
  });
});

describe("linkNotes", () => {
  test("la catena si spiega da entrambi i lati", () => {
    const n = linkNotes({
      kind: "chain",
      newTaskText: "Altri feedback grafici",
      targetText: "Feedback grafici sulla landing",
      reason: "Stesso tema.",
    });
    expect(n.onNewTask).toContain("Feedback grafici sulla landing");
    expect(n.onNewTask).toContain("Non parte finché");
    expect(n.onTargetTask).toContain("Altri feedback grafici");
    expect(n.onTargetTask).toContain("in attesa di questa card");
  });
  test("il sottotask si spiega da entrambi i lati", () => {
    const n = linkNotes({
      kind: "subtask",
      newTaskText: "Altri feedback grafici",
      targetText: "Feedback grafici sulla landing",
      reason: "Stesso tema.",
    });
    expect(n.onNewTask).toContain("sottotask");
    expect(n.onTargetTask).toContain("Altri feedback grafici");
    expect(n.onTargetTask).toContain("sottotask");
  });
});

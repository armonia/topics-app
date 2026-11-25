/**
 * The delivery summary is the review card: five fixed bold headings. A summary
 * missing any of them gets a WARNING note on the thread, never a refusal, so
 * the agent fixes it at the next delivery and the card still reaches review.
 *
 * @covers KANBAN-11
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { type Database } from "bun:sqlite";
import { freshDb } from "./tasks-test-db";
import { createTaskService } from "./tasks";
import { REVIEW_CARD_FIELDS, REVIEW_CARD_RULE } from "../../shared/board";

const PID = "topics-app-test01";
let db: Database;
let svc: ReturnType<typeof createTaskService>;
beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

// A real delivery summary, copied read-only from a card that sat in review.
const REAL_FREE_FORM = "Cosa vedrà Attilio: Approva su ramo non unito → riga «usa Landa su main»; Archivia → «Archiviata» con Ripristina, senza bottoni; turni finiti → «Rimandalo avanti»; card chiusa da lui non riaperta dal land. Ramo ribasato su main, corretto il ramo nodo archiviato che il merge aveva perso. Ok, o cosa cambiare?"; // allow-italian: verbatim real delivery

const NEW_FORMAT = [
  "**Cosa e perché** Approva avvisa se il codice non è unito, così non si chiude una card a vuoto.",
  "**Prova** bun test tasks.review-card.test.ts → exit 0; CI verde.",
  "**Come verificarlo tu** Apri una card con ramo non unito e premi Approva.",
  "**Rischio e come si annulla** Basso, solo testo: si annulla con un revert.",
  "**Decisione** Landa su main (consigliata) oppure dimmi cosa cambiare.",
].join("\n"); // allow-italian: reviewer-facing fixture

function deliver(summary: string): { status: string; notes: string[] } {
  const t = svc.create({ projectId: PID, text: "una card" });
  const out = svc.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary } });
  const notes = (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'service'").all(t.id) as { content: string }[])
    .map((r) => r.content).filter((c) => c.includes("Consegna non leggibile dalla card"));
  return { status: out.status, notes };
}

describe("review card: five fixed fields in the delivery summary", () => {
  test("a real free-form delivery reaches review and gets the warning naming all five", () => {
    const r = deliver(REAL_FREE_FORM);
    expect(r.status).toBe("review");
    expect(r.notes).toHaveLength(1);
    for (const h of REVIEW_CARD_FIELDS) expect(r.notes[0]).toContain(h);
  });

  test("a delivery in the five fields gets no warning", () => {
    const r = deliver(NEW_FORMAT);
    expect(r.status).toBe("review");
    expect(r.notes).toEqual([]);
  });

  test("one missing field is named alone", () => {
    const r = deliver(NEW_FORMAT.split("\n").filter((l) => !l.startsWith("**Prova**")).join("\n"));
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("**Prova**");
    expect(r.notes[0]).not.toContain("**Decisione**");
  });

  test("the rule quotes every heading verbatim, in order", () => {
    const at = REVIEW_CARD_FIELDS.map((h) => REVIEW_CARD_RULE.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

/**
 * A delivery gets ANNOTATED with whatever does not hold up, and is never stopped.
 *
 * WHY IT ANNOTATES AND DOES NOT BLOCK, the one design decision in here. The
 * audit of `done` tasks found 14 cards closed with no work behind them, and the
 * four mechanical checks catch them. But the check can be wrong: in its FIRST
 * HOUR of life it accused 20 paths that all existed, because reports cite files
 * by short name and it resolved them from the repository root. A gate that
 * blocks an honest delivery gets switched off within a month, and then it is
 * not there for the dishonest one either.
 *
 * So the note is read before approving, and the human decides. What these tests
 * hold is that the note can never turn into an obstacle: whatever happens in
 * the probe, the card reaches review.
 *
 * @covers KANBAN-11
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { type Database } from "bun:sqlite";
import { freshDb } from "./tasks-test-db";
import { createTaskService } from "./tasks";

const PID = "topics-app-test01";
let db: Database;
let svc: ReturnType<typeof createTaskService>;

beforeEach(() => {
  db = freshDb();
  svc = createTaskService(db);
});

/**
 * A card carried into `review` by an agent: the report IS the delivery.
 * Since `update({status:'review'})` demands `summary`, the report travels
 * there — not in some comment left earlier. The claim check reads the declared
 * delivery, so the test delivers it where the check looks.
 */
function deliver(report: string): string {
  const t = svc.create({ projectId: PID, text: "una card" });
  svc.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: report } });
  return t.id;
}

const note = (id: string): string[] =>
  (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'review-note'").all(id) as Array<{ content: string }>)
    .map((r) => r.content);

describe("la nota compare quando una rivendicazione non regge", () => {
  test("uno sha inventato viene nominato nella nota", () => {
    const id = deliver("Fatto (commit 0000000deadbee1). Tutto verde.");
    const n = note(id).join("\n");
    expect(n).toContain("0000000deadbee1");
  });

  test("e la card e' comunque in review", () => {
    // The point of this whole file: annotating is not stopping.
    const id = deliver("Fatto (commit 0000000deadbee1).");
    expect(svc.get(id)?.task.status).toBe("review");
  });

  test("la nota dice che non blocca, cosi' chi legge sa cosa farne", () => {
    const id = deliver("Fatto (commit 0000000deadbee1).");
    expect(note(id).join("\n")).toContain("Non blocca");
  });
});

describe("la nota NON compare quando non c'e' niente da dire", () => {
  test("un rapporto in prosa, senza rivendicazioni, non produce niente", () => {
    // "Nothing to check" is the legitimate case of someone reporting in prose.
    // Annotating it would turn the note into noise on every single delivery.
    const id = deliver("Ho guardato il problema e ho deciso di non toccarlo: la causa e' altrove.");
    expect(note(id)).toEqual([]);
  });

  test("una rivendicazione VERA non viene accusata", () => {
    // The half that decides whether the note is useful or merely annoying.
    const id = deliver("Fatto: vedi `server/services/tasks.ts`.");
    expect(note(id)).toEqual([]);
  });
});

describe("una deliver arriva in review comunque", () => {
  test("anche con un rapporto che sbaglia tutto", () => {
    const id = deliver("Fatto (commit 1111111abcdef22), migration 999, vedi `file/che/non/esiste.ts`.");
    expect(svc.get(id)?.task.status, "un rilievo non deve mai fermare una deliver").toBe("review");
    expect(note(id).length).toBeGreaterThan(0);
  });

  test("la nota sta in UNO slot, non in una pila", () => {
    // `annotateDeliveryClaims` runs on every transition into review. Without
    // `replaces` the thread would gain an identical line every time.
    const id = deliver("Fatto (commit 0000000deadbee1).");
    svc.update({ taskId: id, actor: "human", by: "u", patch: { status: "in_progress" } });
    svc.addComment({ taskId: id, author: "agent-1", content: "Rifatto (commit 0000000deadbee1)." });
    svc.update({ taskId: id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "riassunto della consegna" } });
    expect(note(id).length, "due giri, due note: lo slot non ha tenuto").toBe(1);
  });
});

/**
 * `parkedEdgeEvent` è il gemello di fallimento di `emitReviewReadyEdge`
 * (`server/routes/tasks-review-edge.test.ts`): il fronte che dice all'umano
 * "questo task si è fermato e NON riparte da solo".
 *
 * Le due metà da inchiodare sono simmetriche e opposte:
 *  - sul park TERMINALE (`requeue: false`) il fronte esce, una volta sola;
 *  - sul REQUEUE non esce MAI — lì il task riparte da sé e un banner sarebbe
 *    rumore su un ritentativo che si auto-guarisce. È l'unica riga che separa
 *    "ti avviso quando serve" da "ti avviso a ogni ritentativo": i siti che
 *    rilasciano con `requeue: !exhausted` passano di qui a ogni tentativo.
 * @covers KANBAN-07
 */
import { describe, test, expect } from "bun:test";
import { parkedEdgeEvent } from "./task-dispatcher";

const TASK = { id: "t1", projectId: "p1", text: "Rifai lo schema" };

describe("parkedEdgeEvent", () => {
  test("emette sul park terminale, con titolo e progetto", () => {
    const ev = parkedEdgeEvent(TASK, { requeue: false, parkState: "failed" });
    expect(ev).toMatchObject({
      type: "task:parked",
      projectId: "p1",
      taskId: "t1",
      taskTitle: "Rifai lo schema",
      state: "failed",
    });
  });

  test("NON emette sul requeue (il task riparte da solo)", () => {
    expect(parkedEdgeEvent(TASK, { requeue: true })).toBeNull();
    expect(parkedEdgeEvent(TASK, { requeue: true, reason: "orphaned" })).toBeNull();
    expect(parkedEdgeEvent(TASK, { requeue: true, parkState: "failed" })).toBeNull();
  });

  test("`requeue: !exhausted` — muto finché ci sono tentativi, parla all'ultimo", () => {
    const attempts = [false, false, true]; // exhausted al terzo
    const fired = attempts
      .map(exhausted => parkedEdgeEvent(TASK, { requeue: !exhausted, parkState: "failed" }))
      .filter(Boolean);
    expect(fired).toHaveLength(1);
  });

  test("parkState 'blocked' chiede un intervento, tutto il resto è un fallimento", () => {
    expect(parkedEdgeEvent(TASK, { requeue: false, parkState: "blocked" })?.state).toBe("blocked");
    expect(parkedEdgeEvent(TASK, { requeue: false, parkState: "failed" })?.state).toBe("failed");
    expect(parkedEdgeEvent(TASK, { requeue: false, parkState: null })?.state).toBe("failed");
    expect(parkedEdgeEvent(TASK, { requeue: false })?.state).toBe("failed");
  });

  test("parkState 'waited_out' ha uno stato SUO: non è un fallimento e non è un blocco", () => {
    // Il chiodo della copy: se questo tornasse 'failed' il banner direbbe «non
    // consegnato», se tornasse 'blocked' direbbe «da sistemare». Sono le due
    // etichette sbagliate per un turno che ha fatto la cosa giusta, cioè
    // dichiarare l'attesa invece di dormirci sopra.
    expect(parkedEdgeEvent(TASK, { requeue: false, parkState: "waited_out" })?.state).toBe("waited_out");
  });

  test("porta il reason quando c'è, e lo omette quando non c'è", () => {
    expect(parkedEdgeEvent(TASK, { requeue: false, reason: "max_turns" })?.reason).toBe("max_turns");
    expect(parkedEdgeEvent(TASK, { requeue: false })).not.toHaveProperty("reason");
  });

  test("titolo vuoto → fallback, mai una notifica senza testo", () => {
    expect(parkedEdgeEvent({ id: "t", projectId: "p", text: "" }, { requeue: false })?.taskTitle).toBe("Task");
    expect(parkedEdgeEvent({ id: "t", projectId: "p", text: null }, { requeue: false })?.taskTitle).toBe("Task");
    expect(parkedEdgeEvent({ id: "t", projectId: "p" }, { requeue: false })?.taskTitle).toBe("Task");
  });
});

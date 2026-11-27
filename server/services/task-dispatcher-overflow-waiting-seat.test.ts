/**
 * A node's free seat behind runs waiting on something external, and the remote
 * claim the CAS declines (card 4876378e, 26/11: nine cards pinned to a node
 * with free seats never started). Moved out of task-dispatcher-overflow.test.ts,
 * which sits at its check:bloat ceiling, onto the shared harness.
 * @covers KANBAN-76
 */
import { describe, expect, it } from "bun:test";
import { harness, PC, PID, settleTwoRounds } from "./task-dispatcher-overflow.harness";

describe("overflow: nodo con posti liberi dietro run in attesa esterna", () => {
  /** A real `in_progress` run on `machineId`, with a run open on the node but stuck on `waiting`. */
  function seedWaitingRun(h: ReturnType<typeof harness>, id: string, machineId: string) {
    const ts = new Date(h.now()).toISOString();
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts,
                          machine_id, dispatch_state, node_run_open, in_progress_at)
       VALUES (?, ?, 'in attesa esterna', 'nodo', 'in_progress', ?, ?, 1, ?, 'waiting', 1, ?)`,
      [id, PID, ts, ts, machineId, ts],
    );
  }

  it("4 posti, 3 run in attesa esterna, 9 card in coda: al giro dopo parte almeno una card sul posto libero", async () => {
    const h = harness({ floor: false, pcSlots: 4 });
    for (let i = 0; i < 3; i++) seedWaitingRun(h, `run-attesa-${i}`, PC);
    const queued = Array.from({ length: 9 }, (_, i) => `card-coda-${i}`);
    for (const id of queued) h.seed(id, { machineId: PC });
    await settleTwoRounds(h);

    // The 3 waiting runs hold 3 of 4 seats: one is free, and the pinned queue
    // takes it instead of sitting behind the waiting runs for ever.
    expect(h.created.length).toBeGreaterThan(0);
  });

  it("una card remota rifiutata dal CAS logga 'remote claim declined' UNA volta sola per episodio, non a ogni giro", async () => {
    const h = harness({ floor: false, pcSlots: 4 });
    h.seed("card-rifiutata", { machineId: PC });
    // The CAS itself refuses the claim (its own row guards: `blocked_by`, a
    // deferral still ahead, `scheduled_by`) - which tick's own pre-filters
    // normally mirror, so this forces the same `null` without needing to
    // reproduce the exact TOCTOU race that leaves them briefly out of step.
    const realClaim = h.svc.claim.bind(h.svc);
    h.svc.claim = (args) => (args.taskId === "card-rifiutata" && args.remote ? null : realClaim(args));

    await h.tick();
    await h.tick();
    await h.tick();

    const hits = h.logs.filter((l) => l.includes("remote claim declined") && l.includes("card-rifiutata"));
    expect(hits.length).toBe(1);

    // The reason goes on the card too, once per episode, not once per tick.
    const notes = h.svc.get("card-rifiutata")!.comments.filter((c) => c.content.includes("In coda sul nodo"));
    expect(notes.length).toBe(1);
    expect(notes[0].content).toContain("si risolve da solo al giro dopo");
  });
});

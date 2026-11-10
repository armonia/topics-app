/**
 * A CARD PARKED BY THE MACHINE GOES BACK BY ITSELF.
 *
 * 2026-11-10: 1dc60129 parked `waited_out` after 7 waits on a silent cloud
 * node, which came back soon after; the card sat in backlog for hours with
 * nobody requeueing it. A wait an agent declared stays with the human.
 *
 * @covers KANBAN-92
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { MACHINE_RETRY_CAP } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { PARKED_WAITED_OUT, WAIT_STREAK_CAP } from "../../shared/board";

const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const MIN = 60_000;

describe("rientro automatico delle card fermate dalla macchina", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  function parkBy(source: "machine" | "agent"): string {
    const t = s.create({ projectId: PID, text: "card sul nodo", status: "todo" });
    const ceiling = source === "machine" ? WAIT_STREAK_CAP : 1;
    for (let i = 0; i <= ceiling; i++) {
      s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
      s.deferForWait({ taskId: t.id, reason: "il nodo «cloud claude» non risponde", minutes: 1, by: "agent", source });
      clock.t += MIN;
    }
    expect(s.get(t.id)!.task.dispatchState).toBe(PARKED_WAITED_OUT);
    return t.id;
  }

  test("attesa di macchina: dopo 30 min torna in todo, col contatore azzerato", () => {
    const id = parkBy("machine");
    expect(s.sweepMachineWaitedOut()).toEqual([]);
    clock.t += 31 * MIN;
    expect(s.sweepMachineWaitedOut().map((t) => t.id)).toEqual([id]);
    const t = s.get(id)!.task;
    expect(t.status).toBe("todo");
    expect(t.dispatchState).toBeNull();
    expect(t.waitStreak).toBe(0);
    expect(s.sweepMachineWaitedOut()).toEqual([]);
  });

  test("attesa di un agente: resta all'umano", () => {
    const id = parkBy("agent");
    clock.t += 24 * 60 * MIN;
    expect(s.sweepMachineWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.status).toBe("backlog");
  });

  test("tetto: dopo MACHINE_RETRY_CAP giri resta in backlog", () => {
    const id = parkBy("machine");
    for (let n = 0; n < MACHINE_RETRY_CAP; n++) {
      clock.t += 30 * MIN * 2 ** n + MIN;
      expect(s.sweepMachineWaitedOut()).toHaveLength(1);
      // the node is still silent: it parks again
      for (let i = 0; i <= WAIT_STREAK_CAP; i++) {
        s.claim({ taskId: id, cap: 5, maxAttempts: 2 });
        s.deferForWait({ taskId: id, reason: "il nodo «cloud claude» non risponde", minutes: 1, by: "agent", source: "machine" });
        clock.t += MIN;
      }
      expect(s.get(id)!.task.status).toBe("backlog");
    }
    clock.t += 48 * 60 * MIN;
    expect(s.sweepMachineWaitedOut()).toEqual([]);
  });

  test("un gesto umano azzera il tetto", () => {
    const id = parkBy("machine");
    s.update({ taskId: id, actor: "human", by: "u", patch: { status: "todo" } });
    expect((db.prepare("SELECT auto_requeues, wait_source FROM tasks WHERE id = ?").get(id) as any))
      .toEqual({ auto_requeues: 0, wait_source: null });
  });
});

/**
 * THE FIVE LABELS THE BOARD EXECUTES ITSELF, out of the route that used to own
 * them. Picking one is an order to the system, so it runs as an UPDATE and
 * never as an agent turn - which is what matters now that the same buttons are
 * drawn under a card that is still working.
 * @covers KANBAN-19
 */
import { test, expect, describe } from "bun:test";
import { ARCHIVE_PARKED_LABEL, LAND_ACTION_LABEL, PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL, TAKE_OVER_PARKED_LABEL } from "../../shared/board";
import { interceptBoardAction, type BoardActionDeps } from "./board-actions";
import type { Task } from "./tasks";

function fakeTask(over: Partial<Task> = {}): Task {
  return { id: "t1", text: "una card", status: "review", createdAt: 1, updatedAt: 1, ...over } as unknown as Task;
}

type Harness = {
  deps: BoardActionDeps;
  events: unknown[];
  updates: unknown[];
  parked: unknown[];
  lands: string[];
  enteredTodo: string[];
};

function harness(over?: {
  parkedOutcome?: { task: Task; children: Task[] } | null;
  gate?: Response | null;
  task?: Task | null;
}): Harness {
  const events: unknown[] = [];
  const updates: unknown[] = [];
  const parked: unknown[] = [];
  const lands: string[] = [];
  const enteredTodo: string[] = [];
  const task = over?.task === undefined ? fakeTask() : over.task;
  const deps: BoardActionDeps = {
    svc: {
      get: () => (task ? { task } : null),
      update: (args) => { updates.push(args); return fakeTask({ status: "in_progress" }); },
      resolveParkedChildren: (args) => {
        parked.push(args);
        return over?.parkedOutcome === undefined
          ? { task: fakeTask({ status: "todo" }), children: [fakeTask({ id: "c1", status: "todo" })] }
          : over.parkedOutcome;
      },
    },
    dispatcher: { onEnterTodo: (_p, id) => { enteredTodo.push(id); } },
    broadcast: (e) => { events.push(e); },
    enqueueLand: (_p, id) => { lands.push(id); return { id: "ticket" }; },
    checksRedGate: () => over?.gate ?? null,
    json: (body, status) => new Response(JSON.stringify(body), { status: status ?? 200, headers: { "content-type": "application/json" } }),
    by: "user",
  };
  return { deps, events, updates, parked, lands, enteredTodo };
}

const target = { projectId: "p1", taskId: "t1" };

describe("interceptBoardAction", () => {
  test("un testo qualunque non e' un'azione: la rotta prosegue", () => {
    const h = harness();
    expect(interceptBoardAction(h.deps, target, "rifai la parte del composer")).toBeNull();
    expect(interceptBoardAction(h.deps, target, "")).toBeNull();
    expect(interceptBoardAction(h.deps, target, undefined)).toBeNull();
    expect(h.updates).toHaveLength(0);
    expect(h.lands).toHaveLength(0);
  });

  test("«serve a me»: la card passa a una persona, nessun figlio toccato", async () => {
    const h = harness();
    const res = interceptBoardAction(h.deps, target, TAKE_OVER_PARKED_LABEL);
    expect(res?.status).toBe(200);
    expect(h.updates).toEqual([{ taskId: "t1", actor: "human", by: "user", patch: { status: "in_progress", assignedTo: "user" } }]);
    expect(h.parked).toHaveLength(0);
    expect(h.events).toHaveLength(1);
    expect(await res!.json()).toMatchObject({ status: "in_progress" });
  });

  test("le tre risposte ai sottotask fermi arrivano al servizio con la loro decisione", () => {
    for (const [label, decision] of [
      [REQUEUE_PARKED_LABEL, "requeue"],
      [PROMOTE_PARKED_LABEL, "promote"],
      [ARCHIVE_PARKED_LABEL, "archive"],
    ] as const) {
      const h = harness();
      const res = interceptBoardAction(h.deps, target, label);
      expect(res?.status).toBe(200);
      expect(h.parked).toEqual([{ taskId: "t1", decision, by: "user" }]);
      // Parent plus every child: the drawer open on the parent has to see them move.
      expect(h.events).toHaveLength(2);
    }
  });

  test("promuovere e' METTERE IN CODA: anche i figli prendono un turno", () => {
    const h = harness();
    interceptBoardAction(h.deps, target, PROMOTE_PARKED_LABEL);
    expect(h.enteredTodo).toEqual(["t1", "c1"]);
  });

  test("rimettere in coda muove il padre, non i figli", () => {
    const h = harness();
    interceptBoardAction(h.deps, target, REQUEUE_PARKED_LABEL);
    expect(h.enteredTodo).toEqual(["t1"]);
  });

  test("nessun sottotask parcheggiato: 409, e nessuno inventa un esito", async () => {
    const h = harness({ parkedOutcome: null });
    const res = interceptBoardAction(h.deps, target, ARCHIVE_PARKED_LABEL);
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ code: "no_parked_children" });
    expect(h.events).toHaveLength(0);
  });

  test("«Landa su main»: passa dal cancello dei checks e mette in coda il land", async () => {
    const h = harness();
    const res = interceptBoardAction(h.deps, target, LAND_ACTION_LABEL);
    expect(res?.status).toBe(202);
    expect(h.lands).toEqual(["t1"]);
    expect(await res!.json()).toMatchObject({ landing: { id: "ticket" } });
  });

  test("checks rossi: il land NON parte e risponde il cancello", () => {
    const gate = new Response("{}", { status: 409 });
    const h = harness({ gate });
    const res = interceptBoardAction(h.deps, target, LAND_ACTION_LABEL);
    expect(res).toBe(gate);
    expect(h.lands).toHaveLength(0);
  });

  test("il task non esiste piu': 404 invece di un land al buio", async () => {
    const h = harness({ task: null });
    const res = interceptBoardAction(h.deps, target, LAND_ACTION_LABEL);
    expect(res?.status).toBe(404);
    expect(h.lands).toHaveLength(0);
    expect(await res!.json()).toMatchObject({ code: "not_found" });
  });
});

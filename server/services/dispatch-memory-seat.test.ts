/**
 * Local memory seat admission and reporting regressions.
 * @covers KANBAN-75
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import type { DispatcherDeps } from "./task-dispatcher";
import type { NodeRunReport } from "./node-client";
import type { TurnEndInfo } from "../providers/stop-reason";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTasksRouter } from "../routes/tasks";
import { call, makeCtx } from "../routes/tasks-test-support";
import { encodeMemoryQueueRef } from "./dispatch-memory-reference";
import { createDispatchMemoryStartController } from "./dispatch-memory-start";
import {
  addLocalReviewCheck, flush, PID, seedTodo, sharedWindowHarness,
  repeatMemoryReading, shutdownDispatchers,
} from "./dispatch-admission-parity-helpers";

const STATE_ROOT = testTmpDir("dispatch-memory-seat");
beforeAll(() => setupTestDataDir(`${STATE_ROOT}/data`));
afterAll(() => cleanupTestDataDir(STATE_ROOT));
afterEach(() => {
  setSystemTime();
  shutdownDispatchers();
});

function remoteNode(machineId: string): NonNullable<DispatcherDeps["node"]> {
  const report: NodeRunReport = {
    status: "in_progress",
    dispatchState: "working",
    dispatchError: null,
    comments: [],
    deliveryBranch: null,
    deliveryCommit: null,
    baseSha: null,
    stat: null,
  };
  return {
    createRun: async () => ({ runId: "remote-run" }),
    readRun: async () => report,
    fetchBundle: async () => ({ empty: true }),
    cancelRun: async () => {},
    baseUrlOf: (id) => id === machineId ? "https://node.local" : null,
    tokenOf: (id) => id === machineId ? "remote-token" : null,
    nameOf: () => "Remote machine",
    localMachineId: () => "local-machine",
    originUrlOf: async () => "git@github.com:acme/alpha.git",
    plantBranch: async () => ({ planted: true, commit: "abcdef123456", reason: null }),
  };
}

describe("the dispatch memory seat", () => {
  it("starts one checked-board card at 4.7 GB and publishes real queue positions", async () => {
    const boardId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const taskIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ];
    const updates: Parameters<NonNullable<DispatcherDeps["broadcast"]>>[0][] = [];
    const w = sharedWindowHarness("count", {
      checksRunning: () => 0,
      broadcast: (message) => updates.push(message),
      memoryReading: () => ({ freeGB: 4.7, at: Date.UTC(2026, 9, 26, 10, 0) }),
      memoryHistory: () => [{ at: Date.UTC(2026, 9, 26, 9, 59), freeGB: 4.8 }],
      memoryConsumers: () => [
        { label: "app Claude", gb: 2.3 },
        { label: "Jarvis", gb: 1.2 },
      ],
    });
    w.h.svc.updateBoardSettings(boardId, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, boardId);
    await w.beats(repeatMemoryReading(4.7, 14));
    expect(w.h.startedAt).toHaveLength(0);

    for (const id of taskIds) seedTodo(w.h.db, id, boardId);
    expect(w.h.dispatcher.isInFlight(taskIds[0]!)).toBe(false);
    await w.h.dispatcher.tick(boardId);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight(taskIds[0]!)).toBe(true);
    for (const id of taskIds.slice(1)) expect(w.h.status(id)).toBe("todo");
    const queueSnapshot = w.h.dispatcher.memoryQueueSnapshot();
    expect(queueSnapshot.queue.map(({ taskId, position, total }) => ({ taskId, position, total }))).toEqual([
      { taskId: encodeMemoryQueueRef(taskIds[1]!), position: 2, total: 4 },
      { taskId: encodeMemoryQueueRef(taskIds[2]!), position: 3, total: 4 },
      { taskId: encodeMemoryQueueRef(taskIds[3]!), position: 4, total: 4 },
    ]);
    const secondCardUpdate = updates
      .filter((message) => {
        if (message.type !== "task:updated") return false;
        return (message as unknown as { task: { id: string } }).task.id === taskIds[1];
      })
      .map((message) => message as unknown as { task: { id: string; dispatchQueue?: unknown } })
      .at(-1);
    const secondCardQueue = secondCardUpdate?.task.dispatchQueue ?? null;
    expect(secondCardQueue).toEqual({
      reason: "waiting-memory", position: 2, total: 4, costGB: 4,
    });
    w.h.db.run("UPDATE tasks SET text = ? WHERE id = ?", ["runtime nativo pavimento prezza 4.0 GB", taskIds[0]!]);
    const snapshot = w.h.dispatcher.memoryQueueSnapshot();

    const router = createTasksRouter(makeCtx(w.h.db, []), w.h.dispatcher);
    const response = await call(router, "GET", "/api/dispatch/memory-queue");
    expect(response?.status).toBe(200);
    const body = await response!.json() as typeof snapshot;
    expect(body).toEqual(snapshot);
    expect(body.reading.freeGB).toBe(4.7);
    expect(body.threshold).toEqual({ startGB: 14 });
    expect(body.consumers).toEqual([
      { label: "app Claude", gb: 2.3 },
      { label: "Jarvis", gb: 1.2 },
    ]);
    expect(Object.keys(body.threshold)).toEqual(["startGB"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/[0-9a-f]{8,}/);
    expect(serialized).not.toMatch(/runtime|pavimento|prezza|nativo/i);
    const details = await call(router, "GET", `/api/all-boards/tasks/${encodeMemoryQueueRef(taskIds[1]!)}`);
    expect(details?.status).toBe(200);
    expect((await details!.json() as { task: { id: string } }).task.id).toBe(taskIds[1]);
  });

  it("starts only the selected memory-waiting card for concurrent start-anyway calls", async () => {
    let freeGB = 4.7;
    const w = sharedWindowHarness("count", {
      checksRunning: () => 0,
      resourceBlock: () => freeGB < 10
        ? { reason: "memory hold", kind: "memory", memoryFirstCardExempt: false, startGB: 10 }
        : { reason: null, kind: null, memoryFirstCardExempt: false, startGB: 10 },
    });
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeatMemoryReading(4.7, 14));
    seedTodo(w.h.db, "anyway-peer");
    seedTodo(w.h.db, "anyway-selected");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(0);
    expect(w.h.svc.get("anyway-peer")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.svc.get("anyway-selected")?.task.dispatchError).toBe("waiting-memory");
    freeGB = 20;

    const router = createTasksRouter(makeCtx(w.h.db, []), w.h.dispatcher);
    const action = `/api/boards/${encodeMemoryQueueRef(PID)}/tasks/${encodeMemoryQueueRef("anyway-selected")}/start-anyway`;
    const results = await Promise.all([call(router, "POST", action), call(router, "POST", action)]);
    expect(results.map((response) => response?.status)).toEqual([202, 202]);
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight("anyway-selected")).toBe(true);
    expect(w.h.dispatcher.isInFlight("anyway-peer")).toBe(false);
    expect(w.h.commentsFor("anyway-selected")).toContain("Partita per scelta dell'utente.");
    expect(w.h.commentsFor("anyway-selected").filter((comment) => comment === "Partita per scelta dell'utente.")).toHaveLength(1);
    expect(w.h.status("anyway-peer")).toBe("todo");
    expect(w.h.svc.get("anyway-peer")?.task.dispatchError).toBe("waiting-memory");

    seedTodo(w.h.db, "not-memory-queued");
    expect(await w.h.dispatcher.startAnyway(PID, "not-memory-queued")).toEqual({
      ok: false,
      code: "not_memory_queued",
    });
    expect(w.h.startedAt).toHaveLength(1);
  });

  it("coalesces overlapping start-anyway calls into one dispatcher run", async () => {
    let inFlight = false;
    let dispatchCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = { id: "coalesced-start", projectId: PID, status: "todo" } as import("./tasks").Task;
    const controller = createDispatchMemoryStartController({
      getTask: () => task,
      isInFlight: () => inFlight,
      isRemoteTask: () => false,
      isMemoryWaiter: () => true,
      localMemorySeatTaken: () => false,
      checksRunning: () => 0,
      dispatch: async () => {
        dispatchCalls += 1;
        await gate;
        task.status = "in_progress";
        inFlight = true;
      },
      notifyQueue: () => {},
    });

    const first = controller.startAnyway(PID, task.id);
    const second = controller.startAnyway(PID, task.id);
    await flush();
    release();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(dispatchCalls).toBe(1);
  });

  it("allows start-anyway for the selected heavy memory waiter", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 0 });
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeatMemoryReading(4.7, 14));
    seedTodo(w.h.db, "heavy-anyway");
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = 'heavy-anyway'");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(0);
    expect(w.h.svc.get("heavy-anyway")?.task.dispatchError).toBe("waiting-memory");
    seedTodo(w.h.db, "heavy-peer");

    expect(await w.h.dispatcher.startAnyway(PID, "heavy-anyway")).toEqual({ ok: true });
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight("heavy-anyway")).toBe(true);
    expect(w.h.dispatcher.isInFlight("heavy-peer")).toBe(false);
  });

  it("keeps GET snapshots from clearing a live reservation", async () => {
    let finish: ((end?: TurnEndInfo) => void) | undefined;
    const w = sharedWindowHarness("count", {
      checksRunning: () => 1,
      runTurn: () => new Promise<TurnEndInfo | void>((resolve) => { finish = resolve; }),
    });
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "live-reservation");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.attempts.getNoLocalChecksReservation?.("live-reservation")).toBe(1);

    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = 'live-reservation'");
    const router = createTasksRouter(makeCtx(w.h.db, []), w.h.dispatcher);
    const response = await call(router, "GET", "/api/dispatch/memory-queue");
    expect(response?.status).toBe(200);
    expect(w.h.dispatcher.memoryQueueSnapshot().running[0]?.weightGB).toBe(4);
    expect(w.h.attempts.getNoLocalChecksReservation?.("live-reservation")).toBe(1);

    await w.h.dispatcher.tick(PID);
    expect(w.h.attempts.getNoLocalChecksReservation?.("live-reservation")).toBeNull();
    finish?.({ end: "end_turn" });
    await flush(30);
  });

  it("does not let a remote run occupy the local memory seat", async () => {
    const machineId = "remote-node";
    const w = sharedWindowHarness("count", {
      checksRunning: () => 0,
      node: remoteNode(machineId),
    });
    addLocalReviewCheck(w.h.svc);
    w.h.db.run("INSERT INTO machines (id) VALUES (?)", [machineId]);
    await w.beats(repeatMemoryReading(4.7, 14));
    seedTodo(w.h.db, "remote-seat");
    w.h.db.run("UPDATE tasks SET machine_id = ? WHERE id = ?", [machineId, "remote-seat"]);
    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.dispatcher.isInFlight("remote-seat")).toBe(true);
    expect(w.h.startedAt).toHaveLength(0);
    seedTodo(w.h.db, "local-seat");
    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.dispatcher.isInFlight("local-seat")).toBe(true);
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.memoryQueueSnapshot().running.map((task) => task.taskId)).toEqual([encodeMemoryQueueRef("local-seat")]);
  });

  it("keeps the seat until a manually closed card's live turn ends", async () => {
    let finish: ((end?: TurnEndInfo) => void) | undefined;
    const w = sharedWindowHarness("count", {
      checksRunning: () => 1,
      runTurn: () => new Promise<TurnEndInfo | void>((resolve) => { finish = resolve; }),
    });
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "closed-live-turn");
    seedTodo(w.h.db, "waiting-for-live-turn");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("closed-live-turn")).toBe(1);

    w.h.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = ?", ["closed-live-turn"]);
    w.h.dispatcher.onBlockerDone("closed-live-turn");
    expect(w.h.dispatcher.isInFlight("closed-live-turn")).toBe(true);
    expect(w.h.attempts.getNoLocalChecksReservation?.("closed-live-turn")).toBe(1);
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.status("waiting-for-live-turn")).toBe("todo");

    finish!({ end: "end_turn" });
    await flush(30);
    expect(w.h.dispatcher.isInFlight("closed-live-turn")).toBe(false);
    expect(w.h.attempts.getNoLocalChecksReservation?.("closed-live-turn")).toBeNull();
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(2);
    expect(w.h.dispatcher.isInFlight("waiting-for-live-turn")).toBe(true);
  });

  it("reports the measured 6.5 GB reading without subtracting an occupied reservation", async () => {
    let reading = 4.8;
    const w = sharedWindowHarness("count", {
      checksRunning: () => 1,
      heldMemory: () => ({ measurable: true, latestGB: 6.5, heldGB: 5.5, coveredMs: 120_000 }),
      memoryReading: () => ({ freeGB: reading, at: Date.UTC(2026, 9, 26, 10, 0) }),
    });
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "reading-seat");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.attempts.getNoLocalChecksReservation?.("reading-seat")).toBe(1);

    reading = 6.5;
    await w.beats(repeatMemoryReading(6.5, 14));
    const snapshot = w.h.dispatcher.memoryQueueSnapshot();
    expect(snapshot.reading.freeGB).toBe(6.5);
    expect(Object.keys(snapshot.threshold)).toEqual(["startGB"]);
    expect(JSON.stringify(snapshot)).not.toContain("5.5");
  });

  it("does not use the idle first-card exception for a heavy task", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 0 });
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeatMemoryReading(4.7, 14));
    seedTodo(w.h.db, "heavy-idle");
    seedTodo(w.h.db, "light-after-heavy");
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = ?", ["heavy-idle"]);
    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight("light-after-heavy")).toBe(true);
    expect(w.h.status("heavy-idle")).toBe("todo");
    expect(w.h.svc.get("heavy-idle")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.attempts.getNoLocalChecksReservation?.("heavy-idle")).toBeNull();
  });

  it("releases the seat when the claim throws because the card was deleted", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 0 });
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeatMemoryReading(4.7, 14));
    seedTodo(w.h.db, "deleted-before-claim");
    seedTodo(w.h.db, "memory-waiter");
    w.h.db.run(
      "UPDATE tasks SET dispatch_state = 'queued', dispatch_error = 'waiting-memory' WHERE id = ?",
      ["memory-waiter"],
    );
    const claim = w.h.svc.claim.bind(w.h.svc);
    w.h.svc.claim = (input) => {
      if (input.taskId === "deleted-before-claim") w.h.db.run("DELETE FROM tasks WHERE id = ?", [input.taskId]);
      return claim(input);
    };

    await expect(w.h.dispatcher.tick(PID)).rejects.toThrow("not found");
    expect(w.h.startedAt).toHaveLength(0);

    // No tick in between: the seat must already be free when the claim threw.
    expect(await w.h.dispatcher.startAnyway(PID, "memory-waiter")).toEqual({ ok: true });
    await flush();
    expect(w.h.dispatcher.isInFlight("memory-waiter")).toBe(true);
  });

  it("after a claim that threw on a deleted card, the next tick starts another local card", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 0 });
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeatMemoryReading(4.7, 14));
    seedTodo(w.h.db, "deleted-before-claim");
    const claim = w.h.svc.claim.bind(w.h.svc);
    w.h.svc.claim = (input) => {
      if (input.taskId === "deleted-before-claim") w.h.db.run("DELETE FROM tasks WHERE id = ?", [input.taskId]);
      return claim(input);
    };
    await expect(w.h.dispatcher.tick(PID)).rejects.toThrow("not found");

    seedTodo(w.h.db, "next-local-card");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight("next-local-card")).toBe(true);
  });

  it("releases a light-card seat when its live task becomes heavy", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 1 });
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "light-to-heavy");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.dispatcher.isInFlight("light-to-heavy")).toBe(true);
    expect(w.h.attempts.getNoLocalChecksReservation?.("light-to-heavy")).toBe(1);

    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = ?", ["light-to-heavy"]);
    await w.h.dispatcher.tick(PID);

    expect(w.h.dispatcher.isInFlight("light-to-heavy")).toBe(true);
    expect(w.h.attempts.getNoLocalChecksReservation?.("light-to-heavy")).toBeNull();
    expect(w.h.dispatcher.memoryQueueSnapshot().running.find((task) => task.taskId === encodeMemoryQueueRef("light-to-heavy"))?.weightGB).toBeGreaterThan(1);
  });
});

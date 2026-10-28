/**
 * Read-only memory queue access and the card-scoped manual dispatch action.
 * @covers KANBAN-97
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import type { DispatchMemoryQueueSnapshot } from "../../shared/board";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx } from "./tasks-test-support";

const PROJECT_ID = "board-a";
const SNAPSHOT: DispatchMemoryQueueSnapshot = {
  reading: { freeGB: 4.7, at: "2026-10-26T10:00:00.000Z" },
  threshold: { startGB: 10 },
  queue: [{ taskId: "task-a", boardId: PROJECT_ID, reason: "waiting-memory", position: 1, total: 2, costGB: 4 }],
  running: [{ taskId: "task-live", title: "running task", weightGB: 2 }],
  consumers: [{ label: "app Claude", gb: 2.3 }],
  history: [{ at: "2026-10-26T09:59:00.000Z", freeGB: 4.8 }],
};

function dispatcher(overrides: Record<string, unknown> = {}) {
  return {
    memoryQueueSnapshot: () => SNAPSHOT,
    startAnyway: async () => ({ ok: true }),
    onEnterTodo() {},
    ...overrides,
  } as any;
}

async function createCard(router: ReturnType<typeof createTasksRouter>): Promise<string> {
  const response = await call(router, "POST", `/api/boards/${PROJECT_ID}/tasks`, { text: "memory waiter" });
  expect(response?.status).toBe(201);
  return (await response!.json() as { id: string }).id;
}

describe("dispatch memory queue routes", () => {
  test("returns the dispatcher's read-only snapshot", async () => {
    const db = freshDb();
    const router = createTasksRouter(makeCtx(db, []), dispatcher());

    const response = await call(router, "GET", "/api/dispatch/memory-queue");

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(SNAPSHOT);
    const serialized = JSON.stringify(SNAPSHOT);
    expect(serialized).not.toMatch(/[0-9a-f]{8,}/i);
    expect(serialized).not.toMatch(/runtime|pavimento|prezza|nativo/i);
    db.close();
  });

  test("does not expose machine-wide queue data to guests", async () => {
    const db = freshDb();
    const ctx = {
      ...makeCtx(db, []),
      requestIdentity: () => ({ role: "guest", deviceId: "guest-device" }),
    } as unknown as AppContext;
    const router = createTasksRouter(ctx, dispatcher());

    const response = await call(router, "GET", "/api/dispatch/memory-queue");

    expect(response?.status).toBe(403);
    expect(await response!.json()).toMatchObject({ code: "guest_forbidden" });
    db.close();
  });

  test("starts only the requested card and leaves one service note across retries", async () => {
    const db = freshDb();
    const broadcasts: unknown[] = [];
    const starts: Array<[string, string]> = [];
    const run = dispatcher({
      startAnyway: async (projectId: string, taskId: string) => {
        starts.push([projectId, taskId]);
        return { ok: true };
      },
    });
    const router = createTasksRouter(makeCtx(db, broadcasts), run);
    const taskId = await createCard(router);
    db.prepare("UPDATE tasks SET dispatch_state = 'queued', dispatch_error = 'waiting-memory' WHERE id = ?").run(taskId);
    const path = `/api/boards/${PROJECT_ID}/tasks/${taskId}/start-anyway`;

    const startedAt = Date.now();
    const responses: Awaited<ReturnType<typeof call>>[] = [];
    try {
      responses.push(...await Promise.all([
        call(router, "POST", path),
        call(router, "POST", path),
      ]));
      setSystemTime(new Date(startedAt + 25 * 60 * 60 * 1000));
      responses.push(await call(router, "POST", path));
    } finally {
      setSystemTime();
    }

    expect(responses.map((response) => response?.status)).toEqual([202, 202, 202]);
    expect(starts).toEqual([[PROJECT_ID, taskId], [PROJECT_ID, taskId], [PROJECT_ID, taskId]]);
    expect(db.query("SELECT content FROM task_comments WHERE task_id = ?").all(taskId)).toEqual([
      { content: "Partita per scelta dell'utente." },
    ]);
    expect(broadcasts.filter((event) => (event as { type?: string }).type === "task:updated")).toHaveLength(3);
    db.close();
  });

  test("maps a card that is no longer waiting on memory to 409 without a note", async () => {
    const db = freshDb();
    let startCalls = 0;
    const run = dispatcher({
      startAnyway: async () => {
        startCalls++;
        return { ok: false, code: "not_waiting_for_memory" };
      },
    });
    const router = createTasksRouter(makeCtx(db, []), run);
    const taskId = await createCard(router);

    const response = await call(router, "POST", `/api/boards/${PROJECT_ID}/tasks/${taskId}/start-anyway`);

    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: "not_waiting_for_memory" });
    expect(startCalls).toBe(1);
    expect(db.query("SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?").get(taskId)).toEqual({ count: 0 });
    db.close();
  });

  test("returns 404 for a missing task before asking the dispatcher to start it", async () => {
    const db = freshDb();
    let startCalls = 0;
    const router = createTasksRouter(makeCtx(db, []), dispatcher({
      startAnyway: async () => { startCalls++; return { ok: true }; },
    }));

    const response = await call(router, "POST", `/api/boards/${PROJECT_ID}/tasks/missing/start-anyway`);

    expect(response?.status).toBe(404);
    expect(startCalls).toBe(0);
    db.close();
  });
});

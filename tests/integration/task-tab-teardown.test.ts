/**
 * Archiviare un task porta via le sue tab — misurato sulla CATENA, non sul pezzo.
 *
 * PERCHÉ ESISTE. `task-tab-teardown.test.ts` prova il servizio da solo, ma il
 * buco che stiamo tappando vive fra i due router: chi scrive il record è
 * `POST /api/topics/:id/browser/open-pane` (routes/topics.ts → task-tab-persist),
 * chi dovrebbe cancellarlo è `DELETE /api/boards/:p/tasks/:id` (routes/tasks.ts),
 * e finché quel secondo pezzo non chiamava nessuno le due chiavi restavano lì
 * per sempre — su ogni `ui-state:init`, a ogni riconnessione di ogni client.
 *
 * Qui si semina come lo semina l'agente (nessun client in ascolto, il server
 * scrive da sé), si archivia come archivia la board, e si guarda il db.
 *
 * @covers RETIRE-07
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";
import { teardownArchivedTaskBrowserState } from "../../server/services/task-tab-teardown";
import { ARCHIVE_PARKED_LABEL } from "../../shared/board";

const TEST_ROOT = testTmpDir("task-tab-teardown");
const TEST_DATA = path.join(TEST_ROOT, "data");
const PROJ = "proj-task-teardown";

let ctx: AppContext;
let broadcasts: any[] = [];
let destroyed: string[] = [];
let topicsRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;
let tasksRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

async function call(
  router: typeof topicsRouter,
  path: string,
  method: string,
  body?: object,
): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`nessuna route per ${method} ${path}`);
  return res;
}

function uiKeys(taskId: string): string[] {
  return (
    ctx.db
      .query("SELECT key FROM ui_state WHERE key LIKE ? OR key LIKE ? ORDER BY key")
      .all(`task-browser-tabs:${taskId}`, `task-browser-layout:${taskId}`) as { key: string }[]
  ).map((r) => r.key);
}

/** Un task dispatchato col suo topic, come lo lascia il dispatcher. */
async function seedTask(taskId: string, name: string, parentId?: string): Promise<string> {
  const res = await call(topicsRouter, "/api/topics", "POST", { name, projectPath: "/tmp/proj-task-teardown" });
  expect(res.status).toBe(201);
  const topic = (await res.json()) as { id: string };
  const nowIso = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, parent_task_id)
       VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?)`,
    )
    .run(taskId, PROJ, `Task ${taskId}`, nowIso, nowIso, topic.id, parentId ?? null);
  return topic.id;
}

/** Il layout del workspace del task, come lo scriverebbe un client che lo apre. */
function seedLayout(taskId: string, paneId: string): void {
  ctx.db.run(
    "INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, 99)",
    [`task-browser-layout:${taskId}`, JSON.stringify({ groups: [{ id: "g1", paneIds: [paneId] }], rows: [], rowHeights: [], focusedGroupId: "g1" })],
  );
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";

  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (msg: object) => void }).broadcastToAll = (msg) => { broadcasts.push(msg); };

  const { createTopicsRouter } = await import("../../server/routes/topics");
  const { createTasksRouter } = await import("../../server/routes/tasks");
  topicsRouter = createTopicsRouter(ctx, {} as any) as typeof topicsRouter;
  // Wiring IDENTICO a server.ts: è il punto della prova.
  tasksRouter = createTasksRouter(ctx, undefined, {
    teardownTaskBrowserState: (taskId) =>
      teardownArchivedTaskBrowserState(
        {
          db: ctx.db,
          broadcastToAll: ctx.broadcastToAll,
          destroyContext: async (contextId) => { destroyed.push(contextId); },
        },
        taskId,
      ),
  }) as typeof tasksRouter;
}, 30_000);

afterAll(async () => {
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("DELETE di un task: le sue tab se ne vanno con lui", () => {
  test("le due chiavi ui_state spariscono, i contesti vengono rilasciati, il frame porta gli id", async () => {
    const topicId = await seedTask("task-td-1", "Consegna 1");
    // Come l'agente: nessun client in ascolto, il record lo scrive il server.
    await call(topicsRouter, `/api/topics/${topicId}/browser/open-pane`, "POST", { url: "http://localhost:3500/report" });
    const ctxId = JSON.parse(
      (ctx.db.query("SELECT value FROM ui_state WHERE key = ?").get("task-browser-tabs:task-td-1") as { value: string }).value,
    ).tabs[0].contextId as string;
    seedLayout("task-td-1", `browser:${ctxId}`);
    expect(uiKeys("task-td-1")).toEqual(["task-browser-layout:task-td-1", "task-browser-tabs:task-td-1"]);

    broadcasts = [];
    destroyed = [];
    const res = await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-1`, "DELETE");
    expect(res.status).toBe(200);

    // 1. il registro che viaggia a ogni riconnessione non le porta più
    expect(uiKeys("task-td-1")).toEqual([]);
    // 2. il contesto headless e il suo gemello nel workspace sono chiusi
    expect(destroyed).toEqual([ctxId, `${ctxId}_ws`]);
    expect(broadcasts.filter((b) => b?.type === "browser:close-pane").map((b) => b.contextId))
      .toEqual([ctxId, `${ctxId}_ws`]);
    // 3. il frame dice al client quali chiavi dimenticare
    const deleted = broadcasts.find((b) => b?.type === "task:deleted");
    expect(deleted.taskIds).toEqual(["task-td-1"]);
  });

  test("archiviare il padre porta via anche le tab dei figli (cascata)", async () => {
    const padreTopic = await seedTask("task-td-padre", "Padre");
    const childTopic = await seedTask("task-td-figlio", "Figlio", "task-td-padre");
    await call(topicsRouter, `/api/topics/${padreTopic}/browser/open-pane`, "POST", { url: "http://localhost:3501/p" });
    await call(topicsRouter, `/api/topics/${childTopic}/browser/open-pane`, "POST", { url: "http://localhost:3501/f" });
    seedLayout("task-td-figlio", "thread:qualcosa");
    expect(uiKeys("task-td-figlio")).toHaveLength(2);

    broadcasts = [];
    await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-padre`, "DELETE");

    expect(uiKeys("task-td-padre")).toEqual([]);
    expect(uiKeys("task-td-figlio")).toEqual([]);
    const deleted = broadcasts.find((b) => b?.type === "task:deleted");
    expect([...deleted.taskIds].sort()).toEqual(["task-td-figlio", "task-td-padre"]);
  });

  test("un task VIVO accanto non perde niente (si archivia solo chi è archiviato)", async () => {
    const aliveTopic = await seedTask("task-td-vivo", "Resta");
    const deadTopic = await seedTask("task-td-morto", "Va via");
    await call(topicsRouter, `/api/topics/${aliveTopic}/browser/open-pane`, "POST", { url: "http://localhost:3502/vivo" });
    await call(topicsRouter, `/api/topics/${deadTopic}/browser/open-pane`, "POST", { url: "http://localhost:3502/morto" });

    await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-morto`, "DELETE");

    expect(uiKeys("task-td-morto")).toEqual([]);
    expect(uiKeys("task-td-vivo")).toEqual(["task-browser-tabs:task-td-vivo"]);
  });

  test("fondere una card la archivia: le sue tab se ne vanno, quelle della superstite e dei figli restano", async () => {
    // A card being merged has no live agent (`merge` refuses one), so no
    // topic: the row and its tabs are seeded the way a finished turn leaves them.
    const nowIso = new Date().toISOString();
    const insert = ctx.db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, parent_task_id)
       VALUES (?, ?, ?, 'review', ?, ?, ?)`,
    );
    insert.run("task-td-fusa", PROJ, "Fusa", nowIso, nowIso, null);
    insert.run("task-td-superstite", PROJ, "Superstite", nowIso, nowIso, null);
    insert.run("task-td-figlio-fusa", PROJ, "Figlio della fusa", nowIso, nowIso, "task-td-fusa");
    const seedTabs = (taskId: string, contextId: string) =>
      ctx.db.run(
        "INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, 99)",
        [`task-browser-tabs:${taskId}`, JSON.stringify({ tabs: [{ contextId, url: "http://localhost:3504/", title: "", seq: 0 }] })],
      );
    seedTabs("task-td-fusa", "ctx-fusa");
    seedLayout("task-td-fusa", "browser:ctx-fusa");
    seedTabs("task-td-superstite", "ctx-superstite");
    seedTabs("task-td-figlio-fusa", "ctx-figlio-fusa");

    broadcasts = [];
    destroyed = [];
    const res = await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-fusa/merge`, "POST", { intoTaskId: "task-td-superstite" });
    expect(res.status).toBe(200);

    expect(uiKeys("task-td-fusa")).toEqual([]);
    expect(destroyed).toEqual(["ctx-fusa", "ctx-fusa_ws"]);
    // The child moved under the survivor, ALIVE: its tabs are still its own.
    expect(uiKeys("task-td-figlio-fusa")).toEqual(["task-browser-tabs:task-td-figlio-fusa"]);
    expect(uiKeys("task-td-superstite")).toEqual(["task-browser-tabs:task-td-superstite"]);
    const deleted = broadcasts.find((b) => b?.type === "task:deleted");
    expect(deleted.taskIds).toEqual(["task-td-fusa"]);
  });

  test("«archivia» sui sottotask parcheggiati: le tab dei figli archiviati se ne vanno, quelle del padre restano", async () => {
    const nowIso = new Date().toISOString();
    const insert = ctx.db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, parent_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("task-td-padre-fermo", PROJ, "Padre fermo", "review", nowIso, nowIso, null);
    insert.run("task-td-figlio-fermo", PROJ, "Figlio fermo", "backlog", nowIso, nowIso, "task-td-padre-fermo");
    for (const [taskId, contextId] of [["task-td-padre-fermo", "ctx-padre-fermo"], ["task-td-figlio-fermo", "ctx-figlio-fermo"]]) {
      ctx.db.run(
        "INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, 99)",
        [`task-browser-tabs:${taskId}`, JSON.stringify({ tabs: [{ contextId, url: "http://localhost:3505/", title: "", seq: 0 }] })],
      );
    }

    broadcasts = [];
    destroyed = [];
    const res = await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-padre-fermo/comments`, "POST", { content: ARCHIVE_PARKED_LABEL });
    expect(res.status).toBe(200);

    expect(uiKeys("task-td-figlio-fermo")).toEqual([]);
    expect(destroyed).toEqual(["ctx-figlio-fermo", "ctx-figlio-fermo_ws"]);
    expect(uiKeys("task-td-padre-fermo")).toEqual(["task-browser-tabs:task-td-padre-fermo"]);
    const deleted = broadcasts.filter((b) => b?.type === "task:deleted");
    expect(deleted.map((d) => d.taskIds)).toEqual([["task-td-figlio-fermo"]]);
  });

  test("un secondo DELETE non esplode e non chiude niente due volte", async () => {
    const topicId = await seedTask("task-td-bis", "Due volte");
    await call(topicsRouter, `/api/topics/${topicId}/browser/open-pane`, "POST", { url: "http://localhost:3503/" });
    await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-bis`, "DELETE");

    destroyed = [];
    const res = await call(tasksRouter, `/api/boards/${PROJ}/tasks/task-td-bis`, "DELETE");
    expect(res.status).toBe(200);
    expect(destroyed).toEqual([]);
    expect(uiKeys("task-td-bis")).toEqual([]);
  });
});

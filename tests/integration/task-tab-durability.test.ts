/**
 * La tab che l'agente apre su un task dispatchato deve esistere ANCHE se in quel
 * momento non c'è nessuna finestra Topics aperta.
 *
 * PERCHÉ ESISTE. Nel modello di consegna «tab nel workspace + lista scaricabili»
 * la tab È il risultato del task. Ma il fork task-owned in `routes/topics.ts` si
 * limitava a `broadcastToAll({type:"browser:open-task-tab"})`, e l'UNICO
 * scrittore del record `task-browser-tabs:<taskId>` era il client
 * (`useTaskBrowserTabsSync` → PUT /api/ui-state). Un dispatch gira in
 * background, spesso a app chiusa: nessun client connesso ⇒ nessuno consuma il
 * broadcast ⇒ la tab non veniva MAI scritta, e il task arrivava in review senza
 * il suo risultato. Il pezzo puro ha il suo test (`task-tab-persist.test.ts`);
 * qui si misura la CATENA — route → servizio → ui_state — che è dove il buco
 * viveva, e con ZERO client in ascolto (i broadcast finiscono in un array e
 * nessuno li applica: esattamente lo scenario ad app chiusa).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("task-tab-durability");
const TEST_DATA = path.join(TEST_ROOT, "data");

let ctx: AppContext;
let broadcasts: any[] = [];
let topicsRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

async function callTopics(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await topicsRouter(req, url, url.pathname, method);
  if (!res) throw new Error(`nessuna route per ${method} ${path}`);
  return res;
}

/** Il record ui_state delle tab di un task, come lo leggerebbe il client. */
function storedTabs(taskId: string): { tabs: any[]; activeContextId: string | null; nextSeq: number } | null {
  const row = ctx.db.query("SELECT value FROM ui_state WHERE key = ?")
    .get(`task-browser-tabs:${taskId}`) as { value: string } | null;
  return row ? JSON.parse(row.value) : null;
}

/** Un topic di dispatch legato a un task, come lo lascia il dispatcher. */
async function seedDispatchedTask(taskId: string, name: string): Promise<{ topicId: string }> {
  const res = await callTopics("/api/topics", "POST", { name, projectPath: "/tmp/proj-task-tabs" });
  expect(res.status).toBe(201);
  const topic = (await res.json()) as { id: string };
  const nowIso = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id)
     VALUES (?, 'proj-task-tabs', ?, 'in_progress', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, nowIso, nowIso, topic.id);
  return { topicId: topic.id };
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  // Il bridge PTY non c'entra con questa catena: spento, o il router terminali
  // proverebbe a connettersi e il rosso parlerebbe d'altro.
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";

  ctx = await createTestAppContext();
  broadcasts = [];
  (ctx as { broadcastToAll: (msg: object) => void }).broadcastToAll = (msg) => { broadcasts.push(msg); };

  const { createTopicsRouter } = await import("../../server/routes/topics");
  // Un browserService finto e basta truthy: il ramo task-owned esce PRIMA di
  // usarlo (broadcast + return, niente Playwright headless — vedi il commento
  // nel route: la pane può essere smontata).
  const fakeBrowserService = {} as any;
  topicsRouter = createTopicsRouter(ctx, fakeBrowserService) as typeof topicsRouter;
}, 30_000);

afterAll(async () => {
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("open-pane di un agente su un task: la tab sopravvive senza client", () => {
  test("scrive task-browser-tabs:<id> pur con ZERO client in ascolto", async () => {
    const { topicId } = await seedDispatchedTask("task-dur-1", "Dispatch 1");
    broadcasts = [];

    const res = await callTopics(`/api/topics/${topicId}/browser/open-pane`, "POST", {
      url: "http://localhost:3400/report",
    });
    expect(res.status).toBe(200);

    // Il record c'è: nessun client l'ha scritto, l'ha scritto il server.
    const stored = storedTabs("task-dur-1");
    expect(stored).not.toBeNull();
    expect(stored!.tabs).toHaveLength(1);
    expect(stored!.tabs[0].url).toBe("http://localhost:3400/report");
    expect(stored!.tabs[0].contextId).toBe(stored!.activeContextId);
    // contextId canonico task-owned (`task-<id8>-a<topic8>`): è quello che il
    // client riconosce come tab DEL TASK e che tiene fuori dal pane-store.
    expect(stored!.tabs[0].contextId).toMatch(/^task-[0-9a-z-]{8}-a/);
  });

  test("annuncia sia l'apertura sia l'aggiornamento di ui-state (chi è connesso vede subito)", async () => {
    const { topicId } = await seedDispatchedTask("task-dur-2", "Dispatch 2");
    broadcasts = [];

    await callTopics(`/api/topics/${topicId}/browser/open-pane`, "POST", { url: "http://localhost:3401/" });

    const uiFrame = broadcasts.find((m) => m?.type === "ui-state:updated" && m.key === "task-browser-tabs:task-dur-2");
    const openFrame = broadcasts.find((m) => m?.type === "browser:open-task-tab");
    expect(uiFrame).toBeDefined();
    expect(openFrame).toBeDefined();
    expect(openFrame.taskId).toBe("task-dur-2");
    // Nessun sourceClientId: la scrittura non appartiene a nessun client, quindi
    // TUTTI devono applicarla (il bridge scarta solo l'eco del proprio id).
    expect(uiFrame.sourceClientId).toBeUndefined();
    // L'ui-state arriva PRIMA dell'apertura: chi è connesso non può vedere la
    // tab annunciata e poi trovarsi il record vecchio.
    expect(broadcasts.indexOf(uiFrame)).toBeLessThan(broadcasts.indexOf(openFrame));
  });

  test("due aperture sullo stesso task NON duplicano la tab (stesso ctx per topic)", async () => {
    const { topicId } = await seedDispatchedTask("task-dur-3", "Dispatch 3");

    await callTopics(`/api/topics/${topicId}/browser/open-pane`, "POST", { url: "http://localhost:3402/a" });
    await callTopics(`/api/topics/${topicId}/browser/open-pane`, "POST", { url: "http://localhost:3402/b" });

    const stored = storedTabs("task-dur-3")!;
    expect(stored.tabs).toHaveLength(1);
    expect(stored.tabs[0].url).toBe("http://localhost:3402/b");
  });

  test("un topic NON legato a un task non scrive nessun record di tab", async () => {
    const res = await callTopics("/api/topics", "POST", { name: "Chat libera", projectPath: "/tmp/proj-task-tabs" });
    const topic = (await res.json()) as { id: string };
    broadcasts = [];

    await callTopics(`/api/topics/${topic.id}/browser/open-pane`, "POST", { url: "http://localhost:3403/" });

    const anyTaskKey = ctx.db.query(
      "SELECT COUNT(*) AS n FROM ui_state WHERE key LIKE 'task-browser-tabs:%'",
    ).get() as { n: number };
    // Solo i tre task seminati sopra, nessuno in più: la chat normale passa dal
    // path `browser:navigate` di sempre.
    expect(anyTaskKey.n).toBe(3);
    expect(broadcasts.some((m) => m?.type === "browser:open-task-tab")).toBe(false);
  });
});

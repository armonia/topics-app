/**
 * notification-history.spec.ts — «CRONOLOGIA», la linguetta della inbox.
 *
 * Fino a notifications-redesign questa spec misurava il tastino della
 * cronologia, che CONTAVA righe e le segnava viste all'apertura. Il tastino
 * ora è «Da guardare» (ATTN-09): conta soggetti accesi e aprirlo non segna
 * niente. La cronologia resta, come seconda linguetta, in sola lettura. Le
 * prove di prima, una per una:
 *   NH-01  una riga registrata con l'app aperta arriva nella cronologia da
 *          sola (fronte WS, nessun refresh) e il clic porta sulla cosa che
 *          l'ha generata. Il numero del tasto NON sale: una riga non è una
 *          cosa accesa.
 *   NH-02  aprire la cronologia non segna niente: le righe non viste restano
 *          non viste sul server, anche dopo un ricaricamento.
 *   NH-04  due mittenti dello stesso evento fanno una riga sola.
 *   NH-06  oltre la prima pagina: il registro non finisce alla cinquantesima.
 * NH-03 (un gruppo visto una volta) e NH-05 (un fronte in ritardo non
 * riaccende il numero) misuravano il numero fatto di righe, che non esiste
 * più: i loro gemelli sul numero nuovo sono `attention-sync.spec.ts` (un
 * visto vale per il soggetto ovunque, anche dopo ricarico e riconnessione) e
 * `attention-inbox.spec.ts` (aprire non spegne).
 *
 * Il registro si semina dalla sua rotta pubblica (`POST /api/notifications`):
 * seminare scrivendo in tabella proverebbe la tabella, non la catena.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-notif-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
let taskId = "";

async function postNotification(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ recorded: boolean; unseen: number }> {
  const res = await request.post(`${BASE}/api/notifications`, { data: body });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { recorded: boolean; unseen: number };
}

async function unseenRows(request: APIRequestContext): Promise<number> {
  return ((await (await request.get(`${BASE}/api/notifications`)).json()) as { unseen: number }).unseen;
}

/** Il registro riparte senza righe non viste: non c'è (di proposito) una rotta che lo cancella. */
async function wipeRegistry(request: APIRequestContext): Promise<void> {
  await request.post(`${BASE}/api/notifications/seen`, { data: { upTo: new Date().toISOString() } });
}

const button = (page: Page) => page.getByTestId("inbox-button");
const count = (page: Page) => page.getByTestId("inbox-count");
const historyRows = (page: Page) => page.getByTestId("inbox-history-row");

async function openHistory(page: Page): Promise<void> {
  await button(page).click();
  await expect(page.getByTestId("inbox-panel")).toBeVisible();
  await page.getByTestId("inbox-tab-history").click();
  await expect(page.getByTestId("inbox-panel-history")).toBeVisible();
}

test.describe("Cronologia notifiche", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-notif" }, null, 2));
    const topic = await createTopic(request, "E2E-Notifiche", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Il task che la notifica deve aprire" },
    });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await wipeRegistry(page.request);
  });

  test("NH-01: la riga arriva da sola nella cronologia, il numero non sale, il click porta al task", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    await page.goto("/");
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    await openHistory(page);
    const before = await historyRows(page).count();

    // La riga arriva mentre la cronologia è aperta. Nessun reload.
    await postNotification(page.request, {
      kind: "task-review",
      title: "Task pronto per la review",
      body: "Il task che la notifica deve aprire",
      targetKind: "task",
      targetId: taskId,
      dedupeKey: `task-review:${taskId}:${Date.now()}`,
    });
    await expect(historyRows(page)).toHaveCount(before + 1, { timeout: 10_000 });
    // Una riga non è una cosa accesa: il tasto non conta niente.
    await expect(count(page)).toHaveCount(0);

    // Il click porta ALLA COSA: il cassetto del task che ha generato la riga.
    await historyRows(page).first().click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("task-detail-drawer")).toContainText("Il task che la notifica deve aprire");
  });

  test("NH-02: aprire la cronologia non segna niente, nemmeno dopo un ricaricamento", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    await postNotification(page.request, { kind: "chat-message", title: "Una risposta", dedupeKey: `e2e-seen-${Date.now()}` });
    expect(await unseenRows(page.request)).toBe(1);
    await page.goto("/");
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    await openHistory(page);
    await expect(historyRows(page).first()).toBeVisible();
    await page.reload();
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    // In sola lettura: la riga è ancora non vista sul server.
    expect(await unseenRows(page.request)).toBe(1);
  });

  test("NH-04: due mittenti dello stesso evento = una riga", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    await page.goto("/");
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    await openHistory(page);
    const before = await historyRows(page).count();
    const key = `task-review:${taskId}:${Date.now()}`;
    const first = await postNotification(page.request, { kind: "task-review", title: "Consegna", targetKind: "task", targetId: taskId, dedupeKey: key });
    expect(first.recorded).toBe(true);
    // Il SECONDO mittente dello stesso evento (la spinta, un'altra finestra).
    const second = await postNotification(page.request, { kind: "task-review", title: "Consegna", targetKind: "task", targetId: taskId, dedupeKey: key, source: "push" });
    expect(second.recorded).toBe(false);
    await expect(historyRows(page)).toHaveCount(before + 1, { timeout: 10_000 });
  });

  test("NH-06: oltre la prima pagina — il registro non finisce alla cinquantesima", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    // The registry holds 500 rows and a page serves 50: the history used to
    // draw 50 and stop there, with nothing saying the list was cut.
    for (let i = 0; i < 60; i++) {
      await postNotification(page.request, { kind: "chat-message", title: `Riga di registro ${i}`, dedupeKey: `nh06-${Date.now()}-${i}` });
    }
    await page.goto("/");
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    await openHistory(page);
    await expect(historyRows(page)).toHaveCount(50, { timeout: 15_000 });
    // The list says it is cut, and the next page MERGES below the first.
    await page.getByTestId("inbox-history-more").click();
    await expect
      .poll(() => historyRows(page).count(), { timeout: 15_000, message: "la seconda pagina non è mai arrivata" })
      .toBeGreaterThan(50);
    await expect(historyRows(page).first()).toBeVisible();
  });
});

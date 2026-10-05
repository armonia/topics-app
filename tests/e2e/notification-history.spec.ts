/**
 * notification-history.spec.ts — «CRONOLOGIA», la linguetta della inbox.
 *
 * Fino a notifications-redesign questa spec misurava il tastino della
 * cronologia, che CONTAVA righe e le segnava viste all'apertura. Il tastino
 * ora è «Da guardare» (ATTN-09): conta soggetti accesi e aprirlo non segna
 * niente. La cronologia resta, come seconda linguetta, in sola lettura. Le
 * prove di prima, una per una:
 *   NH-01  the row a live transition writes (a card entering review) reaches
 *          the open history by itself, inside the `attention:updated` frame
 *          that lit the card (no refresh), and the click leads to the thing
 *          that produced it.
 *   NH-02  opening the history marks nothing: an unseen row stays unseen on
 *          the server, even after a reload; and a row is not a lit thing, so
 *          the button's number does not rise for it.
 *   NH-04  due mittenti dello stesso evento fanno una riga sola, and that row,
 *          posted to the log with the history open, arrives by itself on
 *          `attention:history` (no subject, no transition: its own frame).
 *   NH-06  oltre la prima pagina: il registro non finisce alla cinquantesima.
 * NH-03 (un gruppo visto una volta) e NH-05 (un fronte in ritardo non
 * riaccende il numero) misuravano il numero fatto di righe, che non esiste
 * più: i loro gemelli sul numero nuovo sono `attention-sync.spec.ts` (un
 * visto vale per il soggetto ovunque, anche dopo ricarico e riconnessione) e
 * `attention-inbox.spec.ts` (aprire non spegne).
 *
 * The log is seeded through its public route (`POST /api/notifications`):
 * seeding by writing the table would prove the table, not the chain. NH-01
 * drives a real transition: its row travels in the `attention:updated` of
 * that transition. A posted row, written by no transition, travels on
 * `attention:history` (NH-04).
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
): Promise<{ recorded: boolean; row: { id: string } }> {
  const res = await request.post(`${BASE}/api/notifications`, { data: body });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { recorded: boolean; row: { id: string } };
}

/** When the server says a row was seen (null: not yet), read from the log itself. */
async function seenAtOf(request: APIRequestContext, rowId: string): Promise<string | null | undefined> {
  const rows = ((await (await request.get(`${BASE}/api/notifications?limit=500`)).json()) as { rows: { id: string; seenAt: string | null }[] }).rows;
  return rows.find((r) => r.id === rowId)?.seenAt;
}

/** The button's number as it reads, "" when it shows none. */
async function litCount(page: Page): Promise<string> {
  return (await count(page).count()) ? (await count(page).textContent())?.trim() ?? "" : "";
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
  });

  test("NH-01: the row of a live transition reaches the open history by itself, and the click leads to the task", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    await page.goto("/");
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    await openHistory(page);
    const before = await historyRows(page).count();

    // A card enters review while the history is open: the attention store
    // writes its row and sends it in the frame that lights the card. No reload.
    const text = `The card the row must open ${Date.now()}`;
    const created = await page.request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "review" } });
    expect(created.ok()).toBe(true);
    const reviewId = ((await created.json()) as { id: string }).id;
    try {
      await expect(historyRows(page)).toHaveCount(before + 1, { timeout: 10_000 });
      await expect(historyRows(page).first()).toContainText(text);

      // The click leads TO THE THING: the drawer of the card that wrote the row.
      await historyRows(page).first().click();
      await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("task-detail-drawer")).toContainText(text);
    } finally {
      await deleteTask(page.request, PROJECT_ID, reviewId);
    }
  });

  test("NH-02: opening the history marks nothing, not even after a reload, and a row raises no number", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-09" });
    await page.goto("/");
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    // The badge counts what is lit on the whole test server, and a spec that ran
    // earlier in the shard can leave something lit (a question, a review): the
    // contract is that THIS row does not raise it, not that the server is empty.
    const litBefore = await litCount(page);
    const posted = await postNotification(page.request, { kind: "chat-message", title: "Una risposta", dedupeKey: `e2e-seen-${Date.now()}` });
    expect(posted.recorded).toBe(true);
    expect(await seenAtOf(page.request, posted.row.id)).toBeNull();
    await page.reload();
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    await openHistory(page);
    await expect(historyRows(page).filter({ hasText: "Una risposta" }).first()).toBeVisible();
    // A row is not a lit thing: the button's number did not rise.
    expect(await litCount(page)).toBe(litBefore);
    await page.reload();
    await expect(button(page)).toBeVisible({ timeout: 15_000 });
    // Read only: the row is still unseen on the server.
    expect(await seenAtOf(page.request, posted.row.id)).toBeNull();
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
    // No reload, no reopening of the tab: the row arrives on its own frame.
    await expect(historyRows(page)).toHaveCount(before + 1, { timeout: 10_000 });
    await expect(historyRows(page).first()).toContainText("Consegna");
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

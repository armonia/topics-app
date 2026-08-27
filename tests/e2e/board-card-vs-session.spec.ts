/**
 * board-card-vs-session.spec.ts — a task's CARD and the SESSION working it are
 * two different destinations, and that is visible before clicking.
 *
 * THE CASE. «Apri il task» meant two things: the card (description, checklist,  allow-italian: quoted UI string
 * delivery, thread — where things get DECIDED, and which always exists) and the
 * agent's chat (where the WORK happens, and which may be gone). Same word, two
 * surfaces, and no way to know which one would open. Now they are two gestures
 * with two names, the way back exists in both directions, and a session that is
 * gone gets SAID instead of opening onto nothing.
 *
 * IT TAKES A VIDEO, not a screenshot: what has to be shown is a ROUND TRIP —
 * board → card → session → card — i.e. four states on the same window. One
 * still frame would prove one of them.
 *
 * WHY THE DEAD SESSION IS STAGED FROM THE TOPIC INDEX.
 * `tasks.assigned_topic_id` carries a foreign key on `topics(id)` (migration
 * 026, with `PRAGMA foreign_keys = ON`): a DANGLING link cannot be written into
 * the database, not even from the test routes. But the question "does that
 * session still exist?" is one the client asks of its own topic index, not of
 * the DB — and that is where the case is real: a task worked on another
 * machine, a restored archive, a row pruned by some maintenance. So THAT topic
 * is removed from the `GET /api/topics` response: the UI is not faked, what is
 * staged is the world in which that topic is absent. See
 * `client/src/lib/taskSession.ts`.
 *
 * @covers KANBAN-07
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-cardsess-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const STAMP = Date.now();
const TASK_VIVO = `Sessione viva ${STAMP}`;
const DEAD_TASK = `Sessione finita ${STAMP}`;

let projectTopicId: string | null = null;
let aliveTopic: string | null = null;
let topicMorto: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

async function createTask(request: Req, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

/** Lega il task al topic dell'agente come fa il dispatcher (servizio vero). */
async function bindTopic(request: Req, id: string, topicId: string, dispatchState: string | null) {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, {
    data: { topicId, dispatchState },
  });
  expect(res.ok()).toBe(true);
}

/**
 * The world in which `topicMorto` no longer exists: the topic index answers
 * without that entry. The OTHERS are there, and that is the point — an EMPTY
 * index means "I do not know yet" and the gesture stays lit (see
 * `lib/taskSession.ts`); only a full index that does not contain it is a death.
 */
async function hideDeadTopic(page: Page) {
  await page.route("**/api/topics", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { topics?: Record<string, unknown> };
    if (body.topics && topicMorto) delete body.topics[topicMorto];
    await route.fulfill({ response: res, json: body });
  });
}

async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

/** A pause that serves ONLY the delivery clip (E2E_EVIDENCE=1). Zero on a normal suite. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Scheda del task e sessione dell'agente", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cardsess" }, null, 2));
    // The project topic records the workspace; the other two are the SESSIONS.
    // Standalone on purpose (no projectPath): that way they open as App-level
    // chat tabs, which is the surface of this clip — exactly what the dispatcher
    // does on the catch-all board.
    projectTopicId = (await createTopic(request, "E2E-CardSess", { projectPath: PROJECT_PATH })).id;
    aliveTopic = (await createTopic(request, `Sessione viva ${STAMP}`)).id;
    topicMorto = (await createTopic(request, `Sessione finita ${STAMP}`)).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    for (const id of [topicMorto, aliveTopic, projectTopicId]) if (id) await deleteTopic(request, id);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("dalla board alla scheda, dalla scheda alla sessione, e ritorno — e la sessione finita lo dice", async ({ page, request }) => {
    const vivo = await createTask(request, TASK_VIVO);
    const morto = await createTask(request, DEAD_TASK);
    await bindTopic(request, vivo.id, aliveTopic!, "working");
    await bindTopic(request, morto.id, topicMorto!, null);

    await resetPaneStore(page.request, []);
    await hideDeadTopic(page);
    await page.goto("/");
    await openGlobalBoard(page);

    const aliveCard = page.locator(`[data-task-card="${vivo.id}"]`);
    const deadCard = page.locator(`[data-task-card="${morto.id}"]`);
    await expect(aliveCard).toBeVisible({ timeout: 15000 });
    await expect(deadCard).toBeVisible({ timeout: 15000 });

    // (a) BEFORE THE CLICK the difference is readable: one card offers the
    //     session, the other says it is over and offers nothing to open.
    await expect(aliveCard.getByTestId("card-open-session")).toBeVisible();
    await expect(aliveCard.getByTestId("card-session-gone")).toHaveCount(0);
    await expect(deadCard.getByTestId("card-session-gone")).toBeVisible();
    await expect(
      deadCard.getByTestId("card-open-session"),
      "una sessione che non c'è più non si apre: il gesto non esiste proprio",
    ).toHaveCount(0);
    await beat(page, 2200);

    // (b) A bare click on the card opens the CARD DETAIL — never the session.
    //     The title, because the geometric centre of the card can be taken by an
    //     in-line control, and that click is not the bare click this means to
    //     exercise.
    await aliveCard.getByText(TASK_VIVO).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText(TASK_VIVO);
    await beat(page, 2000);

    // (c) From the card detail to the SESSION: it is the only gesture that leads
    //     to the other surface, and it really does lead there.
    await drawer.getByTestId("task-open-session-tab").click();
    const strip = page.getByTestId("chat-task-card-strip");
    await expect(strip, "la chat aperta è la sessione DI questo task, e lo dice").toBeVisible({ timeout: 15000 });
    await expect(strip).toContainText(TASK_VIVO);
    await beat(page, 2400);

    // (d) …and the way back: from the session to the card detail, on the SAME task.
    await strip.getByTestId("chat-open-task-card").click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText(TASK_VIVO);
    await beat(page, 2400);

    // (e) The card detail of a task whose session is over: the reason is written
    //     down, and the gesture toward nothing is absent.
    await deadCard.click();
    await expect(drawer).toContainText(DEAD_TASK, { timeout: 15000 });
    await expect(drawer.getByTestId("task-session-gone")).toBeVisible();
    await expect(
      drawer.getByTestId("task-open-session-tab"),
      "il drawer non deve offrire una sessione che non esiste",
    ).toHaveCount(0);
    await beat(page, 2600);
  });
});

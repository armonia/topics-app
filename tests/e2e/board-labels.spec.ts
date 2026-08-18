/**
 * board-labels.spec.ts — le etichette che DECIDONO, dal vivo.
 *
 * Due stati, e per questo è una clip e non uno screenshot:
 *  1. tre card in review con le loro etichette addosso — e su quella `invisibile`
 *     con la barra verde il chip che dice «la chiude il conduttore»;
 *  2. il filtro `visibile` acceso: la colonna Review si screma e resta esattamente
 *     la lista che un umano deve guardare.
 *
 * L'11/08/2026 quella lista Attilio se l'era fatta a mano, aprendo 29 diff.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

// Viewport della CLIP DI CONSEGNA: 1440x760 sta sotto la soglia di taglio della
// card d'anteprima (h/w ≤ 0.537 = 144/268), quindi il .webm si rimpicciolisce
// invece di essere tagliato. Il default della suite (1280x800 → 0.625) taglia.
test.use({ viewport: { width: 1440, height: 760 } });

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-labels-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const VISIBILE = "Il chip del drawer non entra sotto i 320px";
const INVISIBILE = "Il dispatcher interroga i board a turno";
const ALTRA = "Bench del tetto MCP: 3 sonde e una tabella";
const PIANO = "Piano: amicizia fra installazioni";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function setLabels(request: any, taskId: string, labels: string[]) {
  const res = await request.put(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}/labels`, { data: { labels } });
  expect(res.ok()).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-labels/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Etichette · chi chiude la card, e il filtro che la trova", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-labels" }, null, 2));
    const topic = await createTopic(request, "E2E-Labels", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("le etichette si vedono sulle card, e il filtro lascia solo le visibili", async ({ page, request }) => {
    const visibile = await createTask(request, { text: VISIBILE, status: "review" });
    const invisibile = await createTask(request, { text: INVISIBILE, status: "review" });
    const altra = await createTask(request, { text: ALTRA, status: "review" });
    const piano = await createTask(request, { text: PIANO, status: "review" });
    await setLabels(request, visibile.id, ["visibile", "bugfix"]);
    await setLabels(request, invisibile.id, ["invisibile", "chore"]);
    await setLabels(request, altra.id, ["invisibile", "misura"]);
    // La terza classe: un piano non è invisibile, la decide una persona.
    await setLabels(request, piano.id, ["decisione"]);

    await page.goto("/");
    await openProjectBoard(page);

    // 1° stato: quattro card in review, ognuna con le sue etichette addosso.
    await expect(page.locator("[data-task-card]")).toHaveCount(4);
    const cardVis = page.locator(`[data-task-card="${visibile.id}"]`);
    const cardInv = page.locator(`[data-task-card="${invisibile.id}"]`);
    await expect(cardVis.getByTestId("card-label-visibile")).toBeVisible();
    await expect(cardVis.getByTestId("card-label-bugfix")).toBeVisible();
    await expect(cardInv.getByTestId("card-label-invisibile")).toBeVisible();
    await expect(page.locator(`[data-task-card="${piano.id}"]`).getByTestId("card-label-decisione")).toBeVisible();
    await beat(page, 2400);

    // 2° stato: il filtro `visibile` acceso. Resta UNA card — la lista che un
    // umano deve guardare, senza aprire un solo diff.
    await page.getByTestId("filter-labels-chip").click();
    await page.getByRole("option", { name: "visibile", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-task-card]")).toHaveCount(1);
    await expect(cardVis).toBeVisible();
    await expect(cardInv).toHaveCount(0);
    await beat(page, 2600);

    // E il filtro si inverte: le invisibili sono due, il piano non è fra loro.
    await page.getByTestId("filter-labels-chip").click();
    await page.getByRole("option", { name: "visibile", exact: true }).click();
    await page.getByRole("option", { name: "invisibile", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-task-card]")).toHaveCount(2);
    await beat(page, 2200);
  });

  test("un agente NON può marcarsi invisibile: il server risponde 403", async ({ request }) => {
    // Lo stesso cancello del test unitario, ma dalla porta vera dell'agente —
    // quella che un modello può davvero chiamare via MCP (`label_task`).
    const t = await createTask(request, { text: "Consegna di un agent", status: "review" });
    // La session key di un topic è `topic:` + i primi 8 caratteri del suo id
    // (session-control-core), come la costruisce l'adattatore MCP.
    const sessionKey = `topic:${projectTopicId!.slice(0, 8)}`;
    const res = await request.put(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${t.id}/labels`,
      { data: { labels: ["invisibile"] } },
    );
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("label_forbidden");

    // E alzare la mano invece passa.
    const ok = await request.put(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${t.id}/labels`,
      { data: { labels: ["visibile", "bugfix"] } },
    );
    expect(ok.ok()).toBe(true);
  });
});

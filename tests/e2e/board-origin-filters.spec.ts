/**
 * board-origin-filters.spec.ts - whose work a card is, readable and filterable.
 *
 * A board opens on «My work» (the person's cards and the board's, nothing in
 * progress); every card carries its owner (the person, the board, an agent by
 * name, a chat, a schedule) and its channel; the owner chips and the channel
 * menu cut the board; the density slider and the Workflow view change how it
 * reads. Screenshots at 375, 768, 1440 and 3440 px go to SHOTS for a person to
 * judge the look (the CI uploads them).
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = canonicalTmpDir("e2e-origin");
const PROJECT_ID = boardIdForPath(PROJECT_PATH);
// Uploaded by the CI as `board-filtri-shots-<shard>`: the look is judged by a person, on these.
const SHOTS = "test-results/board-filtri";
const AS_PERSON = { "X-Topics-Action-Origin": "interface" };

const topicIds: string[] = [];
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body, headers });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") await projectsSection.click();
  const btn = projectRow(page, /e2e-origin/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
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

test.describe("Di chi è la card", () => {
  test.describe.configure({ timeout: 180_000 });
  const ids: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-origin" }, null, 2));
    const project = await createTopic(request, "E2E-Origin", { projectPath: PROJECT_PATH });
    const discord = await createTopic(request, "#lancio-sito", { icon: "Discord", color: "#5865F2" });
    const whatsapp = await createTopic(request, "Studio Rossi: gruppo clienti", { icon: "WhatsApp", color: "#25D366" });
    topicIds.push(project.id, discord.id, whatsapp.id);
    const long = "Contesto abbastanza lungo da bastare per finire da sola, con la prova scritta sotto.";
    ids.mine = (await createTask(request, { text: "Rivedere il testo della pagina prezzi", status: "todo" }, AS_PERSON)).id;
    ids.running = (await createTask(request, { text: "Card mia già in corso", status: "in_progress" }, AS_PERSON)).id;
    ids.board = (await createTask(request, { text: "Aggiornare le dipendenze del client", description: long, bar: "bun test", source: "chat:e2e", status: "todo" })).id;
    ids.bare = (await createTask(request, { text: "Card d'agente senza contesto", createdBy: "agent:jarvis", status: "todo" })).id;
    ids.discord = (await createTask(request, {
      text: "Lancio del sito: controllare i link del footer", description: long, bar: "bun test", source: "jarvis-channels",
      channelTopicId: discord.id, status: "todo",
    })).id;
    ids.whatsapp = (await createTask(request, {
      text: "Studio Rossi: verificare i backup della posta", description: long, bar: "bun test", source: "jarvis-channels",
      channelTopicId: whatsapp.id, status: "review",
    })).id;
    ids.cron = (await createTask(request, { text: "Rapporto settimanale della CI", description: long, bar: "bun test", source: "cron", createdBy: "cron:ci-weekly", status: "todo" })).id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    for (const id of topicIds) await deleteTopic(request, id);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  const cardOf = (page: Page, key: string) => page.locator(`[data-task-card="${ids[key]}"]`);

  test("la board si apre su «Il mio lavoro», i chip dei proprietari e dei canali tagliano, «Tutto» resta ricordato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
    await page.goto("/");
    // The suite starts on «All» (playwright.config.ts): this test checks the real default.
    await page.evaluate(() => localStorage.removeItem("topics.board.preset"));
    await page.reload();
    await openProjectBoard(page);

    await expect(page.getByTestId("board-preset-mine")).toHaveAttribute("aria-checked", "true");
    await expect(cardOf(page, "mine")).toBeVisible();
    await expect(cardOf(page, "board")).toBeVisible();
    for (const hidden of ["running", "bare", "discord", "whatsapp", "cron"]) await expect(cardOf(page, hidden)).toHaveCount(0);
    await expect(cardOf(page, "mine").getByTestId("card-origin")).toHaveAttribute("data-owner", "me");
    await expect(cardOf(page, "board").getByTestId("card-origin")).toHaveAttribute("data-owner", "board");

    await page.getByTestId("board-preset-all").click();
    for (const shown of ["running", "bare", "discord", "whatsapp", "cron"]) await expect(cardOf(page, shown)).toBeVisible();
    // A channel's card is its agent's (Jarvis by default), and says the channel with its mark.
    const discord = cardOf(page, "discord");
    await expect(discord.getByTestId("card-origin")).toHaveAttribute("data-owner", "agent:jarvis");
    await expect(discord.getByTestId("card-origin")).toContainText("Jarvis");
    await expect(discord.getByTestId("card-channel")).toHaveAttribute("data-channel-kind", "discord");
    await expect(cardOf(page, "cron").getByTestId("card-origin")).toHaveAttribute("data-owner", "scheduled");
    await expect(cardOf(page, "bare").getByTestId("card-incomplete")).toBeVisible();

    // One owner: Jarvis's three cards (two from channels, one he opened), and its count says so.
    const jarvis = page.getByTestId("board-owner-agent-jarvis");
    await expect(jarvis).toContainText("3");
    await jarvis.click();
    await expect(cardOf(page, "mine")).toHaveCount(0);
    await expect(cardOf(page, "bare")).toBeVisible();
    await jarvis.click();

    // Only WhatsApp, from the channel menu.
    await page.getByTestId("board-channel-filter").click();
    await page.getByTestId("board-channel-menu").getByRole("menuitemcheckbox", { name: /WhatsApp/ }).click();
    await page.keyboard.press("Escape");
    await expect(cardOf(page, "whatsapp")).toBeVisible();
    await expect(cardOf(page, "discord")).toHaveCount(0);
    await expect(page.getByTestId("board-channel-filter")).toContainText("WhatsApp");

    // The preset picked is where the next board opens.
    expect(await page.evaluate(() => localStorage.getItem("topics.board.preset"))).toBe("all");
  });

  test("lo slider del dettaglio e la vista Workflow", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-108" });
    await page.goto("/");
    await openProjectBoard(page);
    const card = cardOf(page, "board");
    await expect(card).toHaveAttribute("data-density", "full");

    const slider = page.getByTestId("board-density");
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(card).toHaveAttribute("data-density", "compact");
    await page.keyboard.press("ArrowLeft");
    await expect(card).toHaveAttribute("data-density", "title");
    await expect(slider).toHaveAttribute("aria-valuetext", "Solo titolo");
    await expect(card.getByTestId("card-foot")).toBeHidden();
    await page.getByTestId("board-density-full").click();
    await expect(card).toHaveAttribute("data-density", "full");

    // Dragging the knob: from «full» past the left end rests on «title», then back to «compact».
    const center = async (level: string) => {
      const b = (await page.getByTestId(`board-density-${level}`).boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const full = await center("full");
    const compact = await center("compact");
    await page.mouse.move(full.x, full.y);
    await page.mouse.down();
    await page.mouse.move(full.x - 200, full.y, { steps: 8 });
    await expect(card).toHaveAttribute("data-density", "title");
    await page.mouse.move(compact.x, compact.y, { steps: 4 });
    await page.mouse.up();
    await expect(card).toHaveAttribute("data-density", "compact");
    await expect(slider).toHaveAttribute("aria-valuetext", "Compatte");

    await page.getByTestId("board-view-workflow").click();
    const flow = page.getByTestId("workflow-view");
    await expect(flow).toBeVisible();
    await expect(page.getByTestId("board-origin-filters")).toHaveCount(0);
    await expect(flow.getByTestId("workflow-count-todo")).toHaveText(/^\d+$/);
    await expect(flow.getByTestId("workflow-rules")).toBeVisible();
    await flow.getByTestId("workflow-step-todo").click();
    await expect(page.getByTestId("board-view-grid")).toHaveAttribute("aria-checked", "true");
  });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [375, 768, 1440, 3440]) {
      test(`screenshot ${width}px ${theme}: filtri, card, canali, workflow`, async ({ page }) => {
        test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: width === 375 ? 812 : width === 3440 ? 1440 : 900 });
        await page.goto("/");
        await openProjectBoard(page);
        await page.getByTestId("board-preset-all").click();
        await expect(cardOf(page, "discord")).toBeVisible();
        if (width >= 1440) {
          // On a desktop the bar fits: nothing past the right edge (it scrolls only on a phone).
          const bar = page.getByTestId("board-toolbar");
          const over = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(over).toBeLessThanOrEqual(1);
        }
        await page.screenshot({ path: `${SHOTS}/board-${width}-${theme}.png` });
        await page.getByTestId("board-preset-mine").click();
        await expect(cardOf(page, "discord")).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/mio-lavoro-${width}-${theme}.png` });
        await page.getByTestId("board-preset-all").click();
        await page.getByTestId("board-channel-filter").click();
        await expect(page.getByTestId("board-channel-menu")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/canali-${width}-${theme}.png` });
        await page.keyboard.press("Escape");
        await page.getByTestId("board-view-plan").click();
        await expect(page.getByTestId("plan-view")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/chi-la-segue-${width}-${theme}.png` });
        await page.getByTestId("board-view-workflow").click();
        await expect(page.getByTestId("workflow-view")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/workflow-${width}-${theme}.png` });
        await page.getByTestId("board-view-grid").click();
      });
    }
  }
});

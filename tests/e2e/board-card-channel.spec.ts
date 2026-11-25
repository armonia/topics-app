/**
 * board-card-channel.spec.ts - a card says which Jarvis channel its work came from.
 *
 * Two separate things: Jarvis as the agent (the avatar chip, the slot of the card's
 * agent) and the channel chip (official mark and channel name only),
 * on the card (full and compact) and in the drawer; one click opens that channel's
 * chat. A card with no channel chat behind it shows nothing. The screenshots at
 * 375, 768 and 1440 px, dark and light, are the proof the eye judges.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = canonicalTmpDir("e2e-channel-card");
const PROJECT_ID = boardIdForPath(PROJECT_PATH);
const SHOTS = `${homedir()}/.topics/media/board-canale`;

const topicIds: string[] = [];
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body, headers: { "X-Topics-Agent": "jarvis" } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") await projectsSection.click();
  const btn = projectRow(page, /e2e-channel-card/);
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

test.describe("Canale sulla card", () => {
  test.describe.configure({ timeout: 180_000 });
  let discordId = "";
  let whatsappId = "";
  let discordCard = "";
  let whatsappCard = "";
  let plainCard = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-channel-card" }, null, 2));
    const project = await createTopic(request, "E2E-Channel-Card", { projectPath: PROJECT_PATH });
    topicIds.push(project.id);
    const discord = await createTopic(request, "#Video Zeno: musica e voce da rifare", { icon: "Discord", color: "#5865F2" });
    const whatsapp = await createTopic(request, "Studio Rossi: gruppo clienti", { icon: "WhatsApp", color: "#25D366" });
    topicIds.push(discord.id, whatsapp.id);
    discordId = discord.id;
    whatsappId = whatsapp.id;
    const long = "Contesto abbastanza lungo da bastare per finire da sola, con la prova scritta sotto.";
    discordCard = (await createTask(request, {
      text: "Video Zeno: montaggio dopo la scelta di musica e voce", description: long, bar: "bun test", source: "jarvis-channels",
      channelTopicId: discordId, status: "todo",
    })).id;
    whatsappCard = (await createTask(request, {
      text: "Posta Giuseppe: verifica dei backup di sola posta", description: long, bar: "bun test", source: "jarvis-channels",
      channelTopicId: whatsappId, status: "todo",
    })).id;
    plainCard = (await createTask(request, { text: "Card senza canale", description: long, bar: "bun test", source: "jarvis-channels", status: "todo" })).id;
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

  test("il testo del canale non sparisce e se si taglia lo fa con ellissi, dentro la card", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await openProjectBoard(page);
    for (const id of [discordCard, whatsappCard]) {
      const chip = page.locator(`[data-task-card="${id}"]`).getByTestId("card-channel");
      await expect(chip).toBeVisible();
      const result = await chip.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const host = el.closest("[data-task-card]")!.getBoundingClientRect();
        const pieces = [...el.querySelectorAll<HTMLElement>("[data-testid='card-channel-server'],[data-testid='card-channel-channel'],[data-testid='card-channel-thread']")];
        return {
          inside: box.right <= host.right + 0.5,
          pieces: pieces.map((p) => ({
            level: p.dataset.testid,
            text: (p.textContent ?? "").trim(),
            width: p.getBoundingClientRect().width,
            clipped: p.scrollWidth > p.clientWidth + 1,
            ellipsis: getComputedStyle(p).textOverflow === "ellipsis",
          })),
        };
      });
      expect(result.inside).toBe(true);
      expect(result.pieces.length).toBeGreaterThan(0);
      for (const piece of result.pieces) {
        expect(piece.text.length).toBeGreaterThan(0);
        expect(piece.width).toBeGreaterThan(8);
        if (piece.clipped) expect(piece.ellipsis).toBe(true);
        if (piece.level === "card-channel-server") expect(piece.clipped).toBe(false);
      }
    }
  });

  test("la card dice il canale, il chip apre la chat, la card senza canale resta pulita", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${discordCard}"]`);
    const chip = card.getByTestId("card-channel");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-channel-kind", "discord");
    await expect(chip).not.toContainText("Jarvis");
    await expect(card.getByTestId("card-origin")).toHaveAttribute("data-owner", "agent:jarvis");
    await expect(card.getByTestId("card-origin")).toContainText("Jarvis");
    await expect(chip).toContainText("#Video Zeno: musica e voce da rifare");
    await expect(chip.locator("svg[aria-label='Discord']")).toBeVisible();
    await expect(page.locator(`[data-task-card="${whatsappCard}"]`).getByTestId("card-channel")).toHaveAttribute("data-channel-kind", "whatsapp");
    await expect(page.locator(`[data-task-card="${plainCard}"]`).getByTestId("card-channel")).toHaveCount(0);

    // One click opens the channel chat, and not the card's drawer.
    await chip.click();
    await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0);
    await expect(page.getByTestId("pane-tab-label").filter({ hasText: "#Video Zeno: musica e voce da rifare" }).first()).toBeVisible({ timeout: 10000 });
  });

  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 768, 1440, 3440]) {
      test(`screenshot ${width}px ${theme}: card, card compatta e drawer`, async ({ page }) => {
        test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: width === 375 ? 812 : width === 3440 ? 1440 : 900 });
        await page.goto("/");
        await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
        await openProjectBoard(page);
        const card = page.locator(`[data-task-card="${discordCard}"]`);
        await card.scrollIntoViewIfNeeded();
        await expect(card.getByTestId("card-channel")).toBeVisible();
        await expect(card.getByTestId("card-origin")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/card-${width}-${theme}.png` });
        await card.screenshot({ path: `${SHOTS}/card-solo-${width}-${theme}.png` });

        // The drawer: Jarvis and the channel, two chips on their own line under the project.
        await card.getByText("Video Zeno: montaggio dopo la scelta di musica e voce").click();
        const drawer = page.getByTestId("task-detail-drawer");
        await expect(drawer).toBeVisible({ timeout: 10000 });
        await expect(drawer.getByTestId("card-channel")).toBeVisible();
        await expect(drawer.getByTestId("card-origin")).toContainText("Jarvis");
        await page.screenshot({ path: `${SHOTS}/drawer-${width}-${theme}.png` });
      });
    }
  }

  for (const theme of ["dark", "light"] as const) {
    test(`card compatta (vista «Chi la segue»): il chip resta, 1440px ${theme}`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await openProjectBoard(page);
      // Only the cards view (all projects) draws the board's compact card.
      await page.getByText("Tutti i progetti", { exact: true }).click();
      await page.getByTestId("board-view-plan").click();
      await expect(page.getByTestId("board-cards-grid").first()).toBeVisible({ timeout: 15000 });
      const card = page.locator(`[data-task-card="${discordCard}"][data-density="compact"]`);
      await expect(card.getByTestId("card-channel")).toBeVisible();
      await expect(card.getByTestId("card-origin")).toContainText("Jarvis");
      await page.screenshot({ path: `${SHOTS}/compatta-1440-${theme}.png` });
    });
  }
});

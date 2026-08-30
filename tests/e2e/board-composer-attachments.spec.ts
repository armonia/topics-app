/**
 * board-composer-attachments.spec.ts — un'immagine entra da dove il task nasce.
 *
 * A card's thread accepted a pasted image; the composer that CREATES the task
 * accepted nothing: no paste, no drag, no paperclip. Whoever opened the board
 * holding the screenshot of the error had to create the card, open it and
 * attach it afterwards, doing twice the gesture they came for.
 *
 * The round here is a person's: I type, I paste the screenshot, I see it
 * staged under the field, I send. Then I drag a file over it and the pill says
 * so before I even drop. The final assertion is not on screen: it is that the
 * server wrote that file ONTO THE CARD, because that is where the agent will
 * find it.
 *
 * It is also the delivery clip: attaching is a multi-state behaviour (it
 * appears, it stays, it leaves with the task), not a screenshot.
 *
 * @covers KANBAN-70
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

const BASE = E2E_BASE;
const STAMP = Date.now();
const PROJECT_PATH = `/tmp/e2e-composer-attach-${STAMP}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** 1x1 PNG: the content does not matter, being a real image does. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IDEA = "Il bottone di invio esce dal bordo su pane stretta";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function openProjectBoard(page: Page) {
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") {
    await section.click();
  }
  const row = projectRow(page, /e2e-composer-attach/);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      await item.click();
      await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("nessun menu «+» con la voce Board");
}

/**
 * The real gesture, the way the browser delivers it: an event with a
 * `DataTransfer` carrying a File. Playwright has no "paste a file", and faking
 * it with the keyboard would depend on the clipboard of the machine running
 * la suite.
 */
async function sendFileEvent(page: Page, type: "paste" | "dragover" | "drop", selector: string, name: string, mime: string) {
  await page.evaluate(({ type, selector, name, mime, b64 }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: mime }));
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element for ${selector}`);
    const ev = type === "paste"
      ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      : new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }, { type, selector, name, mime, b64: PNG_B64 });
}

test.describe("Composer: allegare un'immagine al task che nasce", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-composer-attach" }, null, 2));
    const topic = await createTopic(request, "E2E-ComposerAttach", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
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

  test("incollo lo screenshot, lo trascino, e il task nasce con i file addosso", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-70" });
    await page.goto("/");
    await openProjectBoard(page);

    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(IDEA);

    // 1) PASTE. The image does not become text: it becomes a staged
    // attachment, with its thumbnail, under the field.
    await sendFileEvent(page, "paste", '[data-testid="board-task-composer"] textarea', "schermata.png", "image/png");
    const staged = page.getByTestId("composer-attachments");
    await expect(staged).toBeVisible({ timeout: 10000 });
    await expect(staged.locator("img")).toHaveCount(1);
    // The typed text stays as it was: pasting an image writes nothing into
    // the field.
    await expect(composer).toHaveValue(IDEA);

    // 2) DRAG. Over the pill, carrying files, the composer SAYS so before the
    // drop: without a signal the gesture is blind.
    await sendFileEvent(page, "dragover", '[data-testid="board-task-composer"]', "note.pdf", "application/pdf");
    await expect(page.getByTestId("composer-drop-hint")).toBeVisible({ timeout: 5000 });
    await sendFileEvent(page, "drop", '[data-testid="board-task-composer"]', "note.pdf", "application/pdf");
    await expect(page.getByTestId("composer-drop-hint")).toHaveCount(0);
    await expect(staged.locator("img")).toHaveCount(1);
    await expect(staged).toContainText("note.pdf");

    // Born in Backlog: what is measured here is the attachment, not dispatch.
    const chip = page.getByTestId("composer-start-chip");
    await chip.click();
    await page.getByTestId("composer-start-backlog").click();
    await expect(chip).toContainText("Backlog");

    await page.getByTestId("composer-send").click();

    const card = page.getByTestId("kanban-column-backlog").locator("[data-task-card]").filter({ hasText: /bottone di invio/ });
    await expect(card).toBeVisible({ timeout: 10000 });
    // The composer emptied COMPLETELY: text and attachments left with the
    // task, they did not stay on for the next one.
    await expect(page.getByTestId("composer-attachments")).toHaveCount(0);

    // And the files are ON THE CARD, which is where the agent will find them.
    const list = await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks`)).json() as {
      tasks: { id: string; text: string }[];
    };
    const born = list.tasks.find((t) => t.text.includes("bottone di invio"))!;
    createdTasks.push(`${PROJECT_ID}:${born.id}`);
    const thread = await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${born.id}`)).json() as {
      comments: { media: string[] }[];
    };
    const media = thread.comments.flatMap((c) => c.media);
    expect(media.length).toBe(2);
    expect(media.some((m) => m.endsWith(".png"))).toBe(true);
    expect(media.some((m) => m.endsWith(".pdf"))).toBe(true);
  });
});

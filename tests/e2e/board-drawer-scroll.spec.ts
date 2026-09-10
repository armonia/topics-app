/**
 * The conversation owns the task drawer. Its expanded metadata shares one
 * scroll area; title, floating composer and delivery controls stay reachable. Preview and work
 * surfaces open explicitly, replacing the thread in narrow mode and sitting
 * alongside it in wide mode. Closing them restores the same conversation.
 *
 * The geometry fixture is intentionally tall: a 2200×6010 image, 30 comments,
 * a long description and eight subtasks in a 1280×720 viewport.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE, testServerEnv } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
// Canonical spelling (`/private/tmp` on macOS): the server resolves the topic's
// projectPath and hashes the STRING into the board id, so a literal `/tmp`
// seeded a board the pane never reads.
const PROJECT_PATH = canonicalTmpDir("e2e-drawer");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

// ── Un PNG VERO, della forma che rompe ───────────────────────────────────────
// Non un 1×1 finto: il difetto è nella GEOMETRIA (un'immagine alta 6010px in un
// riquadro senza tetto in px si prende mezzo drawer), quindi il test deve
// misurare un'immagine che il browser decodifica davvero con quelle dimensioni.
// Scala di grigi 8 bit, una banda per riga: comprime a pochi KB e resta
// visibilmente "lunga" nel video di consegna.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function tallPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (width + 1);
    raw[off] = 0; // filter: none
    // Bande orizzontali: nel video si vede QUALE fetta dell'immagine è a schermo.
    raw.fill(y % 400 < 200 ? 0x33 : 0xcc, off + 1, off + 1 + width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let projectTopicId: string | null = null;
let sessionTopicId: string | null = null;
let liveTopicId: string | null = null;
let steerTopicId: string | null = null;
const createdTasks: string[] = [];

async function api(request: import("@playwright/test").APIRequestContext, method: "get" | "post" | "patch", path: string, data?: unknown) {
  const res = await request[method](`${BASE}${path}`, data === undefined ? {} : { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()}`).toBe(true);
  return res.json();
}

/** Il task del caso peggiore: anteprima alta, 30 commenti, 8 sottotask, in review. */
async function seedWorstCaseTask(request: import("@playwright/test").APIRequestContext, previewPath: string) {
  const text = `Drawer worst case ${Date.now()}`;
  const task = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, {
    text,
    description: Array.from({ length: 12 }, (_, i) => `Riga ${i + 1} della descrizione, abbastanza lunga da occupare spazio verticale vero.`).join("\n\n"),
  })) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  for (let i = 0; i < 8; i++) {
    const sub = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, {
      text: `Sottotask ${i + 1}`, parentTaskId: task.id,
    })) as { id: string };
    createdTasks.push(`${PROJECT_ID}:${sub.id}`);
  }
  for (let i = 0; i < 30; i++) {
    await api(request, "post", `/api/boards/${PROJECT_ID}/tasks/${task.id}/comments`, {
      content: `Commento ${i + 1}: una nota di lavoro lunga quanto basta a riempire il thread.`,
    });
  }
  await api(request, "patch", `/api/boards/${PROJECT_ID}/tasks/${task.id}`, { previewImage: previewPath });
  // Il semino ATTECCHISCE, o si ferma qui. La rotta filtra `previewImage`
  // contro l'allowlist e, se il path non passa, risponde 200 lasciando il campo
  // a null: senza questo controllo il test misurerebbe un drawer senza
  // anteprima e passerebbe dicendo il contrario.
  const seeded = (await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`)).json()) as { task?: { previewImage?: string | null } };
  expect(seeded.task?.previewImage, "previewImage scartata dall'allowlist").toBe(previewPath);
  // In review PER ULTIMO: è lo stato che fa comparire Approva/Rimanda indietro, cioè i
  // bottoni che questo file esiste per tenere dentro lo schermo.
  await api(request, "patch", `/api/boards/${PROJECT_ID}/tasks/${task.id}`, { status: "review" });
  return { id: task.id, text };
}

/**
 * A LIGHT task in review, bound to a topic that already holds agent steps: the
 * case the Session tab exists to show.
 *
 * Status FIRST, binding second: a PATCH on the task goes through the path that
 * clears `assigned_topic_id`, so binding first would measure a task that lost
 * its agent on the way.
 */
async function seedDispatchedTask(request: import("@playwright/test").APIRequestContext, topicId: string, step: string, status: "review" | "todo" = "review") {
  const text = `Drawer sessione ${Date.now()}`;
  const task = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, { text })) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  await api(request, "patch", `/api/boards/${PROJECT_ID}/tasks/${task.id}`, { status });
  const bind = await request.post(`${BASE}/api/test/tasks/${task.id}/bind-topic`, { data: { topicId } });
  expect(bind.ok(), `bind-topic → ${bind.status()}`).toBe(true);
  // One agent step in the topic's session (`role: assistant`): it is what the
  // pane has to show, and without it the tab would only prove it exists.
  const msg = await request.post(`${BASE}/api/topics/${topicId}/system-message`, { data: { content: step } });
  expect(msg.ok(), `system-message → ${msg.status()}`).toBe(true);
  return { id: task.id, text };
}

/** Apre il drawer cliccando la card per TESTO (come board.spec.ts). */
async function openTaskDrawer(page: Page, text: string, column = "review") {
  await page.getByTestId(`kanban-column-${column}`).getByText(text).click({ timeout: 15000 });
  await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-drawer/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page) {
  await openTestProject(page);
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

/** Expand task metadata without opting into the separate workspace view. */
async function expandEverySection(page: Page) {
  const drawer = page.getByTestId("task-detail-drawer");
  if ((await drawer.getByTestId("task-brief-scroll").count()) === 0) {
    await drawer.getByTestId("task-details-toggle").click();
  }
  for (const label of [/^Descrizione$/, /^Sottotask/]) {
    const btn = drawer.getByRole("button", { name: label }).first();
    if ((await btn.count()) === 0 || !(await btn.isEnabled())) continue;
    if ((await btn.locator("svg.lucide-chevron-down").count()) === 0) await btn.click();
  }
}

/** Delivery decisions and files share the conversation's existing scroll. */
async function openDelivery(page: Page) {
  const drawer = page.getByTestId("task-detail-drawer");
  const toggle = drawer.getByTestId("task-delivery-toggle");
  await expect(toggle).toBeInViewport();
  await toggle.click();
  const delivery = drawer.getByTestId("task-delivery-panel");
  await expect(delivery).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return delivery;
}

/**
 * Quanti antenati SCROLLABILI ci sono fra un nodo e la root del drawer.
 * È la misura dell'invariante: uno, non zero (niente scorrerebbe) e non due
 * (scroll dentro scroll — la forma che i tetti in `vh` imitavano).
 */
async function scrollableAncestors(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const start = document.querySelector(`[data-testid="${id}"]`);
    const root = document.querySelector('[data-testid="task-detail-drawer"]');
    if (!start || !root) return -1;
    let n = 0;
    let el: HTMLElement | null = start.parentElement;
    while (el && el !== root) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") n++;
      el = el.parentElement;
    }
    return n;
  }, testId);
}

test.describe("Drawer del task — un solo scroll", () => {
  test.describe.configure({ timeout: 90_000 });

  let previewPath = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-drawer" }, null, 2));
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
    );
    // Sotto la cartella media del server di test, non nel progetto e non nella MIA home:
    // l'allowlist che accetta un `previewImage` (server/utils.ts:isPathAllowed)
    // guarda la HOME DEL SERVER, che qui è isolata. Un'anteprima scritta altrove
    // viene scartata in silenzio e il test misurerebbe un drawer SENZA
    // anteprima — cioè non il caso peggiore, cioè niente.
    // The server's own media root is `TOPICS_HOME/media` (card 211605ee), and
    // in this bench TOPICS_HOME is not `$HOME/.topics`.
    const mediaDir = `${testServerEnv().TOPICS_HOME}/media`;
    mkdirSync(mediaDir, { recursive: true });
    previewPath = `${mediaDir}/e2e-drawer-2200x6010-${Date.now()}.png`;
    writeFileSync(previewPath, tallPng(2200, 6010));
    const topic = await createTopic(request, "E2E-Drawer", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    if (sessionTopicId) await deleteTopic(request, sessionTopicId);
    if (liveTopicId) await deleteTopic(request, liveTopicId);
    if (steerTopicId) await deleteTopic(request, steerTopicId);
    removeTmpDir(PROJECT_PATH);
    if (previewPath) rmSync(previewPath, { force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("DRAWER-01: dettagli e conversazione hanno uno scroll; composer fisso e Consegna raggiungibile", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-35" });
    await page.setViewportSize({ width: 1280, height: 720 });
    const task = await seedWorstCaseTask(page.request, previewPath);
    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);
    const drawer = page.getByTestId("task-detail-drawer");
    const session = drawer.getByTestId("task-session-column");
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    await expect(drawer.getByTestId("task-brief-scroll")).toHaveCount(0);
    await expandEverySection(page);

    const brief = session.getByTestId("task-brief-scroll");
    const scroller = session.getByTestId("task-conversation-scroll");
    await expect(brief).toBeVisible();
    expect(await brief.evaluate((el) => getComputedStyle(el).overflowY)).not.toMatch(/auto|scroll/);
    expect(await scrollableAncestors(page, "task-detail-subtasks")).toBe(1);
    const metrics = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    const composer = drawer.getByTestId("task-composer");
    await expect(composer).toBeInViewport();
    const composerBefore = (await composer.boundingBox())!;
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    const lastComment = session.getByText("Commento 30: una nota di lavoro lunga quanto basta a riempire il thread.", { exact: true });
    await expect(lastComment).toBeInViewport();
    const composerAfter = (await composer.boundingBox())!;
    expect(Math.abs(composerAfter.y - composerBefore.y), "scrolling the transcript does not move the composer").toBeLessThan(1);
    const commentBox = (await lastComment.boundingBox())!;
    expect(commentBox.y + commentBox.height, "the final comment clears the floating composer").toBeLessThanOrEqual(composerAfter.y);

    const drawerBox = (await drawer.boundingBox())!;
    const header = drawer.getByTestId("task-brief-header");
    await expect(header.getByText(task.text, { exact: true })).toBeInViewport();
    await expect(drawer.getByTestId("task-composer-submit")).toBeInViewport();
    await expect(drawer.getByTestId("task-reply-input")).toBeInViewport();
    // Details own metadata, description and subtasks; no delivery controls or image.
    await expect(brief.locator("img")).toHaveCount(0);
    await expect(brief.getByTestId("task-preview-open")).toHaveCount(0);
    await expect(drawer.getByTestId("task-approve")).toHaveCount(0);
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    const delivery = await openDelivery(page);
    await expect(brief).toHaveCount(0);
    expect(await scrollableAncestors(page, "task-review-actions")).toBe(1);
    const approve = delivery.getByTestId("task-approve");
    await expect(approve).toBeInViewport();
    const approveBox = (await approve.boundingBox())!;
    expect(approveBox.y + approveBox.height).toBeLessThanOrEqual(drawerBox.y + drawerBox.height + 1);
    await expect(drawer.getByTestId("task-composer-submit")).toBeInViewport();
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
  });

  test("DRAWER-02: la consegna apre una superficie solo su richiesta e torna alla conversazione", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const task = await seedWorstCaseTask(page.request, previewPath);
    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);
    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);
    await expect(drawer.getByTestId("task-brief-scroll").locator("img")).toHaveCount(0);
    const delivery = await openDelivery(page);
    await delivery.getByTestId("task-preview-open").click();

    const body = drawer.getByTestId("task-drawer-body");
    const session = drawer.getByTestId("task-session-column");
    await expect(body).toBeVisible();
    await expect(body.locator("img")).toBeVisible();
    await expect(session).toBeHidden();
    await expect(drawer.getByTestId("task-composer-submit")).toBeHidden();
    const bodyBox = (await body.boundingBox())!;
    expect(bodyBox.height).toBeGreaterThan(160);
    expect(bodyBox.height).toBeGreaterThanOrEqual((await body.locator("..").boundingBox())!.height - 1);
    await expect(drawer.getByTestId("task-brief-header").getByText(task.text, { exact: true })).toBeInViewport();
    // Even after opening its preview, one click returns to the delivery decisions.
    await drawer.getByTestId("task-delivery-toggle").click();
    await expect(delivery).toBeVisible();
    await expect(delivery.getByTestId("task-approve")).toBeInViewport();
    await expect(body).toHaveCount(0);

    await drawer.getByTestId("task-conversation-toggle").click();
    await expect(body).toHaveCount(0);
    await expect(session).toBeVisible();
    await expect(delivery).toHaveCount(0);
    await expect(drawer.getByTestId("task-composer-submit")).toBeInViewport();
    await expect(session.getByText("Commento 30: una nota di lavoro lunga quanto basta a riempire il thread.", { exact: true })).toHaveCount(1);
    // A returned conversation can open the same attachment again; closing the
    // view must not park or remove the task's pane from its saved layout.
    await drawer.getByTestId("task-workspace-toggle").click();
    await expect(body.locator("img")).toBeVisible();
    await expect(drawer.getByTestId("task-composer-submit")).toBeHidden();
    await drawer.getByTestId("task-conversation-toggle").click();
    await expect(session).toBeVisible();
    await expect(drawer.getByTestId("task-composer-submit")).toBeInViewport();
  });

  test("DRAWER-03: allargare espande la conversazione; il workspace si affianca solo su richiesta", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const task = await seedWorstCaseTask(page.request, previewPath);
    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);
    const drawer = page.getByTestId("task-detail-drawer");
    const session = drawer.getByTestId("task-session-column");
    const header = drawer.getByTestId("task-brief-header");
    await expect(header).toBeVisible();
    await expect(drawer.getByTestId("task-drawer-right")).toHaveCount(0);
    await drawer.getByTitle(/Allarga il drawer/).click();
    await expect(drawer.getByTestId("task-drawer-right")).toHaveCount(0);
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    const drawerBox = (await drawer.boundingBox())!;
    expect((await session.boundingBox())!.width).toBeGreaterThan(drawerBox.width * 0.8);

    await drawer.getByTestId("task-workspace-toggle").click();
    const right = drawer.getByTestId("task-drawer-right");
    await expect(right).toBeVisible();
    await expect(session).toBeVisible();
    const headerBox = (await header.boundingBox())!;
    const sessionBox = (await session.boundingBox())!;
    const rightBox = (await right.boundingBox())!;
    expect(headerBox.width).toBeGreaterThanOrEqual(drawerBox.width - 2);
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(rightBox.y + 1);
    expect(sessionBox.width).toBeGreaterThanOrEqual(320);
    expect(rightBox.width).toBeGreaterThanOrEqual(320);
    expect(rightBox.x).toBeGreaterThanOrEqual(sessionBox.x + sessionBox.width - 2);
    expect((await right.getByTestId("task-drawer-body").boundingBox())!.height).toBeGreaterThan(160);
    await expect(drawer.getByTestId("task-composer-submit")).toBeInViewport();
    await expect(drawer.getByTestId("task-reply-input")).toBeInViewport();
    const delivery = await openDelivery(page);
    await expect(delivery.getByTestId("task-approve")).toBeInViewport();

    await drawer.getByTestId("task-conversation-toggle").click();
    await expect(right).toHaveCount(0);
    await expect(session).toBeVisible();
    expect((await session.boundingBox())!.width).toBeGreaterThan(drawerBox.width * 0.8);
  });

  test("DRAWER-03b: in modo stretto il workspace ha spazio e il ritorno conserva la conversazione", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const task = await seedWorstCaseTask(page.request, previewPath);
    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);
    const drawer = page.getByTestId("task-detail-drawer");
    const session = drawer.getByTestId("task-session-column");
    const body = drawer.getByTestId("task-drawer-body");
    await expect(session).toBeVisible();
    await expect(body).toHaveCount(0);
    const composer = drawer.getByTestId("task-reply-input");
    await composer.fill("Bozza conservata mentre guardo la consegna");
    const comment = session.getByText("Commento 30: una nota di lavoro lunga quanto basta a riempire il thread.", { exact: true });
    await expect(comment).toBeVisible();
    await drawer.getByTestId("task-workspace-toggle").click();
    await expect(body).toBeVisible();
    await expect(session).toBeHidden();
    await expect(composer).toBeHidden();
    await expect(drawer.getByTestId("task-composer-submit")).toBeHidden();
    await expect(drawer.getByTestId("task-delivery-toggle")).toBeInViewport();
    expect((await body.boundingBox())!.height).toBeGreaterThan(160);
    expect((await body.boundingBox())!.height).toBeGreaterThanOrEqual((await body.locator("..").boundingBox())!.height - 1);
    await expect(body.getByTestId("task-session-column")).toHaveCount(0);
    await drawer.getByTestId("task-conversation-toggle").click();
    await expect(body).toHaveCount(0);
    await expect(comment).toBeVisible();
    await expect(composer).toBeInViewport();
    await expect(composer).toHaveValue("Bozza conservata mentre guardo la consegna");
    await expect(drawer.getByTestId("task-composer-submit")).toBeInViewport();
    expect((await session.boundingBox())!.height).toBeGreaterThan(160);
  });

  /**
   * DRAWER-04 - the agent's steps are IN THE CONVERSATION, and there is no
   * second surface holding them.
   *
   * They lived in a tab of their own for one release, and before that in a
   * collapsed sliver above every thread row. Both shapes made the reader do the
   * same join by hand: what the agent DID on one side, what it SAID on the
   * other, and the wall clock as the only thing relating them. One list now,
   * and this measures both halves of that sentence - the step is inside the
   * column you write in, and the tab that used to hold it does not exist.
   */
  test("DRAWER-04: il passo dell'agente sta nella conversazione, e la scheda Sessione non c'e' piu'", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const topic = await createTopic(page.request, `E2E-Drawer-Session-${Date.now()}`);
    sessionTopicId = topic.id;
    const step = `Passaggio dell'agente ${Date.now()}`;
    const task = await seedDispatchedTask(page.request, topic.id, step);

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);

    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);

    // The step is in the column with the composer, not behind a tab.
    const session = drawer.getByTestId("task-session-column");
    await expect(session).toBeVisible();
    await expect(session.getByText(step)).toBeVisible({ timeout: 15000 });

    // And the tab is GONE. The id was the persistence key of the old pane, so
    // this is also the assertion that no saved layout resurrects it.
    await expect(drawer.getByTestId(`pane-tab-session:${task.id}`)).toHaveCount(0);
    await expect(drawer.getByTestId("task-session-pane")).toHaveCount(0);
  });

  /**
   * DRAWER-05 — a live turn arrives on the WIRE, and the conversation is ONE
   * list: the agent's step, the reader's steer with where it got to, the
   * comment the agent wrote drawn ONCE, and a question answerable on the spot.
   *
   * The drawer used to ask for 200 rows of history every 3 seconds to notice a
   * token. It now reads the same store the chat reduces every frame into, and
   * to be fed at all it has to DECLARE its topic: per-token deltas are routed
   * on the subscribed set, and a drawer is not a pane.
   *
   * So there are three things to measure, and the negative one is the point:
   *  · the window really sends a `subscribe` frame carrying this topic;
   *  · live progress and tools stay folded but update when their details open;
   *  · the final reply is visible after `stream:end` without opening details;
   *  · zero history reads while the turn runs. The counter is armed AFTER the
   *    mount on purpose: mount, wake-up and `stream:end` are the three reads
   *    that survive, and none of them falls inside the window measured here.
   */
  test("DRAWER-05: avanzamento live nei dettagli, risposta visibile e steer consegnato una volta sola", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const topic = await createTopic(page.request, `E2E-Drawer-Live-${Date.now()}`);
    liveTopicId = topic.id;
    const seeded = `Passo seminato ${Date.now()}`;
    // `todo`, and the global auto-dispatch off for the length of the test.
    // "Queued" is a state of a card that still OWES a turn (KANBAN-74 lists
    // `in_progress` and `todo`), and `todo` is the one a test can hold still:
    // on `in_progress` the comment route resumes the agent for real, so the
    // chip would be racing the envelope that its own resume writes - a race
    // whose two outcomes are both correct, which is the definition of a test
    // that will flake.
    const settings = (await api(page.request, "get", "/api/all-boards/settings")) as { autoDispatch: boolean };
    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: false });
    await api(page.request, "post", "/api/test/dispatch-hold", { ms: 180_000 });
    const task = await seedDispatchedTask(page.request, topic.id, seeded, "todo");

    const list = await page.request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await list.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = Object.values(topics.topics).find((t) => t.id === topic.id)?.sessionKey;
    expect(sessionKey, "the bound topic must carry a sessionKey").toBeTruthy();

    // The socket, proxied: what the page SENDS is readable (the subscribe
    // frame), and frames can be pushed back as the server would push them.
    const sent: string[] = [];
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => { sent.push(String(m)); server.send(m); });
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });
    const send = (frame: Record<string, unknown>) =>
      inject!(JSON.stringify({ sessionKey, topicId: topic.id, ...frame }));

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text, "todo");
    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);
    // No tab to click: the steps are in the column you write in.
    const pane = drawer.getByTestId("task-session-column");
    // The mount read has happened: the seeded step is on screen. Everything
    // after this line is what the wire alone can do.
    await expect(pane.getByText(seeded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);

    // The declaration: this window asked to hear about the drawer's topic.
    const declares = (frame: string) => {
      const f = JSON.parse(frame) as { type?: string; topicIds?: string[] };
      return f.type === "subscribe" && (f.topicIds ?? []).includes(topic.id);
    };
    await expect.poll(() => sent.some(declares), { timeout: 10_000 }).toBe(true);

    // From here on, every history read is a regression.
    let historyReads = 0;
    await page.route("**/api/history/**", async (route) => { historyReads++; await route.fallback(); });

    const MSG = `live-drawer-${Date.now()}`;
    // Each piece must arrive in the opened session details while the turn is
    // still live. The initial closed state is checked before opening them.
    const PIECES = [
      "Sto leggendo il file. ",
      "La riga incriminata ",
      "e' la 214, ",
      "e non e' quella ",
      "che il rapporto indicava. ",
      "Il valore ci arriva ",
      "gia' arrotondato, ",
      "quindi la differenza ",
      "nasce prima, ",
      "in chi lo scrive. ",
      "Ho lasciato il confronto ",
      "in fondo al file.",
    ];
    send({ type: "stream:start", messageId: MSG });
    const liveRow = pane.getByTestId("task-session-item").last();
    const liveSummary = liveRow.getByTestId("task-work-summary").first();
    let written = "";
    for (const piece of PIECES) {
      send({ type: "stream:content_chunk", messageId: MSG, content: piece });
      written += piece;
      if (written === piece) {
        await expect(liveSummary).toHaveAttribute("aria-expanded", "false");
        await expect(liveRow.getByTestId("task-work-body")).toHaveCount(0);
        await expect(pane.getByText(written.trim(), { exact: true })).toHaveCount(0);
        await liveSummary.click();
      }
      await expect(liveRow.getByTestId("task-work-body")).toContainText(written.trim(), { timeout: 10_000 });
    }
    const LIVE_TOOL_ID = `read-drawer-${Date.now()}`;
    send({ type: "stream:tool_call", messageId: MSG,
      toolCall: { id: LIVE_TOOL_ID, name: "Read", args: { file_path: "source.ts" }, status: "running" },
    });
    await expect(liveRow.getByTestId(`tool-call-row-${LIVE_TOOL_ID}`)).toBeVisible();
    await liveSummary.click();
    await expect(liveSummary).toHaveAttribute("aria-expanded", "false");
    await expect(liveRow.getByTestId("task-work-body")).toHaveCount(0);
    await expect(pane.getByTestId(`tool-call-row-${LIVE_TOOL_ID}`)).toHaveCount(0);
    send({ type: "stream:tool_result", toolCallId: LIVE_TOOL_ID, status: "success", result: "Comparison ready." });
    const finalReply = `Il confronto finale e' pronto ${Date.now()}.`;
    send({ type: "stream:content_chunk", messageId: MSG, content: finalReply });
    expect(historyReads, "no history read while following a live turn").toBe(0);

    // The turn ends, and the drawer asks for the history again: that read is
    // NOT asserted here, and the reason is worth writing down. `loadHistory`
    // drops a re-fetch that lands within 5 seconds of the previous one, so at
    // this timescale the request never reaches the network and a counter here
    // would be measuring the dedup instead of the drawer. What the drawer does
    // with a `stream:end` (its own session only, never a neighbour's) is held
    // by the unit gate on the source, `Board/TaskDetail.test.ts`.
    send({ type: "stream:end", messageId: MSG, completed: true, latencyMs: 900 });
    await expect(pane.getByText(finalReply, { exact: true })).toBeVisible();
    await expect(pane.getByText(written.trim(), { exact: true })).toHaveCount(0);
    await expect(pane.getByTestId(`tool-call-row-${LIVE_TOOL_ID}`)).toHaveCount(0);
    expect(historyReads, "the turn ended, and still no poll behind it").toBe(0);

    // ── WHERE WHAT YOU WROTE GOT TO ───────────────────────────────────────
    // The steer goes in through the composer, like a person's does. The card
    // is `todo` and no envelope has gone out since, so the bubble says
    // "queued" - a state DERIVED from the envelopes at every read, which is
    // why nothing had to write it into the thread. The POST's own receipt says
    // `note` here (the route resumes an agent only from `review`/
    // `in_progress`), and it must NOT overrule that: it would print the quiet
    // button's wording, "no agent response requested", under words the person
    // just sent to the agent. The precedence is `chipKey.commentChip`.
    const steer = `Guarda anche il caso vuoto ${Date.now()}`;
    const composer = drawer.getByTestId("task-reply-input");
    await composer.fill(steer);
    await composer.press("Enter");
    await expect(pane.getByText(steer)).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("task-comment-queued").last()).toBeVisible({ timeout: 15_000 });

    // ── THE RESUME CARRIES IT, AND THE ENVELOPE DOES NOT SHOW ─────────────
    // The dispatcher's resume is a `user` row naming the comment ids it
    // delivered. Seeded here with the shape the server writes (T1 proves the
    // server writes it); what is measured is the projection: the row does not
    // appear, and the chip on the human bubble flips to "delivered".
    const withComments = (await (await page.request.get(
      `${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`,
    )).json()) as { comments?: Array<{ id: string; content: string }> };
    const steerId = withComments.comments?.find((c) => c.content.includes(steer))?.id;
    expect(steerId, "lo steer deve essere una riga del filo").toBeTruthy();
    const ENVELOPE = "Riprendi il lavoro sulla card.";
    await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "user",
      content: ENVELOPE,
      blocks: [{ kind: "dispatched-envelope", commentIds: [steerId] }],
    });

    // ── THE AGENT'S WORD, DRAWN ONCE ──────────────────────────────────────
    // An assistant row that called `comment_task`, and the comment that came
    // out of it, anchored by `messageId`. Two lists said this twice; here the
    // comment sits right under its step and the mirrored tool row is gone.
    const spoken = `Ho chiuso il caso vuoto ${Date.now()}`;
    const COMMENT_TOOL_ID = `tc-comment-${Date.now()}`;
    const step2 = (await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "assistant",
      content: "Chiuso.",
      blocks: [
        { kind: "text", text: "Chiuso." },
        { kind: "tool", toolCall: { id: COMMENT_TOOL_ID, name: "mcp__topics__comment_task", args: { content: spoken }, status: "success" } },
      ],
    })) as { message: { id: string } };
    await api(page.request, "post", `/api/test/tasks/${task.id}/anchored-comment`, {
      content: spoken, author: "agent", messageId: step2.message.id,
    });

    // ── A QUESTION NOBODY ROUTED IS ANSWERED HERE ─────────────────────────
    // Same tool family, no comment anchored to it: the row stays, and with it
    // the form. Before the conversation was one list this question was
    // answerable in the chat and dead in the card.
    const ASK_ID = `tc-ask-${Date.now()}`;
    await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "assistant",
      content: "",
      blocks: [{
        kind: "tool",
        toolCall: {
          id: ASK_ID,
          name: "mcp__topics__ask_user_question",
          args: {},
          status: "waiting_for_input",
          userInputSchema: {
            kind: "questions",
            questions: [{ question: "Tengo il caso vuoto fuori dallo scope?", options: [{ label: "Si" }, { label: "No" }] }],
          },
        },
      }],
    });

    // Nothing above went over the socket: those rows are in the transcript, and
    // the drawer reads it back at the END OF A TURN. So the end of the turn is
    // what gets asked for, again, until the projection has caught up. Asking
    // (rather than sleeping) is the point: `loadHistory` drops a re-read that
    // lands within 5 seconds of the last one, so a fixed wait here would be
    // measuring the dedup.
    const again = pane;
    await expect.poll(
      async () => {
        send({ type: "stream:end", messageId: MSG, completed: true, latencyMs: 900 });
        return again.getByTestId("task-comment-delivered").count();
      },
      { timeout: 40_000, intervals: [1_000, 2_000, 3_000, 3_000, 3_000] },
    ).toBeGreaterThan(0);

    // The envelope is not on screen, and the chip says it arrived.
    await expect(again.getByTestId("task-comment-delivered").last()).toBeVisible({ timeout: 20_000 });
    await expect(again.getByTestId("dispatch-envelope-row")).toHaveCount(0);
    await expect(again.getByText(ENVELOPE)).toHaveCount(0);

    // The agent's words: ONCE, right under the step they came out of, and the
    // mirrored tool row is not drawn. Counted on the text of the column rather
    // than on matching elements, because a bubble nests: two nodes carrying one
    // sentence is one drawing, and it is the DRAWINGS that must not be two.
    await expect(again.getByTestId(`tool-call-row-${COMMENT_TOOL_ID}`)).toHaveCount(0);
    const drawn = await again.evaluate((el, arg: { id: string; needle: string }) => {
      const step = el.querySelector(`[data-message-id="${arg.id}"]`);
      const leaf = [...el.querySelectorAll("*")].find((n) => n.children.length === 0 && (n.textContent ?? "").includes(arg.needle));
      return {
        times: (el.textContent ?? "").split(arg.needle).length - 1,
        order: step && leaf
          ? (step.compareDocumentPosition(leaf) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before")
          : "missing",
      };
    }, { id: step2.message.id, needle: spoken });
    expect(drawn.times, "la parola dell'agente e' disegnata una volta sola").toBe(1);
    expect(drawn.order, "il commento ancorato segue il suo passo").toBe("after");

    // …and the unrouted question is answerable right here.
    await expect(again.getByTestId(`tool-input-form-${ASK_ID}`)).toBeVisible({ timeout: 20_000 });

    // Widening a task with a live conversation does not open an unrelated
    // workspace. The reply, delivery chip and pending question keep the space.
    await page.setViewportSize({ width: 1600, height: 900 });
    const widen = drawer.getByTitle(/Allarga il drawer/);
    if (await widen.count()) await widen.click();
    await expect(drawer.getByTestId("task-drawer-right")).toHaveCount(0);
    await expect(again.getByTestId(`tool-input-form-${ASK_ID}`)).toBeVisible();
    await testInfo.attach("conversazione-unica-1600x900", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Back to whatever it was, not to `true`: the switch is GLOBAL and the DB
    // is shared, so a test that hands it back changed is a test that breaks the
    // next one (BOARD-01 reads it).
    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: settings.autoDispatch });
  });

  /**
   * DRAWER-06 - a steer written mid-turn shows up as a CHIP, not as a note.
   *
   * The dispatcher used to write two service rows to say where your message had
   * got to: one while the agent was working, one when the flush found the card
   * out of the queue. Both were STATE, and state is now carried by the chip
   * under the bubble: "queued" until the envelope goes out, "delivered" once it
   * does. The note said the same thing in the past tense, forever, next to the
   * words that already said it.
   *
   * THE BOUNDARY, declared: that the dispatcher no longer writes those rows is
   * held by its unit test (no `service` row while it buffers, and the envelope
   * carrying the `commentIds`). What is measured HERE is the surface, with the
   * same staging as DRAWER-05 - a card that still owes a turn, reconcile held:
   * no app row appears in the thread, and what says where the steer got to is
   * the chip, which changes when the envelope lands.
   */
  test("DRAWER-06: lo steer a turno vivo non produce nessuna nota, solo il chip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const topic = await createTopic(page.request, `E2E-Drawer-Steer-${Date.now()}`);
    steerTopicId = topic.id;
    const settings = (await api(page.request, "get", "/api/all-boards/settings")) as { autoDispatch: boolean };
    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: false });
    await api(page.request, "post", "/api/test/dispatch-hold", { ms: 120_000 });
    const seeded = `Passo seminato ${Date.now()}`;
    const task = await seedDispatchedTask(page.request, topic.id, seeded, "todo");

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text, "todo");
    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);
    const pane = drawer.getByTestId("task-session-column");
    await expect(pane.getByText(seeded)).toBeVisible({ timeout: 15_000 });
    const notesBefore = await pane.getByTestId("task-app-note").count();

    const steer = `Guarda anche il caso vuoto ${Date.now()}`;
    const composer = drawer.getByTestId("task-reply-input");
    await composer.fill(steer);
    await composer.press("Enter");

    // The bubble is yours and the chip is under it: not one extra row.
    await expect(pane.getByText(steer)).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("task-comment-queued").last()).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("task-app-note")).toHaveCount(notesBefore);
    await expect(pane.getByText(/Feedback ricevuto/)).toHaveCount(0);

    // And when the envelope goes out it is the SAME chip that changes word: one
    // row that updates, not two rows that both stay.
    const withComments = (await (await page.request.get(
      `${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`,
    )).json()) as { comments?: Array<{ id: string; content: string }> };
    const steerId = withComments.comments?.find((c) => c.content.includes(steer))?.id;
    expect(steerId, "the steer must be a row of the thread").toBeTruthy();
    await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "user",
      content: "Riprendi il lavoro sulla card.",
      blocks: [{ kind: "dispatched-envelope", commentIds: [steerId] }],
    });
    // The envelope row is in the transcript, which the drawer reads back at
    // MOUNT: one reload, instead of a wait on the clock.
    await page.reload();
    // The board is already open in the group (the "+" filters out the singleton
    // panes already there): wait for it to remount, do not reopen it.
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    await openTaskDrawer(page, task.text, "todo");
    const reopened = page.getByTestId("task-detail-drawer");
    await expect(reopened.getByTestId("task-comment-delivered").last()).toBeVisible({ timeout: 20_000 });
    await expect(reopened.getByTestId("dispatch-envelope-row")).toHaveCount(0);
    await expect(reopened.getByTestId("task-app-note")).toHaveCount(notesBefore);

    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: settings.autoDispatch });
  });

});

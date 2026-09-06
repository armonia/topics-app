/**
 * board-remote-node.spec.ts — a card chosen for a NODE says so, on both
 * surfaces, and keeps saying it after a reload.
 *
 * The case this pins. "Run it there" is a HUMAN choice (KANBAN-76): there is no
 * `auto` node and nothing moves a card because another machine is less loaded.
 * A choice nobody can see is a choice nobody makes, so it has to be readable in
 * the two places a person actually looks: the drawer, where it is taken, and
 * the card in its column, where the board is read without opening anything.
 *
 * And when the node goes silent the card must NOT look like a card that will
 * restart by itself. The deferral is the same deferral as any other, so the
 * generic branch would print a clock ("it starts again at 06:52") over a
 * machine that is simply off. The reason chip carries its own kind instead, in
 * both languages: a person who reads "node silent" goes and looks at the node,
 * a person who reads a clock waits for nothing.
 *
 * The paired row comes from the suite's setup verb (`POST /api/test/machines`):
 * the public way there is a handshake against a SECOND server, and an
 * end-to-end run has one.
 *
 * @covers KANBAN-76
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { beat, didascalia } from "./helpers/evidence";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const STAMP = Date.now();

/**
 * THE REAL PATH, not `/tmp`: the server stores a topic's `projectPath`
 * canonical, and the board id is a hash of that STRING. On macOS `/tmp` is a
 * symlink to `/private/tmp`, so a spec hashing the symlinked name creates its
 * cards on one board and the client opens another.
 */
const PROJECT_PATH = `${realpathSync("/tmp")}/e2e-node-${STAMP}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** Neutral on purpose: the chip's sentence changes language, the name does not. */
const NODE_NAME = "Kestrel";
const NODE_URL = "https://kestrel.test:3333";
const OFFLINE_NODE_NAME = "Merlin";

const PICKED = "Compilare il guscio per Windows";
const SILENT = "Riprovare la firma del pacchetto";

let projectTopicId: string | null = null;
let nodeId = "";
let offlineNodeId = "";
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok(), await res.text()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

/** The paired row, as the handshake would leave it. */
async function seedNode(request: any, name: string, baseUrl: string, status: "online" | "offline"): Promise<string> {
  const res = await request.post(`${BASE}/api/test/machines`, { data: { name, baseUrl, status } });
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { machine: { id: string } };
  return body.machine.id;
}

/**
 * The card as the dispatcher leaves it when the node did not answer: the
 * deferral (which also refunds the attempt) and the SENTINEL in
 * `dispatch_error`. Two writes because no single service call does both, which
 * is exactly what `deferForSilentNode` does in production.
 */
async function silenceNode(request: any, taskId: string): Promise<void> {
  const gate = await request.post(`${BASE}/api/test/tasks/${taskId}/dispatch-gate`, {
    data: { deferMinutes: 10, deferReason: `il nodo «${NODE_NAME}» non risponde` }, // allow-italian: the note the dispatcher writes
  });
  expect(gate.ok(), await gate.text()).toBe(true);
  const chip = await request.post(`${BASE}/api/test/tasks/${taskId}/dispatch-state`, {
    data: { state: "waiting", error: "node_unreachable" },
  });
  expect(chip.ok(), await chip.text()).toBe(true);
}

/**
 * Opens the project board, and is IDEMPOTENT: a test that reloads the page to
 * change language finds the kanban pane already seeded, and adding a second one
 * would put two copies of every card in the DOM.
 */
async function openProjectBoard(page: Page) {
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") {
    await section.click();
  }
  const row = projectRow(page, /e2e-node-/);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const board = page.getByTestId("kanban-board");
  if (await board.first().isVisible({ timeout: 3000 }).catch(() => false)) return;

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      await item.click();
      await expect(board).toBeVisible({ timeout: 10000 });
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("no + menu with a Board (kanban) entry found");
}

/** Writes the language in BOTH stores the app reads: `localStorage` paints the
 *  first frame, `ui_state` hydrates right after. One alone means watching the
 *  page turn back. */
async function speak(page: Page, language: "it" | "en"): Promise<void> {
  await page.request.put(`${API}/ui-state/settings`, { data: { language } });
  await page.addInitScript((lang) => {
    const KEY = "app-settings";
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>; } catch { /* empty */ }
    localStorage.setItem(KEY, JSON.stringify({ ...cur, language: lang }));
  }, language);
}

test.describe.serial("Una card che gira su un nodo", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-node" }, null, 2));
    projectTopicId = (await createTopic(request, `E2E-Node-${STAMP}`, { projectPath: PROJECT_PATH })).id;
    nodeId = await seedNode(request, NODE_NAME, NODE_URL, "online");
    offlineNodeId = await seedNode(request, OFFLINE_NODE_NAME, "https://merlin.test:3333", "offline");
  });

  test.afterAll(async ({ request }) => {
    // Language is a USER preference shared by the whole suite: leaving it in
    // English would redden every Italian spec that runs after.
    await request.put(`${API}/ui-state/settings`, { data: { language: "auto" } }).catch(() => {});
    // The cards let go of the node FIRST: a machine still named by one is a
    // declared conflict (MACHINE-02), and deleting a card is an archive, so the
    // count that raises that conflict does not go down on its own.
    for (const id of [...createdTasks].reverse()) {
      await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data: { machineId: null } }).catch(() => {});
      await deleteTask(request, PROJECT_ID, id).catch(() => {});
    }
    for (const id of [nodeId, offlineNodeId]) {
      if (id) await request.delete(`${API}/machines/${id}`).catch(() => {});
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("il nodo si sceglie nella scheda, la colonna lo dice, e il ricarico lo tiene", async ({ page, request }) => {
    const card = await createTask(request, { text: PICKED, status: "todo" });

    await page.goto("/");
    await openProjectBoard(page);
    const cardEl = page.locator(`[data-task-card="${card.id}"]`);
    await expect(cardEl).toBeVisible({ timeout: 10000 });

    // Before the choice the card says NOTHING about where it runs: absent means
    // "here", and printing that on every card would be noise on all of them to
    // inform one.
    await expect(cardEl.getByTestId("card-node-chip")).toHaveCount(0);
    await didascalia(page, "Una card senza nodo non dice niente: «assente» vuol dire «qui»");
    await beat(page, 2000);

    await cardEl.getByText(PICKED).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    const chip = drawer.getByTestId("task-node-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("qui");
    await chip.click();

    // The picker lists the paired NODES and never this machine as a target: the
    // local row is "here", and offering it as a place to run "there" would be
    // the same choice twice under two names. Liveness is on the row, so a node
    // that stopped answering is visible before it is picked.
    const here = page.getByRole("option", { name: /Questa macchina/ });
    await expect(here).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("option", { name: new RegExp(NODE_NAME) })).toContainText("in linea");
    await expect(page.getByRole("option", { name: new RegExp(OFFLINE_NODE_NAME) })).toContainText("non risponde");
    await didascalia(page, "I nodi accoppiati, con la loro vitalità — mai «questa macchina» come destinazione");
    await beat(page, 2400);

    await page.getByRole("option", { name: new RegExp(NODE_NAME) }).click();
    await expect(chip).toContainText(NODE_NAME, { timeout: 10000 });

    // The choice reached the row, not just the label: this is the field the
    // dispatcher reads to take the remote lane.
    await expect
      .poll(async () => {
        const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${card.id}`);
        return res.ok() ? ((await res.json()) as { task?: { machineId?: string | null } }).task?.machineId ?? null : null;
      }, { timeout: 10000 })
      .toBe(nodeId);

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5000 });

    // THE COLUMN, which is where the board is read without opening anything.
    await expect(cardEl.getByTestId("card-node-chip")).toContainText(`su ${NODE_NAME}`, { timeout: 10000 });
    await didascalia(page, `La card dice «su ${NODE_NAME}» dalla colonna, senza aprire niente`);
    await beat(page, 2400);

    // AFTER A RELOAD: the choice is a row in the database, not a state of this
    // document. A chip that survives only until F5 would have been a label.
    await page.reload();
    await openProjectBoard(page);
    await expect(page.locator(`[data-task-card="${card.id}"]`).getByTestId("card-node-chip"))
      .toContainText(`su ${NODE_NAME}`, { timeout: 15000 });
    await didascalia(page, "Ricaricata: la scelta è una riga, non un'etichetta");
    await beat(page, 2200);
  });

  test("il nodo muto ha il suo chip, e lo dice nelle due lingue", async ({ page, request }) => {
    const card = await createTask(request, { text: SILENT, status: "todo" });
    const pointed = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${card.id}`, {
      data: { machineId: nodeId },
    });
    expect(pointed.ok(), await pointed.text()).toBe(true);
    await silenceNode(request, card.id);

    await page.goto("/");
    await openProjectBoard(page);
    const cardEl = page.locator(`[data-task-card="${card.id}"]`);
    await expect(cardEl).toBeVisible({ timeout: 10000 });

    // NOT the generic deferral, which would print a clock over a machine that
    // is off, and the tone says it does not restart on its own.
    const reason = cardEl.getByTestId("queue-reason-chip");
    await expect(reason).toHaveAttribute("data-kind", "node_unreachable", { timeout: 15000 });
    await expect(reason).toHaveAttribute("data-tone", "stalled");
    // The chip NAMES the node: an id in that sentence would name nothing to
    // whoever reads it.
    await expect(reason).toHaveText(`nodo muto · ${NODE_NAME} non risponde`);
    await didascalia(page, `«nodo muto · ${NODE_NAME} non risponde» — non un orologio`);
    await beat(page, 2400);

    // THE OTHER HALF: that an English sentence exists at all. The whole board
    // suite runs in Italian, so a key added to one catalogue only would pass
    // every other spec and stay Italian in an app that declares `lang="en"`.
    await speak(page, "en");
    await page.reload();
    await openProjectBoard(page);
    const enCard = page.locator(`[data-task-card="${card.id}"]`);
    const enReason = enCard.getByTestId("queue-reason-chip");
    await expect(enReason).toHaveAttribute("data-kind", "node_unreachable", { timeout: 15000 });
    await expect(enReason).toHaveText(`node silent · ${NODE_NAME} is not answering`);
    await expect(enCard.getByTestId("card-node-chip")).toContainText(`on ${NODE_NAME}`);
    await didascalia(page, "In inglese la stessa card dice «node silent», non un italiano rimasto lì");
    await beat(page, 2400);
  });
});

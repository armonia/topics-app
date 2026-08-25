/**
 * board-card-layout-preview.spec.ts - the delivery preview of the card that
 * stopped changing shape when it crosses a column boundary.
 *
 * WHAT IT PROVES, in one frame. Three columns side by side, seeded so that the
 * same card reads the same way in each of them:
 *   1. the subtask CHECKLIST is drawn in EVERY column, not only in review;
 *   2. the order inside the card is title, meta chips, checklist, description;
 *   3. the turn measures live in the card FOOT (state, model, git changes),
 *      with the last update closing the row on the right;
 *   4. the git changes are a compact CHIP that drops a list under itself, not
 *      a panel that takes over the card.
 *
 * WHY A SPEC AND NOT A HAND CAPTURE. The states that make the point are not
 * reachable by clicking: `dispatch_state` is written only by the dispatcher and
 * the delivery diffstat only by a real delivery, so both come from the test
 * doors (`/api/test/.../dispatch-state`, `/api/test/.../delivery`) that pass
 * through the real services. The project directory is a real git repository
 * with a real delivery commit, so the file list in the dropdown is git talking,
 * not a fixture.
 *
 * THE IMAGE IS THE DELIVERABLE. It is cropped to the three columns instead of
 * the whole window: a board preview is read at 268px wide on a task card, and
 * at that scale the app chrome is what eats the pixels the cards need.
 *
 * @covers KANBAN-01
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-cardpreview-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);
const BRANCH = "topics/e2e-card-preview";

/**
 * Where the preview lands. It is an ATTACHMENT of the review, not repo content.
 * Derived at runtime and never written as a literal: a home path inside a
 * tracked file names the person who ran it, and this repository is public
 * (`tests/unit/no-personal-data-tracked.test.ts` refuses one).
 */
const SHOT = process.env.CARD_PREVIEW_OUT ?? join(homedir(), ".topics", "media", "card-layout-preview.png");

/** The columns the frame shows. Todo is the one that used to have no checklist. */
const COLUMNS = ["todo", "in_progress", "review"] as const;

let projectTopicId: string | null = null;
let deliveryCommit = "";
const createdTasks: string[] = [];

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: PROJECT_PATH,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  }).trim();
}

function write(rel: string, body: string): void {
  mkdirSync(dirname(`${PROJECT_PATH}/${rel}`), { recursive: true });
  writeFileSync(`${PROJECT_PATH}/${rel}`, body);
}

/**
 * A real repository with a real delivery commit off main.
 *
 * The diff route resolves three anchors in order and the only one reachable
 * from a test is the DELIVERY COMMIT: it needs the commit to still hold work of
 * its own outside `main`, which is why the branch is left unmerged.
 */
function seedRepo(): void {
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cardpreview" }, null, 2));
  git(["init", "-q", "-b", "main"]);
  write("src/card.ts", "export const card = () => 'before';\n");
  write("src/column.ts", "export const column = () => 'before';\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["checkout", "-q", "-b", BRANCH]);
  write("src/card.ts", "export const card = () => 'after';\nexport const foot = () => 'model, git, updated';\n");
  write("src/column.ts", "export const column = () => 'after';\n");
  write("src/checklist.ts", "export const checklist = () => 'in every column';\n");
  write("src/deliveryFiles.ts", "export const dropdown = () => 'under the chip';\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "the card stops changing shape"]);
  deliveryCommit = git(["rev-parse", "HEAD"]);
  // Back on main so the delivery commit is genuinely outside the integration
  // branch, which is the shape the route knows how to measure.
  git(["checkout", "-q", "main"]);
}

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

/** A root plus its steps, some of them already closed. */
async function createWithSteps(
  request: any,
  root: Record<string, unknown>,
  steps: Array<{ text: string; done?: boolean }>,
): Promise<{ id: string }> {
  const parent = await createTask(request, root);
  for (const s of steps) {
    const step = await createTask(request, { text: s.text, parentTaskId: parent.id });
    if (s.done) {
      const r = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${step.id}`, { data: { status: "done" } });
      expect(r.ok()).toBe(true);
    }
  }
  return parent;
}

async function setLabels(request: any, taskId: string, labels: string[]): Promise<void> {
  const res = await request.put(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}/labels`, { data: { labels } });
  // Soft on purpose: the labels are a chip in the meta row, not the fact this
  // frame exists to show. A refusal here must not cost the picture.
  expect.soft(res.ok(), `labels ${labels.join(",")}: ${res.status()}`).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-cardpreview/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const before = await paneTabLabels(page);
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
  await closeOtherPanes(page, before);
  // The app sidebar folds away if the shortcut lands: it is chrome the frame
  // does not want, and it is room the columns do. Best effort on purpose, the
  // crop below measures what is actually there instead of assuming it worked.
  await page.keyboard.press("Meta+b");
}

/**
 * The board alone in the project window.
 *
 * The `+` menu SPLITS, so the board is born sharing the width with whatever the
 * window already had open. Half a window fits two columns, and the third is the
 * one the frame exists to compare against. The tabs that were there before are
 * identified by their close control's aria-label, which carries the pane id.
 */
async function closeOtherPanes(page: Page, before: string[]): Promise<void> {
  const win = page.getByTestId("project-window");
  for (const label of before) {
    const close = win.locator(`[data-testid="pane-tab-close"][aria-label="${label}"]`);
    if ((await close.count()) === 0) continue;
    await close.first().click({ force: true }).catch(() => {});
  }
  // The window itself must survive: the OUTER tab bar carries a close control
  // for the project pane too, and closing that one takes the whole thing away.
  await expect(win).toBeVisible();
  await expect(page.getByTestId("kanban-board")).toBeVisible();
}

/**
 * The close controls of the tabs INSIDE the project window, by aria-label
 * (which holds the pane id). Scoped on purpose: the same testid names the
 * project pane's own tab out in the app tab bar.
 */
async function paneTabLabels(page: Page): Promise<string[]> {
  return page.getByTestId("project-window").locator('[data-testid="pane-tab-close"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") ?? "").filter((l) => l.length > 0),
  );
}

test.describe("Preview della card della board", () => {
  test.describe.configure({ timeout: 180_000 });
  // Wide enough that the three columns of the frame stand side by side without
  // the row having to scroll under the crop.
  // Three whole columns need about 1100px of ROW, and the row is what is left
  // of the window after the app sidebar and the project rail: measured, 1440
  // leaves 970 and cuts one. The window is only a stage, the image written is
  // the crop. Rendered at 2x so it survives the reduction to the 268px a
  // preview is read at.
  test.use({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2 });

  test.beforeAll(async ({ request }) => {
    seedRepo();
    const topic = await createTopic(request, "E2E-CardPreview", { projectPath: PROJECT_PATH });
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

  test("tre colonne, la stessa card: checklist ovunque e le misure nel piede", async ({ page, request }) => {
    // TODO. The column that used to get a mute `1/3` instead of the steps.
    const todo = await createWithSteps(
      request,
      {
        text: "Portare la checklist in ogni colonna",
        description: "La card cambiava forma passando di colonna: in review si apriva la lista dei passi, altrove restava un contatore muto. Stessa card, stessa lettura, ovunque.",
        status: "todo",
        priority: 4,
        model: "opus",
      },
      [
        { text: "Togliere il cancello su status === review", done: true },
        { text: "Chiedere i figli a chi ne ha", done: false },
        { text: "Tenere il contatore come ripiego", done: false },
      ],
    );
    await setLabels(request, todo.id, ["feature", "visibile"]);

    // IN PROGRESS. The agent is writing: the foot carries the dispatch chip,
    // the model, and the git chip that has no numbers yet because the delivery
    // has not been measured.
    const running = await createWithSteps(
      request,
      {
        text: "Spostare le misure del turno nel piede",
        description: "Modello, tempo, token e ultimo aggiornamento stavano sparsi in cima e in mezzo: ora chiudono la card, e l'ultimo aggiornamento sta a destra.",
        status: "in_progress",
        model: "sonnet",
      },
      [
        { text: "Una riga sola, sempre montata", done: true },
        { text: "L'ultimo aggiornamento a destra", done: false },
      ],
    );
    await setLabels(request, running.id, ["chore"]);
    const st = await request.post(`${BASE}/api/test/tasks/${running.id}/dispatch-state`, { data: { state: "working" } });
    expect(st.ok()).toBe(true);

    // REVIEW. The delivery is measured, so the git chip carries the numbers and
    // the dropdown has a real file list behind it.
    const review = await createWithSteps(
      request,
      {
        text: "Le modifiche git diventano un chip che si apre",
        description: "Il pannello a tutta card e' diventato una tendina larga quanto basta, accanto al modello che quelle righe le ha scritte.",
        status: "review",
        model: "opus",
      },
      [
        { text: "Chip chiuso col conto dei file", done: true },
        { text: "Tendina sotto al chip, non sopra la card", done: true },
        { text: "Percorso tagliato a sinistra", done: false },
      ],
    );
    await setLabels(request, review.id, ["feature"]);
    const del = await request.post(`${BASE}/api/test/tasks/${review.id}/delivery`, {
      data: { branch: BRANCH, commit: deliveryCommit, filesChanged: 4, insertions: 6, deletions: 2 },
    });
    expect(del.ok()).toBe(true);

    // The dropdown shows what git says, so the route must have an answer BEFORE
    // the frame is taken: an empty list would be a different statement.
    const diff = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${review.id}/diff`);
    expect(diff.ok()).toBe(true);
    const diffBody = (await diff.json()) as { stat?: Array<{ path: string }>; code?: string };
    expect.soft(diffBody.stat?.length ?? 0, `diff route said ${diffBody.code ?? "nothing"}`).toBeGreaterThan(0);

    await page.goto("/");
    await openProjectBoard(page);

    // THE THREE CARDS ARE THERE, and the checklist with them. This is the
    // assertion the picture illustrates: a step of the TODO card, drawn as a
    // row and not as a counter.
    for (const id of [todo.id, running.id, review.id]) {
      await expect(page.locator(`[data-task-card="${id}"]`)).toBeVisible({ timeout: 10000 });
    }
    const todoCard = page.locator(`[data-task-card="${todo.id}"]`);
    await expect(todoCard).toContainText("Chiedere i figli a chi ne ha", { timeout: 10000 });
    await expect(todoCard.getByTestId("card-foot")).toBeVisible();

    // The git chip of the review card, opened: the frame has to show the shape
    // of the dropdown, which is the whole point of the change.
    const gitChip = page.locator(`[data-task-card="${review.id}"]`).getByTestId("card-delivery-files-toggle");
    await expect(gitChip).toBeVisible();
    await gitChip.click();
    const fileList = page.locator(`[data-task-card="${review.id}"]`).getByTestId("card-delivery-files-list");
    // Waited for, not asserted yet: the frame is the deliverable and it gets
    // taken either way. The verdict on what it contains comes after the shot,
    // so a weak picture goes red WITH the picture on disk to look at.
    const listShown = await fileList.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
    if (listShown) await fileList.getByText("checklist.ts").waitFor({ timeout: 10000 }).catch(() => {});

    // The working card carries its own git chip, the one without numbers.
    await expect(
      page.locator(`[data-task-card="${running.id}"]`).getByTestId("card-delivery-files-toggle"),
    ).toBeVisible();

    // THE CROP. Measured from the columns themselves, so the frame follows the
    // layout instead of hard-coded pixels. Only the columns that fit whole are
    // taken: half a column reads as a rendering fault.
    // A card in progress with auto-dispatch off gets requeued to todo by the
    // server's reconcile, and the frame would lose the state it exists to show.
    // Re-stated right before the shot, which is the only moment that matters.
    await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${running.id}`, { data: { status: "in_progress" } });
    await request.post(`${BASE}/api/test/tasks/${running.id}/dispatch-state`, { data: { state: "working" } });
    await expect(
      page.getByTestId("kanban-column-in_progress").locator(`[data-task-card="${running.id}"]`),
    ).toBeVisible({ timeout: 10000 });

    // Bring the three columns to the left edge of the scrolling row: at any
    // window width the row starts on `backlog`, which is not in the frame.
    // Measured on the RENDERED rectangles, not on `offsetLeft`: the column and
    // the row do not share an offset parent, and the difference is a scroll
    // that lands somewhere else.
    await page.evaluate(() => {
      const col = document.querySelector("[data-testid='kanban-column-todo']") as HTMLElement | null;
      const row = col?.parentElement;
      if (col && row) row.scrollLeft += col.getBoundingClientRect().left - row.getBoundingClientRect().left;
    });
    await expect(page.getByTestId("kanban-column-review")).toBeVisible();

    // The row is a CLIPPING box, and `boundingBox()` does not know it: a column
    // scrolled out of view still reports a rectangle, and cropping to it framed
    // the neighbouring pane instead. A column counts only when its rectangle is
    // whole inside the row.
    // The frame is the BOARD's own rectangle. The column's parent is the
    // scrolled CONTENT box, which starts left of the screen once the row has
    // scrolled: measured against it, a half-hidden column looked whole and the
    // crop opened on a card cut down the middle.
    const rowBox = (await page.getByTestId("kanban-board").boundingBox())!;
    const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const status of COLUMNS) {
      const b = await page.getByTestId(`kanban-column-${status}`).boundingBox();
      if (b) boxes.push(b);
    }
    expect(boxes.length).toBe(COLUMNS.length);
    const view = page.viewportSize()!;
    const kept = boxes.filter(
      (b) => b.x >= rowBox.x - 1 && b.x + b.width <= Math.min(rowBox.x + rowBox.width, view.width) + 1,
    );
    expect(kept.length).toBeGreaterThanOrEqual(2);
    const left = Math.min(...kept.map((b) => b.x));
    const top = Math.min(...kept.map((b) => b.y));
    // The open dropdown hangs a little past the column it belongs to: cutting
    // it would turn the very thing the frame is showing into a rendering fault.
    const dropRight = await fileList.boundingBox().then((b) => (b ? b.x + b.width : 0), () => 0);
    const right = Math.min(
      Math.max(...kept.map((b) => b.x + b.width), dropRight + 6),
      view.width,
    );

    // The height is the CONTENT, not the empty run of the columns: the tallest
    // card decides where the frame ends, plus the dropdown when it hangs lower.
    const bottoms = await page.evaluate((frame: { left: number; right: number }) => {
      const nodes = Array.from(document.querySelectorAll("[data-task-card], [data-testid='card-delivery-files-list']"));
      return nodes
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.left >= frame.left - 1 && r.right <= frame.right + 1)
        .map((r) => r.bottom);
    }, { left, right });
    const content = Math.max(...bottoms) + 14;
    const width = Math.min(right, view.width) - left;
    // A preview is read wide, not tall: the cap keeps height/width at 0.70 even
    // when a column runs long.
    const height = Math.min(content - top, view.height - top, width * 0.7);

    mkdirSync(dirname(SHOT), { recursive: true });
    await page.screenshot({
      path: SHOT,
      clip: { x: left, y: top, width, height },
    });
    process.stdout.write(
      `[card-layout-preview] ${SHOT} clip=${Math.round(width)}x${Math.round(height)} css px, ` +
      `${kept.length} columns\n`,
    );

    // NOW the verdict on what the frame carries. The list of files behind the
    // chip is git talking: an empty dropdown would make the picture a mock-up.
    expect(listShown, "the git changes dropdown never opened").toBe(true);
    await expect(fileList).toContainText("checklist.ts");
    // Two whole columns are the floor, and they already carry the point: the
    // checklist standing in a column that is not review. The third is what
    // makes the comparison complete, so a narrow window degrades the frame
    // instead of failing it.
    expect(kept.length, "no column fit the frame whole").toBeGreaterThanOrEqual(2);
  });
});

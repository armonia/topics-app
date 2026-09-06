/**
 * plan-surface.spec.ts — the "Plan" tab reads without scrolling sideways.
 *
 * The other half of the measurement. `client/src/components/Board/planSurface.test.ts`
 * pins the TREE (no `<pre>`, one `<p>`, the options as a list); here we
 * measure the GEOMETRY, which a static tree cannot see: a `<pre>` is wide
 * only after layout, and that is where the plan became unreadable.
 * "proposit plan" and a half word were exactly that: the tab header and the
 * piece of a long word that fell inside the visible window of the block.
 *
 * THE SEED IS THE REAL ONE. The plan is POSTED through the agent's door
 * (`POST /api/sessions/:key/tasks/:id/comments` with `options`), i.e. the only
 * one that composes the ```question fence, and the test checks that the saved
 * comment is byte for byte the fixture `plan-comment.saved.md` the unit test
 * renders. Should the server change that layout, the fixture pair would fall
 * out of parity and this file would go red: that is how we avoid measuring
 * a shape the product no longer produces.
 *
 * @covers KANBAN-07
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath, PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";


hermetic(test);

const BASE = E2E_BASE;
/**
 * THE PATH MUST BE CANONICAL, and it is not a detail of the bench.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, and the server canonicalises
 * a topic's `projectPath` (`canonicalProjectPath`, realpath). The board id is
 * a hash of the path: creating the task on `boardIdForPath('/tmp/…')` and
 * commenting on it through the agent's door — which resolves the board from
 * the canonical path of its topic — gives two DIFFERENT boards, and the
 * comment comes back "task not found" on a task that exists. Measured on 09-03.
 *
 * So the path is built on the canonical root (`canonicalTmpRoot`), and that
 * is the only spelling this file ever uses.
 */
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-plan-surface-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const FIXTURES = join(__dirname, "..", "..", "client", "src", "components", "Board", "__fixtures__");
/** The plan AS THE AGENT WRITES IT (no fence: the server composes it). */
const PLAN_TEXT = readFileSync(join(FIXTURES, "plan-comment.md"), "utf8").trim();
/** The comment as the server SAVES it, i.e. what the unit test renders. */
const PLAN_SAVED = readFileSync(join(FIXTURES, "plan-comment.saved.md"), "utf8").trim();
/** The options of the saved fixture, in the same order (the last is legacy). */
const PLAN_OPTIONS = [PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL, "Landa e pubblica"];

/**
 * The second seed: a plan with a long token and no spaces.
 *
 * Not a textbook case, it is what a plan always contains: a path. In a
 * `<pre>` it widens the block as much as it is long; in prose it must wrap
 * (`break-words`). If somebody removed that class the tree would stay
 * identical and only this measurement would go red.
 */
const PLAN_LONG_TOKEN = "Riparto dal commit 9f2c7a41b5d83e60c1fa47b92d0e5638ac71d942b6e30af58c92d17b4e063cab e tocco un file solo.";

const EVIDENCE_DIR = join(__dirname, "..", "..", "test-results", "plan-surface");

const createdTasks: string[] = [];
let projectTopicId: string | null = null;

async function apiCreatePlanTask(request: APIRequestContext, text: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text, status: "in_progress", planFirst: true },
  });
  expect(res.ok(), `create → ${res.status()}`).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task.id;
}

/** The plan comes through the AGENT's door: the only one that composes the fence. */
async function seedPlanComment(request: APIRequestContext, taskId: string, content: string): Promise<string> {
  const key = `topic:${projectTopicId!.slice(0, 8)}`;
  const res = await request.post(`${BASE}/api/sessions/${encodeURIComponent(key)}/tasks/${taskId}/comments`, {
    data: { content, options: PLAN_OPTIONS },
  });
  expect(res.status(), await res.text()).toBe(201);
  const comment = (await res.json()) as { id: string; content: string };
  // THE SEED TAKES, OR WE STOP HERE. The Plan tab exists only if the server
  // has POINTED at this comment (`planCommentId`): without the check, the red
  // would come 15 s later, as a tab that does not appear, and it would talk
  // about the client instead of the seed.
  const back = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`);
  const { task } = (await back.json()) as { task: { planFirst?: boolean; planCommentId?: string } };
  expect(task.planFirst, "il task non e' piano-prima").toBe(true);
  expect(task.planCommentId, "il server non ha puntato il commento come piano").toBe(comment.id);
  return comment.content.trim();
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-plan-surface/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="project-window"][data-project-path*="e2e-plan-surface-"]')).toBeVisible({ timeout: 10000 });
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

/** Opens the task drawer and brings the Plan tab in front of us. */
/**
 * The delivery preview: the Plan tab ALONE, not the whole window. It turns on
 * with `E2E_EVIDENCE=1` (the same lever as the rest of the suite) and serves
 * to put the before/after on a card, where it is looked at 268px wide.
 */
async function shotPlanPanel(page: Page, name: string) {
  if (process.env.E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const panel = page.getByTestId("plan-surface-body").locator("xpath=..");
  await panel.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });
}

async function openPlanTab(page: Page, taskId: string, text: string) {
  await page.getByTestId("kanban-column-in_progress").getByText(text).click({ timeout: 15000 });
  const drawer = page.getByTestId("task-detail-drawer");
  await expect(drawer).toBeVisible({ timeout: 10000 });
  // The workspace may be folded: the tab lives inside it. The state is
  // DECLARED by the button (`data-open`), and when it is the only thing to
  // see it is open and disabled: asking for the chevron clicked a disabled button.
  const workspace = drawer.getByTestId("task-workspace-toggle");
  if ((await workspace.count()) > 0 && (await workspace.first().getAttribute("data-open")) === "0") {
    await workspace.first().click();
  }
  const tab = page.getByTestId(`pane-tab-plan:${taskId}`);
  await expect(tab, "la tab Piano non c'e': il server non ha puntato il commento del piano").toBeVisible({ timeout: 15000 });
  await tab.click();
  await expect(page.getByTestId("plan-surface-body")).toBeVisible({ timeout: 10000 });
}

/** Content width against box width, on the node and on every child. */
async function overflowingWidths(page: Page): Promise<{ tag: string; scrollWidth: number; clientWidth: number }[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="plan-surface-body"]');
    if (!root) return [{ tag: "MISSING", scrollWidth: 1, clientWidth: 0 }];
    const nodes = [root, ...Array.from(root.querySelectorAll("*"))] as HTMLElement[];
    return nodes
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => ({ tag: el.tagName, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  });
}

test.describe("Tab Piano", () => {
  test.describe.configure({ timeout: 90_000 });

  const seeded: { id: string; text: string }[] = [];

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-plan-surface" }, null, 2));
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const topic = await createTopic(request, "E2E-Plan", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;

    const stamp = Date.now();
    for (const [i, plan] of [PLAN_TEXT, PLAN_LONG_TOKEN].entries()) {
      const text = `Piano ${i + 1} ${stamp}`;
      const id = await apiCreatePlanTask(request, text);
      const saved = await seedPlanComment(request, id, plan);
      if (i === 0) {
        expect(saved, "la fixture salvata non e' piu' cio' che il server compone").toBe(PLAN_SAVED);
      }
      expect(saved.startsWith("```question"), "il seme deve portare il recinto").toBe(true);
      seeded.push({ id, text });
    }
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

  test("PLANTAB-01: nessun piano si legge scorrendo di lato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    test.info().annotations.push({ type: "spec", description: "PLANTAB-01" });
    await page.goto("/");
    await openProjectBoard(page);

    for (const [i, { id, text }] of seeded.entries()) {
      await openPlanTab(page, id, text);
      await shotPlanPanel(page, `piano-${i + 1}`);
      const body = page.getByTestId("plan-surface-body");
      // The tree: the fence is no longer a preformatted block.
      await expect(body.locator("pre")).toHaveCount(0);
      expect(await body.locator("p").count()).toBeGreaterThan(0);
      // The geometry: nothing overflows horizontally, in the body or below it.
      expect(await overflowingWidths(page), `${text}: qualcosa deborda in orizzontale`).toEqual([]);
      await page.keyboard.press("Escape");
    }
  });

  test("PLANTAB-02: il testo si legge intero, e le opzioni sono un elenco", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    await page.goto("/");
    await openProjectBoard(page);
    const [primo] = seeded;
    await openPlanTab(page, primo.id, primo.text);

    const body = page.getByTestId("plan-surface-body");
    // The word that showed up cut in half: whole, and inside the prose.
    await expect(body).toContainText("allegata");
    await expect(body).not.toContainText("```");

    const options = page.getByTestId("plan-surface-options");
    await expect(options.locator("li")).toHaveCount(2);
    await expect(options).toContainText(PLAN_APPROVE_LABEL);
    // Land and publish is a merge+push in one click: it stays out, always.
    await expect(options).not.toContainText("Landa e pubblica");
  });
});

/**
 * board-group-density.spec.ts — the cross-project board grouped by project,
 * and the compact card, the same in the Kanban and in the Plan.
 *
 * Two projects, two cards each in different columns: with one project a lane
 * would be indistinguishable from the flat board. One card is bound to a live
 * session, because the compact card must keep the session door the full card
 * has (the «sessions around» of the request).
 *
 * The reload is the proof the two choices are preferences of whoever looks at
 * the board, not component state. Folding a lane and then opening the Plan is
 * the proof the two views share one folded set.
 *
 * The second project is named «zeta» and holds the card in review: it waits
 * for a person, so BOTH the lanes and the Plan list it BEFORE «alfa»: the two
 * views share one order (waiting for the person first, then by name). The
 * review card is also the proof the compact card keeps the wait in sight.
 *
 * Then the same grouped board, read against the Plan and against the composer:
 * a project REGISTERED under a name that differs from its folder has the same
 * heading and the same place in both views; the composer's ghost sits in its
 * project's lane (a temporary lane when the project has no card, always open
 * even if folded) or, on «Automatico», above the lanes with no project header;
 * a registered project the picker does not offer (a hidden folder) is headed by
 * the same name in both; a compact review card keeps its question, with the
 * quick replies when there are usable ones and without them when the only
 * option is the card's own «land» choice; a card dragged between the columns of
 * its lane changes status, not project; and a card dropped in ANOTHER project's
 * lane changes nothing and says why.
 *
 * @covers KANBAN-107
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
const PATH_A = `${canonicalTmpRoot()}/e2e-lane-alfa-${STAMP}`;
const PATH_B = `${canonicalTmpRoot()}/e2e-lane-zeta-${STAMP}`;
const ID_A = boardIdForPath(PATH_A);
const ID_B = boardIdForPath(PATH_B);
// Registered under a name that differs from the folder, and chosen so that the
// two orders disagree: by folder it sits between alfa and zeta, by name before alfa.
const PATH_C = `${canonicalTmpRoot()}/e2e-lane-gamma-${STAMP}`;
const ID_C = boardIdForPath(PATH_C);
const NAME_C = `Aaa rinominato ${STAMP}`;
// A project that exists but has no card: no lane until the composer's ghost asks for one.
const PATH_D = `${canonicalTmpRoot()}/e2e-lane-vuoto-${STAMP}`;
const ID_D = boardIdForPath(PATH_D);
// Registered, with cards, but in a folder the picker never offers (a `.topics`
// dotdir): the Kanban index does not list it, the Plan names it from the registry.
const PATH_E = `${canonicalTmpRoot()}/.topics/e2e-lane-nascosto-${STAMP}`;
const ID_E = boardIdForPath(PATH_E);
const NAME_E = `Bbb nascosto ${STAMP}`;

type Req = import("@playwright/test").APIRequestContext;
const createdTasks: { board: string; id: string }[] = [];
const topics: string[] = [];

async function createTask(request: Req, board: string, text: string, status: string, description?: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${board}/tasks`, { data: { text, status, description } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push({ board, id });
  return id;
}

async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

test.describe("Board per progetto e card compatte", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1360, height: 860 } });

  let live = "";
  let plain = "";
  let review = "";
  let projectC = "";
  let projectE = "";

  test.beforeAll(async ({ request }) => {
    for (const [path, name] of [[PATH_A, "e2e-lane-alfa"], [PATH_B, "e2e-lane-zeta"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(`${path}/package.json`, JSON.stringify({ name }, null, 2));
      topics.push((await createTopic(request, name, { projectPath: path })).id);
    }
    // topics[2]: the session that asks the question on project C's card.
    mkdirSync(PATH_C, { recursive: true });
    writeFileSync(`${PATH_C}/package.json`, JSON.stringify({ name: "e2e-lane-gamma" }, null, 2));
    topics.push((await createTopic(request, "e2e-lane-gamma", { projectPath: PATH_C })).id);
    const registered = await request.post(`${BASE}/api/projects`, { data: { name: NAME_C, path: PATH_C, slug: `aaa-rinominato-${STAMP}` } });
    expect(registered.ok(), await registered.text()).toBe(true);
    projectC = ((await registered.json()) as { id: string }).id;
    await createTask(request, ID_C, `Card nel rinominato ${STAMP}`, "todo");
    mkdirSync(PATH_D, { recursive: true });
    writeFileSync(`${PATH_D}/package.json`, JSON.stringify({ name: "e2e-lane-vuoto" }, null, 2));
    topics.push((await createTopic(request, "e2e-lane-vuoto", { projectPath: PATH_D })).id);
    mkdirSync(PATH_E, { recursive: true });
    writeFileSync(`${PATH_E}/package.json`, JSON.stringify({ name: "e2e-lane-nascosto" }, null, 2));
    const hidden = await request.post(`${BASE}/api/projects`, { data: { name: NAME_E, path: PATH_E, slug: `bbb-nascosto-${STAMP}` } });
    expect(hidden.ok(), await hidden.text()).toBe(true);
    projectE = ((await hidden.json()) as { id: string }).id;
    await createTask(request, ID_E, `Card nel nascosto ${STAMP}`, "todo");
    const session = (await createTopic(request, `Sessione lane ${STAMP}`)).id;
    topics.push(session);
    live = await createTask(request, ID_A, `Card con sessione ${STAMP}`, "in_progress", "Una descrizione che la card compatta non disegna.");
    plain = await createTask(request, ID_A, `Card in coda alfa ${STAMP}`, "todo", "Anche questa descrizione resta nella scheda.");
    await createTask(request, ID_B, `Card in coda zeta ${STAMP}`, "todo");
    await createTask(request, ID_B, `Card in backlog zeta ${STAMP}`, "backlog");
    review = await createTask(request, ID_B, `Card in review zeta ${STAMP}`, "review");
    // In review for two days: the age chip only speaks past the first hour.
    const at = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const seeded = await request.post(`${BASE}/api/test/tasks/${review}/review-at`, { data: { at } });
    expect(seeded.ok(), `seed review-at: ${seeded.status()}`).toBe(true);
    const bind = await request.post(`${BASE}/api/test/tasks/${live}/bind-topic`, { data: { topicId: session, dispatchState: "working" } });
    expect(bind.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id);
    for (const id of [...topics].reverse()) await deleteTopic(request, id);
    if (projectC) await request.delete(`${BASE}/api/projects/${projectC}`).catch(() => {});
    if (projectE) await request.delete(`${BASE}/api/projects/${projectE}`).catch(() => {});
    removeTmpDir(PATH_A);
    removeTmpDir(PATH_B);
    removeTmpDir(PATH_C);
    removeTmpDir(PATH_D);
    removeTmpDir(PATH_E);
  });

  test("raggruppa per progetto, compatta le card, ricorda le scelte e il Piano le rispetta", async ({ page }, testInfo) => {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.evaluate(() => {
      for (const k of ["topics.board.groupBy", "topics.board.groupBy:all", "topics.board.collapsedProjects", "topics.board.showDone"]) localStorage.removeItem(k);
    });
    await openGlobalBoard(page);

    const group = page.getByTestId("board-group-by");
    const doneToggle = page.getByTestId("board-done-toggle");
    const liveCard = page.locator(`[data-task-card="${live}"]`);
    const plainCard = page.locator(`[data-task-card="${plain}"]`);
    await expect(liveCard).toBeVisible({ timeout: 15000 });

    // ── 1. The default: flat board, full cards, the description is drawn ───
    await expect(group).toContainText("Raggruppa per");
    await expect(doneToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("kanban-column-done")).toHaveCount(0);
    await expect(page.getByTestId("board-lane")).toHaveCount(0);
    await expect(plainCard).toHaveAttribute("data-density", "full");
    await expect(plainCard).toContainText("Anche questa descrizione");
    await expect(liveCard.getByTestId("card-open-session")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("prima.png") });

    // ── 2. Grouped: one lane per project, each with its counts ─────────────
    await group.click();
    await page.getByRole("option", { name: "Progetto", exact: true }).click();
    await expect(group).toContainText("Progetto");
    const laneA = page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`);
    const laneB = page.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`);
    await expect(laneA).toBeVisible();
    await expect(laneB).toBeVisible();
    await expect(laneA.locator(`[data-task-card="${live}"]`)).toBeVisible();
    await expect(laneA.locator(`[data-task-card="${plain}"]`)).toBeVisible();
    await expect(laneA.getByTestId("board-lane-count-todo")).toHaveText("1");
    await expect(laneA.getByTestId("board-lane-count-in_progress")).toHaveText("1");
    await expect(laneB.getByTestId("board-lane-count-todo")).toHaveText("1");
    await expect(laneB.getByTestId("board-lane-count-backlog")).toHaveText("1");
    await expect(laneB.getByTestId("board-lane-count-review")).toHaveText("1");

    // ── 2b. The composer's ghost: ONE, in one lane, not one per lane ───────
    const textarea = page.getByTestId("board-task-composer").locator("textarea");
    await textarea.fill(`Bozza nelle corsie ${STAMP}`);
    await expect(page.getByTestId("kanban-draft-card")).toHaveCount(1);
    await textarea.fill("");
    await expect(page.getByTestId("kanban-draft-card")).toHaveCount(0);

    // ── 3. Done is out of the way by default and one click brings it back ──
    await doneToggle.click();
    await expect(doneToggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("kanban-column-done").first()).toBeVisible();
    await doneToggle.click();
    await expect(page.getByTestId("kanban-column-done")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("dopo.png") });
    const laneOrder = await page.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));

    // ── 4. Folding a lane hides its columns, the header stays ─────────────
    await laneB.getByTestId("board-lane-header").getByRole("button").click();
    await expect(laneB).toHaveAttribute("data-collapsed", "true");
    await expect(laneB.locator("[data-task-card]")).toHaveCount(0);

    // ── 5. All three choices survive a reload ─────────────────────────────
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("board-group-by")).toContainText("Progetto");
    await expect(page.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`)).toHaveAttribute("data-collapsed", "true");

    // ── 6. The Plan: same fold, same compact card ─────────────────────────
    await page.getByTestId("board-view-plan").click();
    const plan = page.getByTestId("plan-view");
    await expect(plan).toBeVisible({ timeout: 15000 });
    await expect(plan.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`)).toHaveAttribute("data-collapsed", "true");
    const tileA = plan.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`);
    await expect(tileA).not.toHaveAttribute("data-collapsed", "true");
    const planCard = tileA.locator(`[data-task-card="${live}"]`);
    await expect(planCard).toHaveAttribute("data-density", "compact");
    await expect(planCard.getByTestId("card-open-session")).toBeVisible();
    // The cards view has no status columns: just the project's two cards, one grid.
    await expect(tileA.getByTestId("board-cards-grid").locator("[data-task-card]")).toHaveCount(2);
    await expect(tileA.getByTestId("kanban-column-todo")).toHaveCount(0);
    // Same order as the lanes, for the two projects of this test.
    const tileOrder = await plan.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));
    const pick = (ids: (string | null)[]) => ids.filter((id) => id === ID_A || id === ID_B);
    expect(pick(tileOrder)).toEqual(pick(laneOrder));
    // «zeta» waits for a person (the review card): it leads in both, though «alfa» comes first by name.
    expect(pick(laneOrder)).toEqual([ID_B, ID_A]);
    await page.screenshot({ path: testInfo.outputPath("piano.png") });
  });

  const laneOf = (page: Page, id: string) => page.locator(`[data-testid="board-lane"][data-project-id="${id}"]`);
  const orderOf = (ids: (string | null)[], among: string[]) => ids.filter((id): id is string => !!id && among.includes(id));

  /** A fresh grouped board, with the composer pointed at `composerProject` (null = «Automatico»). */
  async function freshGrouped(page: Page, composerProject: string | null) {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.evaluate((target) => {
      for (const k of ["topics.board.collapsedProjects", "board:composerProject"]) localStorage.removeItem(k);
      localStorage.setItem("topics.board.groupBy", "project");
      if (target) localStorage.setItem("board:composerProject", target);
    }, composerProject);
    await page.reload();
    await openGlobalBoard(page);
    await expect(laneOf(page, ID_A)).toBeVisible({ timeout: 15000 });
  }

  test("un progetto rinominato ha la stessa intestazione e lo stesso posto in Kanban e Piano", async ({ page }, testInfo) => {
    await freshGrouped(page, null);
    const laneC = laneOf(page, ID_C);
    await expect(laneC).toBeVisible();
    // The registered name heads the lane; the folder name is nowhere in it.
    await expect(laneC.getByTestId("board-lane-header")).toContainText(NAME_C);
    await expect(laneC.getByTestId("board-lane-header")).not.toContainText("e2e-lane-gamma");
    const laneOrder = await page.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));

    await page.getByTestId("board-view-plan").click();
    const plan = page.getByTestId("plan-view");
    const tileC = plan.locator(`[data-testid="board-lane"][data-project-id="${ID_C}"]`);
    await expect(tileC).toBeVisible({ timeout: 15000 });
    await expect(tileC).toContainText(NAME_C);
    await expect(tileC).not.toContainText("e2e-lane-gamma");
    const tileOrder = await plan.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));

    // The waiting project first, then by name: renamed before alfa. By folder it would be alfa, gamma.
    const among = [ID_A, ID_B, ID_C];
    expect(orderOf(laneOrder, among)).toEqual([ID_B, ID_C, ID_A]);
    expect(orderOf(tileOrder, among)).toEqual(orderOf(laneOrder, among));
    await page.screenshot({ path: testInfo.outputPath("piano-rinominato.png") });
  });

  test("un progetto registrato in una cartella che il selettore non offre ha lo stesso nome in Kanban e Piano", async ({ page, request }, testInfo) => {
    // The premise: the picker's index does not list it, the registry knows it.
    const index = (await (await request.get(`${BASE}/api/all-boards/projects`)).json()) as { projects: { projectId: string }[] };
    expect(index.projects.some((p) => p.projectId === ID_E)).toBe(false);

    await freshGrouped(page, null);
    const laneE = laneOf(page, ID_E);
    await expect(laneE).toBeVisible();
    await expect(laneE.getByTestId("board-lane-header")).toContainText(NAME_E);
    const laneOrder = await page.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));

    await page.getByTestId("board-view-plan").click();
    const plan = page.getByTestId("plan-view");
    const tileE = plan.locator(`[data-testid="board-lane"][data-project-id="${ID_E}"]`);
    await expect(tileE).toBeVisible({ timeout: 15000 });
    await expect(tileE.getByTestId("board-lane-header")).toContainText(NAME_E);
    const tileOrder = await plan.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));
    const among = [ID_A, ID_B, ID_C, ID_E];
    expect(orderOf(laneOrder, among)).toEqual([ID_B, ID_C, ID_E, ID_A]);
    expect(orderOf(tileOrder, among)).toEqual(orderOf(laneOrder, among));
    await page.screenshot({ path: testInfo.outputPath("piano-nascosto.png") });
  });

  test("la bozza del composer indica il progetto giusto: la sua corsia, una corsia di passaggio, o sopra le corsie", async ({ page }, testInfo) => {
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    const drafts = page.getByTestId("kanban-draft-card");

    // «Automatico»: the project is decided later, so the ghost belongs to no lane and has no project header.
    await freshGrouped(page, null);
    await composer.fill(`Bozza automatica ${STAMP}`);
    await expect(drafts).toHaveCount(1);
    await expect(page.getByTestId("board-draft-above").getByTestId("kanban-draft-card")).toHaveCount(1);
    await expect(page.getByTestId("board-lane").getByTestId("kanban-draft-card")).toHaveCount(0);
    await expect(laneOf(page, ID_D)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("bozza-automatico.png") });
    await composer.fill("");
    await expect(drafts).toHaveCount(0);

    // A project with no card: a lane of THAT project, with only the ghost; it goes when the text goes.
    await freshGrouped(page, ID_D);
    const laneD = laneOf(page, ID_D);
    await expect(laneD).toHaveCount(0);
    await composer.fill(`Bozza progetto vuoto ${STAMP}`);
    await expect(laneD).toBeVisible();
    await expect(laneD.getByTestId("board-lane-header")).toContainText("e2e-lane-vuoto");
    await expect(drafts).toHaveCount(1);
    await expect(laneD.getByTestId("kanban-draft-card")).toHaveCount(1);
    await expect(laneD.locator("[data-task-card]")).toHaveCount(0);
    await expect(page.getByTestId("board-draft-above")).toHaveCount(0);
    await laneD.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("bozza-progetto-vuoto.png") });
    await composer.fill("");
    await expect(laneD).toHaveCount(0);

    // A project with a lane that is FOLDED: the lane opens around the ghost, and folds back after.
    await freshGrouped(page, ID_B);
    const laneB = laneOf(page, ID_B);
    await laneB.getByTestId("board-lane-header").getByRole("button").first().click();
    await expect(laneB).toHaveAttribute("data-collapsed", "true");
    await composer.fill(`Bozza corsia ripiegata ${STAMP}`);
    await expect(laneB).not.toHaveAttribute("data-collapsed", "true");
    await expect(laneB.getByTestId("kanban-draft-card")).toHaveCount(1);
    await expect(drafts).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("bozza-corsia-ripiegata.png") });
    await composer.fill("");
    await expect(laneB).toHaveAttribute("data-collapsed", "true");
  });

  test("la card compatta in review porta la domanda insieme alle risposte", async ({ page, request }, testInfo) => {
    const asked = await createTask(request, ID_C, `Card con domanda ${STAMP}`, "review");
    const sessionKey = `topic:${topics[2]!.slice(0, 8)}`;
    const posted = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${asked}/comments`, {
      data: { content: "Porto la modifica sul ramo principale?", options: ["Si, subito", "No, aspetto"] },
    });
    expect(posted.status(), await posted.text()).toBe(201);

    await freshGrouped(page, null);
    await page.getByTestId("board-view-plan").click();
    const card = page.getByTestId("plan-view").locator(`[data-task-card="${asked}"]`);
    await expect(card).toHaveAttribute("data-density", "compact");
    const question = card.getByTestId("card-compact-question");
    await expect(question).toContainText("Porto la modifica sul ramo principale?");
    const answerButtons = question.getByTestId("card-compact-reply");
    await expect(answerButtons).toHaveCount(2);
    await expect(answerButtons.first()).toHaveText("Si, subito");
    await expect(answerButtons.first()).toBeEnabled();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("card-compatta-domanda.png") });
  });

  test("la card compatta in review mostra la domanda anche quando l'unica opzione e' la scelta di land", async ({ page, request }, testInfo) => {
    const asked = await createTask(request, ID_C, `Card con domanda di land ${STAMP}`, "review");
    const sessionKey = `topic:${topics[2]!.slice(0, 8)}`;
    const posted = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${asked}/comments`, {
      data: { content: "Fatto: colonna slots aggiunta. Landa su main?", options: ["Landa su main"] },
    });
    expect(posted.status(), await posted.text()).toBe(201);

    await freshGrouped(page, null);
    await page.getByTestId("board-view-plan").click();
    const card = page.getByTestId("plan-view").locator(`[data-task-card="${asked}"]`);
    await expect(card).toHaveAttribute("data-density", "compact");
    // The sentence is there; the reply that would duplicate the card's own choice is not.
    await expect(card.getByTestId("card-compact-question")).toContainText("Landa su main?");
    await expect(card.getByTestId("card-compact-reply")).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("card-compatta-domanda-land.png") });
  });

  test("trascinare una card fra due colonne di una corsia cambia lo stato, non il progetto", async ({ page, request }, testInfo) => {
    const moving = await createTask(request, ID_A, `Card da trascinare ${STAMP}`, "todo");
    await freshGrouped(page, null);
    const lane = laneOf(page, ID_A);
    const card = lane.locator(`[data-task-card="${moving}"]`);
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    const from = (await card.boundingBox())!;
    const to = (await lane.getByTestId("kanban-column-body-backlog").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + 20, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 14 });
    await page.screenshot({ path: testInfo.outputPath("trascinamento-in-corso.png") });
    await page.mouse.up();

    await expect.poll(async () => {
      const r = await request.get(`${BASE}/api/boards/${ID_A}/tasks/${moving}`);
      return ((await r.json()) as { task: { status: string; projectId: string } }).task;
    }, { timeout: 10000 }).toMatchObject({ status: "backlog", projectId: ID_A });
    await expect(lane.getByTestId("kanban-column-backlog").locator(`[data-task-card="${moving}"]`)).toBeVisible();
    await expect(laneOf(page, ID_B).locator(`[data-task-card="${moving}"]`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("trascinamento-fatto.png") });
  });

  test("rilasciare una card nella corsia di un altro progetto non cambia niente e lo dice", async ({ page, request }, testInfo) => {
    const moving = await createTask(request, ID_A, `Card che resta in alfa ${STAMP}`, "todo");
    await freshGrouped(page, null);
    const own = laneOf(page, ID_A);
    // The lane NEXT to the card's own, whatever the order is (projects waiting
    // for the person lead): the two then fit the viewport together, which a
    // drag between the first and the last of many lanes does not.
    const lanes = await page.getByTestId("board-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-project-id")));
    const next = lanes[lanes.indexOf(ID_A) - 1] ?? lanes[lanes.indexOf(ID_A) + 1];
    expect(next, "a second lane next to the card's own").toBeTruthy();
    const other = laneOf(page, next!);
    const card = own.locator(`[data-task-card="${moving}"]`);
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    const target = other.getByTestId("kanban-column-body-backlog");
    await target.scrollIntoViewIfNeeded();
    // Both ends must be on screen at once: a pointer sent to a coordinate outside the viewport drops nowhere.
    const from = (await card.boundingBox())!;
    const to = (await target.boundingBox())!;
    expect(from.y, "the card is inside the viewport").toBeGreaterThan(0);
    expect(to.y + 60, "the other lane's column is inside the viewport").toBeGreaterThan(0);
    expect(to.y + 60, "the other lane's column is inside the viewport").toBeLessThan(840);
    await page.mouse.move(from.x + from.width / 2, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + 20, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 14 });
    await page.screenshot({ path: testInfo.outputPath("trascinamento-altro-progetto.png") });
    await page.mouse.up();

    await expect(page.getByTestId("board-drop-notice")).toBeVisible();
    // Nothing was written: same status, same project, and the card is still in its own lane.
    const after = ((await (await request.get(`${BASE}/api/boards/${ID_A}/tasks/${moving}`)).json()) as { task: { status: string; projectId: string } }).task;
    expect(after).toMatchObject({ status: "todo", projectId: ID_A });
    await expect(own.getByTestId("kanban-column-todo").locator(`[data-task-card="${moving}"]`)).toBeVisible();
    await expect(other.locator(`[data-task-card="${moving}"]`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("trascinamento-altro-progetto-fatto.png") });
  });

  test("il filtro «Serve te» mostra solo le card che aspettano la persona, in tutte e tre le viste", async ({ page, request }) => {
    const asked = await createTask(request, ID_C, `Serve te ${STAMP}`, "review");
    const sessionKey = `topic:${topics[2]!.slice(0, 8)}`;
    const posted = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${asked}/comments`, {
      data: { content: "Posso procedere?", options: ["Si", "No"] },
    });
    expect(posted.status(), await posted.text()).toBe(201);
    const quiet = await createTask(request, ID_C, `Nessuna attesa ${STAMP}`, "todo");

    await freshGrouped(page, null);
    await page.getByTestId("board-quick-me").click();
    await expect(page.getByTestId("board-quick-me")).toHaveAttribute("aria-pressed", "true");
    // Kanban (grid), then list, then cards: the same two cards, the same filter.
    await page.getByTestId("board-view-grid").click();
    await expect(page.locator(`[data-task-card="${asked}"]`).first()).toBeVisible();
    await expect(page.locator(`[data-task-card="${quiet}"]`)).toHaveCount(0);
    await page.getByTestId("board-view-list").click();
    await expect(page.locator(`[data-task-card="${asked}"]`).first()).toBeVisible();
    await expect(page.locator(`[data-task-card="${quiet}"]`)).toHaveCount(0);
    await page.getByTestId("board-view-plan").click();
    const plan = page.getByTestId("plan-view");
    await expect(plan.locator(`[data-task-card="${asked}"]`)).toBeVisible({ timeout: 15000 });
    await expect(plan.locator(`[data-task-card="${quiet}"]`)).toHaveCount(0);
  });
});

/**
 * board.spec.ts — E2E for the Kanban board (kanban-agent-authoring, KANBAN-01/03/05/07).
 *
 * Covers the human board surface end-to-end against the isolated test server:
 *  - project board opens from the project window "+" menu, 5 columns
 *  - inline create in a column → card appears (and dispatch feedback exists)
 *  - live WS update when a task is created via API (no manual refresh)
 *  - agent-surface create (`/api/sessions/:key/tasks`) lands in Backlog (intake)
 *  - review gate: Approva moves review → done
 *  - auto-dispatch pill: "agent: off" by default, IS the global toggle (click flips)
 *  - global board ("Board generale") opens from the standalone "+" menu and
 *    aggregates tasks across projects with project badges
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-board-${Date.now()}`;

/** BYTE-IDENTICAL to server/services/tasks.ts:projectIdForPath (parity-tested there). */
function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string },
  projectId = PROJECT_ID,
): Promise<{ id: string; status: string }> {
  const res = await request.post(`${BASE}/api/boards/${projectId}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string; status: string };
  createdTasks.push(`${projectId}:${task.id}`);
  return task;
}

/** Open the e2e project window by clicking its sidebar row (project-tabs pattern). */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: /e2e-board/ })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  // Ancora sulla FINESTRA DI PROGETTO, non su `panel-tab-bar`: quella testid la
  // porta anche la barra standalone, quindi l'asserzione passava con il
  // workspace vuoto e non provava nulla — poi openProjectBoard falliva piu'
  // avanti con "no + menu with a Board (kanban) entry found", a 10 s di
  // distanza dal punto in cui il problema era gia' visibile.
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/** Open the project board pane via the project window's "+" menu. */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  // Several tab bars carry a PaneAddMenu trigger (standalone top bar + the
  // project window's) and their DOM order is not guaranteed. Only the project
  // scope lists the "Board" (kanban) entry, so probe triggers until the item
  // shows, closing wrong menus with Escape.
  // VISIBLE triggers only, and never block on one. A leftover pane from an
  // earlier spec (the workspace is shared across the run) contributes a trigger
  // that is in the DOM but not on screen; clicking it used to hang on
  // "visible, enabled and stable" until the whole 60s test budget was gone —
  // which is how this file went red in a full-suite run while passing alone.
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Kanban board", () => {
  // First test after a cold test-server boot can burn >30s on sidebar +
  // project-window + pane mounts alone; give the whole flow headroom.
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board" }, null, 2));
    const topic = await createTopic(request, "E2E-Board", { projectPath: PROJECT_PATH });
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

  // Workspace ermetico per OGNI test: si azzerano ENTRAMBI i canali di stato,
  // poi si riapre solo la finestra del progetto e2e.
  //
  // Servono entrambi perche' sono due cose diverse. `resetPaneStore` azzera lo
  // store GLOBALE dei pane; il layout INTERNO della finestra di progetto e'
  // invece una chiave `ui_state` a se' (`topics-project-panes-<hash>`), vive
  // sul SERVER e sopravvive sia al reset globale sia a un context Playwright
  // nuovo. Il "+" del progetto filtra via i tipi di pane SINGLETON gia'
  // presenti nel gruppo (useProjectLayout.availableTypesForGroup), quindi la
  // board lasciata li' dentro da un test faceva sparire la voce "Board" a
  // quello dopo. Provato: lo screenshot del fallimento mostra i tab
  // `Topics · Board Test · Files · Processes · Board Test` — gia' aperta, DUE
  // volte — e l'errore era il fuorviante "no + menu with a Board (kanban)
  // entry found".
  //
  // Niente `.catch(() => {})` sui reset/seed: un seed che non attecchisce deve
  // far fallire il beforeEach, dove il problema e' leggibile, invece di
  // riemergere 10 s dopo travestito da elemento mancante. (C'erano anche due
  // beforeEach separati con lo stesso reset: fusi qui.)
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("BOARD-01: project board renders 5 columns + dispatch settings (auto-dispatch off)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await page.goto("/");
    await openProjectBoard(page);

    for (const status of ["backlog", "todo", "in_progress", "review", "done"]) {
      await expect(page.getByTestId(`kanban-column-${status}`)).toBeVisible();
    }
    // The "agent: off" pill was removed (refactor 75712097 — it duplicated the
    // dropdown); dispatch now lives in the header's GlobalSettingsMenu. Verify
    // that control is present and that auto-dispatch defaults OFF.
    const dispatchMenu = page.getByTitle(/Impostazioni dispatch/);
    await expect(dispatchMenu).toBeVisible();
    await dispatchMenu.click();
    const autoDispatch = page.locator("label", { hasText: "Auto-dispatch" }).getByRole("checkbox");
    await expect(autoDispatch).toBeVisible();
    await expect(autoDispatch).not.toBeChecked();
  });

  test("BOARD-02: inline create adds a card to the column", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await page.goto("/");
    await openProjectBoard(page);

    const backlog = page.getByTestId("kanban-column-backlog");
    await backlog.getByRole("button", { name: "Aggiungi" }).click();
    const text = `Inline task ${Date.now()}`;
    await backlog.locator("textarea").fill(text);
    await backlog.locator("textarea").press("Enter");
    await expect(backlog.getByText(text)).toBeVisible({ timeout: 10000 });

    // Track for cleanup (created via UI, id unknown → find it via API).
    const res = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks`);
    const { tasks } = (await res.json()) as { tasks: Array<{ id: string; text: string }> };
    const mine = tasks.find((t) => t.text === text);
    if (mine) createdTasks.push(`${PROJECT_ID}:${mine.id}`);
  });

  test("BOARD-03: task created via API appears live (WS, no refresh)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    await page.goto("/");
    await openProjectBoard(page);

    const text = `Live task ${Date.now()}`;
    await apiCreateTask(page.request, { text, status: "todo" });
    await expect(page.getByTestId("kanban-column-todo").getByText(text)).toBeVisible({ timeout: 10000 });
  });

  test("BOARD-04: agent-surface create lands in Backlog (intake, not the run-queue)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    await page.goto("/");
    await openProjectBoard(page);

    // The MCP adapter drives /api/sessions/:key/tasks; the session key of a
    // topic is `topic:` + first 8 chars of its id (session-control-core).
    const sessionKey = `topic:${projectTopicId!.slice(0, 8)}`;
    const text = `Agent task ${Date.now()}`;
    const res = await page.request.post(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks`,
      { data: { text } },
    );
    expect(res.status()).toBe(201);
    const task = (await res.json()) as { id: string; status: string };
    createdTasks.push(`${PROJECT_ID}:${task.id}`);
    expect(task.status).toBe("backlog");
    await expect(page.getByTestId("kanban-column-backlog").getByText(text)).toBeVisible({ timeout: 10000 });
  });

  test("BOARD-05: review gate — Approva moves review → done", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
    const text = `Review task ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    const patch = await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });
    expect(patch.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);

    const reviewCol = page.getByTestId("kanban-column-review");
    await expect(reviewCol.getByText(text)).toBeVisible({ timeout: 10000 });
    // Only this test's task sits in review, so the column-scoped button is it.
    // exact:true — the dnd-kit card is itself role=button and its accessible
    // name (whole card text) also contains "Approva".
    await reviewCol.getByRole("button", { name: "Approva", exact: true }).click();
    await expect(page.getByTestId("kanban-column-done").getByText(text)).toBeVisible({ timeout: 10000 });
    await expect(reviewCol.getByText(text)).not.toBeVisible();
  });

  test("BOARD-06: auto-dispatch is a GLOBAL toggle (flips on/off and round-trips)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    await page.goto("/");
    await openProjectBoard(page);

    // The "agent: off" pill this test used to click was removed in refactor
    // 75712097 (it duplicated the dropdown) — same stale-selector fix BOARD-01
    // already got. The BEHAVIOUR under test is unchanged: one GLOBAL switch for
    // every board, whose state survives the PATCH round-trip.
    const dispatchMenu = page.getByTitle(/Impostazioni dispatch/);
    await expect(dispatchMenu).toBeVisible({ timeout: 10000 });
    await dispatchMenu.click();
    const autoDispatch = page.locator("label", { hasText: "Auto-dispatch" }).getByRole("checkbox");
    await expect(autoDispatch).toBeVisible({ timeout: 5000 });
    await expect(autoDispatch, "the test env starts manual").not.toBeChecked();

    await autoDispatch.click();
    await expect(autoDispatch, "the flip is controlled state, not optimistic UI").toBeChecked({ timeout: 5000 });

    // Restore: the whole test env must stay manual for the other tests.
    await autoDispatch.click();
    await expect(autoDispatch).not.toBeChecked({ timeout: 5000 });
  });

  test("BOARD-08: a question comment renders formatted in the drawer (no raw fences)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    const text = `Question task ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    // Agent surface with STRUCTURED options — the server composes the block.
    const sessionKey = `topic:${projectTopicId!.slice(0, 8)}`;
    const res = await page.request.post(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${task.id}/comments`,
      { data: { content: "Quale opzione preferisci?", options: ["Opzione alfa", "Opzione beta"] } },
    );
    expect(res.status()).toBe(201);

    await page.goto("/");
    await openProjectBoard(page);

    // Open the detail drawer from the card.
    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer.getByText("Quale opzione preferisci?")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText("Opzione alfa")).toBeVisible();
    await expect(drawer.getByText("Opzione beta")).toBeVisible();
    // The raw fence must never reach the human.
    await expect(drawer.getByText("```question")).not.toBeVisible();
  });

  // ONE row, not two: the board has a dedicated top-of-tree row (with the open
  // task count), so buildSidebarItems no longer also emits a generic utility row
  // for it — opening the board used to produce two identical "Board generale"
  // entries. The dedicated row is tab-aware, which is what this test pins.
  test("BOARD-09: the open Board generale tab has exactly ONE sidebar row, and it is selected", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await resetPaneStore(page.request, []);
    await page.goto("/");

    // Open from the standalone "+" menu.
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });

    // The tab has a first-class sidebar row, focused…
    const row = page.getByTestId("sidebar-board-generale");
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toHaveAttribute("aria-selected", "true");
    // …and it is the ONLY one: no second, generic utility row underneath.
    await expect(row, "the board must not get a duplicate sidebar row").toHaveCount(1);
    await expect(
      page.getByTestId("sidebar-utility-board"),
      "the generic utility row is suppressed for the board",
    ).toHaveCount(0);
  });

  test("BOARD-12: a persisted Board generale pane survives hydrate/render (persistence regression)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    // Regression: `KNOWN_PANE_TYPES` omitted 'board', so `sanitizePane` dropped
    // the __board__ pane on EVERY HYDRATE_FROM_SNAPSHOT (reload / warm-boot /
    // cross-tab / server broadcast). The pane was SAVED correctly (outbound and
    // the server do no type filtering) but stripped on the way back IN, and its
    // now-dangling group ref was pruned as an entity-less ghost — so the tab
    // vanished on reload.
    //
    // Seed the AUTHORITATIVE pane channel with the board pane exactly as an open
    // "Board generale" leaves it (paneRecordForId('__board__') → type 'board',
    // and __board__ in group:default.paneIds), then load. This exercises the
    // GET → HYDRATE_FROM_SNAPSHOT → sanitizeSnapshot → render path directly:
    // pre-fix the pane is stripped on hydrate and no tab renders; post-fix it
    // survives and the tab is present. (We seed rather than open-then-reload so
    // the test isn't coupled to the debounced-persist/empty-store-clobber timing
    // — the same seed pattern tab-persistence.spec.ts relies on.)
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // The board pane survived sanitize/hydrate → its tab is rendered...
    await expect(page.locator('[data-pane-id="__board__"]')).toBeVisible({ timeout: 10000 });
    // ...and it gets its first-class sidebar row like every other open tab
    // (focus-independent proof the pane entity is live, not a stranded ref).
    await expect(page.getByTestId("sidebar-board-generale")).toBeVisible({ timeout: 10000 });
  });

  test("BOARD-10: nested subtasks — quick-add in drawer, counter chip, done gate", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-08" });
    const text = `Epic task ${Date.now()}`;
    const parent = await apiCreateTask(page.request, { text, status: "in_progress" });

    await page.goto("/");
    await openProjectBoard(page);

    // Open the drawer, quick-add a subtask. On a task with no steps yet the
    // subtask section is hidden: the composer is revealed on demand from the
    // ⋯ options menu (portaled — page-level locator, not drawer-scoped).
    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await page.getByTestId("task-options-menu").click();
    await page.getByRole("menuitem", { name: "Aggiungi sottotask" }).click();
    const subText = `Subtask ${Date.now()}`;
    await drawer.getByPlaceholder("+ sottotask…").fill(subText);
    await drawer.getByPlaceholder("+ sottotask…").press("Enter");
    await expect(drawer.getByTestId("task-detail-subtasks").getByText(subText)).toBeVisible({ timeout: 10000 });

    // The parent shows the counter chip; the step is NOT a card of its own —
    // subtasks are the parent's checklist (drawer tree), never board cards.
    const parentCard = page.getByTestId("kanban-column-in_progress").locator("div.group", { hasText: text });
    await expect(parentCard.getByText("↳ 0/1")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("kanban-column-backlog").getByText(subText)).not.toBeVisible();

    // Structural gate: a parent with open subtasks cannot be closed.
    const done = await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${parent.id}`, {
      data: { status: "done" },
    });
    expect(done.status()).toBe(409);
    expect((await done.json()).code).toBe("open_subtasks");

    // Cleanup tracking for the subtask created via UI: the board feed hides
    // steps, so read it off the parent's detail (children).
    const res = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${parent.id}`);
    const { children } = (await res.json()) as { children: Array<{ id: string; text: string }> };
    const sub = children?.find((t) => t.text === subText);
    if (sub) createdTasks.push(`${PROJECT_ID}:${sub.id}`);
  });

  test("BOARD-11: Esc closes the drawer; the header exposes a copyable task deep-link", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    const text = `Esc+link task ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "todo" });

    await page.goto("/");
    await openProjectBoard(page);

    // Open the drawer from the card.
    await page.getByTestId("kanban-column-todo").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // The copy-link button is present; clicking it writes an openable deep-link
    // to the clipboard — and questa riga la LEGGE DAVVERO.
    //
    // Prima c'era un'asserzione che non poteva fallire: due `.catch(() => "")`
    // annidati riducevano ogni errore a stringa vuota, e `if (clip)` saltava
    // l'unica `expect` del blocco. Copia non avvenuta, permesso negato,
    // `readText` in errore, link sbagliato in modo da risultare vuoto: tutti
    // VERDI. Il permesso non è mai stato il problema — `playwright.config.ts`
    // (`use.permissions`) concede clipboard-read/write a TUTTA la suite, quindi
    // la `grantPermissions` per-test era anch'essa rumore.
    //
    // Il link è path-based (`/task/<uuid>`): la forma `?task=<slug>~<uuid>` è
    // stata abbandonata (commit e5c10f37) e l'uuid è l'identificatore stabile.
    // L'uguaglianza è ESATTA perché `buildTaskLink` compone `serverHttpBase()
    // || window.location.origin` + `/task/<id>` senza query: sul web quel base
    // è l'origine della pagina, cioè `BASE`.
    await drawer.getByTestId("task-copy-link").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe(`${BASE}/task/${task.id}`);

    // Esc closes the drawer (not editing, no menu open → the drawer's own Esc).
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible({ timeout: 5000 });
  });

  test("BOARD-13: a URL in a thread comment is a link that opens OUT, without navigating the app", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    // Regressione: il renderer `a` viveva solo in MessageContent, quindi ogni
    // altra superficie markdown (commenti della board, descrizione, piano,
    // divisori di compattazione) cadeva sull'`<a>` di default di react-markdown.
    // Nella WKWebView del guscio Tauri quel link è morto; su web porta via la
    // SPA. Ora il default sta in ChatMarkdown, che tutte ereditano.
    const text = `Link task ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    const url = "https://example.org/anteprima";
    const sessionKey = `topic:${projectTopicId!.slice(0, 8)}`;
    const res = await page.request.post(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${task.id}/comments`,
      { data: { content: `Anteprima pronta: ${url}` } },
    );
    expect(res.status()).toBe(201);

    // `openExternal` su web finisce in window.open: lo si registra invece di
    // aprirlo davvero, così il click è osservabile senza una finestra vera.
    await page.addInitScript(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((u?: string | URL) => {
        (window as unknown as { __opened: string[] }).__opened.push(String(u));
        return null;
      }) as typeof window.open;
    });

    await page.goto("/");
    await openProjectBoard(page);
    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");

    // remark-gfm autolinka l'URL scritto in chiaro: dev'essere un vero <a>.
    const link = drawer.locator(`a[href="${url}"]`);
    await expect(link).toBeVisible({ timeout: 10000 });

    const before = page.url();
    await link.click();

    // Aperto FUORI…
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened), {
        timeout: 5000,
      })
      .toContain(url);
    // …e la SPA è rimasta dov'era (il preventDefault ha fatto il suo lavoro).
    expect(page.url()).toBe(before);
    await expect(drawer).toBeVisible();
  });

  test("BOARD-07: Board generale opens from the standalone + menu and crosses projects", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-06" });
    // Seed tasks on TWO boards: the project one + a second ad-hoc board.
    const otherId = "otherproj-e2e001";
    const a = `Cross A ${Date.now()}`;
    const b = `Cross B ${Date.now()}`;
    await apiCreateTask(page.request, { text: a, status: "todo" });
    await apiCreateTask(page.request, { text: b, status: "todo" }, otherId);

    await resetPaneStore(page.request, []);
    await page.goto("/");

    // Standalone tab bar "+" → Board generale (the entry this change adds).
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();

    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 10000 });
    await expect(board.getByText(a)).toBeVisible({ timeout: 10000 });
    await expect(board.getByText(b)).toBeVisible();
    // Project badge on cross-project cards (label = dirName before the hash).
    await expect(board.getByText("otherproj", { exact: true })).toBeVisible();
  });
});

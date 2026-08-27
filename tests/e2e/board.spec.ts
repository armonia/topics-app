/**
 * board.spec.ts — E2E for the Kanban board (kanban-agent-authoring, KANBAN-01/03/05/07).
 *
 * Covers the human board surface end-to-end against the isolated test server:
 *  - project board opens from the project window "+" menu, 5 columns
 *  - inline create in a column → card appears (and dispatch feedback exists)
 *  - live WS update when a task is created via API (no manual refresh)
 *  - agent-surface create (`/api/sessions/:key/tasks`) lands in Backlog (intake)
 *  - review gate: "Approva" moves review → done
 *  - auto-dispatch pill: "agent: off" by default, IS the global toggle (click flips)
 *  - global board ("Board generale") opens from the standalone "+" menu and
 *    aggregates tasks across projects with project badges
 *
 * @covers KANBAN-02
 *
 * Partial, and worth stating: filters, board settings and the column round trip
 * live here. The APPROVALS and agent-assignment half of the same requirement is
 * elsewhere (board-review-*.spec.ts, board-card-*.spec.ts).
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

// Hermetic boundary: this file restarts from the globalSetup baseline, not from
// the state left behind by the specs before it. See fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-board-${Date.now()}`;

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
  const btn = projectRow(page, /e2e-board/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  // Anchored on the PROJECT WINDOW, not on `panel-tab-bar`: the standalone bar
  // carries that testid too, so the assertion passed on an empty workspace and
  // proved nothing — then openProjectBoard failed further on with "no + menu
  // with a Board (kanban) entry found", 10 s away from the point where the
  // problem was already visible.
  // AND ANCHORED ON THIS FILE'S PROJECT, not on "a" project window.
  //
  // `getByTestId("project-window")` alone is strict-mode: when another spec file
  // runs in parallel and has opened ITS project, the locator finds two and the
  // assertion dies with "resolved to 2 elements", naming two paths that have
  // nothing to do with each other. Measured 2026-08-26 running board.spec
  // alongside board-subtask-work-chip: `/tmp/e2e-subwork-…` and
  // `/tmp/e2e-board-…` both present. On its own the file always passes — which
  // is why the red showed only in the nightly, the one that runs the whole
  // suite while the PR tier skips this file.
  //
  // `data-project-path` is already on the element: just ask it WHICH.
  await expect(projectWindow(page)).toBeVisible({ timeout: 10000 });
}

/** This file's project window, not any project window. */
function projectWindow(page: Page) {
  return page.locator('[data-testid="project-window"][data-project-path*="e2e-board-"]');
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
    // A REAL favicon, because since 08/08 the board row shows only the projects
    // that have one (no name, no monograms: the icon IS the identity, and
    // whoever lacks it ends up inside the «+N»). Without this file BOARD-14      allow-italian: quoted UI string
    // would have no chip to measure — and would be red for the setup, not for
    // the rule. A valid 1×1 PNG, the smallest one that really decodes.
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
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

  // A hermetic workspace for EVERY test: BOTH state channels are cleared, then
  // only the e2e project window is reopened.
  //
  // Both are needed because they are two different things. `resetPaneStore`
  // clears the GLOBAL pane store; the INTERNAL layout of the project window is
  // instead a `ui_state` key of its own (`topics-project-panes-<hash>`), it
  // lives on the SERVER and survives both the global reset and a fresh
  // Playwright context. The project's "+" filters out the SINGLETON pane types
  // already present in the group (useProjectLayout.availableTypesForGroup), so
  // a board left in there by one test made the "Board" entry disappear for the
  // next one. Proven: the failure screenshot shows the tabs
  // `Topics · Board Test · Files · Processes · Board Test` — already open,
  // TWICE — and the error was the misleading "no + menu with a Board (kanban)
  // entry found".
  //
  // No `.catch(() => {})` on the resets/seeds: a seed that does not take hold
  // must fail the beforeEach, where the problem is readable, instead of
  // resurfacing 10 s later disguised as a missing element. (There were also two
  // separate beforeEach hooks with the same reset: merged here.)
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
    // The ▾ next to the title — a SECOND way into the same settings, carrying a
    // copy of the state of its own — was taken out in 2f5be1ef6. ONE door is
    // left: the ⚙, title `board.toolbar.dispatchSettings`.
    const dispatchMenu = page.getByTitle(/Impostazioni auto-dispatch/);
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

  test("BOARD-03b: il thread vuoto dice cosa succedera', e cambia con lo stato", async ({ page }) => {
    // «Nessun commento» constatava un'assenza che si vede gia' da sola. La riga
    // sotto a un task senza thread e' l'unico posto in cui dire DOVE arriveranno
    // la consegna e le domande dell'agente, e a chi tocca la mossa.
    //
    // Le DUE colonne servono entrambe, ed e' il punto della card: un task in
    // coda aspetta la macchina, uno in backlog aspetta TE. Una riga sola per
    // tutti gli stati sarebbe di nuovo una constatazione, solo piu' lunga.
    // Il lavoro originale (780ac282) aveva i test sul catalogo delle stringhe:
    // dicevano che le frasi esistono, non che qualcuno le legge.
    await page.goto("/");
    await openProjectBoard(page);

    const inCoda = `Coda vuota ${Date.now()}`;
    const inBacklog = `Backlog vuoto ${Date.now()}`;
    await apiCreateTask(page.request, { text: inCoda, status: "todo" });
    await apiCreateTask(page.request, { text: inBacklog, status: "backlog" });

    await page.getByTestId("kanban-column-todo").getByText(inCoda).click({ timeout: 10000 });
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    const vuoto = page.getByTestId("task-thread-empty");
    await expect(vuoto).toBeVisible({ timeout: 10000 });
    await expect(vuoto, "in coda: aspetta la macchina").toContainText(/in coda/i);
    const textQueue = await vuoto.innerText();

    await page.keyboard.press("Escape");
    await page.getByTestId("kanban-column-backlog").getByText(inBacklog).click({ timeout: 10000 });
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(vuoto).toBeVisible({ timeout: 10000 });
    // In backlog la mossa e' TUA: se questa frase fosse uguale a quella di
    // sopra, la riga sarebbe tornata una constatazione con piu' parole.
    await expect(vuoto, "in backlog: aspetta te").toContainText(/backlog/i);
    expect(await vuoto.innerText()).not.toBe(textQueue);
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

  test("BOARD-05: review gate — \"Approva\" moves review → done", async ({ page }) => {
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
    // name (whole card text) also contains the label.
    await reviewCol.getByRole("button", { name: "Approva", exact: true }).click();
    await expect(page.getByTestId("kanban-column-done").getByText(text)).toBeVisible({ timeout: 10000 });
    await expect(reviewCol.getByText(text)).not.toBeVisible();
  });

  test("BOARD-06: auto-dispatch is a GLOBAL toggle (flips on/off and round-trips)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    await page.goto("/");
    await openProjectBoard(page);

    // The same single door as BOARD-01 (the ▾ went away in 2f5be1ef6). The
    // BEHAVIOUR under test does not change: one GLOBAL switch for every board,
    // whose state survives the round trip through the server.
    const dispatchMenu = page.getByTitle(/Impostazioni auto-dispatch/);
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

  /**
   * LA RIGA DELLA BOARD DICE ANCHE DI CHI SONO I TASK.
   *
   * I conteggi per colonna dicono a che punto è il lavoro; non dicono DOVE. Con
   * task su più progetti «3 in review» è un numero che non si può agire — prima
   * di aprire la board si vuole sapere se quei tre sono tutti sullo stesso
   * progetto o sparsi. Le pastiglie lo dicono, e ci stanno quante ce ne stanno.
   *
   * Questo test esiste perché quel raggruppamento è già SPARITO una volta, in
   * silenzio: portandolo da una seconda riga a IN LINEA, il suo contenitore ha
   * perso il `flex-1` ed è collassato a larghezza zero — e a zero
   * `fitProjectChips` risponde «nessuna pastiglia, e niente da annunciare»,
   * quindi non restava nemmeno il «+N» a dire che mancava qualcosa. Una
   * funzione intera scomparsa senza un rosso. Adesso il rosso c'è.
   */
  test("BOARD-14: la riga della board mostra i progetti dei task aperti", async ({ page }) => {
    await apiCreateTask(page.request, { text: `Chip probe ${Date.now()}`, status: "todo" });
    await resetPaneStore(page.request, []);
    await page.goto("/");

    const row = page.getByTestId("sidebar-board-generale");
    await expect(row).toBeVisible({ timeout: 15000 });

    // Almeno una pastiglia di progetto, con una larghezza VERA: un contenitore
    // collassato renderebbe gli elementi «presenti» ma larghi zero, che è
    // esattamente il modo in cui il difetto era invisibile.
    // `:not([data-testid="board-project-more"])`: il «+N» condivide il PREFISSO
    // e `.first()` poteva cadere su di lui — misurando un elemento che non è una
    // pastiglia. E il rettangolo si POLLA invece di leggerlo una volta: le
    // pastiglie compaiono quando la sonda dell'icona atterra (dall'08/08 la riga
    // mostra solo i progetti con un'icona), quindi fra il controllo di
    // visibilità e la misura l'elemento può staccarsi — `boundingBox()` torna
    // null e il test muore su un difetto che non esiste.
    const chip = row
      .locator('[data-testid^="board-project-"]:not([data-testid="board-project-more"])')
      .first();
    await expect(chip, "nessun progetto sulla riga della board").toBeVisible({ timeout: 10000 });
    let box: { x: number; y: number; width: number; height: number } | null = null;
    await expect
      .poll(async () => { box = await chip.boundingBox(); return box?.width ?? 0; }, { timeout: 10000 })
      .toBeGreaterThan(0);
    box = box!;
    // 28 = `CHIP_W_ICON`, il PAVIMENTO dichiarato: la pastiglia più stretta che
    // il layout ammette — 8 di padding più i 20 dello slot dell'icona. Sotto
    // quella misura non c'è un degrado, c'è un contenitore collassato.
    expect(Math.round(box.width), "la pastiglia esiste ma è larga zero").toBeGreaterThanOrEqual(28);
    // E porta l'ICONA, che dall'08/08 è l'unica identità che la pastiglia
    // mostra: se questa <img> non c'è, il progetto non aveva titolo di stare
    // sulla riga e la pastiglia è un guscio.
    await expect(
      chip.locator('img[src*="/api/projects/icon"]'),
      "la pastiglia non porta l'icona del progetto",
    ).toBeVisible({ timeout: 10000 });

    // E sta DENTRO la riga, non le sborda a destra.
    const rowBox = (await row.boundingBox())!;
    expect(Math.round(box.x + box.width), "la pastiglia sborda dalla riga").toBeLessThanOrEqual(
      Math.round(rowBox.x + rowBox.width) + 1,
    );
  });

  /**
   * LA TAB DELLA BOARD DICE A CHE PUNTO STA IL LAVORO.
   *
   * Una tab «Board» portava icona + nome e basta: dentro un gruppo di split, o
   * semplicemente non selezionata, non diceva niente di ciò che c'è dietro —
   * mentre la riga della sidebar lo dice da sempre. Adesso porta gli stessi due
   * stati che riassume la sidebar (review, in corso), dallo STESSO feed.
   *
   * Il numero non è scritto a mano nel test: si confronta con quello che l'API
   * risponde nello stesso istante. Un'asserzione su una costante proverebbe che
   * la tab sa contare fino a due; questa prova che la tab e la board sono
   * d'accordo, che è l'invariante vero.
   */
  test("BOARD-15: la tab «Board generale» mostra i conteggi per stato", async ({ page }) => {
    const stamp = Date.now();
    const t1 = await apiCreateTask(page.request, { text: `Tab count A ${stamp}`, status: "in_progress" });
    const patch = await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${t1.id}`, {
      data: { status: "review" },
    });
    expect(patch.ok()).toBe(true);
    await apiCreateTask(page.request, { text: `Tab count B ${stamp}`, status: "in_progress" });

    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });

    // Quanti ne conta il server, adesso, su TUTTE le board (root soltanto: è lo
    // stesso feed che alimenta la tab).
    const atteso = async (status: string) => {
      const r = await page.request.get(`${BASE}/api/all-boards/tasks`);
      const { tasks } = (await r.json()) as { tasks: { status: string }[] };
      return tasks.filter((t) => t.status === status).length;
    };

    const tab = page.locator('[data-pane-id="__board__"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    for (const status of ["review", "in_progress"]) {
      const cue = tab.getByTestId(`tab-board-count-${status}`);
      await expect(cue, `manca il conteggio ${status} sulla tab`).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => (await cue.innerText()).trim(), { timeout: 10000 })
        .toBe(String(await atteso(status)));
      // …e con una larghezza VERA: dentro una tab a larghezza fissa un
      // contenitore che collassa lascia elementi «visibili» e larghi zero — è
      // così che il raggruppamento della sidebar era già sparito una volta
      // (BOARD-14). Il glifo da solo è 14px.
      const box = await cue.boundingBox();
      expect(Math.round(box?.width ?? 0), `il conteggio ${status} è largo zero`).toBeGreaterThanOrEqual(14);
    }
  });

  /**
   * E la tab di UN PROGETTO conta solo i suoi.
   *
   * È la parte che può rompersi in silenzio: il progetto non sta sul pane, la
   * barra lo conosce come scope della finestra. Se quella risoluzione salta, la
   * tab di progetto mostrerebbe il totale di TUTTI i progetti — un numero
   * plausibile e sbagliato. Qui il secondo progetto esiste apposta perché i due
   * numeri NON coincidano.
   */
  test("BOARD-16: la tab della board di progetto conta solo i task di quel progetto", async ({ page }) => {
    const stamp = Date.now();
    const OTHER_ID = boardIdForPath(`/tmp/e2e-board-altro-${stamp}`);
    await apiCreateTask(page.request, { text: `Solo mio ${stamp}`, status: "in_progress" });
    await apiCreateTask(page.request, { text: `Di un altro ${stamp}`, status: "in_progress" }, OTHER_ID);

    await page.goto("/");
    await openProjectBoard(page);

    const perProject = async (projectId: string) => {
      const r = await page.request.get(`${BASE}/api/boards/${projectId}/tasks`);
      const { tasks } = (await r.json()) as { tasks: { status: string; parentTaskId: string | null }[] };
      return tasks.filter((t) => t.status === "in_progress" && !t.parentTaskId).length;
    };
    const mio = await perProject(PROJECT_ID);
    const altro = await perProject(OTHER_ID);
    expect(altro, "il secondo progetto serve a rendere i due numeri diversi").toBeGreaterThan(0);

    const cue = projectWindow(page).getByTestId("tab-board-count-in_progress");
    await expect(cue).toBeVisible({ timeout: 15000 });
    // `mio`, non `mio + altro`: con un task in corso su ciascun progetto i due
    // numeri sono diversi, quindi questa uguaglianza è anche il rosso che
    // scatta se la tab di progetto ricadesse sul totale globale.
    await expect.poll(async () => (await cue.innerText()).trim(), { timeout: 10000 }).toBe(String(mio));
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

    // The parent carries the step ON ITSELF, and the step is NOT a card of its
    // own — subtasks are the parent's checklist (drawer tree), never cards.
    //
    // The compact `↳ done/total` chip is no longer what shows up here: ever
    // since the card draws the checklist itself (up to five rows, the rest
    // behind «Vedi tutti»), that chip is the FALLBACK for a card whose children  allow-italian: quoted UI string
    // have not arrived yet. With the children loaded — which is the case here,
    // the assertion above has just seen them in the drawer — what shows is the
    // ROW.
    const parentCard = page.getByTestId("kanban-column-in_progress").locator("div.group", { hasText: text });
    await expect(parentCard.getByText(subText)).toBeVisible({ timeout: 10000 });
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
    // Il link non è più un'icona a catena nella testata: vive dentro il
    // pannello di condivisione, che è l'unico posto dove si chiede un link.
    await drawer.getByTestId("share-control").click();
    await page.getByTestId("share-copy-link").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe(`${BASE}/task/${task.id}`);

    // Il pannello di condivisione è aperto, e Escape chiude prima il popover in
    // cima alla pila: è la regola dell'app, non un incidente. Si chiude lui, e
    // solo allora la riga sotto misura quello che dice di misurare.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-panel")).toBeHidden({ timeout: 5000 });

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
    // Cercato DENTRO la card e non nella board intera: da quando la barra
    // mostra i progetti come chip filtro (`project-filter-chip-*`), lo stesso
    // nome compare due volte sulla superficie e un `getByText` largo cadeva su
    // strict mode — accusando la card, che invece il badge ce l'ha.
    const colonne = board.locator('[data-testid^="kanban-column-body-"]');
    await expect(colonne.getByText("otherproj", { exact: true })).toBeVisible();
  });

  // BOARD-17, not BOARD-14: that number was already taken by the project-row
  // test further up in this file, cited from the CHANGELOG and from
  // `boardProjectChips`. Two tests with the same id is an id that no longer
  // selects anything.
  test("BOARD-17: trascinare una card cambia colonna e riordina, e resta dopo un reload", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    // Il drag era l'unica parte della board senza rete: nessuna spec trascinava
    // una card, quindi l'inserimento frazionario e la correzione dell'indice per
    // lo spostamento verso il basso non erano provati da nessuna parte. La
    // logica pura sta in `client/src/lib/boardOrder.ts` (bun:test); questo prova
    // il filo intero — dnd-kit → PATCH → persistito.
    const stamp = Date.now();
    const primo = `Drag primo ${stamp}`;
    const secondo = `Drag secondo ${stamp}`;
    const t1 = await apiCreateTask(page.request, { text: primo, status: "todo" });
    await apiCreateTask(page.request, { text: secondo, status: "todo" });

    await page.goto("/");
    await openProjectBoard(page);

    const todo = page.getByTestId("kanban-column-body-todo");
    await expect(todo.getByText(primo)).toBeVisible({ timeout: 10000 });
    await expect(todo.getByText(secondo)).toBeVisible();

    const drag = (from: string, to: string) => dragCard(page, from, to);

    // 1) Ordine dentro la colonna: il primo scende sotto il secondo.
    const cardsNow = async () =>
      (await todo.locator("[data-task-card]").allInnerTexts()).map((s) => s.split("\n").find((l) => l.includes(String(stamp))) ?? "");
    expect((await cardsNow()).findIndex((t) => t.includes("primo")))
      .toBeLessThan((await cardsNow()).findIndex((t) => t.includes("secondo")));

    await drag(t1.id, `[data-task-card="${(await apiFindTask(page, secondo))}"]`);
    await expect.poll(async () => {
      const c = await cardsNow();
      return c.findIndex((t) => t.includes("primo")) > c.findIndex((t) => t.includes("secondo"));
    }, { timeout: 10000 }).toBe(true);

    // …e sopravvive al reload: la posizione è sul server, non nella memoria del
    // pane. Il pane è persistito, quindi si ASPETTA la board che torna su — non
    // si riapre dal "+" (che filtra via i tipi singleton già nel gruppo).
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("kanban-column-body-todo").getByText(primo)).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      const c = await cardsNow();
      return c.findIndex((t) => t.includes("primo")) > c.findIndex((t) => t.includes("secondo"));
    }, { timeout: 10000 }).toBe(true);

    // 2) Fra colonne: il drop cambia lo STATO, e il server lo conferma.
    await drag(t1.id, '[data-testid="kanban-column-body-backlog"]');
    await expect(page.getByTestId("kanban-column-body-backlog").getByText(primo)).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      const r = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${t1.id}`);
      return (await r.json()).task.status;
    }, { timeout: 10000 }).toBe("backlog");
  });

  test("BOARD-18: In Progress is not a queue, and the drop says so", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    // The black hole: the dispatcher lists ONLY `status: "todo"`, so a card left
    // in In Progress by hand is picked up by nobody, and leaving Todo also
    // cancels the dispatch already queued for it. The drop ends up where the
    // gesture meant to go, and the blue line under the toolbar says so.
    //
    // This proves the WIRE (dnd-kit -> redirect -> PATCH -> notice on screen) on
    // a card with no agent. WHICH cards get redirected and which do not is the
    // case table in `client/src/lib/boardOrder.test.ts` (bun:test), which covers
    // the delivered one too: that card lives in review, a column the carousel
    // keeps off screen, so dragging from there would measure the scroll instead
    // of the rule.
    const stamp = Date.now();
    const testo = `Lavoraci ora ${stamp}`;
    const task = await apiCreateTask(page.request, { text: testo, status: "backlog" });

    await page.goto("/");
    await openProjectBoard(page);
    const backlog = page.getByTestId("kanban-column-body-backlog");
    await expect(backlog.getByText(testo)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("board-drop-notice")).toHaveCount(0);

    await dragCard(page, task.id, '[data-testid="kanban-column-body-in_progress"]');

    // 1) The card is in Todo, not in In Progress. The server is the source.
    await expect.poll(async () => {
      const r = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`);
      return (await r.json()).task.status;
    }, { timeout: 10000 }).toBe("todo");
    await expect(page.getByTestId("kanban-column-body-todo").getByText(testo)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("kanban-column-body-in_progress").getByText(testo)).toHaveCount(0);

    // 2) And you SEE it: a gesture that silently lands elsewhere is the same
    //    black hole with a different shape.
    await expect(page.getByTestId("board-drop-notice")).toContainText("Todo");
  });
});

/**
 * dnd-kit starts after 4px: it takes a real drag, in steps.
 *
 * Grabbed at the TOP, not at the centre. The sensors are deaf to fields and
 * commands (`dndSensors.ts`), and the centre of a card that offers choices
 * falls on a button: from there the drag never starts at all, and the spec
 * fails saying the drop did nothing. The card's first row is its title, which
 * is a handle in every state.
 */
async function dragCard(page: Page, from: string, to: string) {
  const src = page.locator(`[data-task-card="${from}"]`);
  const dst = page.locator(to);
  // BOTH ends of the gesture must be on screen, and the grab is VERIFIED, not
  // calculated.
  //
  // The board is a scroll-snap carousel (`Card.tsx`: "a scroll-snap carousel at
  // EVERY breakpoint") wider than the window: at the chromium project's 1280
  // viewport, `in_progress` measured x=1093..1379 — geometric centre at 1236,
  // right edge off screen. The mouse cannot go where the screen ends, so the
  // drop landed on another column: the test read `review` where it expected
  // `todo`, green on its own and red in the full run depending on where the
  // carousel had come to rest.
  //
  // But scrolling the DESTINATION into view moves the row, and with it the
  // source card: measured, after the scroll there was no card left at the grab
  // point at all, the drag never started, and the task stayed where it was — a
  // test that failed saying "the redirect rule does not work" while the gesture
  // had never begun.
  //
  // So: destination first, then source, and the grab is confirmed by asking the
  // DOM who is under that point.
  //
  // Between a scroll and reading the boxes, wait for the row to COME TO REST,
  // not for a duration: `scroll-smooth` plus scroll-snap animate, and a box read
  // mid-travel is already stale by the time the mouse gets there. The real
  // condition is "`scrollLeft` stops changing"; a `waitForTimeout` would be the
  // sleep `check:sleeps` forbids, and rightly (on a loaded machine it would not
  // be enough, on an idle one it would be wasted).
  const scrollSettled = async () => {
    await page.waitForFunction(
      () => {
        const row = document.querySelector<HTMLElement>(".snap-x.overflow-x-auto");
        if (!row) return true;
        const w = window as unknown as { __lastScrollLeft?: number; __stillFor?: number };
        const cur = row.scrollLeft;
        if (w.__lastScrollLeft === cur) {
          w.__stillFor = (w.__stillFor ?? 0) + 1;
        } else {
          w.__lastScrollLeft = cur;
          w.__stillFor = 0;
        }
        // Three identical consecutive samples, one per frame: the inertial
        // scroll has finished, not merely slowed down.
        return (w.__stillFor ?? 0) >= 3;
      },
      undefined,
      { timeout: 5_000, polling: "raf" },
    );
    await page.evaluate(() => {
      const w = window as unknown as { __lastScrollLeft?: number; __stillFor?: number };
      w.__lastScrollLeft = undefined;
      w.__stillFor = undefined;
    });
  };
  await dst.scrollIntoViewIfNeeded();
  await scrollSettled();
  await src.scrollIntoViewIfNeeded();
  await scrollSettled();
  const a = (await src.boundingBox())!;
  const b = (await dst.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + 12);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** L'id del task con questo testo, letto dall'API (le card lo espongono come attributo). */
async function apiFindTask(page: Page, text: string): Promise<string> {
  const r = await page.request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`);
  const { tasks } = (await r.json()) as { tasks: { id: string; text: string }[] };
  const hit = tasks.find((t) => t.text === text);
  if (!hit) throw new Error(`nessun task con testo "${text}"`);
  return hit.id;
}

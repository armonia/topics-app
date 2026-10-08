# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: board-feed-reads.spec.ts >> Kanban board — letture del feed >> BOARD-20: la lettura parcheggiata durante il drag non riporta indietro la card
- Location: tests/e2e/board-feed-reads.spec.ts:220:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('kanban-board')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByTestId('kanban-board')

```

# Test source

```ts
  1   | /**
  2   |  * board-feed-reads.spec.ts — how many times the board READS, and when.
  3   |  *
  4   |  * Sibling of board.spec.ts, which owns what the board renders. These two cases
  5   |  * are about the read itself and share nothing with the rendering ones except
  6   |  * the project fixture, so they live apart: board.spec.ts was over the file-size
  7   |  * gate with them inside.
  8   |  *
  9   |  *  - BOARD-19: a burst of WS events costs at most TWO reads of the global feed
  10  |  *  - BOARD-20: a read parked during a drag must not undo the drop
  11  |  */
  12  | import { test } from "./fixtures/layout.fixture";
  13  | import { projectRow } from "./helpers/project-row";
  14  | import { expect, type Page } from "@playwright/test";
  15  | import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
  16  | import { mkdirSync, writeFileSync } from "fs";
  17  | import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
  18  | import { E2E_BASE } from "./helpers/test-server";
  19  | import { hermetic } from "./fixtures/hermetic";
  20  | import { interceptWebSocket } from "./helpers/ws-helpers";
  21  | import { projectIdForPath as boardIdForPath } from "../../shared/board";
  22  | 
  23  | hermetic(test);
  24  | 
  25  | const BASE = E2E_BASE;
  26  | // Canonical spelling (`/private/tmp` on macOS): the server resolves the
  27  | // topic's projectPath and hashes the STRING into the board id, so a literal
  28  | // `/tmp` addressed a board nobody's session was bound to — locally only, the
  29  | // Linux runner has a real `/tmp`. See `canonicalTmpDir`.
  30  | const PROJECT_PATH = canonicalTmpDir("e2e-board-feed");
  31  | 
  32  | const PROJECT_ID = boardIdForPath(PROJECT_PATH);
  33  | 
  34  | /** La finestra di coalescenza del feed — la stessa di `useGlobalBoard`. */
  35  | const FINESTRA_MS = 400;
  36  | 
  37  | /**
  38  |  * Un `task:updated` che il client ACCETTA.
  39  |  *
  40  |  * Il frame deve portare l'oggetto `task` con `id`/`projectId`/`status`
  41  |  * (`shared/ws-outbound.ts`), e chi arriva senza viene scartato dalla
  42  |  * validazione in ingresso di `useWebSocket` — in silenzio, perché il messaggio
  43  |  * di scarto esiste solo in DEV e il banco gira su un bundle di produzione.
  44  |  * Questo file mandava frame con `taskId` e basta: non svegliavano nessuno, e i
  45  |  * due test qui sotto misuravano una raffica che non era mai partita.
  46  |  */
  47  | function taskUpdated(taskId: string, status: string, extra: Record<string, unknown> = {}) {
  48  |   return { type: "task:updated", projectId: PROJECT_ID, task: { id: taskId, projectId: PROJECT_ID, status, ...extra } };
  49  | }
  50  | 
  51  | let projectTopicId: string | null = null;
  52  | const createdTasks: string[] = [];
  53  | 
  54  | async function apiCreateTask(
  55  |   request: import("@playwright/test").APIRequestContext,
  56  |   body: { text: string; status?: string },
  57  | ): Promise<{ id: string; status: string }> {
  58  |   const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  59  |   expect(res.ok()).toBe(true);
  60  |   const task = (await res.json()) as { id: string; status: string };
  61  |   createdTasks.push(task.id);
  62  |   return task;
  63  | }
  64  | 
  65  | /** Il "+" della finestra di progetto → Board (vedi board.spec.ts per il giro). */
  66  | async function openProjectBoard(page: Page) {
  67  |   const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  68  |   if ((await projectsSection.count()) > 0) {
  69  |     const expanded = await projectsSection.getAttribute("aria-expanded");
  70  |     if (expanded === "false") await projectsSection.click();
  71  |   }
  72  |   const btn = projectRow(page, /e2e-board-feed/);
  73  |   await expect(btn).toBeVisible({ timeout: 10000 });
  74  |   await btn.click();
  75  |   await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  76  | 
  77  |   const triggers = page.getByTestId("pane-add-menu-trigger");
  78  |   const count = await triggers.count();
  79  |   const item = page.getByTestId("pane-add-menu-kanban");
  80  |   let opened = false;
  81  |   for (let i = count - 1; i >= 0; i--) {
  82  |     const t = triggers.nth(i);
  83  |     if (!(await t.isVisible().catch(() => false))) continue;
  84  |     if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
  85  |     if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
  86  |       opened = true;
  87  |       break;
  88  |     }
  89  |     await page.keyboard.press("Escape");
  90  |   }
  91  |   if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  92  |   await item.click();
> 93  |   await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
      |                                                  ^ Error: expect(locator).toBeVisible() failed
  94  | }
  95  | 
  96  | test.describe("Kanban board — letture del feed", () => {
  97  |   test.describe.configure({ timeout: 60_000 });
  98  | 
  99  |   test.beforeAll(async ({ request }) => {
  100 |     mkdirSync(PROJECT_PATH, { recursive: true });
  101 |     writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board-feed" }, null, 2));
  102 |     const topic = await createTopic(request, "E2E-Board-Feed", { projectPath: PROJECT_PATH });
  103 |     projectTopicId = topic.id;
  104 |   });
  105 | 
  106 |   test.afterAll(async ({ request }) => {
  107 |     for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
  108 |     if (projectTopicId) await deleteTopic(request, projectTopicId);
  109 |     removeTmpDir(PROJECT_PATH);
  110 |   });
  111 | 
  112 |   // Workspace ermetico per OGNI test: si azzerano ENTRAMBI i canali di stato
  113 |   // (globale + layout della finestra di progetto), poi si riapre il progetto.
  114 |   // Il perché sta per esteso in board.spec.ts.
  115 |   test.beforeEach(async ({ page }) => {
  116 |     await resetPaneStore(page.request, []);
  117 |     await resetProjectPanes(page.request, PROJECT_PATH);
  118 |     await seedProjectPane(page.request, PROJECT_PATH);
  119 |   });
  120 | 
  121 |   test("BOARD-19: una raffica di 10 eventi costa al massimo DUE letture del feed globale", async ({ page }) => {
  122 |     test.info().annotations.push({ type: "spec", description: "KANBAN-06" });
  123 |     // Misurato sulla macchina viva il 15/08/2026: `GET /api/all-boards/tasks`
  124 |     // sono 467 task radice, 1.435.735 byte, 145 ms. Erano TRE i lettori
  125 |     // indipendenti che lo richiedevano a ogni evento `task:*` (la pane della
  126 |     // board, `useTaskTopicIndex`, `useGlobalBoard`) e uno solo raffreddava la
  127 |     // raffica: dieci mosse di agente in due secondi valevano una ventina di
  128 |     // letture e altrettanti ridisegni per arrivare a UNO stato.
  129 |     //
  130 |     // Adesso il feed ha un proprietario solo e la raffica si chiude in una
  131 |     // finestra di 400 ms: la prima lettura parte subito (chi ha appena mosso
  132 |     // una card non aspetta) e la coda ne fa UNA per tutte le altre.
  133 |     const stamp = Date.now();
  134 |     const testo = `Raffica ${stamp}`;
  135 |     const marcatore = `Raffica letta ${stamp}`;
  136 |     const seme = await apiCreateTask(page.request, { text: testo, status: "todo" });
  137 | 
  138 |     // Il feed passa dal server vero (nessuno schema copiato a mano qui), ma
  139 |     // ogni richiesta si conta e, dal marcatore in poi, la risposta cambia il
  140 |     // testo della card: è così che si sa che la lettura di CODA è atterrata,
  141 |     // invece di aspettare un tempo a caso.
  142 |     let letture = 0;
  143 |     let inVolo = 0;
  144 |     let lastActivity = Date.now();
  145 |     let marcato = false;
  146 |     let corpo: { tasks: { id: string; text: string }[] } | null = null;
  147 |     await page.route(/\/api\/all-boards\/tasks(\?|$)/, async (route) => {
  148 |       letture++;
  149 |       inVolo++;
  150 |       lastActivity = Date.now();
  151 |       if (!corpo) corpo = (await (await route.fetch()).json()) as { tasks: { id: string; text: string }[] };
  152 |       const tasks = corpo.tasks.map((t) => (marcato && t.id === seme.id ? { ...t, text: marcatore } : t));
  153 |       await route.fulfill({ json: { tasks } });
  154 |       inVolo--;
  155 |       lastActivity = Date.now();
  156 |     });
  157 | 
  158 |     /**
  159 |      * «Il feed ha smesso di leggere»: niente in volo, e nessuna richiesta nuova
  160 |      * per più di una finestra di coalescenza.
  161 |      *
  162 |      * Serve due volte, e per la stessa ragione: l'apertura della board fa
  163 |      * partire la SUA raffica (montaggio + riconnessione della socket), la cui
  164 |      * coda atterra ~400 ms dopo. Senza aspettarla, il conteggio della raffica
  165 |      * vera si sommava a quella dell'avvio, e — peggio — il verdetto dipendeva
  166 |      * da quale lato del `marcato = true` cadeva quella coda: è così che questo
  167 |      * test passava, e passava senza misurare niente.
  168 |      *
  169 |      * Non è un `waitForTimeout`: è una condizione su ciò che si osserva, e
  170 |      * scade in rosso se il feed non si ferma mai.
  171 |      */
  172 |     const stoppedFeed = async () => {
  173 |       await expect
  174 |         .poll(() => inVolo === 0 && Date.now() - lastActivity > 3 * FINESTRA_MS, {
  175 |           timeout: 15_000,
  176 |           intervals: [100],
  177 |           message: "il feed globale non smette di leggere",
  178 |         })
  179 |         .toBe(true);
  180 |     };
  181 | 
  182 |     // L'intercettazione della WebSocket va installata PRIMA del goto, o la
  183 |     // connessione iniziale sfugge (vedi helpers/ws-helpers.ts).
  184 |     const ws = await interceptWebSocket(page);
  185 |     await resetPaneStore(page.request, []);
  186 |     await page.goto("/");
  187 | 
  188 |     await page.getByTestId("pane-add-menu-trigger").first().click();
  189 |     await page.getByTestId("pane-add-menu-board").click();
  190 |     const board = page.getByTestId("kanban-board");
  191 |     await expect(board).toBeVisible({ timeout: 10000 });
  192 |     await expect(board.getByText(testo)).toBeVisible({ timeout: 10000 });
  193 | 
```
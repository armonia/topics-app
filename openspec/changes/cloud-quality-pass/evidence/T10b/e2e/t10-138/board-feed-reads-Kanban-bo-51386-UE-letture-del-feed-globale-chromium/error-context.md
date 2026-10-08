# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: board-feed-reads.spec.ts >> Kanban board — letture del feed >> BOARD-19: una raffica di 10 eventi costa al massimo DUE letture del feed globale
- Location: tests/e2e/board-feed-reads.spec.ts:121:7

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
  91  |   if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  92  |   await item.click();
  93  |   await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
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
> 191 |     await expect(board).toBeVisible({ timeout: 10000 });
      |                         ^ Error: expect(locator).toBeVisible() failed
  192 |     await expect(board.getByText(testo)).toBeVisible({ timeout: 10000 });
  193 | 
  194 |     // Da qui si misura: le letture dell'avvio non sono la raffica.
  195 |     await stoppedFeed();
  196 |     letture = 0;
  197 |     marcato = true;
  198 |     // THE FRAME CARRIES THE MARKER, the feed response no longer does. A
  199 |     // `task:updated` that stays inside the feed's cut is now written straight
  200 |     // into the store (`applyBoardTaskFrame`), so a burst costs ZERO reads:
  201 |     // waiting for the marker to arrive on a read was waiting for a read the
  202 |     // product has stopped doing, and the test hung for ten seconds. The marker
  203 |     // now proves the right thing, and a stronger one: the ten frames were
  204 |     // APPLIED.
  205 |     for (let i = 0; i < 10; i++) ws.send(taskUpdated(seme.id, "todo", { text: marcatore }));
  206 | 
  207 |     await expect(board.getByText(marcatore)).toBeVisible({ timeout: 10000 });
  208 |     // La coda della raffica arriva DOPO la prima lettura: contare qui, appena
  209 |     // il marcatore compare, misurerebbe mezza raffica.
  210 |     await stoppedFeed();
  211 |     // The ceiling is the point of the test. The floor is no longer "at least
  212 |     // one read": an absorbed burst does zero, and that is the intended
  213 |     // behaviour. What stops the ceiling from being true for the wrong reason
  214 |     // (frames dropped by the inbound validation in `shared/ws-outbound.ts`, so
  215 |     // no reads because nothing arrived) is the marker above: it only appears if
  216 |     // the ten frames were really applied.
  217 |     expect(letture).toBeLessThanOrEqual(2);
  218 |   });
  219 | 
  220 |   test("BOARD-20: la lettura parcheggiata durante il drag non riporta indietro la card", async ({ page }) => {
  221 |     test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
  222 |     // Il difetto, sotto BOARD-17: mentre una card è in mano la board rimanda a
  223 |     // dopo ogni rilettura, e quella coda si svuotava in cima a `onDragEnd` —
  224 |     // cioè PRIMA della PATCH del drop. La GET partiva e rispondeva con lo stato
  225 |     // di partenza, perfettamente corretta e perfettamente vecchia: la card
  226 |     // tornava nella colonna da cui l'avevi presa e ci restava per un giro di
  227 |     // rete intero. Sembrava un drop non preso, e capitava proprio quando la
  228 |     // board è viva — cioè quando un altro client si muove mentre trascini.
  229 |     //
  230 |     // La scena riproduce le due condizioni insieme: un evento `task:*` estraneo
  231 |     // A PUNTATORE ABBASSATO (che è ciò che mette una lettura in coda) e una
  232 |     // PATCH lenta (che allarga la finestra in cui la risposta vecchia può
  233 |     // vincere). La prova è la NEGAZIONE — la card non ricompare mai nella
  234 |     // colonna di partenza — quindi si guarda a raffica, non una volta sola.
  235 |     const stamp = Date.now();
  236 |     const testo = `Drag lento ${stamp}`;
  237 |     const estraneo = `Rumore di fondo ${stamp}`;
  238 |     const task = await apiCreateTask(page.request, { text: testo, status: "todo" });
  239 |     const altro = await apiCreateTask(page.request, { text: estraneo, status: "backlog" });
  240 | 
  241 |     // La PATCH del drop, rallentata. Non è un trucco per far passare il test:
  242 |     // è la finestra vera, misurata in millisecondi su una macchina scarica,
  243 |     // allargata quanto basta perché il rosso sia leggibile invece che raro.
  244 |     await page.route(/\/api\/boards\/[^/]+\/tasks\/[^/?]+$/, async (route) => {
  245 |       if (route.request().method() !== "PATCH") return route.fallback();
  246 |       await new Promise((r) => setTimeout(r, 800));
  247 |       await route.continue();
  248 |     });
  249 | 
  250 |     const ws = await interceptWebSocket(page);
  251 |     await page.goto("/");
  252 |     await openProjectBoard(page);
  253 | 
  254 |     const todo = page.getByTestId("kanban-column-body-todo");
  255 |     const backlog = page.getByTestId("kanban-column-body-backlog");
  256 |     await expect(todo.getByText(testo)).toBeVisible({ timeout: 10000 });
  257 | 
  258 |     // Il drag, a mano: serve un punto in cui il puntatore è ancora giù.
  259 |     const src = page.locator(`[data-task-card="${task.id}"]`);
  260 |     const a = (await src.boundingBox())!;
  261 |     const b = (await backlog.boundingBox())!;
  262 |     await page.mouse.move(a.x + a.width / 2, a.y + 12);
  263 |     await page.mouse.down();
  264 |     await page.mouse.move(a.x + a.width / 2 + 8, a.y + 20, { steps: 4 });
  265 |     await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  266 |     // QUI: la card è in aria, e un altro task si muove. La board mette la
  267 |     // rilettura in coda invece di rifare le colonne sotto il puntatore.
  268 |     ws.send(taskUpdated(altro.id, "backlog"));
  269 |     await page.waitForTimeout(150);
  270 |     await page.mouse.up();
  271 | 
  272 |     // 1,5 s a 50 ms: se la lettura in coda parte prima della PATCH, la card
  273 |     // ricompare in Todo per qualche centinaio di millisecondi. Una sola
  274 |     // occhiata, alla fine, non vedrebbe niente.
  275 |     const fine = Date.now() + 1500;
  276 |     let ricomparsa = 0;
  277 |     while (Date.now() < fine) {
  278 |       if ((await todo.locator(`[data-task-card="${task.id}"]`).count()) > 0) ricomparsa++;
  279 |       await page.waitForTimeout(50);
  280 |     }
  281 |     expect(ricomparsa, "la card è tornata nella colonna di partenza").toBe(0);
  282 | 
  283 |     // E il drop è andato davvero: la negazione da sola sarebbe vera anche se la
  284 |     // card fosse sparita del tutto.
  285 |     await expect(backlog.locator(`[data-task-card="${task.id}"]`)).toBeVisible({ timeout: 10000 });
  286 |     await expect.poll(async () => {
  287 |       const r = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`);
  288 |       return (await r.json()).task.status;
  289 |     }, { timeout: 10000 }).toBe("backlog");
  290 |   });
  291 | });
```
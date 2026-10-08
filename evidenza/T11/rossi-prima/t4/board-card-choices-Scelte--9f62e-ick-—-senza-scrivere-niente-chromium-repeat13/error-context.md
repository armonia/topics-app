# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: board-card-choices.spec.ts >> Scelte sempre presenti sulla card >> quattro stati, quattro decisioni in un click — senza scrivere niente
- Location: tests/e2e/board-card-choices.spec.ts:181:7

# Error details

```
TimeoutError: locator.click: Timeout 15000ms exceeded.
Call log:
  - waiting for locator('[data-task-card="a8f994ad-ebc1-4170-a864-527a4a44b825"]').getByTestId('task-choices-menu')
    - locator resolved to <button aria-haspopup="menu" aria-expanded="false" title="Azioni su questo turno" data-testid="task-choices-menu" aria-label="Azioni su questo turno" class="flex shrink-0 items-center rounded-md px-1.5 py-1.5 text-app-text-secondary hover:bg-white/10 hover:text-app-text disabled:opacity-50 ">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not stable
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not stable
    - retrying click action
      - waiting 100ms
    - waiting for element to be visible, enabled and stable
  - element was detached from the DOM, retrying

```

# Test source

```ts
  139 |     git(wt.absPath, ["commit", "-q", "-m", "scheda: rifatta"]);
  140 | 
  141 |     const topic = await createTopic(request, "E2E-Scelte", { projectPath: REPO });
  142 |     topicId = topic.id;
  143 |     expect((await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId: wt.id } })).ok()).toBe(true);
  144 | 
  145 |     // 4a. Card in REVIEW CON RAMO: legata alla topic dell'agente, poi mandata in
  146 |     //     review — è il passaggio che fotografa il ramo consegnato.
  147 |     taskIds.ramo = await createTask(request, { text: T_RAMO, status: "todo" });
  148 |     expect((await request.post(`${API}/test/tasks/${taskIds.ramo}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
  149 |     expect((await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.ramo}`, { data: { status: "review" } })).ok()).toBe(true);
  150 |     // Se questa cade, il rosso parla del SETUP: senza ramo la card mostrerebbe
  151 |     // le scelte dell'altro stato e il test verificherebbe un'altra cosa.
  152 |     const ramo = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.ramo}`);
  153 |     expect(((await ramo.json()) as { task: { deliveryBranch: string | null } }).task.deliveryBranch).toBeTruthy();
  154 | 
  155 |     // 4b. Card in REVIEW SENZA RAMO (una consegna che non è codice).
  156 |     taskIds.piano = await createTask(request, { text: T_PIANO, status: "review" });
  157 | 
  158 |     // 4c. Card IN CORSO, con l'agente davvero al lavoro (chip `working`: lo
  159 |     //     scrive solo il dispatcher, qui lo semina la route di test).
  160 |     taskIds.corso = await createTask(request, { text: T_CORSO, status: "in_progress" });
  161 |     expect((await request.post(`${API}/test/tasks/${taskIds.corso}/dispatch-state`, { data: { state: "working" } })).ok()).toBe(true);
  162 | 
  163 |     // 4d. Card BLOCCATA da un'altra card aperta.
  164 |     taskIds.bloccante = await createTask(request, { text: BLOCKING_T, status: "backlog" });
  165 |     taskIds.bloccata = await createTask(request, { text: BLOCKED_T, status: "backlog", blockedByTaskId: taskIds.bloccante });
  166 |   });
  167 | 
  168 |   test.afterAll(async ({ request }) => {
  169 |     for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
  170 |     if (topicId) await deleteTopic(request, topicId);
  171 |     if (worktreePath && existsSync(worktreePath)) removeTmpDir(worktreePath);
  172 |     removeTmpDir(REPO);
  173 |   });
  174 | 
  175 |   test.beforeEach(async ({ page }) => {
  176 |     await resetPaneStore(page.request, []);
  177 |     await resetProjectPanes(page.request, REPO);
  178 |     await seedProjectPane(page.request, REPO);
  179 |   });
  180 | 
  181 |   test("quattro stati, quattro decisioni in un click — senza scrivere niente", async ({ page }) => {
  182 |     test.info().annotations.push({ type: "spec", description: "KANBAN-02" });
  183 |     await page.goto("/");
  184 |     await openProjectBoard(page);
  185 | 
  186 |     const card = (id: string) => page.locator(`[data-task-card="${id}"]`);
  187 |     const choice = (id: string, choiceId: string) => card(id).getByTestId(`task-choice-${choiceId}`);
  188 | 
  189 |     // ── 1. Review CON ramo: landare, rimandare indietro, prenderselo ──────────
  190 |     const ramo = card(taskIds.ramo);
  191 |     await expect(ramo).toBeVisible({ timeout: 10000 });
  192 |     await expect(choice(taskIds.ramo, "land")).toHaveText("Landa su main");
  193 |     await expect(choice(taskIds.ramo, "send-back")).toHaveText("Rimanda indietro");
  194 |     await expect(choice(taskIds.ramo, "take-over")).toHaveText("Serve a me");
  195 |     await beat(page);
  196 |     // Un click: la card esce dalla review e passa in mano all'umano (@io).
  197 |     await choice(taskIds.ramo, "take-over").click();
  198 |     await expect(page.getByTestId("kanban-column-body-in_progress").locator(`[data-task-card="${taskIds.ramo}"]`))
  199 |       .toBeVisible({ timeout: 10000 });
  200 |     await expect(ramo).toContainText("@io");
  201 |     await beat(page);
  202 | 
  203 |     // ── 2. Review SENZA ramo: approva / rifai così… / archivia ────────────────
  204 |     // The words come from the one table (`taskActionWords`): the same ones the
  205 |     // card's context menu and the drawer's own buttons say.
  206 |     const piano = card(taskIds.piano);
  207 |     await expect(choice(taskIds.piano, "accept")).toHaveText("Approva");
  208 |     await expect(choice(taskIds.piano, "redo")).toHaveText("Rifai così…");
  209 |     await expect(choice(taskIds.piano, "drop")).toHaveText("Archivia");
  210 |     // Il commento libero RESTA — ultima opzione, non l'unica.
  211 |     await expect(piano.getByPlaceholder("…oppure commenta")).toBeVisible();
  212 |     await beat(page);
  213 |     await choice(taskIds.piano, "accept").click();
  214 |     await expect(page.getByTestId("kanban-column-body-done").locator(`[data-task-card="${taskIds.piano}"]`))
  215 |       .toBeVisible({ timeout: 10000 });
  216 |     await beat(page);
  217 | 
  218 |     // ── 3. In corso: fermarsi o farsi consegnare quello che c'è ───────────────
  219 |     // Qui le due scelte NON sono bottoni sulla card: stanno dietro il `⋯` della
  220 |     // riga. Sono azioni rare su una card che non chiede niente (sta lavorando),
  221 |     // e due bottoni pieni pesavano su ogni card in corso della board. Il menu è
  222 |     // in un portal su `<body>`, quindi il pannello si cerca dalla pagina e non
  223 |     // dentro la card.
  224 |     //
  225 |     // Il chip `working` senza un turno vivo dietro è, per il server, un orfano da
  226 |     // recuperare: il giro di `reconcile` (10s) se lo riprende e rimette la card
  227 |     // in coda. Lo si rimette finché la card non mostra il suo menu — poi le
  228 |     // asserzioni e il click stanno dentro la finestra.
  229 |     const menuBtn = card(taskIds.corso).getByTestId("task-choices-menu");
  230 |     await expect.poll(async () => {
  231 |       await page.request.post(`${API}/test/tasks/${taskIds.corso}/dispatch-state`, { data: { state: "working" } });
  232 |       // La board si aggiorna sui broadcast, e la route di test non ne emette:
  233 |       // una PATCH innocua sullo stesso task ne emette uno col chip fresco.
  234 |       await page.request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.corso}`, { data: { priority: 2 } });
  235 |       return await menuBtn.count();
  236 |     }, { timeout: 30_000, intervals: [400, 800, 1500] }).toBeGreaterThan(0);
  237 |     // E la card in corso NON porta più la riga di bottoni: è il punto del menu.
  238 |     await expect(card(taskIds.corso).getByTestId("task-choices")).toHaveCount(0);
> 239 |     await menuBtn.click();
      |                   ^ TimeoutError: locator.click: Timeout 15000ms exceeded.
  240 |     const menu = page.getByTestId("task-choices-panel");
  241 |     await expect(menu.getByTestId("task-choice-stop")).toHaveText("Ferma");
  242 |     await expect(menu.getByTestId("task-choice-deliver-now")).toHaveText("Consegna quello che hai");
  243 |     await menu.getByTestId("task-choice-stop").click();
  244 |     // Fermare stacca l'agente e PARCHEGGIA il task: esce da In Progress.
  245 |     await expect(page.getByTestId("kanban-column-body-in_progress").locator(`[data-task-card="${taskIds.corso}"]`))
  246 |       .toHaveCount(0, { timeout: 10000 });
  247 |     await beat(page);
  248 | 
  249 |     // ── 4. Bloccata: il bottone NOMINA il bloccante ───────────────────────────
  250 |     const bloccata = card(taskIds.bloccata);
  251 |     // Il fatto sotto esame è che la card NOMINI il bloccante, non il verbo con
  252 |     // cui lo dice: il chip è passato da «in attesa di: X» ad «aspetta: X»
  253 |     // (12/08, vedi lib/board.ts) e un'asserzione sulla frase intera si rompeva
  254 |     // senza che niente fosse rotto.
  255 |     await expect(bloccata.getByTestId("card-blocked-by")).toContainText(BLOCKING_T);
  256 |     // Here too the choices live behind the `⋯` at the end of the chip row, and
  257 |     // for one reason more than the working card's: the row of buttons was the
  258 |     // LAST thing on the card, that is the geometric centre of a short one, so
  259 |     // the click meant to open the drawer pressed «sblocca» instead. The panel     allow-italian: quoted UI string
  260 |     // is in a portal on `<body>`: it is looked up from the page.
  261 |     await expect(bloccata.getByTestId("task-choices")).toHaveCount(0);
  262 |     await bloccata.getByTestId("task-choices-menu").click();
  263 |     const choicesPanel = page.getByTestId("task-choices-panel");
  264 |     await expect(choicesPanel.getByTestId("task-choice-unblock")).toHaveText(`Sblocca: ${BLOCKING_T}`);
  265 |     await expect(choicesPanel.getByTestId("task-choice-unlink")).toHaveText("Togli il legame");
  266 |     await beat(page);
  267 |     await choicesPanel.getByTestId("task-choice-unblock").click();
  268 |     // Un click: il legame cade e la card è in Todo, pronta a partire.
  269 |     await expect(page.getByTestId("kanban-column-body-todo").locator(`[data-task-card="${taskIds.bloccata}"]`))
  270 |       .toBeVisible({ timeout: 10000 });
  271 |     await expect(bloccata.getByTestId("card-blocked-by")).toHaveCount(0);
  272 |     await beat(page, 1800);
  273 |   });
  274 | });
  275 | 
```
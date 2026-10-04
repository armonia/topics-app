import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * "Una domanda a scelta multipla dell'agente si clicca, e la risposta torna
 *  AL MODELLO — non è un nuovo messaggio umano."
 *
 * Il modello, in una chat nativa headless, non ha il built-in AskUserQuestion
 * (la CLI lo registra solo in modalità interattiva). Topics ri-espone lo stesso
 * contratto come tool del bridge MCP `mcp__topics__ask_user_question`: il
 * `tool_use` viene reso dal detector esistente come pannello cliccabile, e la
 * risposta rientra come RISULTATO del tool via il rendez-vous di
 * `server/lib/ask-user-bridge.ts` — sbloccando il turno senza che l'umano
 * scriva niente.
 *
 * Questo e2e esercita il rendez-vous VERO del server: registra un waiter come
 * farebbe il sottoprocesso del bridge (POST /api/sessions/:key/ask-user, che
 * blocca), poi guida il pannello reale nell'UI. Quando l'umano invia, il POST
 * del bridge si risolve con esattamente le risposte scelte.
 *
 * È un COMPORTAMENTO: video acceso, il .webm è la prova. Le parti pure hanno
 * unit test dedicati (ask-user-bridge.test.ts, ask-user-detector.test.ts,
 * topics-mcp-server.test.ts → callAskUserQuestion).
 *
 * @covers ASK-09
 */
test.use({ video: "on" });

test.describe.serial("Pannello AskUserQuestion nativo", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `ask-user-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * Seed an assistant turn that is paused on the bridge ask tool. The seed
   * endpoint stores `toolCalls` verbatim, so the persisted `userInputSchema`
   * survives the round-trip and <ToolCallRow> renders <ToolInputForm> (a
   * waiting_for_input tool auto-expands).
   */
  async function seedAsk(
    request: import("@playwright/test").APIRequestContext,
    toolCallId: string,
    question: string,
    options: Array<{ label: string; description?: string }>,
  ) {
    await seedMessage(request, { sessionKey, role: "user", content: "aiutami a decidere" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Ho bisogno di una tua scelta:",
      toolCalls: [
        {
          id: toolCallId,
          name: "mcp__topics__ask_user_question",
          args: { questions: [{ question, header: "Scelta", options }] },
          status: "waiting_for_input",
          // Il turno è partito qualche secondo fa: la riga deve mostrare da
          // quanto l'agente aspetta (vedi il test sull'orologio più sotto).
          startedAt: Date.now() - 4_000,
          // Persisted verbatim → drives the clickable panel on load.
          userInputSchema: {
            kind: "questions",
            questions: [{ question, header: "Scelta", options, multiSelect: false }],
          },
        },
      ],
    });
  }

  /**
   * Drive the ask exactly as the MCP bridge subprocess does: POST a poll leg,
   * and come straight back while the server answers `{pending:true}`. Legs are
   * short on purpose — the defect this guards against is a leg EXPIRING under a
   * human who is still reading, so the tests deliberately cross that boundary
   * instead of racing to answer inside one leg.
   */
  function registerBridgeAsk(
    request: import("@playwright/test").APIRequestContext,
    questions: unknown,
    legMs = 800,
  ): Promise<{ answers?: Record<string, string>; cancelled?: boolean; legs: number }> {
    return (async () => {
      for (let legs = 1; legs <= 200; legs++) {
        const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/ask-user`, {
          data: { questions, legMs },
          ignoreHTTPSErrors: true,
          timeout: 60_000,
        });
        const body = (await r.json()) as { answers?: Record<string, string>; cancelled?: boolean; pending?: boolean };
        if (!body.pending) return { ...body, legs };
      }
      throw new Error("il bridge ha pollato 200 volte senza risposta");
    })();
  }

  test("scelta singola: clic → Send → la risposta torna al bridge e il turno riprende", async ({ page, chatPage, request }) => {

    test.info().annotations.push({ type: "spec", description: "ASK-06" });
    const toolCallId = "toolu_ask_single";
    const question = "Quale metodo di auth?";
    const options = [
      { label: "OAuth", description: "Gestito dal provider" },
      { label: "JWT", description: "Emesso da noi" },
    ];
    await seedAsk(request, toolCallId, question, options);

    // The MCP bridge subprocess is now blocked waiting for the human.
    const bridge = registerBridgeAsk(request, [{ question, header: "Scelta", options }]);

    // Proxy the WS so we can inject the CLI's follow-up (tool_result) that a
    // real turn would emit once the answer is delivered — this is what visibly
    // resumes the turn in the video.
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // The clickable panel is present (not a spinner, not a textarea).
    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });
    await expect(form.getByText("OAuth")).toBeVisible();
    await expect(form.getByText("JWT")).toBeVisible();
    // The always-present "Other" free-text escape hatch.
    await expect(form.getByText("Altro")).toBeVisible();

    // Mentre la palla è dell'umano la riga NON tiene un cronometro acceso: un
    // contatore che scorre mentre si legge una domanda mette fretta e non dice
    // niente di nuovo. Che stia aspettando lo annuncia il cerchietto ambra; da
    // quanto, il title del cronometro del turno (l'unico che ha un tick).
    const row = page.locator(`[data-testid="tool-call-row-${toolCallId}"]`);
    await expect(row.locator('[data-testid="tool-elapsed"]')).toHaveCount(0);

    // E il testo su cui l'umano deve DECIDERE è grande come il corpo della
    // chat, non come il chrome del log: la domanda a 13px, non a 11.
    const legend = form.locator("legend").first();
    await expect(legend).toHaveCSS("font-size", "13px");
    await expect(form.locator("label").first()).toHaveCSS("font-size", "13px");

    // Un umano legge prima di scegliere: qui è anche il tempo che rende il
    // video guardabile, e attraversa più di una gamba di poll del bridge.
    // DELIBERATE FIXED WAIT: the elapsed time is part of what is under test —
    // the panel must survive a poll leg boundary — and there is no condition
    // that means "a person has been reading for a while".
    await page.waitForTimeout(2000);

    // Pick OAuth and send. The wait is the radio actually taking the value —
    // the form's send button reads React state, not the DOM, so what matters is
    // that the change handler ran, not that 600 ms went by.
    const oauth = form.locator('input[type="radio"][value="OAuth"]');
    await oauth.check();
    await expect(oauth).toBeChecked();
    await form.getByRole("button", { name: /Invia/ }).click();

    // THE contract: the answer returns to the model as the tool's result —
    // exactly the chosen label, keyed by the question text.
    const result = await bridge;
    expect(result.cancelled).toBeFalsy();
    expect(result.answers).toEqual({ [question]: "OAuth" });
    // …e ci è arrivata DOPO che almeno una gamba era già scaduta: è la
    // giuntura su cui è morta la prima domanda vera.
    expect(result.legs).toBeGreaterThan(1);

    // Simulate the CLI resuming: emit the tool_result the model would produce.
    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    inject!(JSON.stringify({
      type: "stream:tool_result",
      sessionKey,
      topicId,
      toolCallId,
      status: "success",
      result: JSON.stringify({ answers: { [question]: "OAuth" } }),
    }));

    // The panel is gone — the turn moved on.
    await expect(form).toBeHidden({ timeout: 10_000 });

    // AND THE CHOICE STAYS ON SCREEN. Reported on 04/10: the tool row did not
    // show the answer that had been picked. It lived only in the collapsible
    // body, which closes when the tool finishes. Now the closed row says
    // "question -> choice" without opening anything.
    const header = row.locator("button[aria-expanded]").first();
    await expect(header, "finito, il tool si richiude").toHaveAttribute("aria-expanded", "false", { timeout: 10_000 });
    const recap = page.getByTestId(`question-answer-${toolCallId}`);
    await expect(recap).toBeVisible();
    await expect(recap.getByTestId("question-answer-line")).toHaveCount(1);
    await expect(recap).toContainText(question);
    await expect(recap.getByTestId("question-answer-value")).toHaveText("OAuth");
    await row.screenshot({ path: test.info().outputPath("answer-recap-closed.png") });

    // Open, the card shows what the choice was made from: the pick ticked, the
    // other one dimmed and without a tick.
    await header.click();
    const card = page.getByTestId(`question-answer-card-${toolCallId}`);
    await expect(card).toBeVisible();
    const chosen = card.locator('[data-testid="question-answer-option"][data-chosen="true"]');
    await expect(chosen).toHaveCount(1);
    await expect(chosen).toHaveText("OAuth");
    await expect(chosen.locator("svg")).toHaveCount(1);
    const notChosen = card.locator('[data-testid="question-answer-option"]:not([data-chosen])');
    await expect(notChosen).toHaveText(["JWT"]);
    await expect(notChosen.locator("svg")).toHaveCount(0);
    // DELIBERATE FIXED WAIT: the .webm is the deliverable for this behaviour, and
    // this is the tail frame that shows the answer kept in the thread. Nothing
    // is asserted after it.
    await page.waitForTimeout(800);
  });

  test("l'opzione consigliata si vede, comunque il modello l'abbia detta", async ({ page, chatPage, request }) => {
    // Chi propone tre strade ha quasi sempre un'idea di quale sia la migliore.
    // Il campo `recommended` è la via pulita, ma la CLI lo scrive in coda al
    // titolo — «(Recommended)» — e un modello che non conosce il campo fa lo
    // stesso a parole: si riconoscono entrambe, e la parola in coda si toglie
    // dal titolo perché il chip la dice già.
    const toolCallId = "toolu_ask_reco";
    const question = "Quale runtime?";
    const options = [
      { label: "Bun (Recommended)", description: "Quello che usiamo" },
      { label: "Node", description: "Il più diffuso" },
    ];
    await seedAsk(request, toolCallId, question, options);
    const bridge = registerBridgeAsk(request, [{ question, header: "Runtime", options }]);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });
    // Il chip c'è, UNO solo, e sta sull'opzione giusta.
    await expect(form.getByTestId("ask-recommended")).toHaveCount(1);
    await expect(form.getByTestId("ask-recommended")).toHaveText("consigliato");
    // Il titolo non ripete la parola.
    await expect(form.getByText("Bun", { exact: true })).toBeVisible();
    await expect(form.getByText("(Recommended)")).toHaveCount(0);
    // Consigliata NON vuol dire preselezionata: la scelta resta un gesto.
    await expect(form.locator('input[type="radio"]:checked')).toHaveCount(0);

    // E sul filo torna l'etichetta ORIGINALE, quella che il modello ha offerto.
    await form.locator('input[type="radio"][value="Bun (Recommended)"]').check();
    await form.getByRole("button", { name: /Invia/ }).click();
    const result = await bridge;
    expect(result.answers).toEqual({ [question]: "Bun (Recommended)" });
  });

  test("tre domande insieme si rispondono A STEP, una alla volta", async ({ page, chatPage, request }) => {
    // Uscivano tutte in un blocco solo: tre domande con le loro opzioni sono un
    // muro, e chi risponde all'ultima deve tenere a mente le prime due. Adesso
    // una schermata per domanda, con il conto («2 di 3»), il riepilogo di quel
    // che hai già scelto e la possibilità di tornare indietro a cambiare idea.
    // Sul filo non cambia niente: l'invio parte una volta sola, alla fine.
    const toolCallId = "toolu_ask_steps";
    const qs = [
      { question: "Quale runtime?", header: "Runtime", options: [{ label: "Bun" }, { label: "Node" }], multiSelect: false },
      { question: "Quale database?", header: "Database", options: [{ label: "SQLite" }, { label: "Postgres" }], multiSelect: false },
      { question: "Quale deploy?", header: "Deploy", options: [{ label: "Locale" }, { label: "Cloud" }], multiSelect: false },
    ];
    await seedMessage(request, { sessionKey, role: "user", content: "decidiamo lo stack" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Tre scelte:",
      toolCalls: [{
        id: toolCallId,
        name: "mcp__topics__ask_user_question",
        args: { questions: qs },
        status: "waiting_for_input",
        startedAt: Date.now() - 4_000,
        userInputSchema: { kind: "questions", questions: qs },
      }],
    });
    const bridge = registerBridgeAsk(request, qs);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Una domanda alla volta: le altre due NON sono a schermo.
    await expect(form.locator("legend")).toHaveCount(1);
    await expect(form.locator("legend")).toContainText("Quale runtime?");
    await expect(form.getByTestId("ask-step-progress")).toHaveText("1 di 3");
    // Non si va avanti senza rispondere.
    await expect(form.getByTestId("ask-step-next")).toBeDisabled();

    // Scegliere È il passo avanti: nessun tasto da cercare.
    await form.locator('input[type="radio"][value="Bun"]').click();

    await expect(form.getByTestId("ask-step-progress")).toHaveText("2 di 3");
    await expect(form.locator("legend")).toContainText("Quale database?");
    // Quel che hai già scelto resta sotto gli occhi.
    await expect(form.getByTestId("ask-step-recap")).toContainText("Bun");

    // Indietro per cambiare idea, e la scelta di prima è ancora selezionata.
    await form.getByTestId("ask-step-back").click();
    await expect(form.getByTestId("ask-step-progress")).toHaveText("1 di 3");
    await expect(form.locator('input[type="radio"][value="Bun"]')).toBeChecked();
    await form.locator('input[type="radio"][value="Node"]').click();
    await expect(form.getByTestId("ask-step-progress")).toHaveText("2 di 3");
    await form.locator('input[type="radio"][value="SQLite"]').click();

    // Ultima: il tasto diventa l'invio, non un altro passo.
    await expect(form.getByTestId("ask-step-progress")).toHaveText("3 di 3");
    await expect(form.getByTestId("ask-step-next")).toHaveCount(0);
    await form.locator('input[type="radio"][value="Cloud"]').check();  // ultima: niente salto, resta a schermo
    await form.getByTestId("ask-submit").click();

    // Al bridge arrivano TUTTE e tre insieme, con la correzione fatta a metà.
    const result = await bridge;
    expect(result.cancelled).toBeFalsy();
    expect(result.answers).toEqual({
      "Quale runtime?": "Node",
      "Quale database?": "SQLite",
      "Quale deploy?": "Cloud",
    });

    // Answered, each question keeps ITS answer, one line each. The row used to
    // say "Node · SQLite · Cloud" and the pairing was lost.
    const lines = page.getByTestId(`question-answer-${toolCallId}`).getByTestId("question-answer-line");
    await expect(lines).toHaveCount(3, { timeout: 10_000 });
    await expect(lines.nth(0)).toContainText("Quale runtime?");
    await expect(lines.nth(0).getByTestId("question-answer-value")).toHaveText("Node");
    await expect(lines.nth(1)).toContainText("Quale database?");
    await expect(lines.nth(1).getByTestId("question-answer-value")).toHaveText("SQLite");
    await expect(lines.nth(2)).toContainText("Quale deploy?");
    await expect(lines.nth(2).getByTestId("question-answer-value")).toHaveText("Cloud");
  });

  test('"Other": il testo libero torna al bridge come risposta', async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_ask_other";
    const question = "Quale database?";
    const options = [
      { label: "Postgres" },
      { label: "SQLite" },
    ];
    await seedAsk(request, toolCallId, question, options);
    const bridge = registerBridgeAsk(request, [{ question, header: "Scelta", options }]);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    // La casella libera è SEMPRE aperta: si scrive e basta, senza prima
    // spuntare il pallino — scrivere seleziona «Altro» da sé.
    const other = form.locator("textarea");
    await expect(other).toBeVisible();
    await other.fill("DuckDB, per l'analitica");
    await expect(form.locator('input[type="radio"][value="Other"]')).toBeChecked();
    await form.getByRole("button", { name: /Invia/ }).click();

    const result = await bridge;
    expect(result.cancelled).toBeFalsy();
    expect(result.answers).toEqual({ [question]: "DuckDB, per l'analitica" });

    // Written text reads as written text, in quotes, not as an option the
    // question never offered.
    await expect(page.getByTestId(`question-answer-${toolCallId}`).getByTestId("question-answer-value"))
      .toHaveText("«DuckDB, per l'analitica»", { timeout: 10_000 });
  });

  test("l'umano si alza dalla scrivania: il pannello sopravvive a decine di gambe scadute", async ({ page, chatPage, request }) => {
    // La regressione del difetto vero. La prima domanda in produzione è morta
    // dopo minuti con un errore di socket: una sola richiesta HTTP tenuta aperta
    // a byte zero. Ora le gambe scadono in continuazione e la domanda resta
    // viva — qui ne facciamo scadere una ventina prima di rispondere.
    const toolCallId = "toolu_ask_slow";
    const question = "Quale runtime?";
    const options = [{ label: "Bun" }, { label: "Node" }];
    await seedAsk(request, toolCallId, question, options);

    const bridge = registerBridgeAsk(request, [{ question, header: "Scelta", options }], 150);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Nessuno tocca niente per un bel po': ~20 gambe da 150 ms.
    // DELIBERATE FIXED WAIT: the assertion below is that NOTHING happened — the
    // panel is still there and nobody invented an answer. A condition-wait
    // cannot stand in for a window in which the failure would have shown up.
    await page.waitForTimeout(3000);
    // Il pannello è ancora lì, cliccabile, e nessuno ha inventato una risposta.
    await expect(form).toBeVisible();
    await expect(form.getByRole("button", { name: /Invia/ })).toBeVisible();

    await form.locator('input[type="radio"][value="Bun"]').check();
    await form.getByRole("button", { name: /Invia/ }).click();

    const result = await bridge;
    expect(result.cancelled).toBeFalsy();
    expect(result.answers).toEqual({ [question]: "Bun" });
    expect(result.legs).toBeGreaterThan(5);
  });

  test("risposto, il pannello si spegne da solo: nessun reload, nessun aiuto dal test", async ({ page, chatPage, request }) => {
    // Reported as «graficamente le domande restano in invio anche se vanno avanti». // allow-italian: the report, verbatim
    // The button went grey on its "sending" label and stayed there while the
    // new turn scrolled underneath, until a reload.
    //
    // No WS injection here, and that is the whole point. The other tests in
    // this file push a `stream:tool_result` of their own to make the panel go
    // away, so the only announcement the server sends BY ITSELF on an answer
    // was never under test: `stream:tool_update` carrying the new status. That
    // announcement used to be dropped by the client (it entered the handler
    // only when a partial result was present) and nothing else was coming.
    const toolCallId = "toolu_ask_unmount";
    const question = "Quale runtime?";
    const options = [{ label: "Bun" }, { label: "Node" }];
    await seedAsk(request, toolCallId, question, options);
    const bridge = registerBridgeAsk(request, [{ question, header: "Scelta", options }]);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    // A second client on the same chat (another window, the phone): the answer
    // given here must reach it from the server and read there too.
    const other = await page.context().newPage();
    await goToApp(other);
    await other.keyboard.press("Escape");
    await openTopic(other, new RegExp(topicName));
    const otherForm = other.getByTestId(`tool-input-form-${toolCallId}`);
    await expect(otherForm).toBeVisible({ timeout: 15_000 });
    await page.bringToFront();

    await form.locator('input[type="radio"][value="Bun"]').check();
    await form.getByTestId("ask-submit").click();

    // The answer reached the model, which is the precondition: the panel must
    // switch off because the row moved on, not because the click did anything
    // locally.
    const result = await bridge;
    expect(result.answers).toEqual({ [question]: "Bun" });

    // A few seconds, no reload, nobody remounting the pane.
    await expect(form.getByTestId("ask-submit")).toHaveCount(0, { timeout: 8_000 });
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId(`question-answer-${toolCallId}`).getByTestId("question-answer-value")).toHaveText("Bun");

    // The other client: its panel switches off and the choice made here reads.
    await expect(otherForm).toHaveCount(0, { timeout: 8_000 });
    await expect(other.getByTestId(`question-answer-${toolCallId}`)).toContainText(question);
    await expect(other.getByTestId(`question-answer-${toolCallId}`).getByTestId("question-answer-value")).toHaveText("Bun");
    await other.close();

    // WHAT THIS TEST DELIBERATELY DOES NOT ASSERT, and why the note is here
    // rather than in a commit nobody will read again.
    //
    // The first version ended with `await page.waitForTimeout(1500)` and a
    // second `toHaveCount(0)`, to say "and it does not come back" - the worry
    // being that the list is virtualised, so a row that scrolls out and
    // remounts could re-arm a panel over a question already answered.
    //
    // Three ways to say it without a clock were tried and all three are worse:
    //   - polling the PANEL after scrolling proves nothing, it is already at
    //     zero from the assertion above and the poll passes on the first tick
    //     without a pixel having moved;
    //   - polling the ROW never goes to zero: over 15s of wheel with 25 extra
    //     messages seeded, Virtuoso keeps that row mounted, so the eviction the
    //     assertion needs does not happen here;
    //   - seeding one more message and waiting for it on screen never shows it,
    //     because a seed writes the database and no socket pushes it to a page
    //     that is already open.
    // And the pause itself was worth nothing: it would have been just as green
    // on a build that rendered nothing at all.
    //
    // So the remount is covered where it can actually be measured, one layer
    // down: `toolUpdatePatch` carries `userResponse` alongside the status, so a
    // row that mounts a second time is built from the SERVER's state and comes
    // back answered. That is a pure function with its own unit test
    // (`client/src/hooks/toolUpdatePatch.test.ts`). Putting a sleep here would
    // have claimed the same thing without checking it.
  });
});

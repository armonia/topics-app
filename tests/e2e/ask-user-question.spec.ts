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
    await expect(form.getByText("Other")).toBeVisible();

    // La riga NON smette di essere una riga di tool solo perché aspetta: il
    // suo orologio continua a girare, ed è la cosa più utile che possa dire
    // ("l'agente è fermo su di te da tot"). Prima mostrava il nulla — né il
    // cronometro (`isRunning` è falso) né la durata finale (`endedAt` non
    // c'è ancora).
    const row = page.locator(`[data-testid="tool-call-row-${toolCallId}"]`);
    const elapsed = row.locator('[data-testid="tool-elapsed"]');
    await expect(elapsed).toBeVisible({ timeout: 5_000 });
    await expect(elapsed).toHaveText(/\d/);

    // E il testo su cui l'umano deve DECIDERE è grande come il corpo della
    // chat, non come il chrome del log: la domanda a 13px, non a 11.
    const legend = form.locator("legend").first();
    await expect(legend).toHaveCSS("font-size", "13px");
    await expect(form.locator("label").first()).toHaveCSS("font-size", "13px");

    // Un umano legge prima di scegliere: qui è anche il tempo che rende il
    // video guardabile, e attraversa più di una gamba di poll del bridge.
    await page.waitForTimeout(2000);

    // Pick OAuth and send.
    await form.locator('input[type="radio"][value="OAuth"]').check();
    await page.waitForTimeout(600);
    await form.getByRole("button", { name: /Send/ }).click();

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
    await page.waitForTimeout(800); // il video mostra la chat che riparte
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

    // Choose "Other" → a free-text box appears → type an answer the options
    // didn't offer.
    await form.locator('input[type="radio"][value="Other"]').check();
    const other = form.locator("textarea");
    await expect(other).toBeVisible();
    await other.fill("DuckDB, per l'analitica");
    await form.getByRole("button", { name: /Send/ }).click();

    const result = await bridge;
    expect(result.cancelled).toBeFalsy();
    expect(result.answers).toEqual({ [question]: "DuckDB, per l'analitica" });
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
    await page.waitForTimeout(3000);
    // Il pannello è ancora lì, cliccabile, e nessuno ha inventato una risposta.
    await expect(form).toBeVisible();
    await expect(form.getByRole("button", { name: /Send/ })).toBeVisible();

    await form.locator('input[type="radio"][value="Bun"]').check();
    await form.getByRole("button", { name: /Send/ }).click();

    const result = await bridge;
    expect(result.cancelled).toBeFalsy();
    expect(result.answers).toEqual({ [question]: "Bun" });
    expect(result.legs).toBeGreaterThan(5);
  });
});

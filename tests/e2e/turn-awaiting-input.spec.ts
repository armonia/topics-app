/**
 * La striscia di attività quando il turno è fermo su una DOMANDA.
 *
 * Il guasto vero, riportato dall'umano come «resta in loading»: un turno
 * parcheggiato su `ask_user_question` resta `partial` — ed è corretto, il
 * processo dell'agente è vivo e aspetta — ma la riga sotto il messaggio
 * continuava a fare la sua parte di lavoro in corso: puntino che pulsa, frase
 * di fatica che ruota ogni pochi secondi, shimmer. Chi guarda legge «sto
 * elaborando» e aspetta, mentre la palla è sua da mezz'ora.
 *
 * Cosa copre: che appena un tool passa in `waiting_for_input` la striscia
 * cambi stato e testo, e che al passaggio a `success` torni quella di prima —
 * cioè che lo stato d'attesa non si incolli addosso al turno che riparte.
 *
 * Il cronometro resta in entrambi gli stati: quanto dura il turno è un dato
 * onesto anche mentre l'attesa è nostra.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Striscia di attività · turno in attesa di risposta", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `awaiting-input-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // Il sessionKey lo assegna il server: leggerlo invece di ricostruirlo fa sì
    // che un cambio di convenzione rompa il test in modo evidente, invece di
    // fargli iniettare frame che nessuno raccoglie (verde vuoto).
    const res = await request.get(`/api/topics`, { ignoreHTTPSErrors: true });
    const body = await res.json();
    const found = (body.topics ?? {})[topicId];
    if (!found?.sessionKey) throw new Error("la topic non ha sessionKey: il test non può iniettare i frame");
    sessionKey = found.sessionKey;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("dice «in attesa della tua risposta», non una frase di lavoro in corso", async ({ page, chatPage }) => {
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    // La storia della sessione arriva DOPO l'apertura e riscrive
    // `messages[sessionKey]`: un frame iniettato prima verrebbe cancellato da
    // quella risposta. L'attesa si arma PRIMA di aprire la topic, altrimenti la
    // risposta è già passata quando ci mettiamo in ascolto.
    const history = page
      .waitForResponse((r) => r.url().includes("/history/"), { timeout: 20_000 })
      // Se la storia è già passata prima che ci mettessimo in ascolto va bene
      // lo stesso: l'attesa serve a non farsi cancellare il frame, non è il
      // soggetto del test.
      .catch(() => null);
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await history;

    // Il turno arriva dal FILO, non da un invio locale: `handleStreamEvent`
    // scarta ogni `stream:*` per una sessione che ha un SSE locale aperto (il
    // ramo lo processa già dalla risposta HTTP), quindi mandare il messaggio da
    // qui renderebbe muti i frame iniettati subito dopo. È anche il caso reale
    // più vicino: la domanda comparsa in una finestra mentre il turno l'ha
    // avviato un'altra.
    ws.send({ type: "stream:start", sessionKey, topicId, messageId: "msg_awaiting_e2e" });

    const strip = page.getByTestId("chat-streaming-indicator").first();
    await expect(strip).toBeVisible({ timeout: 15_000 });
    // Stato di partenza: lavoro in corso, nessun marcatore d'attesa.
    await expect(strip).not.toHaveAttribute("data-waiting", "true");

    const toolCallId = "toolu_ask_e2e";
    ws.send({
      type: "stream:tool_call",
      sessionKey,
      topicId,
      toolCall: { id: toolCallId, name: "mcp__topics__ask_user_question", args: {}, status: "running" },
    });
    ws.send({
      type: "stream:tool_user_input_required",
      sessionKey,
      topicId,
      toolCallId,
      schema: {
        kind: "questions",
        questions: [
          { question: "Quale strada?", header: "Strada", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
        ],
      },
    });

    await expect(strip).toHaveAttribute("data-waiting", "true", { timeout: 10_000 });
    await expect(page.getByTestId("turn-phrase").first()).toHaveText("in attesa della tua risposta");
    // Il cronometro resta ma SI FERMA: mostra il lavoro, che durante un'attesa
    // per costruzione non cresce. Prima contava l'attesa — vero, ma pur sempre
    // un numero che corre mentre si legge una domanda, e l'umano l'ha chiamato
    // brutto tre volte. Da quanto aspetta, e il totale grezzo, nel `title`.
    const timer = page.getByTestId("turn-timer").first();
    await expect(timer).toBeVisible();
    await expect(timer).toHaveAttribute("data-clock", "worked");
    await expect(timer).toHaveAttribute("title", /in attesa di te/);
    // La prova che sta fermo: due letture a due secondi di distanza, stesso
    // testo. Un cronometro che gira le avrebbe fatte diverse.
    const primaLettura = await timer.textContent();
    await page.waitForTimeout(2_200);
    expect(await timer.textContent()).toBe(primaLettura);

    // La domanda si chiude ⇒ il turno riparte davvero, e la striscia deve
    // tornare quella di prima. Senza questo, lo stato d'attesa resterebbe
    // incollato al resto del turno.
    ws.send({
      type: "stream:tool_result",
      sessionKey,
      topicId,
      toolCallId,
      status: "success",
      result: "ok",
    });
    await expect(strip).not.toHaveAttribute("data-waiting", "true", { timeout: 10_000 });
    await expect(page.getByTestId("turn-phrase").first()).not.toHaveText("in attesa della tua risposta");
    // A domanda chiusa il cronometro torna a contare il LAVORO, con l'attesa
    // sottratta: il tempo che ci ha messo l'umano non diventa merito o colpa
    // dell'agente.
    await expect(timer).toHaveAttribute("data-clock", "worked");
    await expect(timer).toHaveAttribute("title", /Lavorato/);
  });

  test("fuori dalla chat il segnale dice «ferma», non «sta lavorando»", async ({ page, chatPage }) => {
    // Il seguito del guasto sopra, un livello più in là: dentro la chat la
    // striscia diceva la verità, ma la riga in sidebar e la tab continuavano a
    // mostrare l'onda del turno che macina. Chi non ha la chat davanti — cioè
    // il caso in cui la domanda serve DAVVERO — non aveva modo di sapere che
    // la palla era sua.
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    const history = page
      .waitForResponse((r) => r.url().includes("/history/"), { timeout: 20_000 })
      .catch(() => null);
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await history;

    ws.send({ type: "stream:start", sessionKey, topicId, messageId: "msg_awaiting_signal_e2e" });

    // Il turno lavora: c'è almeno un indicatore, e nessuno di essi è in attesa.
    const working = page.locator('[data-loader-state="working"]');
    const waiting = page.locator('[data-loader-state="waiting"]');
    await expect(working.first()).toBeVisible({ timeout: 15_000 });
    await expect(waiting).toHaveCount(0);

    const toolCallId = "toolu_ask_signal_e2e";
    ws.send({
      type: "stream:tool_call",
      sessionKey,
      topicId,
      toolCall: { id: toolCallId, name: "mcp__topics__ask_user_question", args: {}, status: "running" },
    });
    ws.send({
      type: "stream:tool_user_input_required",
      sessionKey,
      topicId,
      toolCallId,
      schema: {
        kind: "questions",
        questions: [
          { question: "Quale strada?", header: "Strada", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
        ],
      },
    });

    // Il glifo si ferma e il tooltip lo dice a parole. Nessun indicatore deve
    // restare sull'onda: se ne sopravvivesse uno, una superficie mentirebbe
    // mentre l'altra dice il vero — che è peggio di mentire e basta.
    await expect(waiting.first()).toBeVisible({ timeout: 10_000 });
    await expect(working).toHaveCount(0);
    await expect(waiting.first()).toHaveAttribute("title", /in attesa di una tua risposta/);

    // A domanda chiusa si torna a lavorare, e con essa l'onda.
    ws.send({
      type: "stream:tool_result",
      sessionKey,
      topicId,
      toolCallId,
      status: "success",
      result: "ok",
    });
    await expect(waiting).toHaveCount(0, { timeout: 10_000 });
    await expect(working.first()).toBeVisible();
  });
});

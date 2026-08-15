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
 * Il cronometro invece CAMBIA POSTO. Mentre si lavora sta in riga e corre.
 * Quando la domanda parcheggia il turno sparisce da lì — anche fermo, un
 * numero accanto a «in attesa della tua risposta» si legge come il tempo che
 * stai facendo perdere — e scende nella striscia di chiusura, dove sta in un
 * messaggio finito, col lavoro fatto finora e la spiegazione nel tooltip.
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
    // Accanto alla frase d'attesa NON resta nessun numero: anche fermo, un
    // cronometro lì si legge come il tempo che stai facendo perdere, e la
    // domanda diventa un conto alla rovescia. L'umano l'ha detto quattro volte.
    await expect(page.getByTestId("turn-timer")).toHaveCount(0);
    // Il lavoro fatto finora non sparisce: scende nella striscia di chiusura,
    // dove sta in un messaggio finito, e lì è FERMO — durante un'attesa ogni
    // millisecondo nuovo è attesa, e l'attesa si sottrae.
    const durata = page.getByTestId("message-duration").last();
    await expect(durata).toBeVisible({ timeout: 10_000 });
    await expect(durata).toHaveAttribute("title", /in attesa di te/);
    const primaLettura = await durata.textContent();
    await page.waitForTimeout(2_200);
    expect(await durata.textContent()).toBe(primaLettura);

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
    // A domanda chiusa il cronometro TORNA in riga, e conta il LAVORO con
    // l'attesa sottratta: il tempo che ci ha messo l'umano non diventa merito
    // o colpa dell'agente.
    const timer = page.getByTestId("turn-timer").first();
    await expect(timer).toBeVisible({ timeout: 10_000 });
    await expect(timer).toHaveAttribute("data-clock", "worked");
    await expect(timer).toHaveAttribute("title", /Lavorato/);
  });

  test("parcheggiato su una domanda, il turno si CHIUDE come un messaggio finito", async ({ page, chatPage }) => {
    // Il seguito della lamentela: «mi dà fastidio che non finisce in maniera
    // standard, è diverso rispetto a un messaggio che si chiude». Era vero —
    // il turno in attesa restava a mezz'aria: nessuna striscia di chiusura, e
    // i numeri in un formato tutto suo dentro la riga di attività. Ora sotto
    // ci va la STESSA striscia del messaggio finito, coi numeri di adesso.
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    const history = page
      .waitForResponse((r) => r.url().includes("/history/"), { timeout: 20_000 })
      .catch(() => null);
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await history;

    ws.send({ type: "stream:start", sessionKey, topicId, messageId: "msg_awaiting_footer_e2e" });
    // La bolla dev'esserci: i numeri si scrivono SULLA riga del messaggio (è la
    // correzione stessa — prima vivevano in uno stato locale della striscia e
    // chi montava dopo il frame non li vedeva più).
    await expect(page.getByTestId("chat-streaming-indicator").first()).toBeVisible({ timeout: 15_000 });
    // I numeri arrivano dal server già accumulati, come nel turno vero.
    ws.send({
      type: "stream:usage",
      sessionKey,
      topicId,
      calls: 7,
      promptTokens: 1_000_000,
      completionTokens: 12_000,
      costCents: 42,
      cacheReadTokens: 900_000,
      cacheCreationTokens: 40_000,
      cacheCreation1hTokens: 0,
    });

    const footer = page.getByTestId("message-meta-footer").last();
    const inlineUsage = page.getByTestId("turn-usage");
    // Mentre lavora: numeri in riga, nessuna striscia di chiusura.
    await expect(inlineUsage.first()).toBeVisible({ timeout: 15_000 });
    await expect(footer).toHaveCount(0);

    const toolCallId = "toolu_ask_footer_e2e";
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

    // La domanda parcheggia il turno ⇒ compare la striscia di chiusura, con la
    // stessa contabilità di un messaggio finito: totale, quanto era rilettura,
    // quanto nuovo, e il costo.
    await expect(footer).toBeVisible({ timeout: 10_000 });
    // Il totale è QUANTO È COSTATO, non quanti token sono passati:
    // `shared/token-cost.ts` pesa la rilettura di cache 0,1, ed è la stessa
    // definizione della card e del grafico. Da 1.000.000 letti di cui 900.000
    // riletti e 40.000 scritti, più 12.000 di output:
    // (1.000.000 − 900.000) + 12.000 + 0,1 × 900.000 = 202.000 → `202k`.
    await expect(footer).toContainText("202k tokens");
    // Le due quote in chiaro, coi loro numeri: sommano al letto (900k + 100k) e
    // sono la ragione per cui il totale sopra non è un milione.
    const split = page.getByTestId("message-token-split").last();
    await expect(split).toContainText("900k da cache");
    await expect(split).toContainText("100k nuovi");
    await expect(footer).toContainText("$0.42");
    // E i numeri NON sono più anche in riga: detti due volte sarebbero rumore.
    await expect(inlineUsage).toHaveCount(0);

    // Evidenza durevole: la riga d'attesa E la striscia di chiusura sotto,
    // nella stessa immagine — è il confronto che la lamentela chiedeva.
    await page.getByTestId("chat-streaming-indicator").first()
      .locator("xpath=..")
      .screenshot({ path: "test-results/turno-in-attesa-chiusura.png" });

    // Arriva la risposta ⇒ il turno riparte: la chiusura sparisce e i numeri
    // tornano in riga. Se restasse, un turno che lavora sembrerebbe finito.
    ws.send({ type: "stream:tool_result", sessionKey, topicId, toolCallId, status: "success", result: "ok" });
    await expect(footer).toHaveCount(0, { timeout: 10_000 });
    await expect(inlineUsage.first()).toBeVisible();

    // Un frame di consumo PARZIALE non deve cancellare quello che sapevamo:
    // scriverli tutti a scatola chiusa azzerava i campi mancanti, e la striscia
    // di fine turno spariva del tutto (nessuna durata, nessun token, nessun
    // prezzo → il footer non disegna niente). Qui arriva un frame con i soli
    // token letti: il costo e lo scorporo di prima devono sopravvivere.
    ws.send({ type: "stream:usage", sessionKey, topicId, calls: 8, promptTokens: 1_100_000 });
    await expect(inlineUsage.first()).toContainText("$0.42");

    // E a turno FINITO la striscia di chiusura c'è, coi numeri.
    ws.send({ type: "stream:end", sessionKey, topicId, messageId: "msg_awaiting_footer_e2e" });
    await expect(footer).toBeVisible({ timeout: 10_000 });
    await expect(footer).toContainText("$0.42");
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

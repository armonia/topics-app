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
    // Il cronometro resta, ma cambia MESTIERE: adesso conta da quanto la palla è
    // nostra, non da quanto è aperto il turno. Era il numero che l'umano ha visto
    // scorrere durante l'attesa e ha chiamato brutto — non era brutto, contava la
    // cosa sbagliata. Il totale grezzo resta nel `title`.
    const timer = page.getByTestId("turn-timer").first();
    await expect(timer).toBeVisible();
    await expect(timer).toHaveAttribute("data-clock", "waiting");
    await expect(timer).toHaveAttribute("title", /in attesa di te/);

    // Un'attesa vera dura più di un battito del cronometro: qui se ne aspetta
    // uno, altrimenti il test chiuderebbe la domanda nello stesso secondo in cui
    // l'ha aperta e misurerebbe zero — cioè niente.
    await page.waitForTimeout(1_500);

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
});

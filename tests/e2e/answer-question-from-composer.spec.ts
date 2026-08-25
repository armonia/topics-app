/**
 * Rispondere a una domanda SCRIVENDO IN CHAT.
 *
 * Lo stallo che questo test blinda. Mentre un tool tiene il turno fermo su una
 * domanda, il turno è ancora "in volo": `/api/chat` risponde 409
 * (un-turno-per-sessione) e il client accoda. Ma quel turno finisce solo quando
 * la domanda riceve risposta — e la risposta si poteva dare solo dal pannello.
 * Chi rispondeva scrivendo in chat, cioè la cosa più naturale del mondo (tanto
 * che l'agente stesso la suggerisce: «rispondi qui in chiaro con il numero»),
 * vedeva il testo sparire in una coda che si sarebbe svuotata solo dopo aver
 * fatto la cosa che non stava facendo. Fermo fino allo scadere dell'ask: 90
 * minuti, col cronometro che scorre.
 *
 * Cosa copre: che con una domanda a schermo il composer PROMETTA la risposta
 * (segnaposto + bottone ambra `answer`) e che l'invio finisca davvero su
 * `/api/chat/tool-response` con la risposta agganciata alla domanda giusta —
 * e NON su `/api/chat`, che è la strada della coda.
 *
 * Perché `/chat/tool-response` è servito dal test e non dal server vero: qui il
 * turno è finto, iniettato dal filo, quindi il registro dei pending input del
 * server non conosce questo `toolCallId` e risponderebbe 404 («no pending
 * input»). Il soggetto è la DECISIONE del client — dove va il testo — non la
 * consegna lato server, che ha già i suoi test (`deliverAnswer` in
 * `server/routes/topics.ts`).
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const QUESTION = "Quale strada?";

test.describe("Domanda a schermo · si risponde dal composer", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `answer-composer-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
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

  test("il testo va alla domanda, non nella coda", async ({ page, chatPage }) => {

    test.info().annotations.push({ type: "spec", description: "ASK-05" });
    const toolResponses: Array<Record<string, unknown>> = [];
    await page.route("**/api/chat/tool-response", async (route) => {
      toolResponses.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, submittedAt: new Date().toISOString() }),
      });
    });
    // La strada della coda: se il testo finisce qui, la correzione non ha preso.
    const chatPosts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/chat(\?|$)/.test(r.url())) chatPosts.push(r.url());
    });

    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    // La storia riscrive `messages[sessionKey]`: armare l'attesa PRIMA di aprire
    // la topic evita che cancelli il turno iniettato subito dopo.
    const history = page
      .waitForResponse((r) => r.url().includes("/history/"), { timeout: 20_000 })
      .catch(() => null);
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await history;

    // Turno dal filo, non da un invio locale: `handleStreamEvent` scarta i
    // `stream:*` di una sessione con un SSE locale aperto.
    ws.send({ type: "stream:start", sessionKey, topicId, messageId: "msg_answer_e2e" });
    const toolCallId = "toolu_answer_e2e";
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
          { question: QUESTION, header: "Strada", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
        ],
      },
    });

    await expect(page.getByTestId("chat-streaming-indicator").first()).toHaveAttribute(
      "data-waiting",
      "true",
      { timeout: 15_000 },
    );

    // Il composer promette la risposta prima ancora che si scriva.
    await expect(chatPage.messageInput).toHaveAttribute("placeholder", "Rispondi alla domanda…");

    await chatPage.messageInput.fill("la seconda, quella pulita");
    // Bottone ambra: dice «rispondi», e `sendMessage` fa esattamente quello.
    const button = page.locator("[data-composer-action]").first();
    await expect(button).toHaveAttribute("data-composer-action", "answer");
    await expect(button).toHaveAttribute("aria-label", "Rispondi alla domanda");

    await chatPage.messageInput.press("Enter");

    await expect.poll(() => toolResponses.length, { timeout: 10_000 }).toBe(1);
    expect(toolResponses[0]).toMatchObject({
      sessionKey,
      toolCallId,
      response: { kind: "questions", answers: { [QUESTION]: "la seconda, quella pulita" } },
    });
    // Niente coda, niente 409: il turno non è stato toccato.
    expect(chatPosts).toEqual([]);
    // Niente in coda: la coda si vede come bolle «da inviare» nel trascritto
    // (il badge del composer non esiste più, vedi `QueuedTurns`).
    await expect(page.getByTestId("queued-bubble")).toHaveCount(0);
    // Il campo si svuota come dopo un invio: il testo è partito.
    await expect(chatPage.messageInput).toHaveValue("");
  });
});

/**
 * Il consumo del turno che si vede CRESCERE (FASE token, pezzo 2).
 *
 * Perché questa spec esiste. Ho aggiunto `stream:usage` — l'evento che porta il
 * consumo accumulato mentre il turno va — e nel commit l'ho dichiarato NON
 * provato: contratto e tipi erano verificati, ma nessun test guardava la striscia
 * crescere. Questo chiude quel buco sul lato client.
 *
 * Cosa copre e cosa no, detto qui perché non ci si illuda dopo:
 *   - COPRE il client: che il frame venga accettato dalla validazione inbound, che
 *     la voce NON esista finché non arriva un usage (il conteggio non si inventa),
 *     che i numeri compaiano nella striscia, e che si SOSTITUISCANO al frame
 *     successivo invece di sommarsi — il server manda totali già accumulati, e
 *     "il client somma" è il modo più facile di sbagliare qui.
 *   - NON copre l'accumulo lato server, che vive in `server/usage/turn-usage.ts`
 *     ed è coperto lì da 10 unit test — separarli è deliberato: qui servirebbe un
 *     provider finto che emette due chiamate, e sarebbe un test del finto.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Consumo del turno, live", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `usage-live-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // Il sessionKey lo assegna il SERVER: leggerlo invece di ricostruirlo dalla
    // convenzione fa sì che un cambio di formato rompa il test in modo evidente,
    // invece di fargli iniettare frame che nessuno raccoglie (verde vuoto).
    const res = await request.get(`/api/topics`, { ignoreHTTPSErrors: true });
    const body = await res.json();
    const found = (body.topics ?? {})[topicId];
    if (!found?.sessionKey) throw new Error("la topic non ha sessionKey: il test non può iniettare l'usage");
    sessionKey = found.sessionKey;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("i token crescono durante il turno, e il client non li somma", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "USAGE-12" });
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Tiene aperta la risposta di /api/chat: `sendMessage` crea il segnaposto
    // assistant `partial` PRIMA della risposta, quindi finché la richiesta pende
    // il turno resta parziale e la striscia sta ferma per essere ispezionata. Un
    // mock che risponde subito chiuderebbe il turno in un frame.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 20_000));
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    });
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("primo turno");
    await chatPage.messageInput.press("Control+Enter");

    const strip = page.getByTestId("chat-streaming-indicator").first();
    await expect(strip).toBeVisible({ timeout: 15000 });
    // Finché non arriva un frame di usage la voce NON c'è: il conteggio non si
    // inventa da zero.
    await expect(page.getByTestId("turn-usage")).toHaveCount(0);

    const usage = (calls: number, prompt: number, completion: number) =>
      ws.send({
        type: "stream:usage",
        sessionKey,
        topicId,
        calls,
        promptTokens: prompt,
        completionTokens: completion,
        cacheReadTokens: Math.round(prompt * 0.9),
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
      });

    // IL NUMERO IN STRISCIA È QUANTO È COSTATO, non quanti token sono passati:
    // `shared/token-cost.ts` (`costTokens`) pesa la rilettura di cache 0,1, ed è
    // la stessa definizione della card, del grafico e del piede di un messaggio.
    // Da 12.000 letti di cui 10.800 riletti + 300 scritti:
    // (12.000 − 10.800) + 300 + 0,1 × 10.800 = 2.580 → `3k`.
    // I numeri grezzi non spariscono: stanno nel title, e si asseriscono qui
    // sotto, così una regressione della formula non può nascondersi dietro un
    // arrotondamento.
    usage(1, 12_000, 300);
    const live = page.getByTestId("turn-usage").first();
    await expect(live).toBeVisible({ timeout: 10000 });
    // Compatto, come ovunque nella chat: `3k`, non `2.580`.
    await expect(live).toContainText("3k token");
    // Il separatore delle migliaia lo mette `toLocaleString`, cioè il locale del
    // browser: punto, virgola o niente (parecchi locale non raggruppano a
    // quattro cifre). Si accettano tutti e tre, le cifre no.
    await expect(live).toHaveAttribute("title", /10[.,]?800 riletti dalla cache · 1[.,]?200 nuovi/);

    // Secondo frame: il server manda il TOTALE già accumulato, quindi la striscia
    // deve mostrare il costo di 25.000/22.500/1.000 — (25.000 − 22.500) + 1.000 +
    // 0,1 × 22.500 = 5.750 → `6k` — non la somma col frame di prima (8.330 → `8k`).
    // È la differenza fra "il client mostra" e "il client somma", ed è il modo
    // più facile di sbagliare qui.
    usage(2, 25_000, 1_000);
    await expect(live).toContainText("6k token", { timeout: 10000 });
    await expect(live).not.toContainText("8k");
    await expect(live).toHaveAttribute("title", /22[.,]?500 riletti dalla cache · 2[.,]?500 nuovi/);

    // Il numero di chiamate sta nel title: è ciò che spiega perché i token letti
    // superano la finestra di contesto.
    await expect(live).toHaveAttribute("title", /2 chiamate/);

  });
});

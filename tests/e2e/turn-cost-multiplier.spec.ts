/**
 * Il moltiplicatore del costo, dove si lavora: contesto × chiamate.
 *
 * PERCHÉ ESISTE. I due fattori del costo esistevano già e non si incontravano
 * mai: le chiamate al modello vivevano in un tooltip della striscia del turno,
 * il contesto nell'anello del composer, e il loro PRODOTTO da nessuna parte —
 * quindi ci si accorgeva della spesa a spesa finita. Con 309k in contesto ogni
 * chiamata a un tool costa 309k, e dodici chiamate in un turno fanno 3,7M.
 *
 * COSA COPRE E COSA NO.
 *  - COPRE la UI: che il moltiplicatore NON compaia finché mancano i fattori
 *    (non si inventa una moltiplicazione con uno zero dentro), che compaia
 *    quando arrivano entrambi, che CRESCA a ogni chiamata invece di restare
 *    fermo, e che il pannello del costo nell'ispettore mostri il prodotto della
 *    sessione.
 *  - NON copre l'aritmetica della sonda: quella vive in
 *    `server/usage/cost-probe.ts` ed è pinnata lì contro una misura presa a
 *    mano su una chat vera (`cost-probe.test.ts`). Rifarla qui sarebbe
 *    verificare i numeri di un mock.
 *
 * I DUE ATTI STANNO IN UN TEST SOLO perché questa spec è anche la CLIP di
 * consegna, e il video di Playwright è per test: separarli darebbe due
 * mezze prove al posto della storia («mentre lavora» → «il conto»).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Il contesto misurato nella chat di riferimento all'ultima chiamata del turno. */
const CONTESTO = 309_335;

/** Una pausa che esiste SOLO nella clip: a suite normale è un no-op. */
const beat = (page: Page, ms = 1200) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

/**
 * Didascalia sulla clip — SOLO sotto E2E_EVIDENCE, zero effetto sulla suite.
 *
 * L'anteprima di un task viene resa a 268px di larghezza: da un video di una UI
 * a 1440px non si legge una riga, e «devi ancora saper dire cosa mostra» non è
 * soddisfatto da una macchia di pannelli. Un titolo grande sopravvive alla
 * riduzione. `pointer-events:none` e in basso: non copre il composer e non
 * intercetta un click.
 */
async function didascalia(page: Page, testo: string) {
  if (process.env.E2E_EVIDENCE !== "1") return;
  await page.evaluate((t) => {
    let el = document.getElementById("__e2e_caption__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption__";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
          "background:rgba(10,10,12,.94);color:#fff;font:800 72px/1.15 system-ui,sans-serif;" +
          "padding:18px 24px;letter-spacing:-.02em;border-top:4px solid #8b5cf6;text-align:center;",
      );
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, testo);
}

test.describe("Il moltiplicatore del costo", () => {
  // Viewport più largo del default della suite (1280×800) per una ragione sola:
  // questa spec È la clip di consegna, e l'anteprima di un task viene resa a
  // 268px — oltre un rapporto altezza/larghezza di 0.70 la card TAGLIA invece
  // di rimpicciolire. 1440×760 → 0.528, e ci sta intera. Nessuna asserzione qui
  // dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `cost-mult-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // Il `sessionKey` lo assegna il server: leggerlo invece di ricostruirlo
    // fa sì che un cambio di formato rompa il test in modo evidente, invece di
    // fargli iniettare frame che nessuno raccoglie (verde vuoto).
    const res = await request.get(`/api/topics`, { ignoreHTTPSErrors: true });
    const found = ((await res.json()).topics ?? {})[topicId];
    if (!found?.sessionKey) throw new Error("la topic non ha sessionKey: il test non può iniettare i frame");
    sessionKey = found.sessionKey;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("cresce a ogni chiamata mentre il turno lavora, e l'ispettore ne dà il conto", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "USAGE-13" });
    const ws = await interceptWebSocket(page);

    // La sonda di una topic appena creata è a zero (nessun messaggio): l'atto 2
    // prova la SUPERFICIE, non l'aritmetica — quella è pinnata sui numeri veri
    // in `server/usage/cost-probe.test.ts` contro una misura presa a mano. I
    // valori qui sono quelli di quella stessa chat, ricostruiti dalla sonda.
    await page.route("**/api/context/cost*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cost: {
            contextTokens: CONTESTO,
            windowTokens: 1_000_000,
            perCallUsd: 0.1547,
            toolCalls: 98,
            projectedTokens: 30_314_830,
            promptTokens: 19_250_777,
            completionTokens: 63_878,
            costUsd: 14.83,
            messages: 46,
            model: "claude-opus-5",
            lastTurn: {
              toolCalls: 12,
              contextTokens: CONTESTO,
              projectedTokens: 3_712_020,
              promptTokens: 3_066_181,
              completionTokens: 4_000,
              costUsd: 1.63,
            },
          },
        }),
      }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // ── Atto 1: il turno vivo ────────────────────────────────────────────────
    // Tiene aperta la risposta di `/api/chat`: il segnaposto assistant `partial`
    // nasce PRIMA della risposta, quindi finché la richiesta pende il turno resta
    // vivo e la striscia sta ferma per essere ispezionata.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 40_000));
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    });
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("un turno che chiama tanti tool");
    await chatPage.messageInput.press("Control+Enter");

    await expect(page.getByTestId("chat-streaming-indicator").first()).toBeVisible({ timeout: 15_000 });

    const moltiplicatore = page.getByTestId("turn-multiplier").first();

    // Un fattore solo non è una moltiplicazione: col contesto ma senza chiamate
    // la voce non c'è. È la proprietà che impedisce a un «× 0» di comparire
    // all'inizio di ogni turno.
    ws.send({
      type: "stream:context",
      sessionKey,
      topicId,
      usage: { sessionUpdate: "usage_update", used: CONTESTO, size: 1_000_000 },
      percent: 31,
      level: "ok",
      estimated: false,
      model: "claude-opus-5",
    });
    await expect(moltiplicatore).toHaveCount(0);

    const chiamate = (n: number) =>
      ws.send({
        type: "stream:usage",
        sessionKey,
        topicId,
        calls: n,
        promptTokens: n * CONTESTO,
        completionTokens: 400 * n,
        cacheReadTokens: Math.round(n * CONTESTO * 0.95),
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
      });

    chiamate(1);
    await expect(moltiplicatore).toBeVisible({ timeout: 10_000 });
    await expect(moltiplicatore).toContainText("1 × 309k");
    await didascalia(page, "1 chiamata × 309k");
    await beat(page, 1400);

    // Il punto di tutta la sonda: il numero si MUOVE mentre il turno lavora. È
    // ciò che lo rende una decisione (fermare, compattare) invece di un
    // consuntivo.
    chiamate(6);
    await expect(moltiplicatore).toContainText("6 × 309k", { timeout: 10_000 });
    await beat(page, 700);
    chiamate(12);
    await expect(moltiplicatore).toContainText("12 × 309k", { timeout: 10_000 });

    // I fattori sono anche leggibili a macchina, e il title dice il prodotto in
    // lettere: dodici chiamate a 309k sono 3,7M, non 309k.
    await expect(moltiplicatore).toHaveAttribute("data-calls", "12");
    await expect(moltiplicatore).toHaveAttribute("data-context", String(CONTESTO));
    await expect(moltiplicatore).toHaveAttribute("title", /12 chiamate a tool × 309k di contesto = 3\.7M/);
    await didascalia(page, "12 chiamate = 3,7M");
    await beat(page, 1600);

    // ── Atto 2: il conto della sessione ──────────────────────────────────────
    await page.getByTestId("chat-input-context-ring").first().click();

    const pannello = page.getByTestId("cost-probe-panel").first();
    await expect(pannello).toBeVisible({ timeout: 10_000 });

    // La moltiplicazione scritta come una moltiplicazione: 309k × 98 = 30,3M.
    const prodotto = page.getByTestId("cost-probe-product").first();
    await expect(prodotto).toContainText("309k");
    await expect(prodotto).toContainText("98");
    await expect(prodotto).toContainText("30.3M");

    // E i due numeri che il prodotto da solo non dice: quanto costa la PROSSIMA
    // chiamata, e quanto è partito DAVVERO (meno del proiettato, perché il
    // contesto cresceva).
    await expect(page.getByTestId("cost-probe-percall")).toContainText("$0.15");
    await expect(page.getByTestId("cost-probe-measured")).toContainText("19.3M");
    await expect(page.getByTestId("cost-probe-lastturn")).toContainText("3.1M");
    await didascalia(page, "98 chiamate = 30,3M");
    await beat(page, 2000);
  });
});

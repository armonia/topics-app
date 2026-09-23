import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * IL FANTASMA CHE `mergeHistoryPage` BUTTAVA VIA.
 *
 * Riproduce dall'esterno il difetto fissato in `historyPaging.ts`: una bolla
 * ottimistica (id coniato in locale, il suo `message:new` non è mai arrivato
 * perché è il proprio - `isOwnStream` lo scarta) siede PRIMA del pivot quando
 * arriva una pagina fresca dopo uno stallo del server. Prima della fix
 * `older = existing.slice(0, pivot).filter(durable)` la buttava via, senza che
 * `completeHistory` l'avesse mai sostituita: spariva e basta.
 *
 * Il server è simulato con `page.route`: la prima risposta è il thread intero
 * (41 righe, la prima è il fantasma), la seconda - innescata da un
 * `topic:updated` fuori banda, esattamente come in
 * `chat-inflight-bubble-identity.spec.ts` - è la pagina che il server manda
 * DAVVERO dopo uno stallo (i 40 originali, il fantasma non è mai stato suo).
 * Un `setTimeout` di 5s prima di rispondere sta per lo stallo del loop
 * riportato sul task (4-7s misurati il 23/09). Un MutationObserver lato
 * browser tiene il minimo di bolle viste durante l'attesa: se cala anche per
 * un frame, la fix non regge.
 */
test.use({ video: "on" });

const GHOST_ID = "msg_e2e_ghost_1758";
const GHOST_TEXT = "questo messaggio non deve mai sparire dallo schermo";
const STALL_MS = 5_000;

const durableRow = (n: number) => ({
  id: `e2e-durable-${n}`,
  role: n % 2 ? "user" : "assistant",
  content: `riga ${n}`,
  timestamp: new Date(Date.now() - (41 - n) * 1000).toISOString(),
});

test.describe("Un fantasma pre-pivot resta in vista attraverso uno stallo del server", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;
  let topic: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    topicName = `stall-ghost-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const trovato = Object.values(topics.topics).find((x) => x.id === topicId)!;
    sessionKey = trovato.sessionKey;
    topic = trovato as unknown as Record<string, unknown>;
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("il fantasma non cala mai sotto 41 bolle durante lo stallo e il merge", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    test.slow(); // include lo stallo simulato di 5s

    const durables = Array.from({ length: 40 }, (_, i) => durableRow(i + 1));
    const wholeThread = [{ ...durableRow(0), id: GHOST_ID, content: GHOST_TEXT }, ...durables];

    let historyCalls = 0;
    let lastHistoryAt = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/history/")) {
        historyCalls += 1;
        lastHistoryAt = Date.now();
      }
    });

    let inject: ((data: string) => void) | null = null;
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      if (historyCalls <= 1) {
        // Apertura: il pannello ha già il thread intero, fantasma compreso.
        await route.fulfill({
          status: 200,
          json: { total: wholeThread.length, hasOrphanedMessage: false, compactionMarkers: [], messages: wholeThread },
        });
        return;
      }
      // La pagina dopo lo stallo: quella vera, il server non ha mai visto il
      // fantasma. Il ritardo sta per il loop event fermo 4-7s (task 23/09).
      await new Promise((r) => setTimeout(r, STALL_MS));
      await route.fulfill({
        status: 200,
        json: { total: wholeThread.length, hasOrphanedMessage: false, compactionMarkers: [], messages: durables },
      });
    });
    // Va armata prima di goto, o la connessione iniziale la scavalca.
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
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);

    await expect(page.locator(".message-content")).toHaveCount(41, { timeout: 15_000 });
    await expect(page.getByText(GHOST_TEXT)).toBeVisible();

    // Tiene il minimo di bolle viste da qui in poi: se una qualunque riscrittura
    // del DOM facesse calare la lista anche per un frame, questo lo cattura,
    // a differenza di un'unica lettura a stallo finito.
    await page.evaluate(() => {
      const conta = () => document.querySelectorAll(".message-content").length;
      (window as unknown as Record<string, unknown>).__minMessages = conta();
      const observer = new MutationObserver(() => {
        const w = window as unknown as Record<string, number>;
        w.__minMessages = Math.min(w.__minMessages as number, conta());
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    // La riapertura fuori banda: `topic:updated` la innesca (anti-rimbalzo di
    // `loadHistory`, la stessa soglia di `ws-reconnect-catchup.spec.ts`), quindi
    // si aspetta che la finestra sia trascorsa invece di dormirla alla cieca.
    await expect.poll(() => Date.now() - lastHistoryAt, {
      message: "la finestra anti-rimbalzo di loadHistory è trascorsa",
      timeout: 20_000,
      intervals: [500],
    }).toBeGreaterThan(5_500);

    inject!(JSON.stringify({ type: "topic:updated", sessionKey, topicId, topic }));

    await expect.poll(() => historyCalls, {
      message: "la seconda /api/history è partita",
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(2);

    // Durante lo stallo simulato la lista resta com'era: nessuna riscrittura
    // vuota o parziale prima che la pagina risponda.
    await expect(page.getByText(GHOST_TEXT)).toBeVisible();
    await expect(page.locator(".message-content")).toHaveCount(41);

    // Dopo lo stallo il merge è quello fissato: il fantasma resta, la pagina
    // vera si aggiunge dietro di lui.
    await expect(page.locator(".message-content")).toHaveCount(41, { timeout: STALL_MS + 10_000 });
    await expect(page.getByText(GHOST_TEXT)).toBeVisible();

    const minSeen = await page.evaluate(() => (window as unknown as Record<string, number>).__minMessages);
    expect(minSeen, "la lista non deve mai calare sotto 41 mentre il fantasma è ancora in vita").toBe(41);
  });
});

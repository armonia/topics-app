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
 * DOPO UNA COMPATTAZIONE, QUELLO CHE HAI SCRITTO PARTE.
 *
 * Il guasto, misurato dal vivo il 20/08/2026 su topic:44d914ec: si scrive
 * `/compact`, la CLI compatta davvero (il divider «Contesto compattato» compare
 * in chat, il marker è in DB) — e da lì in poi la chat è morta. I messaggi
 * scritti dopo restano in coda e non partono; trenta minuti dopo compare
 * «⚠️ Nessuna attività dal modello per 30 minuti. Turno terminato.» sopra una
 * compattazione riuscita.
 *
 * Le due cose sono lo STESSO guasto. Il turno di compattazione non si chiudeva
 * (il suo `result` è vuoto per costruzione, e il provider scartava ogni result
 * senza testo — vedi `server/providers/claude-code-compaction-result.test.ts`),
 * e il drain della coda è appeso alla FINE di uno stream: niente fine, niente
 * partenza.
 *
 * Il provider è già provato in unità e in integrazione con un figlio vero. Qui
 * si prova la METÀ CHE VIVE IN PAGINA, sul flusso intero e con le facce che ha
 * davvero: `/compact` mandato dal composer, una riga scritta mentre compatta
 * che finisce in coda, il turno che si chiude con `discardedMessageId` (la riga
 * assistente vuota che il server cancella, perché una compattazione non produce
 * testo) — e il messaggio che parte.
 *
 * COSA NON PROVA, detto perché il contrario si crederebbe leggendo il codice:
 * non isola l'anello `stream:end` del WebSocket. A fine turno il drain ha due
 * strade — la fine della SSE locale e il frame `stream:end` — e in pagina
 * arrivano insieme. MISURATO: togliendo il drain dal ramo `stream:end` questo
 * test resta verde, perché a drenare è la chiusura della SSE. Quell'anello lo
 * inchioda `message-queue.spec.ts` («turno già in volo (409)»), dove la POST
 * finisce SUBITO con un 409 e l'unica cosa che può far ripartire la coda è il
 * frame iniettato.
 *
 * Quello che questo file tiene è il SINTOMO dell'utente: dopo una
 * compattazione, quello che hai scritto parte. Prima non partiva mai.
 *
 * È COMPORTAMENTO: video acceso, il .webm è la prova.
 */
test.use({ video: "on" });

test.describe("Dopo /compact la coda riparte", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `compact-drain-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
    // Due scambi di storia: con un turno solo lo stop cadrebbe nel ramo «prima
    // domanda, ho cambiato idea» (vedi message-queue.spec.ts).
    await seedMessage(request, { sessionKey, role: "user", content: "domanda di prima" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di prima" });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("lo stream:end di una compattazione (con riga scartata) fa partire la coda", async ({ page, chatPage }) => {

    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-03" });
    // La presa sul WS: serve a iniettare lo `stream:end` esattamente com'è
    // quello vero di un turno di compattazione — con `discardedMessageId`, che
    // è la riga vuota che il server cancella perché una compattazione non
    // produce testo. Senza quel campo si proverebbe un caso più facile di
    // quello reale.
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    const sent: string[] = [];
    // Il PRIMO invio (`/compact`) resta aperto finché il test non lo lascia
    // andare: è la finestra in cui l'umano scrive il messaggio successivo, che
    // finisce in coda.
    //
    // Il cancello si apre INSIEME al frame WS, e non è una scorciatoia: a fine
    // turno succedono davvero tutte e due le cose, la SSE si chiude e il server
    // annuncia `stream:end`. Tenere la POST aperta OLTRE lo `stream:end`
    // proverebbe un caso che non esiste — e per giunta il drain non potrebbe
    // partire comunque, perché il lock d'invio è preso finché la richiesta è in
    // volo (misurato: il primo giro di questo test è fallito esattamente lì, ed
    // è il comportamento giusto).
    let apriCancello: (() => void) | null = null;
    const cancello = new Promise<void>((r) => { apriCancello = r; });
    let primo = true;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      if (primo) { primo = false; await cancello; }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();

    // `/compact` parte come messaggio verso la CLI (Topics lo intercetta per
    // mostrare l'avviso, ma il lavoro lo fa la CLI: vedi handleSlashCommand).
    // Escape chiude il menu dei comandi, o Invio ne SELEZIONEREBBE una voce.
    await chatPage.messageInput.fill("/compact");
    await chatPage.messageInput.press("Escape");
    await chatPage.messageInput.press("Enter");
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["/compact"]);

    // Mentre la compattazione lavora, l'umano scrive: va in coda, e la coda si
    // vede — una volta sola, come bolla nel trascritto.
    await chatPage.messageInput.fill("e adesso riprendiamo");
    await chatPage.messageInput.press("Enter");
    await expect(page.getByTestId("queued-bubble")).toHaveCount(1, { timeout: 10_000 });

    // Il turno di compattazione finisce. Questo è il frame VERO: `stream:end`
    // con `discardedMessageId`, perché il server ha appena cancellato la riga
    // assistente vuota che la compattazione lascia — è il caso che il drain
    // deve reggere, non un `stream:end` qualunque.
    inject!(JSON.stringify({
      type: "stream:end",
      sessionKey,
      topicId,
      messageId: "msg-della-compattazione",
      discardedMessageId: "msg-della-compattazione",
      stopReason: "end_turn",
    }));
    apriCancello!();

    // IL PUNTO: la coda parte da sola. Prima restava lì per sempre, perché lo
    // `stream:end` di una compattazione non arrivava mai.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["/compact", "e adesso riprendiamo"]);
    await expect(page.getByTestId("queued-bubble")).toHaveCount(0, { timeout: 10_000 });

    // …e la riga vuota che la compattazione lascia non resta in pagina come
    // bolla assistente muta: il server l'ha cancellata, il client la toglie da
    // sé (`dropEmptyTurn`, su `discardedMessageId`). Nessuna bolla assistente
    // vuota in tutto il trascritto.
    const vuote = await page.locator('[data-testid="chat-message"][data-role="assistant"]').evaluateAll(
      (nodi) => nodi.filter((n) => !(n.textContent ?? "").trim()).length,
    );
    expect(vuote, "nessuna bolla assistente vuota dopo la compattazione").toBe(0);
  });
});

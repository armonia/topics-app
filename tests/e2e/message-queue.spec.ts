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
 * The turn queue: what happens to a message typed WHILE the agent is still
 * answering.
 *
 * The fault this file nails down: **"stop" made things start.** The drain lived
 * in a `ChatPane` effect whose only condition was "it is no longer streaming" —
 * and a stop is exactly that. You pressed stop to halt the agent and the next
 * message went out, with nobody having asked for it. The others exercised here:
 * a slash command typed during streaming ended up in the queue and then went
 * out as TEXT, whoever typed after a stop jumped ahead of what they had typed
 * before, and the queue drained ONE AT A TIME — three lines typed in a row
 * became three turns, and the first one went out having never seen the other
 * two.
 *
 * It is BEHAVIOUR, not layout: video on, the .webm is the proof. The pure logic
 * lives in `client/src/state/chatQueue.ts` with its own unit tests; what gets
 * checked here is that it really happens on the page.
 */
test.use({ video: "on" });

test.describe.serial("Coda dei messaggi", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `msg-queue-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find(t => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
    // Due scambi di storia: con un solo turno lo stop cade nel ramo "prima
    // domanda, ho cambiato idea" e azzera la chat intera (`decideClientWipeOnStop`).
    await seedMessage(request, { sessionKey, role: "user", content: "domanda di prima" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di prima" });
    await seedMessage(request, { sessionKey, role: "user", content: "e poi?" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di poi" });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * Intercetta gli invii e li REGISTRA. `hang` tiene la POST aperta: è la
   * finestra in cui l'umano scrive il messaggio successivo e preme stop.
   */
  async function interceptSends(page: import("@playwright/test").Page) {
    const sent: string[] = [];
    const state = { hang: true };
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      // Il corpo è un `ChatRequest`: il turno appena scritto è l'ULTIMO messaggio.
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      if (state.hang) await new Promise((r) => setTimeout(r, 20_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });
    return { sent, state };
  }

  /**
   * La coda si guarda DOVE SUCCEDE: le bolle «da inviare» in fondo al
   * trascritto. Era un badge a scomparsa sopra il composer, e le due cose
   * convivevano — la stessa coda disegnata due volte a due centimetri di
   * distanza, con le azioni solo in quella nascosta. Ne è rimasta una
   * (`client/src/components/Chat/QueuedTurns.tsx`), quindi i locator sono
   * questi.
   */
  const queuedBubbles = (page: import("@playwright/test").Page) =>
    page.getByTestId("queued-bubble");

  /** Svuota la coda comunque sia messa: con più righe c'è «Svuota», con una
   *  sola la X di quella riga È lo svuota (due bottoni per la stessa azione
   *  sarebbero un bivio finto). */
  async function clearQueue(page: import("@playwright/test").Page) {
    const bolle = queuedBubbles(page);
    for (let giro = 0; giro < 10; giro++) {
      const n = await bolle.count();
      if (n === 0) return;
      if (n > 1) {
        await page.getByTestId("queue-clear").click();
      } else {
        await page.getByTestId("queued-bubble-remove").first().click();
      }
      await expect(bolle).toHaveCount(0, { timeout: 5_000 }).catch(() => {});
    }
  }

  /**
   * Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale.
   * DELIBERATE FIXED WAIT: the pause is the deliverable, and it is off by default.
   */
  const beat = (page: import("@playwright/test").Page, ms = 1200) =>
    process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

  /**
   * Didascalia sulla clip — SOLO sotto E2E_EVIDENCE, zero effetto sulla suite.
   * A 268px di larghezza una chat non si legge: il titolo grande sì, e dice da
   * sé cosa sta provando. `pointer-events:none` così non intercetta un click.
   *
   * 64px e non 44: il video esce a 800px e l'anteprima lo riduce a 268, cioè un
   * terzo. Misurato con `tesseract` sul fotogramma ridotto, a 44px la riga non
   * si legge più (zero caratteri riconosciuti); a 64 sì. Il cancello è quello,
   * non il gusto.
   */
  async function didascalia(page: import("@playwright/test").Page, testo: string) {
    if (process.env.E2E_EVIDENCE !== "1") return;
    await page.evaluate((t) => {
      let el = document.getElementById("__e2e_caption__");
      if (!el) {
        el = document.createElement("div");
        el.id = "__e2e_caption__";
        el.setAttribute(
          "style",
          "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
          "background:rgba(10,10,12,.92);color:#fff;font:700 64px/1.2 system-ui,sans-serif;" +
          "padding:18px 24px;letter-spacing:-.01em;border-top:4px solid #8b5cf6;",
        );
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, testo);
  }

  async function openChat(page: import("@playwright/test").Page, chatPage: { messageInput: import("@playwright/test").Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  /**
   * UNA SOLA CODA A SCHERMO, E CI SI PUÒ AGIRE SOPRA.
   *
   * Il guasto: la stessa coda era disegnata DUE volte — le bolle «da inviare»
   * in fondo al trascritto (mute) e un badge a scomparsa sopra il composer, che
   * era l'unico posto da cui correggere, buttare, svuotare o non aspettare la
   * fine del turno. Chi guardava la chat vedeva il proprio messaggio due volte
   * e non sapeva quale fosse quello vero; chi voleva correggerlo doveva
   * scoprire un pannello nascosto. Ne è rimasta una, ed è quella nel posto in
   * cui il messaggio finirà: le azioni vivono sulla bolla che riguardano.
   */
  test("la coda si vede UNA volta sola, e ci si corregge sopra", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-03" });
    const { sent, state } = await interceptSends(page);
    await openChat(page, chatPage);
    await clearQueue(page);

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    await chatPage.messageInput.fill("da correggere");
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });

    // UNA rappresentazione: il badge del composer non esiste più.
    await expect(page.getByTestId("message-queue-badge")).toHaveCount(0);
    // …e il testo non è scritto due volte a schermo.
    await expect(page.getByText("da correggere", { exact: false })).toHaveCount(1);

    // Correggere: click sul testo, si edita in loco, Invio salva.
    await page.getByTestId("queued-bubble-edit").first().click();
    const campo = page.getByTestId("queued-bubble-input");
    await expect(campo).toBeVisible();
    await campo.fill("corretto");
    await campo.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1);
    await expect(queuedBubbles(page).first()).toContainText("corretto");

    // …e quello che parte è il testo CORRETTO, non quello scritto all'inizio.
    state.hang = false;
    await page.getByRole("button", { name: /Stop generating/ }).first().click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await chatPage.messageInput.fill("ultimo");
    await chatPage.messageInput.press("Enter");
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["primo", "corretto\n\nultimo"]);
  });

  /**
   * «INVIA SUBITO»: NON ASPETTARE LA FINE DEL TURNO.
   *
   * L'azione esisteva già, ma viveva dentro il badge a scomparsa sopra il
   * composer — cioè in un posto che bisognava sapere di dover aprire — e NESSUN
   * test l'aveva mai cliccata, né prima né dopo lo spostamento (verificato su
   * `git show HEAD~2`: zero occorrenze di `queue-send-now`). Un'azione che fa
   * tre cose delicate in fila e che nessuno prova è un'azione che si rompe in
   * silenzio.
   *
   * Le tre cose, tutte necessarie (vedi `handleSendQueueNow` in ChatPane):
   *   1. FERMA il turno in volo — finché è aperto il server risponde 409 a un
   *      secondo turno sulla stessa sessione;
   *   2. TOGLIE IL FRENO che lo stop alza apposta perché la fine di uno stream
   *      non faccia ripartire la coda da sola (era il guasto per cui «ferma»
   *      faceva PARTIRE il messaggio dopo);
   *   3. CHIEDE il drenaggio, perché il drain automatico è appeso alla fine di
   *      uno stream RIUSCITO e un abort non ci passa.
   *
   * Salta un passo e la coda resta ferma. Qui si prova il risultato che conta:
   * si clicca, e quello che avevi scritto parte SENZA aspettare.
   */
  test("«invia subito» non aspetta la fine del turno", async ({ page, chatPage }) => {
    const sent: string[] = [];
    // Il primo turno resta aperto a lungo: è quello che «invia subito» deve
    // interrompere. Senza il click resterebbe lì, e la coda con lui.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      const testo = body?.messages?.[body.messages.length - 1]?.content ?? "";
      sent.push(testo);
      if (sent.length === 1) await new Promise((r) => setTimeout(r, 60_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await openChat(page, chatPage);
    await clearQueue(page);

    await chatPage.messageInput.fill("il turno lungo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    await chatPage.messageInput.fill("non voglio aspettare");
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });

    // Il comando compare SOLO mentre un turno è in volo: a turno fermo non c'è
    // niente da anticipare, e offrirlo sarebbe un bottone che non fa nulla.
    const inviaSubito = page.getByTestId("queue-send-now");
    await expect(inviaSubito).toBeVisible({ timeout: 10_000 });

    await inviaSubito.click();

    // IL PUNTO: parte adesso, senza aspettare i 60 secondi del primo turno.
    await expect.poll(() => sent, { timeout: 25_000 }).toEqual(["il turno lungo", "non voglio aspettare"]);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test("CHAT-QUEUE-04: a coda ferma «invia subito» resta, e fa partire la coda", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-04" });
    // The twin of the test above. Stopping the turn KEEPS the queue, and the
    // command stays too: with nothing left to cut short it promises the other
    // thing, firing the queue right now. Until 2026-09-03 the control vanished
    // here, so a queue nobody had released (a reload, a socket lost for a
    // second) sat in the transcript with no way to fire it.
    const { sent, state } = await interceptSends(page);
    await openChat(page, chatPage);
    await clearQueue(page);

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    await chatPage.messageInput.fill("in attesa");
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });
    const sendNow = page.getByTestId("queue-send-now");
    await expect(sendNow).toBeVisible({ timeout: 10_000 });
    await expect(sendNow).toHaveAttribute("data-queue-busy", "true");

    state.hang = false;
    await page.getByRole("button", { name: /Stop generating/ }).first().click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect(queuedBubbles(page)).toHaveCount(1);
    // Still rendered, now marked idle: the label promises firing, not stopping.
    await expect(sendNow).toBeVisible();
    await expect(sendNow).toHaveAttribute("data-queue-busy", "false");

    await sendNow.click();
    await expect.poll(() => sent, { timeout: 25_000 }).toEqual(["primo", "in attesa"]);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test("la X sulla bolla butta il messaggio prima che parta", async ({ page, chatPage }) => {
    const { sent, state } = await interceptSends(page);
    await openChat(page, chatPage);
    await clearQueue(page);

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    await chatPage.messageInput.fill("ci ho ripensato");
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });

    await page.getByTestId("queued-bubble-remove").first().click();
    await expect(queuedBubbles(page)).toHaveCount(0);

    // Buttato vuol dire buttato: a turno finito non riappare da nessuna parte.
    state.hang = false;
    await page.getByRole("button", { name: /Stop generating/ }).first().click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await chatPage.messageInput.fill("altro");
    await chatPage.messageInput.press("Enter");
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["primo", "altro"]);
  });

  test("stop TIENE il messaggio in coda invece di farlo partire", async ({ page, chatPage }) => {
    // Il frame che faceva il danno arriva dal WS: dopo un abort il server
    // annuncia comunque `stream:end`, e «lo stream è finito» era l'unica
    // condizione che serviva alla coda per ripartire. Qui lo si inietta a mano,
    // com'è nella realtà — senza, il test passerebbe anche col freno tolto
    // (provato: la strada dell'SSE locale si ferma prima, sull'AbortError).
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    const { sent } = await interceptSends(page);
    await openChat(page, chatPage);
    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    expect(sent).toEqual(["primo"]);

    // Scritto MENTRE l'agente risponde: va in coda, e la coda si vede.
    await chatPage.messageInput.fill("secondo");
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });
    await expect(chatPage.messageInput).toHaveValue("");

    const stop = page.getByRole("button", { name: /Stop generating/ }).first();
    await expect(stop).toBeVisible({ timeout: 5_000 });
    await stop.click();

    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // Il server dice la sua: turno finito. È il momento esatto in cui la coda
    // partiva da sola.
    // DELIBERATE FIXED WAIT: the drain used to fire on its own in this gap, so
    // the gap has to exist for the test to be able to catch it.
    await page.waitForTimeout(500);
    inject!(JSON.stringify({ type: "stream:end", sessionKey, topicId, reason: "user_abort" }));

    // IL PUNTO: fermato vuol dire fermo. Nessun secondo invio…
    // L'attesa copre TUTTA la finestra in cui il drain riproverebbe
    // (`TURN_DRAIN_MAX_ATTEMPTS × TURN_DRAIN_RETRY_MS` = 2s).
    // DELIBERATE FIXED WAIT: the assertion is that NO second send happened, and
    // the window has to outlast every retry the drain would have made.
    await page.waitForTimeout(4_000);
    expect(sent, "lo stop non deve far partire il messaggio in coda").toEqual(["primo"]);
    // …e il messaggio non è perso: è ancora lì, correggibile.
    await expect(queuedBubbles(page)).toHaveCount(1);
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]').last())
      .toContainText("primo");
  });

  test("riprendendo, la coda riparte dalla TESTA: nessun sorpasso", async ({ page, chatPage }) => {
    const { sent, state } = await interceptSends(page);
    await openChat(page, chatPage);
    // La coda del test precedente è durevole per costruzione: si svuota qui,
    // altrimenti questo scenario partirebbe da uno stato che non è il suo.
    await clearQueue(page);
    await expect(queuedBubbles(page)).toHaveCount(0);

    await chatPage.messageInput.fill("uno");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    for (const testo of ["due", "tre"]) {
      await chatPage.messageInput.fill(testo);
      await chatPage.messageInput.press("Enter");
    }
    // «Da inviare», non «in coda»: la lista di cose da fare dell'agente diceva
    // anche lei «in coda», e due strisce affiancate col nome della stessa cosa
    // non si distinguono. (Era «(2 messages queued)», una scritta nuda in
    // arancione attaccata al bordo inferiore del composer.)
    await expect(queuedBubbles(page)).toHaveCount(2, { timeout: 10_000 });

    await page.getByRole("button", { name: /Stop generating/ }).first().click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // L'umano riprende scrivendo. Da qui gli invii vanno a buon fine subito.
    state.hang = false;
    await chatPage.messageInput.fill("quattro");
    await chatPage.messageInput.press("Enter");

    // "quattro" è l'ULTIMO: quello che era in coda da prima parte per primo —
    // e parte INSIEME a lui, in un turno solo, non tre turni in fila.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["uno", "due\n\ntre\n\nquattro"]);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
  });

  /**
   * IL GUASTO DI QUESTO GIRO: la coda si drenava UNO ALLA VOLTA.
   *
   * Tre righe scritte mentre l'agente lavora sono UN pensiero in tre pezzi.
   * `claimHead` ne estraeva una sola: l'agente ripartiva sulla prima senza aver
   * mai visto le altre due, lavorava su una domanda a metà, e le altre due
   * diventavano altri due turni in fila — tre giri di modello, tre volte il
   * contesto, per una cosa sola. Adesso `claimBatch` prende tutta la testa
   * omogenea e `mergeBatch` la spedisce come UN prompt.
   *
   * È anche la CLIP DI CONSEGNA di questo lavoro, e per quello sta in un
   * describe suo: gli serve un viewport più largo (vedi sotto). Sotto
   * `E2E_EVIDENCE=1` prende le pause e le didascalie che rendono il video
   * leggibile a 268px; a suite normale non cambia un millisecondo.
   */
  test.describe("il batch", () => {
  // L'anteprima di un task viene resa a 268px: oltre un rapporto
  // altezza/larghezza di 0.70 la card TAGLIA invece di rimpicciolire.
  // 1440×760 → video 800×422 (0.528), ci sta intero. Nessuna asserzione qui
  // dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  test("tre messaggi accodati partono INSIEME, in un turno solo", async ({ page, chatPage }) => {
    const sent: string[] = [];
    // Ogni turno resta aperto finché non lo si lascia andare. Il PRIMO cancello
    // è la finestra in cui l'umano scrive i tre pezzi; il SECONDO tiene aperto
    // il turno unito il tempo di guardarlo in pagina — a turno chiuso la chat si
    // riallinea alla storia del server, che qui non ha mai visto niente perché
    // `/api/chat` è intercettata.
    const cancelli: Array<() => void> = [];
    const apre = (i: number) => new Promise<void>((r) => { cancelli[i] = r; });
    const primoTurno = apre(0);
    const turnoUnito = apre(1);
    let n = 0;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      const mio = n++;
      if (mio === 0) await primoTurno;
      else if (mio === 1) await turnoUnito;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await openChat(page, chatPage);
    await clearQueue(page);
    await expect(queuedBubbles(page)).toHaveCount(0);

    await didascalia(page, "L'agente sta rispondendo…");
    await chatPage.messageInput.fill("uno");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    await beat(page);

    await didascalia(page, "…e intanto scrivo altre 3 righe");
    for (const testo of ["due", "tre", "quattro"]) {
      await chatPage.messageInput.fill(testo);
      await chatPage.messageInput.press("Enter");
      await beat(page, 500);
    }
    await expect(queuedBubbles(page)).toHaveCount(3, { timeout: 10_000 });
    await beat(page);

    // Il turno in volo finisce da sé: nessuno stop, nessun freno.
    await didascalia(page, "Fine turno → partono INSIEME");
    cancelli[0]();

    // IL PUNTO: UN solo invio in più, col testo dei tre pezzi unito.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["uno", "due\n\ntre\n\nquattro"]);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
    // E in chat c'è UNA bolla utente, non tre: è quello che il modello ha visto.
    const bolla = page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: "due" });
    await expect(bolla).toHaveCount(1);
    await expect(bolla).toContainText("quattro");
    await didascalia(page, "Un turno solo, con dentro tutte e 3");
    await beat(page, 2000);
    cancelli[1]();
  });
  });

  test("un comando col cancelletto non si accoda: agisce subito", async ({ page, chatPage }) => {
    const { sent, state } = await interceptSends(page);
    await openChat(page, chatPage);

    await chatPage.messageInput.fill("primo");
    await chatPage.messageInput.press("Enter");
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // The trailing space closes the completion menu: without it, Enter would
    // pick the highlighted entry instead of sending.
    await chatPage.messageInput.fill("/help ");
    await chatPage.messageInput.press("Enter");

    // The command answered on the spot. The line is the one `/help` really
    // prints (`slashCommandsHelp` in ChatPane): it is quoted in full, so that a
    // list which stops naming `/status` makes noise.
    //
    // The text is ITALIAN because the app runs in its default language and the
    // descriptions now go through `tr()` (`chat.slash.status.description`), the
    // same ones read in the composer menu. It used to be English here, and the
    // comment on this line said the day they were translated it would go red
    // and say so. This is that day. The command itself is NOT translated: it is
    // what one types.
    await expect(page.getByText("/status: Mostra lo stato della sessione").first())
      .toBeVisible({ timeout: 10_000 });
    // …and it did not end up in the queue, from where it would then have gone out
    // to the model as text.
    await expect(queuedBubbles(page)).toHaveCount(0);

    // Che non sia partito NEMMENO PIÙ TARDI non si prova aspettando mezzo
    // secondo e sperando: si lascia finire il turno e si manda un messaggio
    // vero. Gli invii sono in ordine, quindi un `/help` accodato comparirebbe
    // prima di «secondo» — o fuso dentro il suo prompt.
    state.hang = false;
    await page.getByRole("button", { name: /Stop generating/ }).first().click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await chatPage.messageInput.fill("secondo");
    await chatPage.messageInput.press("Enter");
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["primo", "secondo"]);
  });

  /**
   * IL CASO IN CUI IL CLIENT NON PUÒ SAPERE DA SOLO CHE LA SESSIONE È OCCUPATA.
   *
   * `decideSend` accoda quando è QUESTA finestra a stare streammando. Ma la
   * sessione può essere occupata da qualcun altro: un'altra finestra sullo
   * stesso topic, o — il caso vero di tutti i giorni — un task dispatchato che
   * sta lavorando nella sua topic mentre l'umano ci scrive dentro. Lì il client
   * spedisce in buona fede, ed è il SERVER a doverlo fermare.
   *
   * Prima non lo fermava nessuno: `/api/chat` era l'unica route mutante di
   * sessione senza cancello, e la seconda POST sovrascriveva la voce di
   * `activeStreams` — il `finally` del primo turno chiudeva il secondo, col
   * messageId sbagliato. Ora risponde 409, ed è il canale di STEERING della
   * chat: lo stesso patto che la board ha già per i task, dove un commento
   * umano viene bufferizzato e consegnato al confine del turno.
   *
   * Il 409 lo fa il server (`server/routes/chat.ts`, provato in unità da
   * `server/routes/chat.front-door.test.ts` con la sua controprova). Qui si
   * verifica l'ALTRA metà del patto, che fino a ieri era codice morto perché
   * nessun 409 esisteva: il messaggio torna in TESTA alla coda, non resta una
   * bolla fantasma in chat, e parte da solo appena il turno dell'altro finisce.
   */
  test("«turno già in volo» (409): il messaggio va in TESTA alla coda e parte a fine turno", async ({ page, chatPage }) => {
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    const sent: string[] = [];
    // Il primo invio trova la sessione occupata da un altro; il secondo (quello
    // che parte dalla coda) la trova libera.
    let occupata = true;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      if (occupata) {
        occupata = false;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "a response is already streaming for this session",
            code: "stream_in_flight",
            messageId: "msg-di-qualcun-altro",
          }),
        });
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await openChat(page, chatPage);
    expect(inject, "la rotta WS deve aver catturato la presa").not.toBeNull();
    await clearQueue(page);
    await expect(queuedBubbles(page)).toHaveCount(0);

    const TESTO = "scrivo mentre l'agente sta lavorando qui";
    await chatPage.messageInput.fill(TESTO);
    await chatPage.messageInput.press("Enter");

    // Respinto ⇒ in coda, e la coda si vede.
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });
    expect(sent).toEqual([TESTO]);
    // E NON resta in chat come se fosse partito: l'unico posto in cui vive è
    // la coda. Prima la domanda restava in pagina mentre il testo viveva in un
    // ref invisibile — un messaggio spedito che non era mai esistito.
    await expect(
      page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: TESTO }),
    ).toHaveCount(0);

    // Il turno dell'altro finisce: il server lo annuncia a tutti.
    inject!(JSON.stringify({ type: "stream:end", sessionKey, topicId }));

    // IL PUNTO: riparte da solo, con lo stesso testo, una volta sola.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual([TESTO, TESTO]);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
  });
});

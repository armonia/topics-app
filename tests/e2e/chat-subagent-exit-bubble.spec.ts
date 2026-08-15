import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * IL RAPPORTO DEL SOTTO-AGENTE CHE SI MANGIAVA LA RISPOSTA.
 *
 * Quando un sotto-agente finisce, il server scrive una riga sua e la trasmette
 * come un `message:new` qualunque — a turno del genitore ANCORA APERTO
 * (`server/lib/subagent-watch.ts`). Il client decideva per POSIZIONE: «l'ultimo
 * messaggio è un assistant parziale, quindi questa riga persistita è lui». Così
 * il rapporto si prendeva id, testo e bandiera della bolla viva, e il resto
 * della risposta continuava a scriversi DENTRO il rapporto.
 *
 * Adesso la decisione è per IDENTITÀ: `stream:start` annuncia l'id della riga in
 * volo, il segnaposto lo porta, e una riga con un id diverso si accoda invece di
 * sostituire. Le delta che arrivano dopo tornano nella bolla del turno, cercata
 * per nome e non «l'ultima».
 *
 * Video acceso: è un COMPORTAMENTO (una bolla che viene sostituita da un'altra
 * sotto gli occhi), e uno screenshot non lo mostra.
 */
test.use({ video: "on" });

const TURNO_ID = "9a1c7d24-55e6-4f10-8b3c-7e2d9f0a1b22";
const REPORT_ID = "c0ffee00-1111-2222-3333-444455556666";
const PRIMA = "Ho delegato l'analisi del log.";
const DOPO = " Il risultato conferma la mia ipotesi.";
/**
 * Il rapporto viaggia in markdown, com'è nella realtà: `subagent-watch` scrive
 * una riga formattata. Quello che finisce nel DOM è il markdown RESO, quindi i
 * backtick non ci sono — asserire la sorgente cercava nella pagina una stringa
 * che la pagina non contiene, e il test falliva su una bolla scritta giusta.
 */
const REPORT = "Sotto-agente `log-scan` completato: 12 occorrenze in 3 file.";
const REPORT_RESO = "Sotto-agente log-scan completato: 12 occorrenze in 3 file.";

test.describe("Un sotto-agente che esce non ruba la bolla del turno", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `subagent-exit-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics.topics).find((x) => x.id === topicId)!.sessionKey;
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function apri(
    page: import("@playwright/test").Page,
    chatPage: { messageInput: import("@playwright/test").Locator },
  ) {
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
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);
    return (frame: Record<string, unknown>) => inject!(JSON.stringify({ sessionKey, topicId, ...frame }));
  }

  test("il rapporto è una riga sua, e il turno continua nella propria", async ({ page, chatPage }) => {
    const send = await apri(page, chatPage);
    const assistenti = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    const turno = page.locator(`[data-testid="chat-message"][data-message-id="${TURNO_ID}"]`);
    const rapporto = page.locator(`[data-testid="chat-message"][data-message-id="${REPORT_ID}"]`);

    send({ type: "stream:start", messageId: TURNO_ID });
    send({ type: "stream:content_chunk", content: PRIMA });
    await expect(turno).toContainText(PRIMA, { timeout: 10_000 });

    // Il sotto-agente esce: riga persistita, id suo, turno ancora aperto.
    send({ type: "message:new", role: "assistant", messageId: REPORT_ID, content: REPORT, preview: REPORT.slice(0, 100) });
    await expect(rapporto).toContainText(REPORT_RESO, { timeout: 10_000 });

    // Due bolle, non una: il rapporto NON ha sostituito il turno.
    await expect(assistenti).toHaveCount(2, { timeout: 10_000 });
    await expect(turno).toContainText(PRIMA);

    // E il resto del turno torna nella bolla del turno, non in coda al rapporto.
    send({ type: "stream:content_chunk", content: DOPO });
    send({ type: "stream:end", messageId: TURNO_ID });
    await expect(turno).toContainText("conferma la mia ipotesi", { timeout: 10_000 });
    await expect(rapporto).not.toContainText("conferma la mia ipotesi");
    await expect(assistenti).toHaveCount(2);
  });

  test("la riga che CHIUDE il turno si fonde nella bolla viva, non se ne apre un'altra", async ({ page, chatPage }) => {
    // Il controllo dell'altra metà: quando l'id È quello del turno, il contenuto
    // deve ATTERRARE nella bolla che c'è già. È il caso per cui quel ramo esiste,
    // e non è un caso di laboratorio: le delta di contenuto viaggiano solo agli
    // iscritti della topic (`server/lib/ws-topic-routing.ts`), quindi una
    // finestra che la topic non ce l'ha aperta riceve `stream:start` e
    // `message:new` e NIENT'ALTRO. Quella riga persistita è tutto il suo turno.
    const send = await apri(page, chatPage);
    const assistenti = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    const turno = page.locator(`[data-testid="chat-message"][data-message-id="${TURNO_ID}"]`);

    // NIENTE `stream:content_chunk`: è esattamente la finestra senza delta.
    send({ type: "stream:start", messageId: TURNO_ID });
    await expect(assistenti).toHaveCount(1, { timeout: 10_000 });

    send({ type: "message:new", role: "assistant", messageId: TURNO_ID, content: PRIMA + DOPO, preview: PRIMA });
    // Una bolla sola, ED È PIENA. Asserire solo l'id sarebbe vero già dopo
    // `stream:start`: il test passerebbe con la fusione cancellata.
    await expect(turno).toContainText(PRIMA, { timeout: 10_000 });
    await expect(turno).toContainText("conferma la mia ipotesi");
    await expect(assistenti).toHaveCount(1);
    await expect(assistenti.first()).toHaveAttribute("data-message-id", TURNO_ID);
  });

  test("una anteprima troncata non accorcia quello che la finestra ha già ricevuto", async ({ page, chatPage }) => {
    // L'errore opposto: `message:new` può portare un `preview` tagliato, e
    // riempire alla cieca sostituirebbe il testo intero con il suo troncone.
    //
    // Il testo qui arriva dal CATCHUP, non dalle delta, e la scelta è la
    // differenza fra un test vero e uno che non può fallire. Una bolla scritta
    // dalle delta porta anche i BLOCCHI, e sono quelli che si vedono: il
    // riempimento tocca solo `content`, quindi il troncamento resterebbe
    // invisibile in pagina e l'asserzione passerebbe anche con la guardia
    // tolta (provato: cancellando il confronto sulle lunghezze il test restava
    // verde). Una finestra che si attacca a turno già iniziato riceve invece
    // `stream:catchup` con il testo accumulato e nessun blocco — è la bolla in
    // cui `content` È quello che si legge, ed è l'unica forma in cui
    // un'anteprima più corta può davvero accorciare quello che si vede.
    const send = await apri(page, chatPage);
    const turno = page.locator(`[data-testid="chat-message"][data-message-id="${TURNO_ID}"]`);
    const segnale = page.locator(`[data-testid="chat-message"][data-message-id="${REPORT_ID}"]`);

    send({ type: "stream:start", messageId: TURNO_ID });
    send({ type: "stream:catchup", messageId: TURNO_ID, content: PRIMA + DOPO });
    await expect(turno).toContainText("conferma la mia ipotesi", { timeout: 10_000 });

    send({ type: "message:new", role: "assistant", messageId: TURNO_ID, content: PRIMA, preview: PRIMA });
    // Il frame va ASPETTATO, non dato per applicato: asserire subito dopo
    // l'invio legge lo stato di PRIMA, e il test passerebbe anche con la
    // guardia tolta. La riga qui sotto è un'ALTRA riga (id diverso) e non tocca
    // la bolla in esame; i frame arrivano in ordine sulla stessa presa, quindi
    // quando si vede lei il troncone è già stato gestito.
    send({ type: "message:new", role: "assistant", messageId: REPORT_ID, content: REPORT, preview: REPORT });
    await expect(segnale).toContainText(REPORT_RESO, { timeout: 10_000 });

    await expect(turno).toContainText("conferma la mia ipotesi");
  });
});

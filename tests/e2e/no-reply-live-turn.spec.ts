import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
const BASE = E2E_BASE;

/**
 * «NESSUNA RISPOSTA» NON SI DICE A UN TURNO CHE STA RISPONDENDO.
 *
 * Il referto del 2026-08-19: mando un messaggio, ricarico la finestra, e compare
 * la scatola ambra «La connessione può essersi interrotta» mentre l'agente sta
 * lavorando. Non è un fastidio estetico: quel banner offre «Riprova», cioè
 * invita a far partire un SECONDO turno a pagamento mentre il primo è vivo.
 *
 * La causa era che il banner leggeva solo `currentStreaming` — la mappa
 * `streaming` di `useChat`, memoria di PROCESSO che ogni reload azzera — e non
 * il registro del server, che invece sopravvive
 * (`GET /api/topics/streaming` → `hydratedStreamTopics`).
 *
 * PERCHÉ LA ROTTA SI INTERCETTA invece di far partire un turno vero. La
 * condizione da riprodurre è «il server dichiara il turno aperto MENTRE la
 * sessione locale non lo sa», e in un browser vero la si ottiene solo
 * cronometrando un reload dentro la finestra di un turno in volo: il test
 * diventerebbe una gara col tempo, cioè rosso a caso il giorno che la macchina
 * è carica — cosa già vista due volte oggi, con i frame e con la prima card.
 *
 * Intercettando la rotta si mette la pagina ESATTAMENTE nello stato del
 * referto, e ciò che si verifica è quello che l'utente vede: la scatola ambra
 * non c'è. La rotta non è un dettaglio interno inventato per il test — è il
 * canale che `useSignalsSync` interroga in produzione ogni 15 secondi, e il suo
 * contratto (`{ sessions: [{ topicId, sessionKey, state }] }`) è lo stesso che
 * il server serve davvero: qui sotto si copia la forma, non la si immagina.
 *
 * Il gemello di questo test è `empty-turn-on-stop.spec.ts`, che prova le due
 * metà opposte: dopo uno STOP il banner compare e dice «Turno interrotto», e su
 * una risposta mai arrivata dice «Nessuna risposta». Insieme coprono i tre
 * stati in cui la pagina ha la stessa forma e la causa è diversa.
 */
test.describe.serial("Il banner tace su un turno vivo", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `no-reply-live-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
    // La forma del referto: l'ULTIMO messaggio è dell'utente e nessuna risposta
    // è ancora arrivata. È anche la forma di un turno morto — ed è precisamente
    // il motivo per cui la pagina da sola non basta a decidere.
    await seedMessage(request, { sessionKey, role: "user", content: "domanda a cui sta rispondendo" });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("il server dichiara il turno APERTO: niente scatola ambra", async ({ page, chatPage }) => {
    await page.route("**/api/topics/streaming", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [{ topicId, sessionKey, state: "streaming" }] }),
      });
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Il messaggio c'è (la prima metà del referto, «sparisce», era il
    // caricamento: la riga utente è persistita nell'istante dell'invio).
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]').last())
      .toContainText("domanda a cui sta rispondendo");

    // E la scatola ambra NON c'è. `toHaveCount(0)` e non `toBeHidden`: qui il
    // nodo non deve proprio esistere, e un `toBeHidden` passerebbe anche su un
    // banner presente ma invisibile per un altro motivo.
    const banner = page.locator('[data-testid="no-reply-banner"]');
    await expect(banner).toHaveCount(0);
    // Tenuto un istante: il poll dei segnali gira, e un banner che comparisse
    // al secondo giro sarebbe lo stesso difetto con un ritardo.
    await page.waitForTimeout(2_000);
    await expect(banner).toHaveCount(0);
  });

  test("il server NON conosce quel turno: la scatola ambra torna a parlare", async ({ page, chatPage }) => {
    // L'altra metà, e serve: senza, questo file passerebbe anche su un banner
    // che non compare MAI — che è il modo in cui una correzione si trasforma
    // nel difetto opposto, silenzioso.
    await page.route("**/api/topics/streaming", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const banner = page.locator('[data-testid="no-reply-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute("data-reason", "interrupted");
  });
});

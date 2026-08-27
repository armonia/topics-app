import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Come si legge un turno finito male.
 *
 * Il difetto era strutturale, non estetico. Il cartello d'errore viveva DENTRO
 * `content` con un ⚠️ davanti, e il client accendeva la scatola ambra guardando
 * quel prefisso — ma quando un messaggio ha i `blocks`, `content` non viene
 * stampato affatto. Le due cose insieme davano il peggio dei due mondi:
 *
 *   · il contenitore di TUTTA la bolla diventava giallo, prosa e cronologia dei
 *     tool comprese, come se ogni cosa lì dentro fosse sbagliata;
 *   · e dentro non compariva una sola parola che dicesse perché, perché il testo
 *     dell'errore era sepolto in una colonna che quel ramo non stampa.
 *
 * Nel DB di produzione erano 45 righe: turni interi, leggibili, incorniciati di
 * giallo senza motivo. Il verdetto ora è un blocco suo (`kind: 'error'`) e si
 * rende come una riga in cima al contenuto — con il turno, intatto, sotto.
 *
 * @covers CHAT-02
 */
test.describe.serial("Il verdetto di un turno finito male", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  const PROSA = "Piano scritto. In sintesi: rifare a shader lo sfondo.";
  const ERRORE = "Non sono riuscito ad avviare il turno: ai-bridge: ack timeout";

  test.beforeAll(async ({ request }) => {
    topicName = "Turn Error " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /** La classe del contenitore della bolla — quello che diventava giallo. */
  async function classesContainer(page: import("@playwright/test").Page): Promise<string> {
    return page
      .locator('[data-testid="message-content-assistant"]')
      .last()
      .evaluate((el) => (el.parentElement?.parentElement as HTMLElement | null)?.className ?? "");
  }

  test("l'errore è una riga sua, e il turno sotto NON è incorniciato", async ({ page, request }) => {
    await seedMessage(request, { sessionKey, role: "user", content: "vedi ora" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: PROSA,
      blocks: [
        { kind: "text", text: PROSA },
        { kind: "error", text: ERRORE },
      ],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    // Il verdetto si legge — ed è quello che prima non si vedeva affatto.
    const verdetto = page.locator('[data-testid="turn-error"]').last();
    await expect(verdetto).toBeVisible();
    await expect(verdetto).toContainText("ack timeout");

    // Il turno è ancora lì, intero.
    await expect(page.locator('[data-testid="message-content-assistant"]').last()).toContainText("rifare a shader");

    // E non è dentro una scatola gialla.
    expect(await classesContainer(page)).not.toContain("amber");
  });

  test("il cartello nel testo di una riga VECCHIA torna leggibile", async ({ page, request }) => {
    // La forma già scritta in DB: il cartello in `content`, i blocchi pieni.
    // Prima questa riga mostrava il turno bordato di giallo e basta: il testo
    // dell'errore non veniva stampato da nessuna parte.
    await seedMessage(request, { sessionKey, role: "user", content: "e questa?" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "⚠️ Failed to send message: ai-bridge: ack timeout",
      blocks: [{ kind: "text", text: "Un turno di lavoro sopravvissuto." }],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const verdetto = page.locator('[data-testid="turn-error"]').last();
    await expect(verdetto).toBeVisible();
    await expect(verdetto).toContainText("ack timeout");
    await expect(page.locator('[data-testid="message-content-assistant"]').last())
      .toContainText("Un turno di lavoro sopravvissuto");
    expect(await classesContainer(page)).not.toContain("amber");

    // E NIENTE bottone «Riprova»: il turno ha prodotto. Rimandarlo non
    // ripara niente — ne farebbe un secondo, a pagamento, sopra uno già lì.
    await expect(page.locator('[data-testid="message-retry"]')).toHaveCount(0);
  });

  /**
   * LA FORMA VERA DEL GUASTO DEL 20/08, che nessuno di questi test copriva.
   *
   * Gli altri seminano una riga già ben formata. Questa semina quello che il
   * DB conteneva davvero 1082 volte: prosa a metà, un tool chiuso «Interrotto»,
   * e il verdetto che la bonifica aggiunge in coda ai blocchi — non in cima.
   * Se il client rendesse il verdetto solo quando è il primo blocco, o solo su
   * `content`, questi turni resterebbero muti a schermo pur avendo la
   * spiegazione in database: il guasto daccapo, con un'altra faccia.
   */
  test("turno morto sotto un tool: il verdetto si vede, e il lavoro sotto resta", async ({ page, request }) => {
    await seedMessage(request, { sessionKey, role: "user", content: "misura la densità" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Troppo lento in foreground. Lo mando in background.",
      blocks: [
        { kind: "text", text: "Troppo lento in foreground. Lo mando in background." },
        {
          kind: "tool",
          toolCall: {
            id: "tu_morto", name: "bash", args: { command: "sleep 100" }, status: "error",
            error: "Interrotto: la sessione è terminata prima del risultato",
          },
        },
        // In CODA, che è dove la bonifica lo mette.
        { kind: "error", text: "Turno interrotto: il server si è riavviato mentre la risposta era in corso." },
      ],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const verdetto = page.locator('[data-testid="turn-error"]').last();
    await expect(verdetto).toBeVisible();
    await expect(verdetto).toContainText("il server si è riavviato");
    // Il lavoro dell'agente resta leggibile sotto il cartello.
    await expect(page.locator('[data-testid="message-content-assistant"]').last())
      .toContainText("Lo mando in background");
    expect(await classesContainer(page)).not.toContain("amber");
  });

  test("una riga di solo errore si legge una volta sola, e porta il suo Riprova", async ({ page, request }) => {
    await seedMessage(request, { sessionKey, role: "user", content: "e adesso?" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: `⚠️ ${ERRORE}`,
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const verdetto = page.locator('[data-testid="turn-error"]').last();
    await expect(verdetto).toBeVisible();
    await expect(verdetto).toContainText("ack timeout");

    // Il testo NON va ristampato anche come prosa sotto il banner.
    const bolla = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
    expect(await bolla.evaluate((el) => (el.textContent ?? "").split("ack timeout").length - 1)).toBe(1);

    // Il bottone che rimanda il messaggio resta al suo posto: è ciò che rende
    // vera la promessa «il tuo messaggio è ancora qui».
    await expect(page.locator('[data-testid="message-retry"]').last()).toBeVisible();
  });
});

/**
 * dictation-hermetic.spec.ts — dettatura con STT intercettato.
 *
 * PERCHE' ESISTE. `dictation-real-mic.spec.ts` prova l'intera catena col motore
 * STT vero: quella spec e' preziosa ma non puo' girare nel gate PR (il server di
 * test gira senza chiavi e senza modelli, il provider risponde 401, la cascata
 * non ha nessun ripiego, la trascrizione non arriva mai — rosso fisso). Percio'
 * vive in NIGHTLY_ONLY_SPECS.
 *
 * Questa spec prova la meta' che la suite PR non copriva: che il testo
 * trascritto entri nel composer AL CURSORE, senza mangiare quello che c'era. La
 * trascrizione e' intercettata a livello HTTP (page.route su /api/stt), quindi
 * il testo esatto e' deterministico e asseribile — e non dipende da nessun
 * modello che non controlliamo. L'audio che arriva al confine e' vero (prodotto
 * dal device finto di Chromium), quindi la catena fino al POST e' identica a
 * quella di produzione.
 *
 * COSA SI VERIFICA
 *   1. ⌘⇧D apre il microfono (banner visibile).
 *   2. Il testo dettato (risposta finta dell'STT) entra nel composer.
 *   3. Entra AL CURSORE — non in coda, non all'inizio — con «prima» e «dopo»
 *      intatti attorno.
 *   4. ⌘⇧R registra una nota vocale: il testo arriva nella bolla, non il
 *      percorso del file.
 */
import { resolve } from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Il device finto di Chromium deve produrre segnale: senza il file WAV il
 *  microfono erogherebbe il beep a 440 Hz, che va bene perche' la trascrizione
 *  e' intercettata. Il WAV e' il DEVICE — non il contenuto asserito. */
const SPOKEN_WAV = resolve(__dirname, "fixtures/audio/spoken-phrase.wav");

/** Frase che lo stub STT restituisce: deterministica e verificabile. */
const STUB_TRANSCRIPT = "git rebase --onto main";

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${SPOKEN_WAV}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
});

test.describe.configure({ timeout: 90_000 });

/**
 * Intercetta /api/stt/capabilities e /api/stt per rendere il test ermetico.
 * Il device audio e' finto ma vero (produce campioni reali), quindi il POST
 * contiene un file audio con dei byte — si verifica che il body non sia vuoto.
 */
async function stubStt(page: Page, transcript: string) {
  await page.route("**/api/stt/capabilities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        provider: "e2e-stub",
        model: "stub",
        providers: [],
        language: null,
      }),
    }),
  );

  await page.route("**/api/stt", async (route) => {
    const body = route.request().postDataBuffer();
    // Il registratore deve aver prodotto dei byte. Zero byte significa che
    // getUserMedia non ha restituito segnale (flusso muto).
    expect(body ? body.length : 0, "il POST /api/stt e' arrivato senza corpo: il microfono non ha prodotto audio").toBeGreaterThan(0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript, provider: "e2e-stub", model: "stub" }),
    });
  });
}

test.describe.serial("Dettatura ermetica — cursore e testo esatto", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `dictation-hermetic-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("⌘⇧D: il testo trascritto entra nel composer AL CURSORE", async ({ page, chatPage }) => {
    await stubStt(page, STUB_TRANSCRIPT);

    await goToApp(page);
    await openTopic(page, topicName);

    const composer = chatPage.messageInput;
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();

    // Il cursore in MEZZO a del testo gia' scritto. E' il cuore dell'asserzione:
    // una dettatura che si limita ad accodare passerebbe un semplice «contiene»
    // e sbaglierebbe comunque il punto di inserimento.
    await composer.fill("prima dopo");
    for (let i = 0; i < 4; i++) await composer.press("ArrowLeft"); // caret fra «prima » e «dopo»

    await page.keyboard.press("Meta+Shift+D");

    // Il banner conferma che getUserMedia ha aperto il microfono e MediaRecorder
    // e' partito. Lo stub risponde «e2e-stub».
    const banner = page.locator('[data-testid="dictation-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/e2e-stub/i);

    // La stessa scorciatoia chiude la dettatura e spedisce il blob al server.
    await page.keyboard.press("Meta+Shift+D");
    await expect(banner).toBeHidden({ timeout: 15_000 });

    // Il testo esatto e' verificabile perche' e' lo stub a rispondere.
    await expect(composer).toHaveValue(new RegExp(STUB_TRANSCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), { timeout: 30_000 });

    // AL CURSORE, non in coda: «prima <detto> dopo».
    const value = await composer.inputValue();
    expect(value.startsWith("prima "), `il testo non inizia con «prima »: "${value}"`).toBe(true);
    expect(value.trimEnd().endsWith("dopo"), `il testo non finisce con «dopo»: "${value}"`).toBe(true);
    expect(value).not.toBe("prima dopo");
  });

  test("⌘⇧R: la nota vocale porta il TESTO detto nella bolla, non il path", async ({ page, chatPage }) => {
    await stubStt(page, STUB_TRANSCRIPT);

    // Ferma la risposta del chat per tenere la bolla utente visibile: il client
    // ricarica la storia dal server dopo lo stream, e senza questo il POST
    // non arriva mai (il server di test non ha un provider chat).
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise<void>((r) => setTimeout(r, 60_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });

    await goToApp(page);
    await openTopic(page, topicName);
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 10_000 });
    await chatPage.messageInput.click();

    await page.keyboard.press("Meta+Shift+R");

    // La barra rossa di registrazione e' la prova che getUserMedia e' aperto.
    const recordingBar = page.getByText("Recording", { exact: true });
    await expect(recordingBar).toBeVisible({ timeout: 15_000 });

    // Chiude la registrazione e spedisce al server.
    await page.keyboard.press("Meta+Shift+R");

    // La bolla: il testo detto (dalla risposta stub), non il segnaposto.
    const bubble = page.locator('[data-testid="message-content-user"]').last();
    await expect(bubble).toContainText(new RegExp(STUB_TRANSCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), { timeout: 30_000 });
    await expect(bubble).not.toContainText("[Voice message:");

    // Il lettore audio nella bolla: il testo serve all'agente, l'audio
    // all'umano che si rilegge.
    await expect(bubble.locator('[data-testid="voice-player"]')).toBeVisible({ timeout: 15_000 });
  });
});

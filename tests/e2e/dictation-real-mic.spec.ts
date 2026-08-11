/**
 * LA DETTATURA NON ERA MAI STATA PARLATA.
 *
 * La cascata STT ha trenta test unit, e tutti fermano il discorso al confine del
 * modulo: `transcribe()` riceve dei byte e sceglie un provider. Nessuno aveva mai
 * verificato l'altra metà della catena — quella che l'umano usa davvero: premo
 * ⌘⇧D, il MICROFONO si apre, `MediaRecorder` produce un webm/opus vero, quel
 * blob viaggia su `/api/stt`, e il testo trascritto torna DENTRO il composer, al
 * punto del cursore. Fra il primo e l'ultimo anello ci sono getUserMedia, la
 * scelta del mimeType, il multipart, ffmpeg, e il rientro nel React state: sei
 * posti dove rompersi, zero coperti.
 *
 * IL MICROFONO. Qui non c'è una bocca, quindi il microfono è quello FINTO di
 * Chromium (`--use-file-for-fake-audio-capture`) alimentato con un WAV di voce
 * vera — sintetizzata da `say`, ma un segnale audio a tutti gli effetti, non un
 * blob costruito a mano. Il finto sta PRIMA di getUserMedia: da lì in giù la
 * catena è identica a quella di produzione, byte per byte. È il modo standard di
 * provare la cattura audio senza un umano nella stanza, ed è l'unico pezzo di
 * questo test che non è il codice vero.
 *
 * CHI TRASCRIVE. Chiunque la cascata scelga: il test non nomina il provider,
 * legge l'etichetta che la app stessa mostra nel banner della dettatura. Con una
 * chiave ElevenLabs valida quel banner dice `elevenlabs scribe_v2`; su una
 * macchina senza chiavi dice `local whisper.cpp …`. La catena provata è la stessa
 * — cambia solo chi risponde in fondo, ed è esattamente ciò che la cascata
 * promette.
 *
 * COME SI LANCIA (serve un motore STT raggiungibile dal server di test):
 *   WHISPER_MODEL_PATH=~/whisper-models/ggml-small.bin npx playwright test dictation-real-mic
 *   ELEVENLABS_API_KEY=… STT_PROVIDER=elevenlabs npx playwright test dictation-real-mic
 */
import { resolve } from "path";
import type { APIRequestContext } from "@playwright/test";
import type { SttCapabilities } from "../../shared/stt";
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Voce vera in un file vero: `say -v Samantha` → WAV 48 kHz mono 16-bit (il formato che il device finto di Chromium sa leggere). */
const SPOKEN_WAV = resolve(__dirname, "fixtures/audio/spoken-phrase.wav");

/**
 * Ciò che il WAV dice. `git rebase` è il pezzo su cui si asserisce: è il termine
 * tecnico che una trascrizione sbagliata sbaglia per primo (Whisper su una voce
 * italiana lo rende «ghi tre base»), quindi la sua presenza è un segnale, non un
 * caso. `Tauri` NON è nell'asserzione di proposito: la lista di vocabolario di
 * `server/lib/stt.ts` viene inviata solo ai provider cloud, quindi il ripiego
 * locale lo rende «Tori» — un divario reale della cascata, non un rosso del test.
 */
const TECHNICAL_TERM = /git rebase/i;

test.use({
  launchOptions: {
    args: [
      // Nessun dialog di permesso: il microfono è concesso in partenza.
      "--use-fake-ui-for-media-stream",
      // I device di cattura sono finti. Il nome del flag è `…-for-media-stream`:
      // l'`…-for-media-capture` che gira in mezza internet Chromium NON lo
      // riconosce più, lo ignora in silenzio, e getUserMedia restituisce il
      // microfono VERO del Mac — che senza permesso TCC dà un flusso muto. Da
      // fuori sembra una trascrizione che non arriva; era la cattura che non
      // c'era mai stata (`strings` sul binario dice quali switch esistono).
      "--use-fake-device-for-media-stream",
      // …e il microfono finto suona QUESTO file invece del solito beep a 440 Hz.
      `--use-file-for-fake-audio-capture=${SPOKEN_WAV}`,
      // Il lettore della nota vocale non deve dipendere da un gesto umano.
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  // La config globale concede la clipboard: `use` SOSTITUISCE la lista, quindi
  // va ripetuta insieme al microfono.
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
});

/**
 * Il tetto di 30 s della config non basta a un test che PARLA: cinque secondi di
 * registrazione più la trascrizione (rete, o un whisper locale che carica il
 * modello a ogni chiamata) stanno larghi in due minuti e in nessun caso in mezzo.
 */
test.describe.configure({ timeout: 180_000 });

/**
 * Didascalia e respiro sulla clip di consegna — SOLO sotto `E2E_EVIDENCE=1`,
 * zero effetto sulla suite. Stessa convenzione di `board-subtask-deeplink`:
 * l'anteprima di un task viene resa a 268px, e a quella larghezza una UI da
 * 1440px è una macchia. Un titolo grande sopravvive alla riduzione.
 */
const EVIDENCE = process.env.E2E_EVIDENCE === "1";
const beat = (page: import("@playwright/test").Page, ms = 1200) =>
  EVIDENCE ? page.waitForTimeout(ms) : Promise.resolve();

async function didascalia(page: import("@playwright/test").Page, testo: string) {
  if (!EVIDENCE) return;
  await page.evaluate((t) => {
    let el = document.getElementById("__e2e_caption__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption__";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
        "background:rgba(10,10,12,.92);color:#fff;font:700 44px/1.25 system-ui,sans-serif;" +
        "padding:14px 20px;letter-spacing:-.01em;border-top:3px solid #8b5cf6;",
      );
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, testo);
}

test.describe.serial("Dettatura e nota vocale · col microfono", () => {
  // 1440×760 e non il 1280×800 della suite: la clip di questa spec È l'evidenza
  // del task, e oltre un rapporto altezza/larghezza di 0.537 la card TAGLIA
  // invece di rimpicciolire. Nessuna asserzione qui dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `dictation-mic-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * Il cancello prima del cancello: se il server di test non ha NESSUN motore di
   * trascrizione, la app fa la cosa giusta (niente tasto dettatura) e i due test
   * qui sotto fallirebbero dicendo una cosa che non è vera del prodotto. Meglio
   * un salto esplicito con la ragione scritta.
   */
  async function readSttCapabilities(request: APIRequestContext): Promise<SttCapabilities> {
    const res = await request.get("/api/stt/capabilities", { ignoreHTTPSErrors: true });
    return (await res.json()) as SttCapabilities;
  }

  test("⌘⇧D: si parla, e il testo entra nel composer AL CURSORE", async ({ page, chatPage, request }) => {
    const caps = await readSttCapabilities(request);
    test.skip(
      !caps.available,
      `nessun motore STT configurato per il server di test: ${(caps.providers ?? [])
        .map((p) => `${p.id}=${p.reason ?? "?"}`)
        .join(", ")}`,
    );

    await goToApp(page);
    await openTopic(page, topicName);

    const composer = chatPage.messageInput;
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();

    // Il cursore in MEZZO a del testo già scritto. È l'asserzione vera di questo
    // test: la dettatura che si limita ad accodare passerebbe un controllo
    // «contiene il testo», e sbaglierebbe comunque il punto in cui lo mette.
    await composer.fill("prima dopo");
    for (let i = 0; i < 4; i++) await composer.press("ArrowLeft"); // caret fra «prima » e «dopo»
    await didascalia(page, "Cursore FRA «prima» e «dopo» · poi ⌘⇧D");
    await beat(page, 1400);

    await page.keyboard.press("Meta+Shift+D");

    // Il banner è la prova che il microfono si è aperto davvero: `useDictation`
    // lo alza solo dopo che getUserMedia ha risolto e MediaRecorder è partito.
    const banner = page.locator('[data-testid="dictation-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // …e dice CHI sta ascoltando. Con una chiave ElevenLabs valida qui si legge
    // «elevenlabs scribe_v2»; senza, il ripiego della cascata.
    if (caps.provider) await expect(banner).toContainText(new RegExp(caps.provider, "i"));

    await didascalia(page, `Microfono aperto · ascolta: ${caps.provider}`);

    // Si parla. Il WAV dura ~3,5 s: cinque secondi di registrazione lo contengono
    // intero anche se la cattura parte con un istante di ritardo.
    await page.waitForTimeout(5_000);

    // Stessa scorciatoia per chiudere: è ciò che il banner promette.
    await page.keyboard.press("Meta+Shift+D");
    await expect(banner).toBeHidden({ timeout: 15_000 });

    // La trascrizione è un viaggio di rete (o un whisper locale che carica il
    // modello): larga la finestra, stretta l'asserzione.
    await expect(composer).toHaveValue(TECHNICAL_TERM, { timeout: 90_000 });

    // AL CURSORE, non in coda: «prima <detto> dopo».
    const value = await composer.inputValue();
    expect(value.startsWith("prima ")).toBe(true);
    expect(value.trimEnd().endsWith("dopo")).toBe(true);
    expect(value).not.toBe("prima dopo");

    await didascalia(page, "Trascritto AL CURSORE: «prima … dopo»");
    await beat(page, 2200);
  });

  test("⌘⇧R: la nota vocale porta il TESTO detto e il lettore audio, non il path", async ({ page, chatPage, request }) => {
    const caps = await readSttCapabilities(request);
    test.skip(!caps.available, "nessun motore STT configurato per il server di test");

    // Il turno vero non c'entra con questa consegna: la nota vocale è finita nel
    // momento in cui il messaggio UTENTE esiste, e farlo eseguire davvero
    // vorrebbe dire un provider di chat configurato (e pagato) dentro un test.
    //
    // La risposta resta APERTA, non chiusa subito: `performSend` mette la bolla
    // utente in modo ottimistico PRIMA della richiesta, ma alla fine dello stream
    // il client ricarica la storia dal server — che con `/api/chat` intercettato
    // non ha mai visto quel messaggio, e la bolla spariva un istante dopo essere
    // comparsa. Con lo stream fermo il turno resta in volo e la bolla sta ferma.
    // (Stesso mestiere di `chat-streaming-indicator.spec.ts`.)
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 60_000));
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

    // In registrazione il composer lascia il posto alla barra rossa col suo
    // cronometro: è la prova che getUserMedia ha aperto il microfono.
    const recordingBar = page.getByText("Recording", { exact: true });
    await expect(recordingBar).toBeVisible({ timeout: 15_000 });
    await didascalia(page, "⌘⇧R · nota vocale in registrazione");

    await page.waitForTimeout(5_000);
    await page.keyboard.press("Meta+Shift+R");

    // La bolla dell'utente: il testo DETTO, non il marcatore col percorso.
    const bubble = page.locator('[data-testid="message-content-user"]').last();
    await expect(bubble).toContainText(TECHNICAL_TERM, { timeout: 90_000 });
    await expect(bubble).not.toContainText("[Voice message:");

    // E il lettore audio, agganciato al file caricato: il testo serve all'agente,
    // l'audio serve all'umano che si rilegge.
    await expect(bubble.locator('[data-testid="voice-player"]')).toBeVisible({ timeout: 15_000 });

    await didascalia(page, "In chat: il TESTO detto + il lettore audio");
    await beat(page, 2400);
  });
});

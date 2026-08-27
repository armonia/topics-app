import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * PIANO §1b.5 — il ring del composer mostra il contesto REALE del modello, e
 * sopra soglia lo dice ACCANTO A SÉ, non con una striscia sopra il composer.
 *
 * La misura vera nasce da `onContextSize` durante un turno del modello: qui
 * non possiamo farne partire uno (nessun account nel test server), quindi
 * intercettiamo il solo confine che il client consuma — `GET
 * /api/context/live` — e verifichiamo tutto il resto per davvero: quale numero
 * disegna il ring, da quale sorgente dice di averlo preso, e cosa dice la
 * pastiglia d'avviso. La forma della risposta è quella prodotta da
 * `classifyContext` (server/usage/context-window.ts), coperta a sua volta dai
 * suoi unit test.
 *
 * IL RIQUADRO NON C'È PIÙ, ed è il cambiamento che questo file pinna: l'avviso
 * era una striscia larga quanto la chat con due bottoni e quattro righe di
 * prosa, che spostava la conversazione a ogni comparsa e si imparava a chiudere
 * senza leggere. Adesso è una pastiglia DENTRO il bottone dell'anello — stesso
 * bersaglio, nessun layout shift — e le vie d'uscita stanno nell'ispettore, a
 * un click da lì.
 *
 * @covers USAGE-09
 */
test.describe.serial("Context ring — contesto reale + avviso accanto all'anello", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Ring ctx " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("senza misura reale il ring resta sul preventivo dell'envelope", async ({ page }) => {
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ context: null }) }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    await expect(ring).toHaveAttribute("data-context-source", "envelope");
    // Nessuna misura reale ⇒ nessun avviso: la pastiglia non deve MAI nascere
    // dal preventivo, che è un'altra domanda.
    await expect(page.getByTestId("context-notice")).toHaveCount(0);
  });

  test("con la misura reale il ring mostra quella, e sopra soglia la pastiglia", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USAGE-09" });
    // Quante volte l'app va a prendere i dati dell'envelope. Serve a provare
    // che la sezione di diagnostica, da CHIUSA, non costa una richiesta: si
    // conta invece di ispezionare il DOM perche' e' il costo vero, e perche'
    // un `<details>` chiuso nasconde i figli senza smontarli — a occhio le due
    // situazioni sono identiche.
    let chiamateEnvelope = 0;
    page.on("request", (r) => {
      if (/\/context-(preview|snapshots)/.test(r.url())) chiamateEnvelope++;
    });
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          // Forma `usage_update` ACP (3.1): `used`/`size` dentro il blocco.
          context: {
            usage: { sessionUpdate: "usage_update", used: 186_000, size: 200_000 },
            percent: 93,
            level: "critical",
            estimated: false,
            model: "claude-opus-5",
            measuredAt: new Date().toISOString(),
          },
        }),
      }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    await expect(ring).toHaveAttribute("data-context-source", "model");
    await expect(ring).toHaveAttribute("data-context-percent", "93");
    await expect(ring).toHaveAttribute("title", /186k \/ 200k \(93%\)/);

    // L'avviso: la percentuale, dentro il bottone dell'anello.
    const notice = page.getByTestId("context-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveAttribute("data-context-level", "critical");
    await expect(notice).toHaveAttribute("data-context-reason", "window");
    await expect(notice).toHaveText("93%");

    // NON è più un riquadro: niente striscia sopra il composer, niente bottoni
    // propri. La pastiglia vive DENTRO il bottone dell'anello — è quello che
    // toglie il layout shift, quindi si verifica la parentela, non l'aspetto.
    const ringHandle = await ring.elementHandle();
    expect(ringHandle).not.toBeNull();
    const dentro = await notice.evaluate((el, ringEl) => (ringEl as Element).contains(el), ringHandle);
    expect(dentro).toBe(true);
    await expect(ring.getByRole("button")).toHaveCount(0);

    // La via d'uscita c'è, un click più in là: l'ispettore col suo «Compatta».
    // Le due foto sono la PROVA di consegna: la pastiglia dentro la riga dei
    // controlli, e il pannello col grafico in cima.
    await page.locator("form").first().screenshot({ path: "test-results/ctx-chip-composer.png" });
    await ring.click();
    const inspector = page.getByTestId("context-inspector").first();
    await expect(inspector).toBeVisible({ timeout: 10_000 });
    await expect(inspector.getByRole("button", { name: /Compatta|Compact/ })).toBeVisible();
    await expect(inspector.getByTestId("context-budget-bar")).toBeVisible();

    // E IN CIMA C'È LA STESSA MISURA DELL'ANELLO DA CUI SI È ARRIVATI.
    //
    // È il difetto che il pannello aveva: lo si apre cliccando l'anello, e
    // dentro trovavi solo il preventivo dell'envelope — un altro numero, per
    // un'altra domanda. I due valori vengono ora dallo stesso hook, quindi
    // NON POSSONO divergere; questa asserzione è ciò che lo tiene vero.
    await expect(inspector.getByTestId("live-context-percent")).toHaveText("93%");
    await expect(inspector).toContainText("186k / 200k");
    // Il preventivo resta, ma SOTTO e etichettato per quello che è.
    await expect(inspector.getByTestId("budget-percent")).toBeVisible();

    // Le sezioni vuote non si disegnano più: erano quattro righe che dicevano
    // che non c'era niente da vedere, in un pannello aperto per vedere qualcosa.
    await expect(inspector).not.toContainText("No memory content yet");
    await expect(inspector).not.toContainText("No system prompt set");
    await expect(inspector).not.toContainText("No pinned messages");
    // E la diagnostica dell'envelope è CHIUSA: è roba da chi sviluppa Topics.
    // Held BY NAME (`envelope-details`), not as the panel's first `details`:
    // "the first" was a position, and the day the "session environment"
    // section appeared above it this test started measuring that one instead.
    // A count would be worse still - opening the envelope reveals two more
    // inside it ("Adaptation notes", "Raw envelope JSON").
    const dettagli = inspector.getByTestId("envelope-details");
    await expect(dettagli).toContainText(/Diagnostica|Envelope/i);
    expect(await dettagli.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    // E CHIUSA NON COSTA NIENTE. Un `<details>` chiuso NASCONDE i figli, non li
    // smonta: prima il componente dentro girava comunque e faceva le sue due
    // fetch a ogni apertura del pannello, per chi non guarderà mai quella
    // sezione. Difetto invisibile a occhio — questa è la riga che lo tiene
    // curato.
    expect(chiamateEnvelope).toBe(0);
    // Aprendola, invece, i dati si vanno a prendere: la sezione funziona.
    // `> summary`: figlio DIRETTO. Aperto il pannello, dentro compaiono altri
    // due `<summary>` («Adaptation notes», «Raw envelope JSON») e un locator
    // discendente ne trova tre — il primo click passava per caso (erano ancora
    // uno solo), il secondo no. Un selettore che smette di essere univoco a
    // meta' test e' un test che si rompe da solo.
    const interruttore = dettagli.locator("> summary");
    await interruttore.click();
    await expect.poll(() => chiamateEnvelope, { timeout: 10_000 }).toBeGreaterThan(0);
    await interruttore.click(); // richiusa per lo screenshot
    expect(await dettagli.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

    await page.locator('[data-popover="context-inspector"]').first()
      .screenshot({ path: "test-results/ctx-inspector.png" });
  });

  /**
   * Il secondo motivo di avviso: la finestra è ampia ma il prompt è già così
   * grande che ogni chiamata lo rilegge per intero.
   *
   * Serve un segno diverso, e questo test esiste perché la prima versione lo
   * sbagliava: diceva «Context almost full — 40%», che è una frase che l'umano
   * non può capire. La pastiglia mostra i TOKEN e non la percentuale, perché su
   * una finestra da 1M il 45% non è il problema — il problema sono i 450k che
   * ripaghi a ogni chiamata; il perché sta nel tooltip dell'anello.
   */
  test("sopra i token assoluti l'avviso parla di COSTO, non di capienza", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USAGE-09" });
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          context: {
            usage: { sessionUpdate: "usage_update", used: 450_000, size: 1_000_000 },
            percent: 45,
            level: "critical",
            reason: "cost",
            estimated: false,
            model: "claude-opus-5",
            measuredAt: new Date().toISOString(),
          },
        }),
      }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    // Il ring resta sulla CAPIENZA: 45% non è un anello rosso.
    await expect(ring).toHaveAttribute("data-context-percent", "45");

    const notice = page.getByTestId("context-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveAttribute("data-context-reason", "cost");
    // I token, non la percentuale: «45%» a meno di metà finestra non spiega
    // niente, «450k» sì.
    await expect(notice).toHaveText("450k");
    // La spiegazione intera sta nel tooltip, e dice COSTO, non capienza.
    await expect(ring).toHaveAttribute("title", /costo per chiamata/);
    await expect(ring).not.toHaveAttribute("title", /quasi pieno/);
  });

  /**
   * La soglia di costo scatta a 200k, cioè al 20% di una finestra da un
   * milione: lo stato normale di qualunque sessione dopo mezz'ora. Col riquadro
   * quel livello era MUTO di proposito, perché un'interruzione permanente non
   * la legge più nessuno. Una pastiglia da quattro caratteri dentro un bottone
   * che c'è comunque non interrompe niente, quindi adesso si vede — ed è il
   * punto di tutto il cambiamento: il segnale non va più barattato con la pace.
   */
  test("anche il costo a livello warn si vede: la pastiglia non interrompe", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USAGE-09" });
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          context: {
            usage: { sessionUpdate: "usage_update", used: 332_000, size: 1_000_000 },
            percent: 33, level: "warn", reason: "cost", estimated: false,
            model: "claude-opus-5", measuredAt: new Date().toISOString(),
          },
        }),
      }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    await expect(ring).toHaveAttribute("data-context-percent", "33");
    // Il tooltip dice perché l'anello è ambra.
    await expect(ring).toHaveAttribute("title", /rilegge questi token/);

    const notice = page.getByTestId("context-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveAttribute("data-context-level", "warn");
    await expect(notice).toHaveText("332k");
  });

  /**
   * L'AVVISO NON SI CHIUDE PIÙ, perché non c'è più niente da chiudere.
   *
   * C'erano due latch di dismiss — uno per «finestra piena», uno per «prompt
   * caro» — nati perché zittire un allarme non doveva zittire l'altro: su una
   * finestra da 1M quello economico scatta a 400k (quasi subito) e quello vero
   * a 900k, e con un latch solo il secondo non si vedeva più. Erano complessità
   * al servizio di un interruttore, e l'interruttore serviva solo perché
   * l'avviso interrompeva. Tolto il riquadro, la pastiglia segue la misura e
   * basta: questo test pinna che NON esiste un gesto capace di spegnerla.
   */
  test("la pastiglia segue la misura: non c'è modo di zittirla", async ({ page }) => {
    await page.route("**/api/context/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          context: {
            usage: { sessionUpdate: "usage_update", used: 940_000, size: 1_000_000 },
            percent: 94, level: "critical", reason: "window", estimated: false,
            model: "claude-opus-5", measuredAt: new Date().toISOString(),
          },
        }),
      }),
    );

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const ring = page.getByTestId("chat-input-context-ring").first();
    await ring.waitFor({ state: "visible", timeout: 10_000 });
    const notice = page.getByTestId("context-notice");
    await expect(notice).toHaveText("94%");

    // Aprire e richiudere l'ispettore — il gesto che prima passava dal bottone
    // di chiusura dell'avviso — non la spegne.
    await ring.click();
    await expect(page.getByTestId("context-inspector").first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(notice).toHaveText("94%");
  });
});

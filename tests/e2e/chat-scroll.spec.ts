import { test, expect, type Page, type Locator } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * Le tre attese di questo file, come CONDIZIONI invece che come dormite.
 *
 * Il primo test lo diceva già nel suo commento — «POLL, don't sleep-then-sample»:
 * il `waitForTimeout(2000)` da cui partiva falliva 3 run su 4 a macchina calda,
 * perché l'ancoraggio iniziale di Virtuoso arriva quando la lista finisce di
 * misurarsi, che non è sull'orologio di nessuno. Gli altri tre test erano rimasti
 * indietro con 15,5 secondi di sonno fisso fra tutti, sbagliato in entrambe le
 * direzioni: sprecato quando lo scroll si assesta in 50ms, insufficiente quando
 * la macchina è carica — e in quel caso il test accusa lo scroll di un difetto
 * che non ha.
 *
 * Restano attese fisse SOLO dove si osserva che qualcosa NON accade: per un
 * evento che non deve arrivare non esiste condizione da pollare, serve una
 * finestra. Sono segnate una per una.
 */
const AT_BOTTOM_TOLERANCE_PX = 150; // = AT_BOTTOM_TOLERANCE_PX in scrollAuthority.ts
const TRUE_BOTTOM_TOLERANCE_PX = 60; // padding di Virtuoso

type Scroller = Locator;

const isAtBottom = (scroller: Scroller, tolerance = AT_BOTTOM_TOLERANCE_PX) =>
  scroller.evaluate(
    (el, tol) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < tol,
    tolerance,
  );

/** Attende che la lista virtualizzata abbia finito di misurarsi e sia ancorata in fondo. */
async function settleAtBottom(scroller: Scroller): Promise<void> {
  await expect.poll(() => isAtBottom(scroller), { timeout: 15_000 }).toBe(true);
}

/** Legge `scrollTop` finché due letture consecutive coincidono: lo scroll si è fermato. */
async function stableScrollTop(scroller: Scroller): Promise<number> {
  let last = await scroller.evaluate((el) => el.scrollTop);
  for (let i = 0; i < 40; i++) {
    const now = await scroller.evaluate((el) => el.scrollTop);
    if (now === last) return now;
    last = now;
  }
  return last;
}

/**
 * Porta lo scroller in cima e restituisce dove si è fermato.
 *
 * Un solo Home non basta, ed è il motivo per cui il codice originale ne premeva
 * due: la lista è virtualizzata e monta le righe mancanti man mano, quindi il
 * primo salto atterra su un'altezza che subito dopo cambia. Ma "due volte" era
 * un numero indovinato — qui si ripete finché `scrollTop` smette di scendere,
 * che è la condizione vera dietro quelle due dormite.
 */
async function scrollToTop(page: Page, scroller: Scroller): Promise<number> {
  await scroller.click();
  let previous = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.keyboard.press("Home");
    const settled = await stableScrollTop(scroller);
    if (settled === 0 || settled >= previous) return settled;
    previous = settled;
  }
  return previous;
}

test.describe("Chat scroll behavior", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `scroll-test-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;

    // Seed with enough messages to make the chat scrollable
    for (let i = 0; i < 20; i++) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `Seed message ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Lo scroller virtualizzato viene preso con `.first()`: con le pane dei file
  // precedenti ancora aperte (pane-store unico per la suite seriale) il primo
  // scroller può essere quello di UN'ALTRA chat. Reset al topic seminato qui.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("auto-scrolls to bottom when new message arrives and user is at bottom", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await scroller.waitFor({ state: "visible", timeout: 15000 });

    // 150px tolerance matches the app's own at-bottom threshold
    // (AT_BOTTOM_TOLERANCE_PX in client/src/components/Chat/scrollAuthority.ts);
    // the redesign lands ~1 short message short of a tight 60px window.
    const atBottom = () =>
      scroller.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 150);

    // POLL, don't sleep-then-sample. This assertion used to run once after a
    // fixed waitForTimeout(2000) and failed 3 runs out of 4 on a warm machine:
    // Virtuoso's initial bottom-anchor lands whenever the list finishes
    // measuring, which is not on anybody's clock. Same reason the second
    // assertion polls instead of sleeping — auto-scroll is a race with the
    // WS frame, and the fixed wait was betting on it.
    await expect.poll(atBottom, { timeout: 15000 }).toBe(true);

    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `New message at ${Date.now()}` },
      ignoreHTTPSErrors: true,
    });

    // The list must END UP at the bottom; it may leave it for a frame while the
    // new row is measured. Polling asserts the settled state, which is the
    // behaviour under test.
    await expect.poll(atBottom, { timeout: 15000 }).toBe(true);
  });

  test("does NOT auto-scroll when user has scrolled up", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    // Lo scroller e' la PRECONDIZIONE della cosa in esame, non una comodita'
    // dell'ambiente: se sparisce, e' il difetto — non un motivo per saltare. Con
    // `test.skip(count === 0)` questi tre test diventavano verdi-vuoti proprio
    // nel caso che dovevano intercettare, e il conteggio dei "saltati" non lo
    // guarda nessuno. Asserire lo fa cadere con il messaggio giusto.
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);

    const scrollBefore = await scrollToTop(page, scroller);

    // Add a new message
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `Message while scrolled up ${Date.now()}` },
      ignoreHTTPSErrors: true,
    });

    // ATTESA FISSA VOLUTA: qui si osserva che una cosa NON accade (la lista non
    // deve rincorrere il messaggio nuovo). Per un evento che non deve arrivare
    // non c'e' condizione da pollare — serve una finestra in cui, se lo scroll
    // saltasse, lo si vedrebbe. Due secondi coprono il round-trip WS piu' il
    // rendering della riga.
    await page.waitForTimeout(2000);

    const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(100);
  });

  test("scroll-to-bottom button appears when scrolled up and works on click", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    // Lo scroller e' la PRECONDIZIONE della cosa in esame, non una comodita'
    // dell'ambiente: se sparisce, e' il difetto — non un motivo per saltare. Con
    // `test.skip(count === 0)` questi tre test diventavano verdi-vuoti proprio
    // nel caso che dovevano intercettare, e il conteggio dei "saltati" non lo
    // guarda nessuno. Asserire lo fa cadere con il messaggio giusto.
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);

    const scrollBtn = page.getByRole("button", { name: "Scroll to bottom" });

    // Home fa uno scroll nativo, che e' cio' che l'IntersectionObserver di
    // Virtuoso rileva per far comparire il bottone.
    await scrollToTop(page, scroller);
    await expect(scrollBtn).toBeVisible({ timeout: 8000 });

    await scrollBtn.click();

    // Lo scroll e' animato (400ms smooth + 600ms di guardia): si polla il fondo
    // vero invece di indovinare quando l'animazione e' finita.
    await expect
      .poll(() => isAtBottom(scroller, TRUE_BOTTOM_TOLERANCE_PX), { timeout: 10_000 })
      .toBe(true);

    // Button should disappear
    await expect(scrollBtn).not.toBeVisible({ timeout: 5000 });
  });

  test("scroll-to-bottom button reaches true bottom and stays there", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    // Lo scroller e' la PRECONDIZIONE della cosa in esame, non una comodita'
    // dell'ambiente: se sparisce, e' il difetto — non un motivo per saltare. Con
    // `test.skip(count === 0)` questi tre test diventavano verdi-vuoti proprio
    // nel caso che dovevano intercettare, e il conteggio dei "saltati" non lo
    // guarda nessuno. Asserire lo fa cadere con il messaggio giusto.
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);

    const scrollBtn = page.getByRole("button", { name: "Scroll to bottom" });

    await scrollToTop(page, scroller);
    await expect(scrollBtn).toBeVisible({ timeout: 8000 });

    await scrollBtn.click();

    // Prima si aspetta che l'animazione ARRIVI in fondo (condizione), poi si
    // guarda se ci RESTA (finestra).
    await expect
      .poll(() => isAtBottom(scroller, TRUE_BOTTOM_TOLERANCE_PX), { timeout: 10_000 })
      .toBe(true);

    // ATTESA FISSA VOLUTA: il difetto in esame e' il RIMBALZO — la lista che
    // torna in fondo e poi se ne stacca da sola. Un rimbalzo si vede solo
    // guardando per un po', quindi qui il campionamento a tempo E' la misura, non
    // un'attesa che si possa sostituire con una condizione. Quattro letture in
    // due secondi.
    const measurements: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(500);
      measurements.push(await isAtBottom(scroller, TRUE_BOTTOM_TOLERANCE_PX));
    }

    // ALL measurements should report at-bottom (no drift/bounce)
    expect(measurements.every(m => m)).toBe(true);

    // Scroll-to-bottom button should remain hidden (no re-appearance from bounce)
    await expect(scrollBtn).not.toBeVisible({ timeout: 2000 });
  });
});
